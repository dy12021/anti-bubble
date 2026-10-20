/**
 * 关闭遗留的小窗口 target（视口小于 700x500 的独立页面）。
 * 独立成脚本，方便反复调用。
 */
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
      }, 10000);
    });
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const targets = (await httpJson('/json/list')) as any[];
  const pages = targets.filter((t) => t.type === 'page');

  let closed = 0;
  for (const p of pages) {
    const c = await Cdp.connect(p.webSocketDebuggerUrl);
    let size = [0, 0];
    try {
      const r = await c.send('Runtime.evaluate', {
        expression: 'JSON.stringify([window.innerWidth, window.innerHeight])',
        returnByValue: true,
      });
      size = JSON.parse(r.result?.value ?? '[0,0]');
    } catch { /* 页面可能已关 */ }
    c.close();

    if (size[0] < 700 && size[1] < 500) {
      console.log(`关闭小窗口 ${p.id.slice(0, 12)} (${size[0]}x${size[1]})`);
      // 先用 Page.close（更温和，能触发 beforeunload 处理），不行再强制关 target
      const c2 = await Cdp.connect(p.webSocketDebuggerUrl);
      try {
        await c2.send('Page.close');
        closed++;
      } catch {
        /* 忽略 */
      }
      c2.close();
      await new Promise((r) => setTimeout(r, 400));
      try {
        await browser.send('Target.closeTarget', { targetId: p.id });
        closed++;
      } catch {
        /* 忽略 */
      }
    }
  }

  await new Promise((r) => setTimeout(r, 1200));
  const after = (await httpJson('/json/list')) as any[];
  const remaining = after.filter((t) => t.type === 'page');
  console.log(`已处理 ${closed} 次；剩余页面 ${remaining.length} 个`);
  browser.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
