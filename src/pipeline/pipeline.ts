import type { ContentItem, UserProfile, Verdict, Mode, JudgeLevel } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { coarseMatch } from './coarse';
import { judgeItems } from './judge';
import { buildSubjectPrompt, parseWordlist, buildFallbackWordlist } from './wordlist';
import { matchBuiltinKeyword } from './keyword';
import type { Wordlist, PipelineContext, JudgeInput, JudgeTarget } from './types';

export interface PipelineOptions {
  /**
   * LLM 客户端。
   *
   * 允许为 null：「仅关键词」档不需要 LLM（零调用、零延迟、也不用配 Key），
   * 这时候整条流水线只能跑本地规则。
   */
  client: LlmClient | null;
  /**
   * 提供当前视频的词表。
   *
   * 不提供时由 Pipeline 自己调 LLM 现生成一份（每个视频 1 次）。
   * 生产环境注入的是 WordlistService：它自己管缓存，命中缓存 0 次调用。
   */
  wordlistProvider?: (ctx: PipelineContext) => Promise<Wordlist>;
  /** 已撤销（白名单）的内容 id，直接放行 */
  whitelist?: string[];
}

/** 拿不到词表时的占位：空模式 = 粗筛永不命中 = 全部放行。 */
const EMPTY_WORDLIST: Wordlist = {
  patterns: [],
  stance: '',
  oppositeKeywords: [],
  cacheKey: 'none',
};

/**
 * 画像匹配：纯本地、零成本的第一道闸门。
 *
 * 命中画像里明确的「不喜欢」标签 → 直接 fold。
 * 这条不需要 LLM，因为它匹配的是画像里已经归纳好的标签。
 *
 * 返回**命中的那个标签**（而不是布尔值）：用户撤销屏蔽时，
 * 页面要能告诉后台「把画像里的这个标签去掉」——没有标签名就做不了。
 */
export function matchProfileTag(text: string, profile: UserProfile | null): string | null {
  if (!profile || profile.dislikes.length === 0) return null;
  const hay = text.toLowerCase();
  for (const d of profile.dislikes) {
    const needle = d.trim().toLowerCase();
    if (!needle) continue;
    if (hay.includes(needle)) return d.trim();
  }
  return null;
}

/** 画像匹配（只要布尔结果时用这个）。 */
export function matchProfile(text: string, profile: UserProfile | null): boolean {
  return matchProfileTag(text, profile) !== null;
}

/**
 * 判定流水线：按档位分流的三级闸门。
 *
 *   ① 白名单 → 直接放行
 *   ② 画像匹配（本地，零成本）→ 命中直接 fold
 *   ③ 档位分流：
 *      - `coarse`：动态词表粗筛 → 未命中放行，命中才进 LLM 精判
 *      - `all`：全部进 LLM 精判（不做任何本地预筛）
 *      - `keyword`：内置关键词库匹配，**一次 LLM 都不调**
 *
 * **成本结构**（coarse 档）：每个视频 1 次词表调用（命中缓存则 0 次）
 * + 命中条数 × 1 次精判。未命中的评论不花钱。
 */
export class Pipeline {
  constructor(private readonly opts: PipelineOptions) {}

