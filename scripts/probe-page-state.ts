/**
 * 轻量探针：只看当前页面的判定状态（不驱动流程）。
 *
 * 用法：node --experimental-strip-types scripts/probe-page-state.ts
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); }
      }, 30000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  if (!page) { console.error('没有内容页面'); process.exit(1); }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  const state = await cdp.eval(`JSON.stringify({
    url: location.href,
    cards: document.querySelectorAll('.bili-video-card').length,
    notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
    marks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
    hidden: Array.from(document.querySelectorAll('.bili-video-card')).filter(e => e.style.display === 'none').length,
    reasons: Array.from(document.querySelectorAll('[data-ab-prefix="ab-notice"]')).map(n => (n.textContent||'').trim().slice(0,60)).slice(0,8),
  })`);
  console.log(state);
  cdp.close();
}

main().catch((e) => { console.error('ERROR: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
