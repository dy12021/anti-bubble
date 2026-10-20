import type { ContentItem, UserProfile, Mode, Verdict } from '../shared/types';
import type { LlmClient } from './llm/client';
import { Pipeline } from '../pipeline/pipeline';
import { WordlistService } from '../pipeline/wordlist-service';
import { VerdictCache, verdictContextKey } from '../pipeline/verdict-cache';
import { getProfile, getWhitelist } from './storage';
import type { VideoContext } from '../pipeline/types';

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

    // ① 先查缓存——同一评论第二次出现时不该再花一次精判的钱。
    //    缓存键含 mode / videoId / 正文，所以换了模式或视频不会误命中。
    const cached = new Map<string, Verdict>();
    const toJudge: ContentItem[] = [];
    for (const item of items) {
      const key = verdictContextKey(item, opts.mode);
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

    // ② 只判未命中的
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

    const results = await pipeline.judge(toJudge, {
      mode: opts.mode,
      profile,
      video: opts.video,
      threshold: opts.threshold,
    });

    // ③ 写回缓存
    for (const v of results) {
      const item = toJudge.find((i) => i.id === v.itemId);
      if (!item) continue;
      await this.cache.set(v.itemId, verdictContextKey(item, opts.mode), v);
    }

    // ④ 按原输入顺序合并（缓存的 + 新判的）
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
