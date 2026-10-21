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
 *
 * ## 两条踩过的坑
 *
 * 1. **必填参数不能漏**：`/x/v3/fav/folder/created/list-all` 必须带 `up_mid`，
 *    `/x/relation/followings` 必须带 `vmid`，
 *    `/x/v3/fav/resource/list` 的收藏夹 id 参数叫 `media_id`（不叫 `fid`）。
 *    漏了会返回 `code=-400`（请求错误），看起来像「没数据」，其实是「参数不对」。
 * 2. **返回形状会变**：同一个接口新版把 `data.list` 从数组换成了
 *    `data.list.vlist`（对象）。解析时**必须两种形状都兼容**，
 *    否则 `push(...非数组)` 会抛异常，把整轮采集打断——
 *    症状是「样本 0 条」，而不是「这个源没取到」。
 */

/** 登录态 + WBI 密钥来源。 */
export async function fetchNav(c: BiliClient): Promise<NavData | null> {
  return c.get<NavData>('/x/web-interface/nav');
}

/** 自己的 uid。没登录返回 null。 */
export async function fetchMyMid(c: BiliClient): Promise<number | null> {
  const nav = await fetchNav(c);
  const mid = nav?.mid;
  return typeof mid === 'number' && mid > 0 ? mid : null;
}

/**
 * 观看历史。
 *
 * 不做 WBI 签名（这个接口不是签名接口），返回形状两种都兼容。
 * 路径也有两个版本，挨个试（第一个有数据就用它）。
 */
export async function fetchHistory(c: BiliClient, maxItems = 1000): Promise<HistoryItem[]> {
  for (const path of ['/x/v2/history/cursor', '/x/web-interface/history/cursor']) {
    const items = await fetchHistoryFrom(c, path, maxItems);
    if (items.length > 0) {
      console.info(`[anti-bubble] 观看历史接口：${path}`);
      return items;
    }
  }
  return [];
}

async function fetchHistoryFrom(
  c: BiliClient,
  path: string,
  maxItems: number,
): Promise<HistoryItem[]> {
  const out: HistoryItem[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20 && out.length < maxItems; i++) {
    const params: Record<string, string | number> = { type: 'all', ps: 30 };
    if (cursor) params['cursor'] = cursor;
    const data = await c.get<{
      list?: unknown;
      page?: { has_more?: boolean; cursor?: string };
    }>(path, params);
    const list = extractHistoryList(data);
    if (list.length === 0) break;
    out.push(...list);
    const page = data?.page;
    if (!page?.has_more || !page.cursor) break;
    cursor = page.cursor;
  }
  return out.slice(0, maxItems);
}

/** 历史条目的两种形状：新版是数组，旧版是 { vlist: [...] }。 */
function extractHistoryList(data: unknown): HistoryItem[] {
  const list = (data as { list?: unknown } | null)?.list;
  if (Array.isArray(list)) return list as HistoryItem[];
  const vlist = (list as { vlist?: unknown } | undefined)?.vlist;
  return Array.isArray(vlist) ? (vlist as HistoryItem[]) : [];
}

/**
 * 收藏夹列表。**必须带 `up_mid`**（自己的 uid），否则 B 站返回 -400。
 */
export async function fetchFavorites(
  c: BiliClient,
  mid: number,
): Promise<FavoriteFolder[]> {
  const data = await c.get<{ list?: FavoriteFolder[] }>(
    '/x/v3/fav/folder/created/list-all',
    { up_mid: mid },
  );
  return data?.list ?? [];
}

/**
 * 某个收藏夹的内容。
 *
 * 收藏夹 id 的参数名是 **`media_id`**（不叫 fid），ps 上限 40。
 */
export async function fetchFavoriteItems(
  c: BiliClient,
  fid: number,
  maxPages = 2,
): Promise<FavoriteItem[]> {
  const out: FavoriteItem[] = [];
  for (let pn = 1; pn <= maxPages; pn++) {
    const data = await c.get<{ medias?: FavoriteItem[] }>('/x/v3/fav/resource/list', {
      media_id: fid, pn, ps: 40, order: 'mtime', type: 0, tid: 0, platform: 'web',
    });
    const items = data?.medias ?? [];
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < 40) break;
  }
  return out;
}

/**
 * 关注列表。**必须带 `vmid`**（自己的 uid），否则 B 站返回 -400。
 */
