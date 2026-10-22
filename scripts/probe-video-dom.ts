/**
 * 探针：视频页标题的 DOM 祖先链，找一个「插进去不破坏布局」的位置。
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, 60000);
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
    const desc = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (el.className && typeof el.className === 'string' ? el.className : '').slice(0, 70),
        display: getComputedStyle(el).display,
        pos: getComputedStyle(el).position,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        children: el.children.length,
      };
    };
    const chain: any[] = [];
    let el = document.querySelector('.video-title');
    for (let i = 0; el && i < 6; i++) { chain.push(desc(el)); el = el.parentElement; }

    const candidates = {};
    for (const sel of ['.video-title', 'h1', '.video-info-container', '.video-info',
                       '#viewbox_report', '.bili-video-info-container', '#commentapp', '.video-toolbar-left']) {
      candidates[sel] = desc(document.querySelector(sel));
    }
    return JSON.stringify({ chain, candidates }, null, 2);
  })()`);
  console.log(out);
  cdp.close();
}

main().catch((e) => { console.error('ERROR: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
