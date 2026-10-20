import type { UserProfile, Mode } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import type { BiliClient } from '../bili/client';
import { fetchVideo, fetchVideoIdByBvid, fetchConclusion } from '../bili/api';
import { getJson, setJson } from '../bg/storage';
import { STORAGE_KEYS } from '../shared/constants';
import {
  buildWordlistPrompt, parseWordlist, buildFallbackWordlist, wordlistCacheKey,
} from './wordlist';
import type { VideoContext, Wordlist } from './types';

interface CachedWordlist extends Wordlist {
  profileUpdatedAt: string;
  /**
   * 缓存键是哈希，反查不出视频 id，
   * 所以把 videoId 一起存下来，invalidate 才知道该删哪些条目。
   */
  videoId: string;
}

/**
 * 词表服务：生成 + 缓存。
 *
 * 缓存键 = 视频 id + 画像版本。画像更新后自动失效（判据可能要变）。
 */
export class WordlistService {
  constructor(private readonly client: LlmClient) {}

  async get(
    video: VideoContext,
    profile: UserProfile | null,
    mode: Mode,
  ): Promise<Wordlist> {
    const profileUpdatedAt = profile?.updatedAt ?? '';
    const key = wordlistCacheKey(video.bvid, profileUpdatedAt);

    const cache = await getJson<Record<string, CachedWordlist>>(
      STORAGE_KEYS.wordlistCache, {},
    );
    const hit = cache[key];
    if (hit && Array.isArray(hit.patterns)) {
      return {
        patterns: hit.patterns,
        stance: hit.stance ?? '',
        oppositeKeywords: hit.oppositeKeywords ?? [],
        cacheKey: key,
      };
    }

    const fallback = buildFallbackWordlist(video, mode);
    let wordlist: Wordlist;
    try {
      const { system, user } = buildWordlistPrompt(video, profile, mode);
      const raw = await this.client.complete(user, { system, maxTokens: 1500 });
      wordlist = parseWordlist(raw, { ...fallback, cacheKey: key });
    } catch {
      // LLM 不可用 → 兜底词表（空模式 = 全部放行），不抛
      wordlist = { ...fallback, cacheKey: key };
    }

    cache[key] = { ...wordlist, profileUpdatedAt, videoId: video.bvid };
    await setJson(STORAGE_KEYS.wordlistCache, cache);
    return wordlist;
  }

  /** 丢掉某个视频的全部词表缓存（下次重新生成）。 */
  async invalidate(videoId: string): Promise<void> {
    const cache = await getJson<Record<string, CachedWordlist>>(
      STORAGE_KEYS.wordlistCache, {},
    );
    for (const [k, v] of Object.entries(cache)) {
      if (v?.videoId === videoId || k.includes(videoId)) delete cache[k];
    }
    await setJson(STORAGE_KEYS.wordlistCache, cache);
  }
}

/**
 * 拉当前视频的上下文（标题 / 简介 / B 站官方 AI 总结）。
 *
 * 任何一步失败都返回 null，不抛——词表拿不到视频信息时降级成空表即可。
 */
export async function loadVideoContext(
  c: BiliClient,
  bvid: string,
): Promise<VideoContext | null> {
  try {
    const v = await fetchVideo(c, bvid);
    if (!v) return null;

    let summary: string | undefined;
    const ids = await fetchVideoIdByBvid(c, bvid);
    if (ids) {
      const conclusion = await fetchConclusion(c, bvid, ids.cid, ids.upMid);
      if (conclusion?.model_result) summary = conclusion.model_result;
    }

    return {
      bvid,
      title: v.title,
      ...(v.description ? { description: v.description } : {}),
      ...(summary ? { summary } : {}),
    };
  } catch {
    return null;
  }
}
