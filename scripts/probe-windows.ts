/**
 * 查 Edge 里每个页面 target 对应哪个原生窗口、窗口多大。
 * 用来确认「小窗口叠在大窗口上」到底是两个独立窗口，还是同一个窗口内的浮层。
 */
export {};

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9334';

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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15000);
    });
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  const targets = (await httpJson('/json/list')) as any[];
  const pages = targets.filter((t) => t.type === 'page');

  console.log('=== 各页面对应的原生窗口 ===');
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i]!;
    let win: any = null;
    try {
      win = await cdp.send('Browser.getWindowForTarget', { targetId: t.id });
    } catch (e) {
      win = { error: e instanceof Error ? e.message : String(e) };
    }
    const bounds = win?.bounds;
    console.log(
      `[page ${i}] windowId=${win?.windowId} ` +
      `bounds=${bounds ? `${bounds.left},${bounds.top} ${bounds.width}x${bounds.height}` : '?'} ` +
      `state=${win?.windowState ?? '?'} url=${t.url.slice(0, 60)}`,
    );
  }

  // 每个页面的视口尺寸
  console.log('\n=== 各页面视口尺寸 ===');
  for (let i = 0; i < pages.length; i++) {
    const t = pages[i]!;
    const c = await Cdp.connect(t.webSocketDebuggerUrl);
    try {
      const r = await c.send('Runtime.evaluate', {
        expression: `JSON.stringify({
          inner: [window.innerWidth, window.innerHeight],
          outer: [window.outerWidth, window.outerHeight],
          dpr: window.devicePixelRatio,
          docW: document.documentElement.scrollWidth,
          docH: document.documentElement.scrollHeight,
          hasHScroll: document.documentElement.scrollWidth > window.innerWidth,
          title: document.title,
        })`,
        returnByValue: true,
      });
      console.log(`[page ${i}] ${r.result?.value}`);
    } finally {
      c.close();
    }
  }

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
