import type { BiliClient } from './client';
import type {
  NavData, HistoryItem, FavoriteFolder, FavoriteItem, VideoItem,
  SearchItem, CommentItem, ConclusionData,
} from './types';

/**
 * B 站端点封装。
 *
 * 约定：每个函数内部失败都返回 null / 空数组，绝不抛。
 * 上层拿不到数据就当作「没有」，不让异常冒到页面上。
 */

/** 登录态 + WBI 密钥来源。 */
export async function fetchNav(c: BiliClient): Promise<NavData | null> {
  return c.get<NavData>('/x/web-interface/nav');
}

/** 观看历史。仅最近 ~1000 条 / 3 个月。 */
export async function fetchHistory(c: BiliClient, maxItems = 1000): Promise<HistoryItem[]> {
  const items = await c.getPaged<
    { list: HistoryItem[]; page: { has_more?: boolean; cursor?: string } },
    HistoryItem
  >('/x/v2/history/cursor', { type: 'all' }, (d) => d.list ?? []);
  return items.slice(0, maxItems);
}

/** 收藏夹列表。 */
export async function fetchFavorites(c: BiliClient): Promise<FavoriteFolder[]> {
  const data = await c.get<{ list?: FavoriteFolder[] }>('/x/v3/fav/folder/created/list-all');
  return data?.list ?? [];
}

/** 某个收藏夹的内容。ps 上限 40。 */
export async function fetchFavoriteItems(c: BiliClient, fid: number): Promise<FavoriteItem[]> {
  const out: FavoriteItem[] = [];
  for (let pn = 1; pn <= 10; pn++) {
    const data = await c.get<{ medias?: FavoriteItem[] }>('/x/v3/fav/resource/list', {
      fid, pn, ps: 40,
    });
    const items = data?.medias ?? [];
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < 40) break;
  }
  return out;
}

/** 关注列表。 */
export async function fetchFollowing(c: BiliClient): Promise<{ mid: number; name: string }[]> {
  const data = await c.get<{ list?: { mid: number; uname: string }[] }>('/x/relation/followings');
  return (data?.list ?? []).map((u) => ({ mid: u.mid, name: u.uname }));
}

/** 视频详情（无需签名）。 */
export async function fetchVideo(c: BiliClient, bvid: string): Promise<VideoItem | null> {
  return c.get<VideoItem>('/x/web-interface/view', { bvid });
}

/** 从视频详情里取 aid / cid / upMid（评论与 AI 总结都要用）。 */
export async function fetchVideoIdByBvid(
  c: BiliClient,
  bvid: string,
): Promise<{ aid: number; cid: number; upMid: number } | null> {
  const v = await c.get<{ aid?: number; cid?: number; owner?: { mid?: number } }>(
    '/x/web-interface/view', { bvid },
  );
  if (!v || typeof v.aid !== 'number' || typeof v.cid !== 'number' || typeof v.owner?.mid !== 'number') {
    return null;
  }
  return { aid: v.aid, cid: v.cid, upMid: v.owner.mid };
}

/** B 站官方 AI 总结。视频没生成过就返回 null。 */
export async function fetchConclusion(
  c: BiliClient,
  bvid: string,
  cid: number,
  upMid: number,
): Promise<ConclusionData | null> {
  return c.getSigned<ConclusionData>('/x/web-interface/view/conclusion/get', {
    bvid, cid, up_mid: upMid,
  });
}

/** 搜索视频（需 WBI 签名）。 */
export async function searchVideos(c: BiliClient, keyword: string): Promise<SearchItem[]> {
  const data = await c.getSigned<{ result?: SearchItem[] }>(
    '/x/web-interface/wbi/search/type',
    { keyword, search_type: 'video' },
  );
  return data?.result ?? [];
}

/**
 * 评论。mode=3 取主楼，mode=2 取楼中楼（需传 parent 作为 root）。
 * 分页用 next 游标，不是页号。
 */
export async function fetchComments(
  c: BiliClient,
  oid: number,
  mode: 3 | 2 = 3,
  parent?: number,
): Promise<CommentItem[]> {
  const params: Record<string, string | number> = { type: 1, oid, mode, ps: 20 };
  if (parent !== undefined) params['root'] = parent;
  const items = await c.getPaged<
    { replies?: CommentItem[]; page?: { has_more?: boolean; cursor?: string } },
    CommentItem
  >('/x/v2/reply/wbi/main', params, (d) => d.replies ?? []);
  return items;
}
