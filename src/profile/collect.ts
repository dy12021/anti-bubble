import type { BiliClient } from '../bili/client';
import { fetchHistory, fetchFavorites, fetchFavoriteItems } from '../bili/api';
import type { ContentItem, UserProfileInput } from '../shared/types';

/** 把内容单元转成画像样本。 */
export function toSample(
  item: ContentItem,
  watchSeconds: number,
  origin: UserProfileInput['origin'],
): UserProfileInput {
  const cat = item.meta['category'];
  return {
    id: item.id,
    title: item.text,
    author: item.author,
    category: typeof cat === 'string' ? cat : '',
    watchSeconds,
    collectedAt: new Date().toISOString(),
    origin,
  };
}

/**
 * 冷启动采样：观看历史 + 收藏夹。
 *
 * 失败一律降级为空数组——拉不到数据不该让插件不可用。
 */
export async function collectColdStart(
  c: BiliClient,
  opts: { includeHistory?: boolean } = {},
): Promise<UserProfileInput[]> {
  const includeHistory = opts.includeHistory !== false;
  const samples: UserProfileInput[] = [];

  if (includeHistory) {
    const history = await fetchHistory(c);
    for (const h of history) {
      const info = h.history;
      if (!info?.bvid) continue;
      samples.push({
        id: info.bvid,
        title: info.title ?? '',
        author: info.author_name ?? '',
        category: info.tname ?? '',
        collectedAt: new Date((info.viewed_at ?? Date.now() / 1000) * 1000).toISOString(),
        origin: 'history',
      });
    }
  }

  const folders = await fetchFavorites(c);
  for (const f of folders.slice(0, 10)) {
    const items = await fetchFavoriteItems(c, f.id);
    for (const m of items) {
      if (!m.bvid) continue;
      samples.push({
        id: m.bvid,
        title: m.title ?? '',
        author: m.upper?.name ?? '',
        category: '',
        collectedAt: m.ctime ? new Date(m.ctime * 1000).toISOString() : new Date().toISOString(),
        origin: 'favorite',
      });
    }
  }

  return samples;
}

/** 增量样本：用户刚看过的视频。 */
export function collectIncremental(
  _c: BiliClient,
  item: ContentItem,
  watchSeconds: number,
): UserProfileInput {
  return toSample(item, watchSeconds, 'history');
}
