/**
 * 抓一张扩展 UI 的实拍图（滚到指定区块再截）。
 *
 * 用法：
 *   SELECTOR='.ab-comments'  OUT='e2e-comment-panel.png' node ... capture-ui.ts
 *   SELECTOR='.ab-recommend' OUT='e2e-recommend.png'     node ... capture-ui.ts
 */
const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const SELECTOR = process.env.SELECTOR ?? '.ab-comments';
const OUT = process.env.OUT ?? 'D:\\coding\\anti-bubble\\docs\\e2e-ui.png';

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
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  if (!page) { console.error('没有内容页标签'); process.exit(1); }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  if (!page.url.includes('/video/')) {
    console.log('导航到视频页…');
    await cdp.send('Page.navigate', { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' });
    await new Promise((r) => setTimeout(r, 20000));
  }

  // 窗口太小截不到面板，先把视口拉大
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await new Promise((r) => setTimeout(r, 1500));

  const info = await cdp.eval(`(() => {
    const panel = document.querySelector(${JSON.stringify(SELECTOR)});
    if (!panel) return JSON.stringify({ found: false });
    panel.scrollIntoView({ block: 'center' });
    return JSON.stringify({
      found: true,
      text: (panel.textContent || '').trim().slice(0, 300),
    });
  })()`);
  console.log(info);
  await new Promise((r) => setTimeout(r, 2000));
  await cdp.eval(`(() => { const p = document.querySelector(${JSON.stringify(SELECTOR)}); if (p) p.scrollIntoView({block:'start'}); window.scrollBy(0, -60); return 1; })()`);
  await new Promise((r) => setTimeout(r, 1500));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图: ' + OUT);
  cdp.close();
}

main().catch((e) => { console.error('ERROR: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
