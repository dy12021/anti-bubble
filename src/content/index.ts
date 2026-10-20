import { createPageBridge } from './page-bridge';
import { BiliClient } from '../bili/client';
import { fetchVideo, fetchConclusion, fetchComments } from '../bili/api';
import { collectColdStart } from '../profile/collect';
import { recallOpposite } from '../recommend/recall';
import { CommentPanel } from './comment-panel';
import type { RecommendItem } from '../actions/recommend';
import { resolveRecommendationAnchor, renderNoOpposition } from '../actions/recommend';
import { PageController } from './controller';
import { WatchTracker, videoProgressSeconds } from './watch';
import { videoSubject } from '../pipeline/subject';
import { MSG } from '../shared/messages';
import type { Settings, ContentItem } from '../shared/types';
import type { VideoContext } from '../pipeline/types';
import { ANTI_TRIGGER_WATCH_SECONDS, WATCH_SAMPLE_SECONDS } from '../shared/constants';

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

/**
 * **全页面共享一个 BiliClient**。
 *
 * BiliClient 内部有节流（B 站风控阈值：连续 5-8 次/分钟就拦），
 * 但节流状态是**实例级**的。如果各处各自 new 一个，
 * 它们的请求就互相不避让，等于没有限流——冷启动采集和视频上下文
 * 并发时就会撞 -352，然后重试退避，表现为「视频页评论区面板一直不出现」。
 *
 * 所以这里建一个模块级单例，全页面共用。
 */
const bili = new BiliClient({ getJson });

/** 向 service worker 发消息。 */
function send(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp: unknown) => {
        const err = chrome.runtime.lastError;
        // lastError 必须读（读了才不会在控制台报 "Unchecked runtime.lastError"），
        // 但也要打出来——「Extension context invalidated」这类错误
        // 不打出来就完全看不到，只会表现为「插件没反应」。
        if (err) {
          console.warn('[anti-bubble] 消息失败：', err.message, 'type=', (msg as { type?: string })?.type);
        }
        resolve(resp);
      });
    } catch (e) {
      console.warn('[anti-bubble] 消息抛出异常：', e);
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
    // 一次 view 接口同时拿标题/简介和 aid/cid/upMid —— 少打一次，省一次限流等待
    const video = await fetchVideo(bili, bvid);
    if (!video) return domVideoContext(bvid);

    let summary: string | undefined;
    const cid = (video as { cid?: number }).cid;
    const upMid = (video as { owner?: { mid?: number } }).owner?.mid;
    if (typeof cid === 'number' && typeof upMid === 'number') {
      try {
        const conclusion = await fetchConclusion(bili, bvid, cid, upMid);
        const text = conclusion?.model_result;
        if (typeof text === 'string' && text.length > 0) {
          summary = text.slice(0, 2000);
        }
      } catch {
        // AI 总结拿不到不影响主流程
      }
    }

    return {
      bvid,
      title: video.title ?? '',
      description: video.description ? video.description.slice(0, 2000) : undefined,
      summary,
      aid: typeof video.aid === 'number' ? video.aid : undefined,
      // 画像样本要用 UP 主与分区
      author: video.author ?? undefined,
      category: video.tname ?? undefined,
    };
  } catch {
    return domVideoContext(bvid);
  }
}

/**
 * API 拿不到视频信息时的兜底：直接从 DOM 读。
 *
 * 视频标题就摆在页面上（`.video-title`）。拿不到简介和 AI 总结没关系——
 * **有标题就够生成词表了**，总比「没有语境 → 全部放行」强。
 * 之前这里是直接返回 null，于是 API 一抖（风控/未登录）整页评论就都不判了。
 *
 * 顺带把 UP 主和标签也读出来：画像样本要靠它们做分区粗判。
 */