  async judge(items: ContentItem[], ctx: PipelineContext): Promise<Verdict[]> {
    if (items.length === 0) return [];

    const level: JudgeLevel = ctx.judgeLevel ?? 'coarse';
    const whitelist = new Set(this.opts.whitelist ?? []);
    const verdicts = new Map<string, Verdict>();

    // ① 白名单：撤销过的内容直接放行（三种档位都一样）
    const pending: ContentItem[] = [];
    for (const item of items) {
      if (whitelist.has(item.id)) {
        verdicts.set(item.id, pass(item.id));
        continue;
      }
      pending.push(item);
    }
    if (pending.length === 0) {
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    // 「仅关键词」档：**不碰词表**（生成词表本身就是一次 LLM 调用），
    // 判据只有内置关键词库 + 画像里的「不喜欢」。
    if (level === 'keyword') {
      for (const item of pending) {
        const tag = matchProfileTag(item.text, ctx.profile);
        if (tag) {
          verdicts.set(item.id, {
            itemId: item.id,
            action: 'fold',
            reason: `命中你不喜欢的「${tag}」`,
            reasonCode: 'dislike_match',
            confidence: 0.9,
            revocable: true,
            matchedTag: tag,
          });
          continue;
        }
        const hit = matchBuiltinKeyword(item.text);
        if (hit) {
          verdicts.set(item.id, {
            itemId: item.id,
            action: 'fold',
            reason: hit.reason,
            reasonCode: hit.reasonCode,
            confidence: 0.9,
            revocable: true,
          });
          continue;
        }
        verdicts.set(item.id, pass(item.id));
      }
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    // 词表先取好：它是 coarse 档 ② 的输入，缺了 ② 只能全放行。
    // context.wordlist 里如果已经有了（service worker 会先解析好，
    // 因为它要用词表版本算判定缓存键），就直接用，不再解析一次。
    let wordlist: Wordlist;
    try {
      wordlist = ctx.wordlist ?? (await this.resolveWordlist(ctx));
    } catch {
      // 词表拿不到 → 用空表，全部放行，绝不误伤
      wordlist = EMPTY_WORDLIST;
    }

    // ② 画像匹配 + 白名单
    //
    // `all` 档**跳过**这一层：那一档的意义就是「全部交给 LLM 判」，
    // 画像作为偏好提示写进 prompt，由模型自己权衡要不要折叠。
    const toJudge: ContentItem[] = [];
    for (const item of pending) {
      if (level !== 'all') {
        const tag = matchProfileTag(item.text, ctx.profile);
        if (tag) {
          verdicts.set(item.id, {
            itemId: item.id,
            action: 'fold',
            reason: `命中你不喜欢的「${tag}」`,
            reasonCode: 'dislike_match',
            confidence: 0.9,
            revocable: true,
            matchedTag: tag,
          });
          continue;
        }
      }
      toJudge.push(item);
    }

    // ③ 档位分流：coarse 走词表粗筛，all 全部进精判
    let suspects: ContentItem[];
    if (level === 'all') {
      suspects = toJudge;
    } else {
      suspects = toJudge.filter((item) => coarseMatch(item.text, wordlist));
      const suspectIds = new Set(suspects.map((i) => i.id));
      for (const item of toJudge) {
        if (!suspectIds.has(item.id)) {
          verdicts.set(item.id, pass(item.id));
        }
      }
    }

    if (suspects.length === 0) {
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    // 没有 LLM 客户端 → 判不了，全部放行（绝不误伤）
    if (!this.opts.client) {
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    // ④ LLM 精判
    const inputs: JudgeInput[] = suspects.map((item) => ({
      text: item.text,
      author: item.author,
      videoTitle: item.context.videoTitle,
    }));
    // 判的是「评论」还是「视频标题」——列表页判标题，视频页判评论。
    // 说法不一样，混着说模型会把标题当评论理解。
    const target: JudgeTarget = ctx.subject?.kind === 'list' ? 'title' : 'comment';
    const judged = await judgeItems(
      this.opts.client,
      inputs,
      wordlist,
      ctx.mode,
      ctx.profile,
      ctx.threshold,
      target,
    );

    suspects.forEach((item, i) => {
      const v = judged[i];
      if (!v) {
        verdicts.set(item.id, pass(item.id));
        return;
      }
      verdicts.set(item.id, { ...v, itemId: item.id });
    });

    return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
  }

  /**
   * 取词表：优先用 context 里已解析好的，
   * 其次用注入的 provider，最后自己调 LLM 生成一份。
   *
   * 对外公开：service worker 需要先拿到词表，才能用「词表版本」算判定缓存键。
   */
  async resolveWordlist(ctx: PipelineContext): Promise<Wordlist> {
    if (ctx.wordlist) return ctx.wordlist;
    if (this.opts.wordlistProvider) return this.opts.wordlistProvider(ctx);

    // 没有语境 = 判不了 = 全部放行。绝不用空语境硬凑一份词表。
    if (!ctx.subject) return EMPTY_WORDLIST;
    const fallback = buildFallbackWordlist(ctx.subject);
    if (!this.opts.client) return fallback;
    try {
      const { system, user } = buildSubjectPrompt(ctx.subject, ctx.profile, ctx.mode);
      const raw = await this.opts.client.complete(user, { system, maxTokens: 1500 });
      return parseWordlist(raw, fallback);
    } catch {
      return fallback;
    }
  }
}

function pass(itemId: string): Verdict {
  return {
    itemId,
    action: 'pass',
    reason: '',
    reasonCode: 'none',
    confidence: 1,
    revocable: false,
  };
}