export async function fetchFollowing(
  c: BiliClient,
  mid: number,
  maxPages = 2,
): Promise<{ mid: number; name: string }[]> {
  const out: { mid: number; name: string }[] = [];
  for (let pn = 1; pn <= maxPages; pn++) {
    const data = await c.get<{ list?: { mid: number; uname: string }[] }>(
      '/x/relation/followings',
      { vmid: mid, pn, ps: 50, order: 'desc', order_type: 'attention' },
    );
    const list = data?.list ?? [];
    if (list.length === 0) break;
    out.push(...list.map((u) => ({ mid: u.mid, name: u.uname })));
    if (list.length < 50) break;
  }
  return out;
}

/**
 * 自己的投稿视频（`/x/space/arc/search`）。
 *
 * 「你看什么」之外，「你做什么」也是偏好的一部分——尤其是知识区。
 */
export async function fetchMySubmissions(
  c: BiliClient,
  mid: number,
  maxPages = 1,
): Promise<{ bvid: string; title: string; author: string; category: string }[]> {
  const out: { bvid: string; title: string; author: string; category: string }[] = [];
  for (let pn = 1; pn <= maxPages; pn++) {
    const data = await c.get<{
      list?: { vlist?: { bvid?: string; title?: string; author?: string; tname?: string }[] };
    }>('/x/space/arc/search', {
      mid, pn, ps: 30, tid: 0, order: 'pubdate', keyword: '',
    });
    const vlist = data?.list?.vlist ?? [];
    if (vlist.length === 0) break;
    for (const v of vlist) {
      if (!v.bvid) continue;
      out.push({
        bvid: v.bvid,
        title: v.title ?? '',
        author: v.author ?? '',
        category: v.tname ?? '',
      });
    }
    if (vlist.length < 30) break;
  }
  return out;
}

/**
 * 点赞过的视频。
 *
 * B 站这个列表换过好几版接口，而且**没有公开文档**，
 * 所以按候选顺序试，谁通用谁。
 * 全部不通就返回空数组——收藏/历史/关注/投稿已经够画像用了，
 * 点赞拿不到不该拖垮整轮采集。
 */
const LIKE_ENDPOINTS = [
  '/x/v3/dynamic/feed/like',
  '/x/space/arc/like',
  '/x/space/like/arc',
] as const;

export async function fetchLikes(
  c: BiliClient,
  mid: number,
): Promise<{ bvid: string; title: string; author: string }[]> {
  for (const path of LIKE_ENDPOINTS) {
    const data = await c.get<{
      list?: unknown;
      data?: { list?: unknown };
      items?: unknown;
    }>(path, { host_mid: mid, mid, pn: 1, ps: 30, order: 'click' });
    const items = extractVideoList(data);
    if (items.length > 0) {
      console.info(`[anti-bubble] 点赞列表接口：${path}`);
      return items;
    }
  }
  console.warn('[anti-bubble] 点赞列表接口都没通（不影响其它采集来源）');
  return [];
}

/** 从各种可能的返回形状里挖出视频列表。 */
function extractVideoList(data: unknown): { bvid: string; title: string; author: string }[] {
  const out: { bvid: string; title: string; author: string }[] = [];
  const push = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const r = raw as Record<string, unknown>;
    const bvid = typeof r['bvid'] === 'string' ? r['bvid'] : '';
    if (!bvid) return;
    out.push({
      bvid,
      title: typeof r['title'] === 'string' ? r['title'] : '',
      author: typeof r['author'] === 'string' ? r['author'] : '',
    });
  };
  const candidates: unknown[] = [
    (data as { list?: unknown } | null)?.list,
    (data as { list?: { vlist?: unknown } } | null)?.list?.vlist,
    (data as { items?: unknown } | null)?.items,
    (data as { data?: { list?: unknown } } | null)?.data?.list,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const item of c) push(item);
      if (out.length) return out;
    }
  }
  return out;
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

/**
 * 剥掉 B 站搜索接口返回的**高亮标记**。
 *
 * 搜索接口的 `title` 不是纯文本：命中的关键词会被包成
 * `<em class="keyword">人类</em>`。不处理的话：
 * - 反向推荐卡片会把 `<em class="keyword">` 原样显示给用户；
 * - 立场比对 prompt 里也会带上这些标签，模型读到的标题是脏的。
 *
 * 用正则剥（不是 innerHTML）：返回值要能安全地进 textContent。
 */
export function stripHighlight(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCharCode(Number(d)))
    .trim();
}

/** 搜索视频（需 WBI 签名）。 */
export async function searchVideos(c: BiliClient, keyword: string): Promise<SearchItem[]> {
  const data = await c.getSigned<{ result?: SearchItem[] }>(
    '/x/web-interface/wbi/search/type',
    { keyword, search_type: 'video' },
  );
  const list = data?.result ?? [];
  return list.map((it) => ({
    ...it,
    title: stripHighlight(it.title ?? ''),
    author: stripHighlight(it.author ?? ''),
  }));
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
