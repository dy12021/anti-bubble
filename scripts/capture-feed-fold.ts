/**
 * 抓「Edge 首页折叠生效」的实拍图。
 *
 * 不做任何撤销操作——要拍的就是「被折叠 + 理由 + 仍要显示」的样子。
 */
const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9334';
const OUT = process.env.OUT ?? 'D:\\coding\\anti-bubble\\docs\\e2e-edge-feed-fold.png';
const URL_TO_OPEN = process.env.NAV_URL ?? 'https://www.bilibili.com/';
const WAIT_S = Number(process.env.WAIT_S ?? 60);

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); } }, 60000);
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
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);

  // 注入画像（可选）：让折叠是确定性的。
  // profileDislikes=词1,词2 → 标题里含这些词的卡片会被本地闸门直接折叠
  const dislikes = process.env.PROFILE_DISLIKES ?? '';
  if (dislikes) {
    const loaded = await browser.send('Extensions.loadUnpacked', { path: 'D:\\coding\\anti-bubble\\dist' });
    const extId = loaded?.id as string;
    const { targetId } = await browser.send('Target.createTarget', {
      url: `chrome-extension://${extId}/src/popup/index.html`,
    });
    await new Promise((r) => setTimeout(r, 1500));
    const pl = (await httpJson('/json/list')) as any[];
    const popup = pl.find((t) => t.id === targetId);
    const pcdp = await Cdp.connect(popup!.webSocketDebuggerUrl);
    await pcdp.eval(`(async () => {
      const ds = ${JSON.stringify(dislikes)}.split(',').map(s => s.trim()).filter(Boolean);
      await chrome.storage.local.set({ profile: {
        interests: [{ tag: '数码', weight: 0.8 }], dislikes: ds, stanceHints: {},
        topics: ['手机'], updatedAt: new Date().toISOString(), sampleCount: 10,
      }});
      await chrome.storage.local.remove(['verdictCache', 'wordlistCache', 'blockedLog']);
      return 1;
    })()`);
    console.log('已注入画像 dislikes=' + dislikes);
    pcdp.close();
    await browser.send('Target.closeTarget', { targetId });
  }

  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  if (!page) { console.error('没有内容页'); process.exit(1); }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url: URL_TO_OPEN });
  console.log('打开 ' + URL_TO_OPEN + '，等判定…');

  let found = false;
  for (let i = 0; i < WAIT_S / 5; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const n = await cdp.eval(`document.querySelectorAll('[data-ab-prefix="ab-notice"]').length`);
    if (n > 0) { found = true; console.log(`  t+${(i + 1) * 5}s 折叠说明 ${n} 条`); break; }
  }
  if (!found) console.log('没等到折叠说明（本次没有内容被判为可折叠）');

  await cdp.eval(`(() => { const n = document.querySelector('[data-ab-prefix="ab-notice"]'); if (n) { n.scrollIntoView({block:'center'}); } return 1; })()`);
  await new Promise((r) => setTimeout(r, 1200));
  const info = await cdp.eval(`JSON.stringify({
    notices: Array.from(document.querySelectorAll('[data-ab-prefix="ab-notice"]')).map(n => (n.textContent||'').trim().slice(0,60)),
  })`);
  console.log(info);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('截图: ' + OUT);
  cdp.close();
}

main().catch((e) => { console.error('ERROR: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
