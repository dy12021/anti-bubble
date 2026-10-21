import type { BiliClient } from '../bili/client';
import {
  fetchHistory, fetchFavorites, fetchFavoriteItems, fetchFollowing,
  fetchMySubmissions, fetchLikes, fetchMyMid,
} from '../bili/api';
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

/** 各采集来源的名字（面板上显示用）。 */
export type CollectSource = 'history' | 'favorite' | 'like' | 'following' | 'submission';

export const COLLECT_SOURCE_LABEL: Record<CollectSource, string> = {
  history: '观看历史',
  favorite: '收藏夹',
  like: '点赞',
  following: '关注',
  submission: '我的投稿',
};

/** 采集结果：样本 + 每个来源各采到多少（以及失败原因）。 */
export interface CollectResult {
  samples: UserProfileInput[];
  /** 每个来源采到的条数 */
  counts: Record<CollectSource, number>;
  /** 每个来源的失败原因（没失败就没有这一项） */
  errors: Partial<Record<CollectSource, string>>;
  /** 没登录 / 拿不到自己的 uid */
  loggedIn: boolean;
}

function emptyCounts(): Record<CollectSource, number> {
  return { history: 0, favorite: 0, like: 0, following: 0, submission: 0 };
}

/**
 * 冷启动采样：观看历史 + 收藏夹 + 点赞 + 关注 + 自己的投稿。
 *
 * ## 为什么要分成这么多来源
 *
 * 用户说「系统没有读取我的收藏和点赞」——**收藏夹这一路当时是坏的**：
 * `/x/v3/fav/folder/created/list-all` 必须带 `up_mid`，漏了就返回 -400，
 * 看起来像「没有收藏」，其实是「参数不对」。
 *
 * ## 为什么要逐源隔离
 *
 * 早先是「一个源抛异常 → 整轮采集中断 → 样本 0 条」，
 * 症状是「什么都没读到」，而不是「这个源没读到」。
 * 现在每个源单独 try/catch，并且**分别统计条数**，
 * 面板上直接显示「收藏 42 / 历史 30 / 点赞 ✗」——哪个没通一眼就看出来。
 */
