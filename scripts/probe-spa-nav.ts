/**
 * 探针：点推荐流里的视频，B 站是整页刷新还是 SPA 路由切换？
 *
 * 这决定了 content script 需不需要处理「URL 变了但页面没重载」。
 *
 * 判定方法：在页面上挂一个 window 上的标记，点完之后标记还在 = 没重载（SPA）。
 */
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
      }, 120000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  await browser.send('Extensions.loadUnpacked', { path: 'D:\\coding\\anti-bubble\\dist' });

  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  if (!page) { console.error('没有内容页面'); process.exit(1); }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  console.log('导航到首页推荐流…');
  await cdp.send('Page.navigate', { url: 'https://www.bilibili.com/' });
  await new Promise((r) => setTimeout(r, 9000));

  const before = await cdp.eval(`JSON.stringify({
    url: location.href,
    cards: document.querySelectorAll('.bili-video-card').length,
    hasMarker: typeof window.__abProbeMarker !== 'undefined',
  })`);
  console.log('点击前:', before);

  // 挂标记
  await cdp.eval(`window.__abProbeMarker = 'alive'; 1`);

  // 点第一张卡片的链接
  const clicked = await cdp.eval(`(() => {
    const a = document.querySelector('.bili-video-card a[href*="/video/"]');
    if (!a) return 'no-card-link';
    const href = a.getAttribute('href');
    a.click();
    return href;
  })()`);
  console.log('点击的链接:', clicked);

  await new Promise((r) => setTimeout(r, 8000));

  const after = await cdp.eval(`JSON.stringify({
    url: location.href,
    cards: document.querySelectorAll('.bili-video-card').length,
    hasMarker: typeof window.__abProbeMarker !== 'undefined',
    commentPanel: !!document.querySelector('.ab-comments'),
    nativeHidden: (document.getElementById('commentapp') || {}).style?.display,
  })`);
  console.log('点击后:', after);

  // 关键：新开了标签页吗？B 站首页点视频可能是「新标签打开」而不是本页跳转。
  const afterTargets = (await httpJson('/json/list')) as any[];
  const pages = afterTargets
    .filter((t) => t.type === 'page')
    .map((t) => ({ id: t.id, url: t.url, title: (t.title || '').slice(0, 40) }));
  console.log('\n当前所有标签页:');
  for (const p of pages) console.log(`  ${p.id}  ${p.url}`);

  const parsed = JSON.parse(after);
  const newTabOpened = pages.some((p) => p.url.includes('/video/'));

  console.log('\n=== 结论 ===');
  if (newTabOpened) {
    console.log('点视频**新开了标签页** → 新标签页会重新注入 content script，功能正常，不需要路由监听');
  } else if (parsed.hasMarker) {
    console.log('页面**没有重载**（SPA 路由切换）→ content script 不会重新注入，视频页功能会失效');
  } else {
    console.log('页面**整页重载**了 → content script 会重新注入，不需要额外的路由监听');
  }

  cdp.close();
  browser.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
