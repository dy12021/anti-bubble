/**
 * 页面桥：content script（隔离世界）↔ 页面上下文（main world）。
 *
 * 为什么需要它
 * ------------
 * B 站 API 靠 Cookie `SESSDATA` 鉴权。我们**不要**让用户手动导出凭据，
 * 而是让请求在**页面上下文**里发出：页面上下文与页面共享同一个 origin 和
 * 同一份 cookie jar，`fetch` 会自动带上 SESSDATA。
 *
 * 但 content script 跑在**隔离世界**里，改不了页面的 `window`，而 MV3 又
 * 禁掉了 `eval` / `new Function`，没法在页面里动态拼代码。于是走标准的
 * 「注入页面脚本 + postMessage 配对」路子：
 *
 * 1. manifest 用 `web_accessible_resources` 暴露 `content/page-fetch.js`；
 * 2. content script 插入 `<script src="chrome-extension://<id>/content/page-fetch.js">`，
 *    该脚本在页面上下文里运行；
 * 3. 页面脚本监听 `message`，只接受 `https://api.bilibili.com/` 的请求，
 *    执行 fetch 后把结果 postMessage 回去；
 * 4. 本模块（content script 一侧）用随机 id 把请求与响应配对。
 *
 * 安全约束
 * --------
 * URL 白名单在**页面脚本一侧**强制执行。页面里的任何脚本都能 postMessage
 * 过来，所以这个通道绝不能退化成任意地址的代理。
 *
 * 健壮性
 * ------
 * 页面脚本可能没被注入、被 CSP 拦掉、或者执行出错。这里的每一个请求都有
 * 超时兜底，**绝不会挂死**——超时/出错一律 resolve 成 null。
 */

/** 页面脚本在扩展包内的路径。与 manifest.web_accessible_resources 保持一致。 */
export const PAGE_FETCH_RESOURCE = 'content/page-fetch.js';

/** 注入脚本的 DOM id，用来避免重复注入。 */
export const PAGE_FETCH_SCRIPT_ID = 'anti-bubble-page-fetch';

/** content script → 页面脚本的请求。 */
export interface PageRequestMessage {
  __ab: true;
  /** 显式区分请求与响应——**必须有**，见 onMessage 里的说明。 */
  kind: 'req';
  id: string;
  url: string;
}

