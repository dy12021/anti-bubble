import type { ContentItem, Verdict, Mode } from '../shared/types';
import { getJson, setJson } from '../bg/storage';
import { STORAGE_KEYS } from '../shared/constants';
import { contentKey } from '../shared/hash';

/** 判定缓存上限。超出后丢弃最旧的。 */
const MAX_ENTRIES = 3000;

/**
 * 判定结果的上下文键。
 *
 * 同一个评论在不同视频/不同模式下，判定结果可能不同，
 * 所以缓存键必须带上上下文。
 */
export function verdictContextKey(item: ContentItem, mode: Mode): string {
  return contentKey('verdict', mode, item.kind, item.context.videoId ?? '', item.text);
}

/**
 * 判定结果缓存。避免同一内容重复花钱。
 */
export class VerdictCache {
  async get(itemId: string, contextKey: string): Promise<Verdict | null> {
    const cache = await this.load();
    const v = cache[contentKey(itemId, contextKey)];
    return v ?? null;
  }

  async set(itemId: string, contextKey: string, verdict: Verdict): Promise<void> {
    const cache = await this.load();
    cache[contentKey(itemId, contextKey)] = verdict;
    // 限制条数，避免无限增长（对象键序即插入序，最旧的在前）
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete cache[k];
    }
    await setJson(STORAGE_KEYS.verdictCache, cache);
  }

  async clear(): Promise<void> {
    await setJson(STORAGE_KEYS.verdictCache, {});
  }

  private async load(): Promise<Record<string, Verdict>> {
    return getJson<Record<string, Verdict>>(STORAGE_KEYS.verdictCache, {});
  }
}
