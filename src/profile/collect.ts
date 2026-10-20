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

/** 冷启动采集的规模上限。
 *
 * 这些数字不是随手写的：收藏夹多 + 每页 40 条 + 最多 10 页，
 * 10 个收藏夹就是 **100 个请求**，每个还要等 1.2 秒限流 = 两分钟。
 * 而这些请求和「取视频上下文」共用同一个限流器，
 * 于是冷启动会把主流程**堵在后面**——视频页的评论区面板迟迟不出现。
 *
 * 所以这里给死上限：收藏夹最多 3 个、每个最多 2 页、总数最多 120 条样本。
 */
export const COLD_START_MAX_FOLDERS = 3;
export const COLD_START_MAX_PAGES_PER_FOLDER = 2;
export const COLD_START_MAX_SAMPLES = 120;

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
    const history = await fetchHistory(c, COLD_START_MAX_SAMPLES);
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
  for (const f of folders.slice(0, COLD_START_MAX_FOLDERS)) {
    const items = await fetchFavoriteItems(c, f.id, COLD_START_MAX_PAGES_PER_FOLDER);
    for (const m of items) {
      if (!m.bvid) continue;
      if (samples.length >= COLD_START_MAX_SAMPLES) break;
      samples.push({
        id: m.bvid,
        title: m.title ?? '',
        author: m.upper?.name ?? '',
        category: '',
        collectedAt: m.ctime ? new Date(m.ctime * 1000).toISOString() : new Date().toISOString(),
        origin: 'favorite',
      });
    }
    if (samples.length >= COLD_START_MAX_SAMPLES) break;
  }

  return samples.slice(0, COLD_START_MAX_SAMPLES);
}

/** 增量样本：用户刚看过的视频。 */
export function collectIncremental(
  _c: BiliClient,
  item: ContentItem,
  watchSeconds: number,
): UserProfileInput {
  return toSample(item, watchSeconds, 'history');
}