/** 页面脚本 → content script 的响应。 */
export interface PageResponseMessage {
  __ab: true;
  kind: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

/** 允许的接口域名。页面脚本与本页共用这一条规则。 */
export const BILI_API_PATTERN = /^https:\/\/api\.bilibili\.com\//;

/** 默认超时。超过就当这次请求失败。 */
export const DEFAULT_TIMEOUT_MS = 15000;

/** 等页面脚本就绪的最长时间。超过就当页面脚本没加载。 */
export const READY_TIMEOUT_MS = 3000;

export interface PageBridgeDeps {
  addEventListener: (type: 'message', handler: (e: MessageEvent) => void) => void;
  removeEventListener: (type: 'message', handler: (e: MessageEvent) => void) => void;
  postMessage: (msg: unknown) => void;
  timeoutMs?: number;
}

let seq = 0;

/** 请求 id：`ab-<base36 时间>-<序号>`。模块级序号保证同一 realm 内唯一。 */
function nextRequestId(): string {
  seq = (seq + 1) % 0xffffff;
  return `ab-${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** 把消息投递回页面。优先用 e.source，退化到全局 postMessage。 */
function resolvePoster(e: MessageEvent): (msg: unknown) => void {
  const src = e.source as unknown as
    | { postMessage?: (msg: unknown, targetOrigin?: string) => void }
    | null
    | undefined;
  if (src && typeof src.postMessage === 'function') {
    return (msg: unknown) => {
      src.postMessage?.(msg, '*');
    };
  }
  const g = globalThis as unknown as {
    postMessage?: (msg: unknown, targetOrigin?: string) => void;
  };
  return (msg: unknown) => {
    g.postMessage?.(msg, '*');
  };
}

/**
 * 建立页面桥。
 *
 * 返回的函数发起一次请求，resolve 的是页面脚本拿到的**已解析 JSON**
 * （即 B 站的 `{ code, message, data }` 信封）。任何失败都 resolve 成 null，
 * 绝不 reject、绝不挂死。
 */
export function createPageBridge(deps: PageBridgeDeps): (url: string) => Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, (value: unknown) => void>();
  let listening = false;

  // 页面脚本就绪了吗？
  //
  // content script 是用 `<script src>` 注入 page-fetch.js 的，那是**异步**加载的。
  // 注入完立刻发请求，页面脚本可能还没执行完 —— 请求发出去没人接，
  // 只能等 15 秒超时。症状是「**第一个** B 站请求必失败，后面的都正常」，
  // 很容易被误判成「这个接口不能用」。
  //
  // 所以：页面脚本执行完会 post 一条 { kind: 'ready' }，桥在这里等它。
  let ready = false;
  let readyWaiters: Array<() => void> = [];

  const markReady = (): void => {
    ready = true;
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) w();
  };

  /** 等页面脚本就绪，最多等 readyTimeoutMs。 */
  const waitReady = async (): Promise<void> => {
    if (ready) return;
    await Promise.race([
      new Promise<void>((resolve) => readyWaiters.push(resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS)),
    ]);
  };

  const onMessage = (e: MessageEvent): void => {
    const data = e.data as
      | (Omit<Partial<PageResponseMessage>, 'kind'> & { kind?: 'req' | 'res' | 'ready' })
      | undefined;
    if (!data || data.__ab !== true) return;
    // **必须区分请求与响应**：window.postMessage 会把消息派发回同一个 window，
    // 所以 content script 自己发出的请求也会被这个监听器收到。
    // 请求消息是 {__ab:true, kind:'req', id, url}，它同样有 __ab 和 id——
    // 只靠 __ab+id 过滤会把**请求自己**当成响应，
    // 于是每次请求都立刻 resolve 成 null，真实响应到达时已经没人等。
    // 这个 bug 的症状是「所有 B 站请求都失败」，包括登录态检测。
    if (data.kind === 'ready') {
      markReady();
      return;
    }
    if (data.kind !== 'res') return;
    if (typeof data.id !== 'string') return;
    const settle = pending.get(data.id);
    if (!settle) return;
    // ok 为 false 时页面脚本报了错（blocked url / 网络异常 / JSON 解析失败）。
    settle(data.ok === true ? (data.payload ?? null) : null);
  };

  const stopListening = (): void => {
    if (!listening) return;
    listening = false;
    deps.removeEventListener('message', onMessage);
  };

  const request = (url: string): Promise<unknown> =>
    new Promise((resolve) => {
      const id = nextRequestId();
      let settled = false;

      const settle = (value: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
        // 没有在途请求了就摘掉监听，别在页面上留常驻监听。
        if (pending.size === 0) stopListening();
      };

      const timer = setTimeout(() => {
        // 页面脚本没注入 / 被拦 / 卡住：这次请求直接作废。
        settle(null);
      }, timeoutMs);

      pending.set(id, settle);

      if (!listening) {
        listening = true;
        deps.addEventListener('message', onMessage);
      }

      // 等页面脚本就绪再发（见上面 ready 的说明）
      void waitReady().then(() => {
        if (settled) return;
        try {
          deps.postMessage({ __ab: true, kind: 'req', id, url } satisfies PageRequestMessage);
        } catch {
          settle(null);
        }
      });
    });

  return request;
}

/**
 * 页面脚本一侧的参考实现。`page-fetch.js` 与它保持同样的行为。
 *
 * - 只处理 `{ __ab: true, kind: 'req', id, url }` 的消息；
 * - URL 必须在 B 站 API 白名单内，否则回 `blocked url`；
 * - fetch 带 `credentials: 'include'`，浏览器自动附上 SESSDATA；
 * - 成功回 `{ kind:'res', ok: true, payload }`，失败回 `{ kind:'res', ok: false, error }`。
 */
export function handlePageMessage(
  e: MessageEvent,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): void {
  const data = e.data as Partial<PageRequestMessage> | undefined;
  if (!data || data.__ab !== true) return;
  // 只认请求。响应消息（kind:'res'）也带 __ab 和 id，不加这行会互相触发。
  if (data.kind !== 'req') return;
  if (typeof data.id !== 'string' || data.id.length === 0) return;
  if (typeof data.url !== 'string' || data.url.length === 0) return;

  const id = data.id;
  const url = data.url;
  const post = resolvePoster(e);

  if (!BILI_API_PATTERN.test(url)) {
    post({ __ab: true, kind: 'res', id, ok: false, error: 'blocked url' } satisfies PageResponseMessage);
    return;
  }

  void (async () => {
    try {
      const res = await fetchImpl(url, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const payload = await res.json();
      post({ __ab: true, kind: 'res', id, ok: true, payload } satisfies PageResponseMessage);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      post({ __ab: true, kind: 'res', id, ok: false, error } satisfies PageResponseMessage);
    }
  })();
}

/**
 * 把页面脚本注入页面上下文。
 *
 * 必须在页面加载之后调用（否则页面 CSP 可能拦掉注入的 script）。
 * 返回是否注入成功（已经注入过也算成功）。
 */
export function injectPageFetch(doc: Document = document): boolean {
  try {
    if (doc.getElementById(PAGE_FETCH_SCRIPT_ID)) return true;
    const el = doc.createElement('script');
    el.id = PAGE_FETCH_SCRIPT_ID;
    el.src = chrome.runtime.getURL(PAGE_FETCH_RESOURCE);
    el.async = false;
    (doc.head ?? doc.documentElement).appendChild(el);
    return true;
  } catch {
    return false;
  }
}
