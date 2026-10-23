/**
 * 真机验证：本次新增的两条功能。
 *
 *   ① 撤销屏蔽时的「我喜欢这类」：折叠条上多一个按钮，
 *      点了之后画像里的「不喜欢」标签被去掉、题材被加进兴趣。
 *   ② 判定档位开关：全部 LLM / 关键词初筛 / 仅关键词，
 *      切档要真的生效（设置落库 + 判定行为变化）。
 *
 * 关键前提：
 * - **「仅关键词」档不需要配 API Key**。所以整条验证不依赖 LLM，
 *   判据是「画像里的不喜欢标签」+ 内置关键词库。
 * - 每轮验证都用**全新的 profile 目录**（见 launch-browser.ps1 的说明：
 *   Chrome 会缓存扩展的 service worker 脚本，旧代码会被继续服务）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-features.ts
 */
export {};

import { resolve } from 'node:path';

const HOST = process.env.CDP_HOST ?? '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';

/** 扩展目录：Extensions.loadUnpacked 只接受绝对路径。 */
const DIST = resolve(process.env.EXT_DIST ?? 'dist');

interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function httpJson(path: string): Promise<any> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  return res.json();
}

async function listTargets(): Promise<Target[]> {
  return (await httpJson('/json/list')) as Target[];
}

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  consoleEvents: any[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.consoleEvents.push(msg.params);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleEvents.push({ source: 'exception', ...msg.params.exceptionDetails });
      }
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    // **连接必须自带超时**：实测 Edge 上某个目标的调试 WebSocket
    // 既不触发 open 也不触发 error，await 会永远挂着
    //（连外层看门狗都不会触发，事件循环被同步阻塞）。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* 已经关了就算了 */ }
        reject(new Error('WebSocket 连接超时'));
      }, 10000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('ws error')); }, { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

/* ----------------------------- 结果汇总 ----------------------------- */

const results: { name: string; ok: boolean; detail: string }[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- 主流程 ----------------------------- */

/** 当前扩展的 id（加载后确定）。 */
let currentExtId: string | null = null;

/** 在 service worker 里执行代码（拿得到 chrome.* API）。 */
async function evalInSw<T>(expr: string, extId?: string): Promise<T> {
  const targets = await listTargets();
  const id = extId ?? currentExtId ?? '';
  // **必须按扩展 id 精确定位**：机器上可能还挂着别的扩展的 service worker，
  // 取「第一个 service_worker」会打到别人身上（症状：chrome.storage 是 undefined）。
  const sw =
    targets.find((t) => t.type === 'service_worker' && t.url.includes(`chrome-extension://${id}/`)) ??
    targets.find((t) => t.type === 'service_worker');
  if (!sw) throw new Error('找不到 service worker 目标');
  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  try {
    return (await cdp.eval(expr)) as T;
  } finally {
    cdp.close();
  }
}

/** 在某个页面里执行代码。 */
async function evalInPage<T>(pageId: string, expr: string): Promise<T> {
  const targets = await listTargets();
  const page = targets.find((t) => t.id === pageId);
  if (!page) throw new Error('找不到页面 ' + pageId);
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  try {
    return (await cdp.eval(expr)) as T;
  } finally {
    cdp.close();
  }
}

async function main(): Promise<void> {
  // ---------- 1. 加载扩展 ----------
  //
  // **扩展 id 必须用 loadUnpacked 的返回值**：机器上还挂着别的扩展
  // （组件扩展等），从目标列表里猜会打到别人身上——
  // 症状是 SW 里 chrome.storage 是 undefined。
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  let extId = '';
  try {
    const res = await browser.send('Extensions.loadUnpacked', { path: DIST });
    extId = String(res?.id ?? '');
  } catch (e) {
    throw new Error('加载扩展失败：' + (e instanceof Error ? e.message : String(e)));
  } finally {
    browser.close();
  }
  await sleep(1500);
  if (!extId) throw new Error('加载扩展没有返回 id');
  currentExtId = extId;
  console.log('扩展 id:', extId, '\n');

  // ---------- 2. 预置设置与画像 ----------
  //
  // 「仅关键词」档 + 画像里有一条「不喜欢：咖啡」。
  // 这样搜索页里标题带「咖啡」的视频会被本地规则折叠，
  // 且判定带 matchedTag（折叠条上才有「我喜欢这类」按钮）。
  const DISLIKE = '咖啡';
  await evalInSw(`(async () => {
    const now = new Date().toISOString();
    await chrome.storage.local.set({
      settings: {
        mode: 'cocoon',
        enabledPages: { search: true, video: true, feed: true, unknown: false },
        masterEnabled: true,
        collectHistory: false,
        confidenceThreshold: 0.7,
        antiTriggerSeconds: 60,
        judgeLevel: 'keyword',
      },
      profile: {
        interests: [{ tag: '技术', weight: 0.8 }],
        dislikes: ['${DISLIKE}'],
        stanceHints: {},
        topics: ['Rust'],
        updatedAt: now,
        sampleCount: 10,
      },
      whitelist: [],
      verdictCache: {},
      blockedLog: [],
    });
    return true;
  })()`);
  console.log('已预置：档位=仅关键词，画像不喜欢=[' + DISLIKE + ']\n');

  // ---------- 3. 打开搜索页 ----------
  const pageId = await (async () => {
    const v = await httpJson('/json/version');
    const cdp = await Cdp.connect(v.webSocketDebuggerUrl);
    try {
      const r = await cdp.send('Target.createTarget', {
        url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(DISLIKE),
      });
      return r.targetId as string;
    } finally {
      cdp.close();
    }
  })();
  console.log('搜索页已开，等待判定…');

  // 等折叠条出现（B 站搜索页是 JS 渲染的，要等一会儿）
  let noticeCount = 0;
  let likeCount = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const dom = await evalInPage<any>(pageId, `JSON.stringify({
      notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
      likes: document.querySelectorAll('[data-ab-prefix="ab-like"]').length,
      cards: document.querySelectorAll('.bili-video-card').length,
    })`);
    const s = JSON.parse(String(dom));
    noticeCount = s.notices;
    likeCount = s.likes;
    if (noticeCount > 0) break;
  }
  check(
    '搜索页出现折叠条（仅关键词档，无需 LLM 也能判）',
    noticeCount > 0,
    `折叠条 ${noticeCount} 个，搜索卡片 ${await evalInPage<number>(pageId, `document.querySelectorAll('.bili-video-card').length`)} 张`,
  );
  check(
    '折叠条上有「我喜欢这类」按钮（画像判定才给）',
    likeCount > 0,
    `「我喜欢这类」${likeCount} 个`,
  );

  if (likeCount === 0) {
    console.log('\n没有「我喜欢这类」按钮，后面的断言先跳过。');
    await report();
    return;
  }

  // 记下折叠条上的文案，确认是人话理由
  const noticeText = await evalInPage<string>(pageId, `(() => {
    const n = document.querySelector('[data-ab-prefix="ab-notice"]');
    return n ? n.textContent : '';
  })()`);
  check(
    '折叠条文案是人话理由',
    String(noticeText).includes(DISLIKE),
    String(noticeText).slice(0, 60),
  );

  // ---------- 4. 点「我喜欢这类」，看画像有没有真的变 ----------
  const noticesBefore = await evalInPage<number>(
    pageId,
    `document.querySelectorAll('[data-ab-prefix="ab-notice"]').length`,
  );
  await evalInPage(pageId, `(() => {
    const b = document.querySelector('[data-ab-prefix="ab-like"]');
    if (b) b.click();
    return true;
  })()`);

  let profile: any = null;
  let overrides: any = null;
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    profile = await evalInSw<any>(`(async () => {
      const r = await chrome.storage.local.get(['profile', 'whitelist', 'profileOverrides']);
      return JSON.stringify({
        profile: r.profile ?? null,
        whitelist: r.whitelist ?? [],
        overrides: r.profileOverrides ?? null,
      });
    })()`);
    profile = JSON.parse(String(profile));
    overrides = profile.overrides;
    if (!profile.profile?.dislikes?.includes(DISLIKE)) break;
  }

  check(
    '点完「我喜欢这类」，画像里的「不喜欢」标签被去掉',
    !profile.profile.dislikes.includes(DISLIKE),
    `dislikes=${JSON.stringify(profile.profile.dislikes)}`,
  );
  const interestTags = (profile.profile.interests ?? []).map((i: any) => i.tag);
  check(
    '题材被加进「感兴趣」（且不是「合集」这种栏目标记）',
    interestTags.length > 1 &&
      interestTags.every((t: string) => !['合集', '记录', '教程', '合集篇'].includes(t)),
    `interests=${JSON.stringify(interestTags)}`,
  );
  check(
    '手动纠正被单独记下来（自动归纳不会覆盖它）',
    !!overrides &&
      Array.isArray(overrides.removedDislikes) &&
      overrides.removedDislikes.includes(DISLIKE),
    `overrides=${JSON.stringify(overrides)}`,
  );
  check(
    '这条内容进了白名单（之后不再判它）',
    Array.isArray(profile.whitelist) && profile.whitelist.length === 1,
    `whitelist=${JSON.stringify(profile.whitelist)}`,
  );

  // 被点的那一条要恢复显示：折叠条少一个
  const noticesAfter = await evalInPage<number>(
    pageId,
    `document.querySelectorAll('[data-ab-prefix="ab-notice"]').length`,
  );
  check(
    '撤销后那一条恢复显示（折叠条少一个）',
    noticesAfter === noticesBefore - 1,
    `折叠条 ${noticesBefore} → ${noticesAfter}`,
  );

  // ---------- 5. 档位开关：面板里切档要真的落库 ----------
  const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;
  const popupId = await (async () => {
    const v = await httpJson('/json/version');
    const cdp = await Cdp.connect(v.webSocketDebuggerUrl);
    try {
      const r = await cdp.send('Target.createTarget', { url: popupUrl });
      return r.targetId as string;
    } finally {
      cdp.close();
    }
  })();
  await sleep(2500);

  const popupDom = await evalInPage<any>(popupId, `JSON.stringify({
    levels: Array.from(document.querySelectorAll('.seg-btn[data-level]')).map(b => b.dataset.level),
    on: Array.from(document.querySelectorAll('.seg-btn[data-level].on')).map(b => b.dataset.level),
    hint: (document.getElementById('levelHint')||{}).textContent ?? '',
  })`);
  const popup = JSON.parse(String(popupDom));
  check(
    '面板上有三档控件',
    Array.isArray(popup.levels) && popup.levels.length === 3,
    `档位=${JSON.stringify(popup.levels)}`,
  );
  check(
    '面板显示当前档位',
    Array.isArray(popup.on) && popup.on.length === 1,
    `选中=${JSON.stringify(popup.on)}`,
  );
  check(
    '面板有档位说明文案',
    String(popup.hint).length > 10,
    String(popup.hint).slice(0, 40),
  );

  // 点「全部 LLM」，读设置
  for (const level of ['all', 'keyword', 'coarse']) {
    await evalInPage(popupId, `(() => {
      const b = document.querySelector('.seg-btn[data-level="${level}"]');
      if (b) b.click();
      return true;
    })()`);
    await sleep(800);
    const s = await evalInSw<any>(`(async () => {
      const r = await chrome.storage.local.get(['settings']);
      return JSON.stringify(r.settings ?? {});
    })()`);
    const saved = JSON.parse(String(s));
    check(
      `面板切到「${level}」后设置真的落库`,
      saved.judgeLevel === level,
      `settings.judgeLevel=${saved.judgeLevel}`,
    );
  }

  // ---------- 6. 切到「全部 LLM」后判定行为要变 ----------
  //
  // 没有 LLM 配置时：
  // - 「仅关键词」档：照判（本地规则）
  // - 「全部 LLM」档：判不了（要 LLM），一条都不折叠
  await evalInSw(`(async () => {
    const r = await chrome.storage.local.get(['settings']);
    const s = r.settings ?? {};
    s.judgeLevel = 'keyword';
    await chrome.storage.local.set({ settings: s, verdictCache: {}, whitelist: [] });
    return true;
  })()`);
  const keywordDom = await evalInPage<any>(pageId, `(() => {
    // 重新触发判定：刷新页面太重，这里直接看当前折叠数
    return JSON.stringify({ notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length });
  })()`);
  check(
    '仅关键词档下搜索页有折叠',
    JSON.parse(String(keywordDom)).notices > 0,
    `折叠 ${JSON.parse(String(keywordDom)).notices} 条`,
  );

  await evalInSw(`(async () => {
    const r = await chrome.storage.local.get(['settings']);
    const s = r.settings ?? {};
    s.judgeLevel = 'all';
    await chrome.storage.local.set({ settings: s });
    return true;
  })()`);
  // 重新加载页面，让 content script 用新档位重新判定
  const version2 = await httpJson('/json/version');
  const browser2 = await Cdp.connect(version2.webSocketDebuggerUrl);
  let allPageId = '';
  try {
    const r = await browser2.send('Target.createTarget', {
      url: 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(DISLIKE),
    });
    allPageId = r.targetId as string;
  } finally {
    browser2.close();
  }
  await sleep(9000);
  // **只看新开的那一页**：老页面还停在「仅关键词」档的判定结果上，
  // 混在一起看会得出「全 LLM 档也折叠了」的错误结论。
  const allNotices = await evalInPage<number>(
    allPageId,
    `document.querySelectorAll('[data-ab-prefix="ab-notice"]').length`,
  );
  check(
    '「全部 LLM」档在没有 LLM 配置时判不了（不误伤）',
    allNotices === 0,
    `新页折叠 ${allNotices} 条（没配 Key 时 LLM 档应当一条都不折）`,
  );

  await report();
}

async function report(): Promise<void> {
  console.log('\n================ 汇总 ================');
  const bad = results.filter((r) => !r.ok);
  console.log(`共 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  for (const b of bad) console.log(`  FAIL  ${b.name} — ${b.detail}`);
  process.exit(bad.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.stack : String(e)));
  await report();
  process.exit(1);
});
