/**
 * 探针：自动化的浏览器里，页面的 visibilityState 到底是什么？
 *
 * 观看时长追踪只算「页面可见」的时候——如果自动化环境里
 * 页面一直算 hidden，计时就永远不走。
 */
export {};

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';

async function httpJson(path: string): Promise<any> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  return res.json();
}

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, 30000);
    });
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  }
  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page' && t.url.includes('/video/'));
  if (!page) { console.error('没有视频页'); process.exit(1); }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  const out = await cdp.eval(`(() => {
    // 在页面里挂一个自己的计时器，看 setInterval 到底跑不跑
    window.__probeTicks = 0;
    window.__probeTimer = setInterval(() => { window.__probeTicks++; }, 1000);
    return JSON.stringify({
      visibilityState: document.visibilityState,
      hidden: document.hidden,
      hasFocus: document.hasFocus(),
    });
  })()`);
  console.log('初始:', out);
  await new Promise((r) => setTimeout(r, 8000));
  const after = await cdp.eval(`JSON.stringify({
    ticks: window.__probeTicks,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
  })`);
  console.log('8 秒后:', after);
  cdp.close();
}

main().catch((e) => { console.error('ERROR: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