function domVideoContext(bvid: string): VideoContext | null {
  try {
    const title = (document.querySelector('.video-title')?.textContent ?? '').trim();
    if (!title) return null;
    const author = (document.querySelector('.up-name')?.textContent ?? '').trim();
    // 页面上的标签（人类/科幻/人工智能…）比分区更细，做画像粗判够用
    const tags = Array.from(document.querySelectorAll('.tag'))
      .map((t) => (t.textContent ?? '').trim())
      .filter((t) => t.length > 0 && t.length < 12)
      .slice(0, 3);
    return {
      bvid,
      title,
      ...(author ? { author } : {}),
      ...(tags.length ? { category: tags.join('、') } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 视频页的观看时长追踪：驱动两件事。
 *
 * 1. **增量画像**：看够 WATCH_SAMPLE_SECONDS 秒就记一条样本，
 *    画像跟着浏览行为长（不是只有冷启动那一次）。
 * 2. **反向推荐的触发**：看够 ANTI_TRIGGER_WATCH_SECONDS 秒才推相反观点。
 */
function startWatchTracking(
  video: VideoContext,
  settings: Settings | null,
  ctrl: PageController,
): void {
  if (!settings) return;

  /** 把这个视频作为一条内容单元，供画像取样。 */
  const item: ContentItem = {
    kind: 'video',
    id: video.bvid,
    text: video.title,
    author: video.author ?? '',
    meta: { category: video.category ?? '' },
    context: { page: 'video', videoId: video.bvid, videoTitle: video.title },
  };

  let recorded = false;
  let warnedNoVideo = false;
  console.info(
    `[anti-bubble] 开始追踪观看时长（阈值 ${
      settings.antiTriggerSeconds ?? ANTI_TRIGGER_WATCH_SECONDS
    } 秒）`,
  );

  const record = (seconds: number): void => {
    if (recorded) return;
    if (seconds < WATCH_SAMPLE_SECONDS) return;
    recorded = true;
    void send({
      type: MSG.RECORD_WATCH,
      id: 'watch',
      payload: { item, watchSeconds: seconds },
    });
  };

  const tracker = new WatchTracker({
    // 阈值可配：默认 60 秒（设计文档的 ANTI_TRIGGER_WATCH_SECONDS）。
    thresholdSeconds: Math.max(
      5,
      settings.antiTriggerSeconds ?? ANTI_TRIGGER_WATCH_SECONDS,
    ),
    // 用视频的实际播放进度当「观看时长」——比「页面可见了多少秒」准：
    // 暂停了、或者只是挂在后台，就不该算在看这个视频。
    readWatchSeconds: () => {
      const s = videoProgressSeconds(document);
      if (s === null && !warnedNoVideo) {
        warnedNoVideo = true;
        console.warn(
          '[anti-bubble] 页面里没有正在播放的视频，观看时长无法计算（反向推荐不会触发）',
        );
      }
      return s;
    },
    onSecond: (seconds) => record(seconds),
    onHidden: (seconds) => record(seconds),
    onThreshold: (seconds) => {
      console.info(`[anti-bubble] 已观看 ${seconds} 秒，开始找相反观点`);
      void fetchOppositeRecommendations(video, settings).then(({ items, recalled }) => {
        const anchor = resolveRecommendationAnchor(document);
        if (!anchor) return;
        if (items.length > 0) {
          ctrl.showRecommendations(anchor, items);
        } else if (recalled) {
          // 召回到了候选但没选出相反观点：说一句，别让用户以为插件坏了
          renderNoOpposition(document, anchor);
        }
      });
    },
  });
  tracker.start();
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
 *
 * **延迟启动**：冷启动请求量大，而限流器是全页面共享的，
 * 早启动会把主流程（取视频上下文、拉评论）堵在后面。
 * 所以先让主流程跑完，再开始采集。
 */
const COLD_START_DELAY_MS = 5000;

async function coldStartIfNeeded(settings: Settings | null): Promise<void> {
  if (!settings) return;
  if (!settings.collectHistory) return;
  if (!settings.masterEnabled) return;

  const resp = (await send({ type: MSG.GET_PROFILE, id: 'cold' })) as {
    ok?: boolean; data?: { updatedAt?: string; sampleCount?: number } | null;
  } | null;
  const profile = resp?.ok ? resp.data : null;
  if (profile && (profile.sampleCount ?? 0) > 0) return;

  await new Promise((r) => setTimeout(r, COLD_START_DELAY_MS));

  try {
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
 *
 * 返回 `recalled` 是为了区分两种「没结果」：
 * - 没召回到候选（被风控/搜不了）→ 什么都不显示
 * - 召回到了但精判没选出相反观点 → 显示一句「没找到」
 * 不区分的话，用户只看到「插件没反应」。
 */
async function fetchOppositeRecommendations(
  video: VideoContext | null,
  settings: Settings | null,
): Promise<{ items: RecommendItem[]; recalled: boolean }> {
  if (!video || !settings) return { items: [], recalled: false };
  if (settings.mode !== 'anti') return { items: [], recalled: false };

  // ① 要词表
  const wlResp = (await send({
    type: MSG.GET_WORDLIST, id: 'wl',
    payload: { subject: videoSubject(video), mode: settings.mode },
  })) as { ok?: boolean; data?: { oppositeKeywords?: string[] } } | null;

  const keywords = wlResp?.ok ? (wlResp.data?.oppositeKeywords ?? []) : [];
  if (keywords.length === 0) {
    console.info('[anti-bubble] 反向推荐：词表里没有对立检索词（这个视频可能没有明确立场）');
    return { items: [], recalled: false };
  }

  // ② 在页面上下文搜 B 站
  try {
    const candidates = await recallOpposite(bili, keywords);
    if (candidates.length === 0) {
      console.warn('[anti-bubble] 反向推荐：没召回到候选视频（可能被 B 站风控了）');
      return { items: [], recalled: false };
    }

    // ③ 交给后台判立场
    console.info(
      `[anti-bubble] 反向推荐：候选 ${candidates.length} 条 → ` +
        candidates.slice(0, 6).map((c, i) => `${i + 1}.${c.title.slice(0, 24)}`).join(' / '),
    );
    const judgeResp = (await send({
      type: MSG.GET_RECOMMENDATIONS, id: 'rec',
      payload: { video, candidates },
    })) as { ok?: boolean; data?: { items?: RecommendItem[] } } | null;

    const items = judgeResp?.ok ? (judgeResp.data?.items ?? []) : [];
    if (items.length === 0) {
      console.info(
        `[anti-bubble] 反向推荐：召回到 ${candidates.length} 条候选，但没选出明确的相反观点`,
      );
    }
    return { items, recalled: true };
  } catch {
    return { items: [], recalled: false };
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
  // aid 已经在 loadVideoContext 里从 view 接口拿到了，不必再打一次
  const aid = video.aid;
  if (typeof aid !== 'number') return;

  const anchor =
    document.getElementById('commentapp') ??
    document.querySelector('.bili-video-info-container') ??
    document.querySelector('#viewbox_report') ??
    document.body?.firstElementChild;
  if (!anchor) return;

  const panel = new CommentPanel({
    root: document,
    aid,
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

  // 视频上下文要在发判定请求前拿到（后台拿不到 B 站 cookie）。
  // **先做这个**——冷启动采集请求量大（限流器是共享的），
  // 放在前面会把视频上下文堵在后面，表现为「评论区面板迟迟不出现」。
  const bvid = currentBvid();
  const video = bvid ? await loadVideoContext(bvid) : null;

  // 冷启动采集放后台跑，不阻塞首次渲染与评论面板
  void coldStartIfNeeded(settings);

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

  // 反向推荐：**看够一段时间才推**。
  //
  // 设计原话是「打开一个表达观点的视频**一段时间后**，自动推荐表达相反观点的视频」。
  // 一进页面就推，那就成了「换个姿势的推荐流」——用户正想看这个，
  // 你立刻塞一堆相反的过去，既打断体验也谈不上打破茧房。
  // 阈值 ANTI_TRIGGER_WATCH_SECONDS = 60 秒。
  if (video) {
    startWatchTracking(video, settings, ctrl);
  }

  // 调试用：验证登录态与页面桥
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
