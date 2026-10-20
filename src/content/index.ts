import { createPageBridge } from './page-bridge';
import { BiliClient } from '../bili/client';
import { fetchNav, fetchVideo, fetchVideoIdByBvid, fetchConclusion, fetchComments } from '../bili/api';
import { collectColdStart } from '../profile/collect';
import { recallOpposite } from '../recommend/recall';
import { CommentPanel } from './comment-panel';
import type { RecommendItem } from '../actions/recommend';
import { PageController } from './controller';
import { MSG } from '../shared/messages';
import type { Settings } from '../shared/types';
import type { VideoContext } from '../pipeline/types';

/**
 * 注入页面上下文脚本。
 * MV3 不允许 eval/new Function，所以用 web_accessible_resources + <script src>。
 */
function injectPageFetch(): void {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/page-fetch.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch {
    // 注入失败不影响页面，只是请求能力不可用
  }
}

injectPageFetch();

const getJson = createPageBridge({
  addEventListener: (t, h) => window.addEventListener(t, h as EventListener),
  removeEventListener: (t, h) => window.removeEventListener(t, h as EventListener),
  postMessage: (m) => window.postMessage(m, window.location.origin),
});

/** 向 service worker 发消息。 */
function send(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp: unknown) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * 取当前视频的上下文（标题/简介/官方 AI 总结）。
 *
 * 必须在**页面上下文**里取——service worker 发不了 B 站请求（拿不到 SESSDATA）。
 * 任何一步失败都返回 null，不抛。
 */
async function loadVideoContext(bvid: string): Promise<VideoContext | null> {
  try {
    const bili = new BiliClient({ getJson });
    const video = await fetchVideo(bili, bvid);
    if (!video) return null;

    let summary: string | undefined;
    try {
      const ids = await fetchVideoIdByBvid(bili, bvid);
      if (ids) {
        const conclusion = await fetchConclusion(bili, bvid, ids.cid, ids.upMid);
        const text = conclusion?.model_result;
        if (typeof text === 'string' && text.length > 0) {
          summary = text.slice(0, 2000);
        }
      }
    } catch {
      // AI 总结拿不到不影响主流程
    }

    return {
      bvid,
      title: video.title ?? '',
      description: video.description ? video.description.slice(0, 2000) : undefined,
      summary,
    };
  } catch {
    return null;
  }
}

/** 从 URL 里取当前视频的 bvid。 */
function currentBvid(): string | null {
  const m = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return m ? m[1]! : null;
}

/**
 * 冷启动：拉取观看历史/收藏夹，转换成样本后交给后台归纳。
 *
 * 必须在这里做——采集需要 B 站登录态，只有页面上下文能拿到 Cookie。
 * 后台（service worker）发不了 B 站请求。
 *
 * 已经有画像时跳过，避免每次打开页面都拉一遍。
 */
async function coldStartIfNeeded(settings: Settings | null): Promise<void> {
  if (!settings) return;
  if (!settings.collectHistory) return;
  if (!settings.masterEnabled) return;

  const resp = (await send({ type: MSG.GET_PROFILE, id: 'cold' })) as {
    ok?: boolean; data?: { updatedAt?: string; sampleCount?: number } | null;
  } | null;
  const profile = resp?.ok ? resp.data : null;
  if (profile && (profile.sampleCount ?? 0) > 0) return;

  try {
    const bili = new BiliClient({ getJson });
    const samples = await collectColdStart(bili, { includeHistory: settings.collectHistory });
    if (samples.length === 0) return;
    await send({
      type: MSG.SYNC_PROFILE_SAMPLES,
      id: 'cold-sync',
      payload: { samples },
    });
  } catch {
    // 采集失败不该影响浏览
  }
}

/**
 * 反向推荐：三步走。
 *
 * 1. 向后台要动态词表（里面有立场摘要 + 对立检索词）
 * 2. **在页面上下文**用检索词搜 B 站（后台拿不到 cookie，搜不了）
 * 3. 把候选交给后台做 LLM 立场判定，拿回结果渲染
 *
 * 任何一步失败都静默放弃——推荐是锦上添花，不该影响主流程。
 */
async function fetchOppositeRecommendations(
  video: VideoContext | null,
  settings: Settings | null,
): Promise<RecommendItem[]> {
  if (!video || !settings) return [];
  if (settings.mode !== 'anti') return [];

  // ① 要词表
  const wlResp = (await send({
    type: MSG.GET_WORDLIST, id: 'wl',
    payload: { video, mode: settings.mode },
  })) as { ok?: boolean; data?: { oppositeKeywords?: string[] } } | null;

  const keywords = wlResp?.ok ? (wlResp.data?.oppositeKeywords ?? []) : [];
  if (keywords.length === 0) return [];

  // ② 在页面上下文搜 B 站
  try {
    const bili = new BiliClient({ getJson });
    const candidates = await recallOpposite(bili, keywords);
    if (candidates.length === 0) return [];

    // ③ 交给后台判立场
    const judgeResp = (await send({
      type: MSG.GET_RECOMMENDATIONS, id: 'rec',
      payload: { video, candidates },
    })) as { ok?: boolean; data?: { items?: RecommendItem[] } } | null;

    return judgeResp?.ok ? (judgeResp.data?.items ?? []) : [];
  } catch {
    return [];
  }
}

