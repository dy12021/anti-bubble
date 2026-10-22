/**
 * 决定性实验：关掉那个小窗口，然后刷新大页面，看小窗口会不会再出现。
 *
 * - 不再出现 -> 与扩展无关（小窗是浏览器/会话恢复留下的）
 * - 又出现   -> 是扩展干的，真 bug
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

async function listPages() {
  const targets = (await httpJson('/json/list')) as any[];
  return targets.filter((t) => t.type === 'page');
}

async function main(): Promise<void> {
  console.log('=== 实验前 ===');
  let pages = await listPages();
  pages.forEach((p, i) =>
    console.log(`  [page ${i}] ${p.id.slice(0, 12)} ${p.url.slice(0, 50)}`),
  );

  // 1) 关掉所有非主窗口的小页面（视口明显小的）
  const browser = await Cdp.connect((await httpJson('/json/version')).webSocketDebuggerUrl);
  for (const p of await listPages()) {
    const c = await Cdp.connect(p.webSocketDebuggerUrl);
    const r = await c.send('Runtime.evaluate', {
      expression: 'JSON.stringify([window.innerWidth, window.innerHeight])',
      returnByValue: true,
    });
    c.close();
    const [w, h] = JSON.parse(r.result?.value ?? '[0,0]');
    if (w < 700 && h < 500) {
      console.log(`  关闭小窗口 target=${p.id.slice(0, 12)} (${w}x${h})`);
      await browser.send('Target.closeTarget', { targetId: p.id });
    }
  }

  await new Promise((r) => setTimeout(r, 1500));
  pages = await listPages();
  console.log(`  关闭后剩余 ${pages.length} 个页面`);

  // 2) 刷新剩下的页面（扩展会随页面重载而运行）
  const main = pages[0];
  if (!main) { browser.close(); return; }
  const c = await Cdp.connect(main.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Page.reload', { ignoreCache: true });
  console.log('  已刷新主页面，等待 20 秒观察是否又冒出小窗口...');
  c.close();
  await new Promise((r) => setTimeout(r, 20000));

  const after = await listPages();
  console.log('\n=== 实验后 ===');
  after.forEach((p, i) => console.log(`  [page ${i}] ${p.id.slice(0, 12)} ${p.url.slice(0, 50)}`));
  console.log(`\n结论：${after.length > pages.length ? '小窗口又出现了 —— 是扩展干的！' : '小窗口没有再出现 —— 与扩展无关'}`);
  browser.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
