import { createPageBridge } from './page-bridge';
import { BiliClient } from '../bili/client';
import { fetchNav, fetchVideo, fetchVideoIdByBvid, fetchConclusion } from '../bili/api';
import { collectColdStart } from '../profile/collect';
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

  // 调试用：验证登录态与页面桥
  const bili = new BiliClient({ getJson });
  void fetchNav(bili).then((nav) => {
    if (nav) {
      console.info('[anti-bubble] nav ok, login=', nav.isLogin, 'uname=', nav.uname);
    } else {
      console.warn('[anti-bubble] nav 获取失败（可能未登录或被风控）');
    }
  });
}

void main();
