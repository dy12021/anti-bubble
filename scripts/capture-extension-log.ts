/**
 * 连上页面 → 开启控制台捕获 → 重新加载 → 收集扩展自己的日志。
 *
 * 必须「连上再刷新」：Runtime.enable 不会回放已经产生的控制台消息。
 */
export {};

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const URL_ = process.env.TARGET_URL ?? 'https://www.bilibili.com/video/BV1GJ411x7h7/';
const WAIT_MS = Number(process.env.WAIT_MS ?? 15000);

async function httpJson(path: string): Promise<any> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  return res.json();
}

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  events: any[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method) {
        this.events.push({ method: msg.method, params: msg.params });
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
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
      }, 60000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  // content script 只在**页面加载**时注入。
  // 如果当前已经在目标 URL，Page.navigate 到同一地址会被 Chrome 当作同文档导航，
  // 不会重新加载，content script 也就不会注入 —— 必须改用 Page.reload。
  const currentUrl = await cdp.eval('location.href') as string;
  if (currentUrl.split('?')[0] === URL_.split('?')[0]) {
    await cdp.send('Page.reload', { ignoreCache: true });
  } else {
    await cdp.send('Page.navigate', { url: URL_ });
  }
  await new Promise((r) => setTimeout(r, WAIT_MS));

  console.log('=== 扩展日志 ===');
  let found = 0;
  for (const e of cdp.events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params;
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      if (text.includes('anti-bubble')) {
        found++;
        console.log(`[${p.type}] ${text}`);
      }
    } else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      const desc = d?.exception?.description ?? d?.text ?? '';
      if (desc.includes('anti-bubble') || desc.includes('page-bridge')) {
        found++;
        console.log(`[EXCEPTION] ${desc.slice(0, 400)}`);
      }
    }
  }
  if (!found) console.log('(没有捕获到扩展日志)');

  console.log('\n=== 页面状态 ===');
  const state = await cdp.eval(`JSON.stringify({
    hasPageFetch: typeof window.__antiBubblePageFetch !== 'undefined',
    panelExists: !!document.querySelector('[data-ab-prefix="ab-comments"]'),
    nativeHidden: (() => { const n = document.getElementById('commentapp'); return n ? n.style.display === 'none' : null; })(),
    commentsRendered: document.querySelectorAll('[data-ab-rpid]').length,
    stylesInjected: !!document.querySelector('[data-ab-prefix="ab-styles"]'),
    statusText: (document.querySelector('.ab-comments-status')?.textContent || '').trim(),
  })`);
  console.log(state);

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
