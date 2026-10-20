import type { ContentItem, UserProfile, Mode, Verdict } from '../shared/types';
import type { LlmClient } from './llm/client';
import { Pipeline } from '../pipeline/pipeline';
import { WordlistService } from '../pipeline/wordlist-service';
import { VerdictCache, verdictContextKey } from '../pipeline/verdict-cache';
import { getProfile, getWhitelist } from './storage';
import type { VideoContext, Wordlist, PipelineContext } from '../pipeline/types';

/**
 * service worker 侧的判定服务。
 * content script 只管抽 DOM 与执行动作，判定全在这里。
 */
export class PipelineService {
  private readonly wordlists: WordlistService;
  private readonly cache = new VerdictCache();

  constructor(private readonly client: LlmClient) {
    this.wordlists = new WordlistService(client);
  }

  async judge(
    items: ContentItem[],
    opts: { mode: Mode; video: VideoContext | null; threshold: number },
  ): Promise<Verdict[]> {
    const profile: UserProfile | null = await getProfile();
    const whitelist = await getWhitelist();

    const pipeline = new Pipeline({
      client: this.client,
      whitelist,
      wordlistProvider: async (ctx) => {
        if (!ctx.video) {
          return { patterns: [], stance: '', oppositeKeywords: [], cacheKey: 'none' };
        }
        return this.wordlists.get(ctx.video, ctx.profile, ctx.mode);
      },
    });

    const ctx: PipelineContext = {
      mode: opts.mode,
      profile,
      video: opts.video,
      threshold: opts.threshold,
    };

    // ① 先拿词表。
    //    不只是为了粗筛——**判定缓存键要带上词表版本**。
    //
    //    为什么：词表变了（重新生成、或者当初生成失败拿到的是空表），
    //    之前的判定就不再可信。如果缓存键不含词表版本，
    //    一条「因为词表是空的所以全部放行」的假判定会被永久缓存，
    //    之后即使词表正常了也命中缓存早退 → LLM 再也不会被调用 →
    //    插件看起来「在运行但什么都不做」。这个坑真机验证时踩过。
    let wordlist: Wordlist;
    try {
      wordlist = await pipeline.resolveWordlist(ctx);
    } catch {
      wordlist = { patterns: [], stance: '', oppositeKeywords: [], cacheKey: 'none' };
    }
    ctx.wordlist = wordlist;

    // 空词表 = 粗筛压根没跑成。这种「放行」不是真正的判定，**不入缓存**。
    const wordlistUsable = wordlist.patterns.length > 0;

    // ② 查缓存（键里带词表版本）
    const cached = new Map<string, Verdict>();
    const toJudge: ContentItem[] = [];
    for (const item of items) {
      const key = verdictContextKey(item, opts.mode, wordlist.cacheKey);
      const hit = await this.cache.get(item.id, key);
      if (hit) {
        cached.set(item.id, hit);
      } else {
        toJudge.push(item);
      }
    }

    if (toJudge.length === 0) {
      return items.map((i) => cached.get(i.id) ?? passVerdict(i.id));
    }

    // ③ 只判未命中的
    const results = await pipeline.judge(toJudge, ctx);

    // ④ 写回缓存（空词表产生的 pass 不写）
    for (const v of results) {
      if (v.action === 'pass' && !wordlistUsable) continue;
      const item = toJudge.find((i) => i.id === v.itemId);
      if (!item) continue;
      await this.cache.set(
        v.itemId,
        verdictContextKey(item, opts.mode, wordlist.cacheKey),
        v,
      );
    }

    // ⑤ 按原输入顺序合并
    const fresh = new Map(results.map((v) => [v.itemId, v]));
    return items.map((i) => cached.get(i.id) ?? fresh.get(i.id) ?? passVerdict(i.id));
  }
}

function passVerdict(itemId: string): Verdict {
  return {
    itemId,
    action: 'pass',
    reason: '',
    reasonCode: 'none',
    confidence: 1,
    revocable: false,
  };
}
