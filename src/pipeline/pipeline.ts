import type { ContentItem, UserProfile, Verdict, Mode } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { coarseMatch } from './coarse';
import { judgeItems } from './judge';
import { buildWordlistPrompt, parseWordlist, buildFallbackWordlist } from './wordlist';
import type { Wordlist, PipelineContext, JudgeInput } from './types';

export interface PipelineOptions {
  client: LlmClient;
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
 */
export function matchProfile(text: string, profile: UserProfile | null): boolean {
  if (!profile || profile.dislikes.length === 0) return false;
  const hay = text.toLowerCase();
  for (const d of profile.dislikes) {
    const needle = d.trim().toLowerCase();
    if (!needle) continue;
    if (hay.includes(needle)) return true;
  }
  return false;
}

/**
 * 判定流水线：三级闸门。
 *
 *   ① 画像匹配（本地，零成本）→ 命中直接 fold
 *   ② 动态词表粗筛（规则，零成本）→ 未命中直接放行
 *   ③ LLM 精判（唯一花钱环节）→ 只判 ② 命中的
 *
 * **成本结构**：每个视频 1 次词表调用（命中缓存则 0 次）+ 命中条数 × 1 次精判。
 * 未命中的评论不花钱。
 */
export class Pipeline {
  constructor(private readonly opts: PipelineOptions) {}

  async judge(items: ContentItem[], ctx: PipelineContext): Promise<Verdict[]> {
    if (items.length === 0) return [];

    const whitelist = new Set(this.opts.whitelist ?? []);
    const verdicts = new Map<string, Verdict>();

    // 词表先取好：它是 ② 的输入，缺了 ② 只能全放行。
    // context.wordlist 里如果已经有了（service worker 会先解析好，
    // 因为它要用词表版本算判定缓存键），就直接用，不再解析一次。
    let wordlist: Wordlist;
    try {
      wordlist = ctx.wordlist ?? (await this.resolveWordlist(ctx));
    } catch {
      // 词表拿不到 → 用空表，全部放行，绝不误伤
      wordlist = EMPTY_WORDLIST;
    }

    // ① 画像匹配 + 白名单
    const toJudge: ContentItem[] = [];
    for (const item of items) {
      if (whitelist.has(item.id)) {
        verdicts.set(item.id, pass(item.id));
        continue;
      }
      if (matchProfile(item.text, ctx.profile)) {
        verdicts.set(item.id, {
          itemId: item.id,
          action: 'fold',
          reason: '命中你不喜欢的题材',
          reasonCode: 'dislike_match',
          confidence: 0.9,
          revocable: true,
        });
        continue;
      }
      toJudge.push(item);
    }

    // ② 动态词表粗筛：未命中的直接放行，**绝不进 ③**
    const suspects = toJudge.filter((item) => coarseMatch(item.text, wordlist));
    const suspectIds = new Set(suspects.map((i) => i.id));
    for (const item of toJudge) {
      if (!suspectIds.has(item.id)) {
        verdicts.set(item.id, pass(item.id));
      }
    }

    if (suspects.length === 0) {
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    // ③ LLM 精判
    const inputs: JudgeInput[] = suspects.map((item) => ({
      text: item.text,
      author: item.author,
      videoTitle: item.context.videoTitle,
    }));
    const judged = await judgeItems(
      this.opts.client,
      inputs,
      wordlist,
      ctx.mode,
      ctx.profile,
      ctx.threshold,
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

    const video = ctx.video ?? { bvid: '', title: '' };
    const fallback = buildFallbackWordlist(video, ctx.mode);
    try {
      const { system, user } = buildWordlistPrompt(video, ctx.profile, ctx.mode);
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