export async function collectColdStart(
  c: BiliClient,
  opts: { includeHistory?: boolean } = {},
): Promise<CollectResult> {
  const includeHistory = opts.includeHistory !== false;
  const samples: UserProfileInput[] = [];
  const counts = emptyCounts();
  const errors: Partial<Record<CollectSource, string>> = {};

  const mid = await safe(() => fetchMyMid(c), 'history');

  // ① 观看历史（**不需要 uid**，所以先采）
  if (includeHistory) {
    const items = await safe(() => fetchHistory(c, COLD_START_MAX_SAMPLES), 'history');
    if (items === null) {
      errors['history'] = '观看历史接口没通';
    } else {
      for (const h of items) {
        // 两种形状：{ history: {...} } 与扁平的 { bvid, title, ... }
        const raw = (h as unknown as { history?: unknown }).history;
        const info = (raw && typeof raw === 'object' ? raw : h) as Record<string, unknown>;
        const bvid = str(info['bvid']);
        if (!bvid) continue;
        samples.push({
          id: bvid,
          title: str(info['title']),
          author: str(info['author_name'] ?? info['author']),
          category: str(info['tname']),
          watchSeconds: 0,
          collectedAt: isoOf(info['viewed_at']),
          origin: 'history',
        });
        counts['history']++;
      }
    }
  }

  // ② 收藏夹 / ③ 点赞 / ④ 关注 / ⑤ 投稿 —— 这些都要自己的 uid
  if (mid === null) {
    // 拿不到 uid → 这几路无从下手，直接说清楚（别让用户以为是「没数据」）
    for (const s of ['favorite', 'like', 'following', 'submission'] as CollectSource[]) {
      errors[s] = '未登录 B 站，或拿不到用户 uid';
    }
    return { samples, counts, errors, loggedIn: false };
  }
  const loggedIn = true;

  // ② 收藏夹
  {
    const folders = await safe(() => fetchFavorites(c, mid), 'favorite');
    if (folders === null) {
      errors['favorite'] = '收藏夹列表接口没通';
    } else {
      for (const f of folders.slice(0, COLD_START_MAX_FOLDERS)) {
        const items = await safe(
          () => fetchFavoriteItems(c, f.id, COLD_START_MAX_PAGES_PER_FOLDER),
          'favorite',
        );
        if (items === null) continue;
        for (const m of items) {
          if (!m.bvid) continue;
          if (samples.length >= COLD_START_MAX_SAMPLES) break;
          samples.push({
            id: m.bvid,
            title: m.title ?? '',
            author: m.upper?.name ?? '',
            category: '',
            watchSeconds: 0,
            collectedAt: m.ctime ? new Date(m.ctime * 1000).toISOString() : new Date().toISOString(),
            origin: 'favorite',
          });
          counts['favorite']++;
        }
        if (samples.length >= COLD_START_MAX_SAMPLES) break;
      }
    }
  }

  // ③ 点赞
  {
    const likes = await safe(() => fetchLikes(c, mid), 'like');
    if (likes === null) {
      errors['like'] = '点赞列表接口没通';
    } else {
      for (const v of likes) {
        if (!v.bvid) continue;
        if (samples.length >= COLD_START_MAX_SAMPLES) break;
        samples.push({
          id: v.bvid,
          title: v.title,
          author: v.author,
          category: '',
          watchSeconds: 0,
          collectedAt: new Date().toISOString(),
          origin: 'like',
        });
        counts['like']++;
      }
    }
  }

  // ④ 关注的 UP 主（他们做什么内容 ≈ 用户的口味）
  {
    const list = await safe(() => fetchFollowing(c, mid, 1), 'following');
    if (list === null) {
      errors['following'] = '关注列表接口没通';
    } else {
      counts['following'] = list.length;
      for (const u of list) {
        const subs = await safe(() => fetchMySubmissions(c, u.mid, 1), 'submission');
        if (!subs) continue;
        for (const v of subs) {
          if (!v.bvid) continue;
          if (samples.length >= COLD_START_MAX_SAMPLES) break;
          samples.push({
            id: v.bvid,
            title: v.title,
            author: v.author || u.name,
            category: v.category,
            watchSeconds: 0,
            collectedAt: new Date().toISOString(),
            origin: 'follow',
          });
          counts['submission']++;
        }
        if (samples.length >= COLD_START_MAX_SAMPLES) break;
      }
    }
  }

  // ⑤ 自己的投稿
  {
    const subs = await safe(() => fetchMySubmissions(c, mid, 1), 'submission');
    if (subs === null) {
      errors['submission'] = '投稿列表接口没通';
    } else {
      for (const v of subs) {
        if (!v.bvid) continue;
        if (samples.length >= COLD_START_MAX_SAMPLES) break;
        samples.push({
          id: v.bvid,
          title: v.title,
          author: v.author,
          category: v.category,
          watchSeconds: 0,
          collectedAt: new Date().toISOString(),
          origin: 'submission',
        });
        counts['submission']++;
      }
    }
  }

  return { samples: samples.slice(0, COLD_START_MAX_SAMPLES), counts, errors, loggedIn };
}

/** 跑一个可能失败的采集步骤：失败记原因、返回 null，不影响别的源。 */
async function safe<T>(
  fn: () => Promise<T>,
  source: CollectSource,
): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[anti-bubble] 采集「${COLLECT_SOURCE_LABEL[source]}」失败：${msg}`);
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 时间戳（秒或毫秒）→ ISO 字符串。 */
function isoOf(v: unknown): string {
  const n = typeof v === 'number' ? v : 0;
  if (!n) return new Date().toISOString();
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
}

/** 增量样本：用户刚看过的视频。 */
export function collectIncremental(
  _c: BiliClient,
  item: ContentItem,
  watchSeconds: number,
): UserProfileInput {
  return toSample(item, watchSeconds, 'history');
}