/**
 * 视频页挂载自有评论区。
 *
 * B 站原生评论在 closed shadow root 里，DOM 够不着；
 * 所以自己用 API 取、自己渲染，折叠/标识/撤销都在自己的 DOM 里做。
 */
async function mountCommentPanel(
  video: VideoContext,
  settings: Settings | null,
  send: (msg: unknown) => Promise<unknown>,
  ctrl: PageController,
): Promise<void> {
  if (!settings || !settings.enabledPages['video']) return;

  const bili = new BiliClient({ getJson });
  const ids = await fetchVideoIdByBvid(bili, video.bvid);
  if (!ids) return;

  const anchor =
    document.getElementById('commentapp') ??
    document.querySelector('.bili-video-info-container') ??
    document.querySelector('#viewbox_report') ??
    document.body?.firstElementChild;
  if (!anchor) return;

  const panel = new CommentPanel({
    root: document,
    aid: ids.aid,
    fetchComments: (oid, mode, parent) => fetchComments(bili, oid, mode, parent),
    send,
    settings,
    videoTitle: video.title,
    video,
    onRevoke: (id) => {
      void send({ type: MSG.REVOKE, id: 'revoke', payload: { itemId: id } });
    },
  });
  panel.mount(anchor);
  void ctrl;
}

async function main(): Promise<void> {
  const resp = (await send({
    type: MSG.GET_SETTINGS, id: 'init',
  })) as { ok?: boolean; data?: Settings } | null;

  const settings = resp?.ok && resp.data ? resp.data : null;

  // 冷启动采集放后台跑，不阻塞首次渲染
  void coldStartIfNeeded(settings);

  // 视频上下文要在发判定请求前拿到（后台拿不到 B 站 cookie）
  const bvid = currentBvid();
  const video = bvid ? await loadVideoContext(bvid) : null;

  const ctrl = new PageController({
    url: location.href,
    send,
    settings,
    video,
    onRevoke: (id) => {
      void send({ type: MSG.REVOKE, id: 'revoke', payload: { itemId: id } });
    },
  });

  await ctrl.start();

  // 视频页：原生评论区在 closed shadow root 里读不到，
  // 改用 API 取评论 + 自渲染面板（见 comment-panel.ts 的说明）。
  if (video) {
    void mountCommentPanel(video, settings, send, ctrl);
  }

  // 反向推荐：插在视频标题后面
  if (video) {
    void fetchOppositeRecommendations(video, settings).then((items) => {
      if (items.length === 0) return;
      const anchor =
        document.querySelector('.video-title') ??
        document.querySelector('h1') ??
        document.body?.firstElementChild;
      if (anchor) ctrl.showRecommendations(anchor, items);
    });
  }

  // 调试用：验证登录态与页面桥
  const bili = new BiliClient({ getJson });
  void bili.isLoggedIn().then((loggedIn) => {
    if (loggedIn) {
      console.info('[anti-bubble] 已登录 B 站，冷启动画像可用');
    } else {
      // 未登录时插件仍能工作（搜索/评论是公开的），
      // 但冷启动画像（观看历史/收藏夹/关注）拿不到数据——要说清楚，别让用户干瞪眼。
      console.warn(
        '[anti-bubble] 未登录 B 站：搜索与评论过滤仍可用，但冷启动画像（观看历史/收藏夹）取不到数据。登录后刷新即可。',
      );
    }
  });

  // 诊断：直接用桥打 nav，把**原始信封**打出来。
  // BiliClient.get() 遇到 code !== 0 会返回 null，光看结果分不清
  // 「页面桥断了（拿不到东西）」和「拿到了但确实没登录（code=-101）」。
  void getJson('https://api.bilibili.com/x/web-interface/nav').then((raw) => {
    const env = raw as
      | { code?: number; message?: string; data?: { isLogin?: boolean; uname?: string } }
      | null;
    if (env && typeof env.code === 'number') {
      console.info(
        `[anti-bubble] nav 原始信封 code=${env.code} msg=${env.message ?? '-'} ` +
          `isLogin=${env.data?.isLogin ?? '?'} uname=${env.data?.uname ?? '-'}`,
      );
    } else {
      console.warn('[anti-bubble] nav 拿不到——页面桥可能没通（检查 content/page-fetch.js 是否注入成功）');
    }
  });
}

void main();
