import type { UserProfile, Mode } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import type { BiliClient } from '../bili/client';
import { fetchVideo, fetchVideoIdByBvid, fetchConclusion } from '../bili/api';
import { getJson, setJson, setLastError, clearLastError } from '../bg/storage';
import { STORAGE_KEYS } from '../shared/constants';
import {
  buildSubjectPrompt, parseWordlist, buildFallbackWordlist, wordlistCacheKey,
} from './wordlist';
import { subjectId } from './subject';
import type { Subject, VideoContext, Wordlist } from './types';

interface CachedWordlist extends Wordlist {
  profileUpdatedAt: string;
  /**
   * 缓存键是哈希，反查不出语境 id，
   * 所以把 subjectId 一起存下来，invalidate 才知道该删哪些条目。
   */
  subjectKey: string;
}

/**
 * 词表服务：生成 + 缓存。
 *
 * 缓存键 = 语境 id + 画像版本。画像更新后自动失效（判据可能要变）。
 */
export class WordlistService {
  /**
   * 可以是 null：「仅关键词」档不需要词表，也就没有 LLM。
   * 这种情况下 get() 直接返回空表（= 粗筛永不命中 = 全部放行），不抛。
   */
  constructor(private readonly client: LlmClient | null) {}

  async get(
    subject: Subject,
    profile: UserProfile | null,
    mode: Mode,
  ): Promise<Wordlist> {
    const profileUpdatedAt = profile?.updatedAt ?? '';
    const key = wordlistCacheKey(subjectId(subject), profileUpdatedAt);

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

    const fallback = buildFallbackWordlist(subject);

    // 没有 LLM 客户端 → 没有词表。返回空表（= 全部放行），不抛。
    if (!this.client) {
      return { ...fallback, cacheKey: key, error: '未配置 LLM，无法生成词表' };
    }

    let wordlist: Wordlist;
    try {
      const { system, user } = buildSubjectPrompt(subject, profile, mode);
      const raw = await this.client.complete(user, { system });
      wordlist = parseWordlist(raw, { ...fallback, cacheKey: key });
      if (wordlist.patterns.length === 0) {
        // 解析出来是空表 = 没解析出判据。和失败一样处理：
        // 不缓存（否则这个语境永远拿不到词表），并把原因带出去。
        const reason = '模型返回的内容里没有可用的判据（patterns 为空）';
        console.error(`[anti-bubble] 词表生成失败：${reason}`);
        await setLastError(`词表生成失败：${reason}`);
        return { ...fallback, cacheKey: key, error: reason };
      }
    } catch (e) {
      // LLM 不可用 → 兜底词表（空模式 = 全部放行），不抛
      //
      // **失败不写缓存**：写进去的话，这个语境的词表就永久是空的，
      // 之后再也不会重试 —— 一次网络抖动会让这个页面从此再也不判定。
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[anti-bubble] 词表生成失败：${reason}`);
      await setLastError(`词表生成失败：${reason}`);
      return { ...fallback, cacheKey: key, error: reason };
    }

    cache[key] = { ...wordlist, profileUpdatedAt, subjectKey: subjectId(subject) };
    await setJson(STORAGE_KEYS.wordlistCache, cache);
    await clearLastError();
    return wordlist;
  }

  /** 丢掉某个语境的全部词表缓存（下次重新生成）。 */
  async invalidate(subjectKey: string): Promise<void> {
    const cache = await getJson<Record<string, CachedWordlist>>(
      STORAGE_KEYS.wordlistCache, {},
    );
    for (const [k, v] of Object.entries(cache)) {
      if (v?.subjectKey === subjectKey || k.includes(subjectKey)) delete cache[k];
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
