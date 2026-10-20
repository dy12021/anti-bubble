/**
 * 打开扩展的 popup 页面并截图——面板好不好用得看渲染出来什么样。
 *
 * popup 的 URL 是 chrome-extension://<id>/src/popup/index.html
 */
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

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
      }, 20000);
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

/**
 * 由扩展目录的绝对路径算出扩展 ID —— 这条路**不可靠**
 * （Chrome 对 Windows 路径的归一化方式与直接 sha256(path) 不同，实测算出来的 ID 不对）。
 * 保留仅作参考，实际一律用 loadUnpacked 的返回值。
 */
function extensionIdFromPath(absPath: string): string {
  const hash = createHash('sha256').update(absPath, 'utf8').digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const b = hash[i]!;
    id += String.fromCharCode(97 + (b >> 4));
    id += String.fromCharCode(97 + (b & 0x0f));
  }
  return id;
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);

  // 扩展 id：一律用 loadUnpacked 的返回值。
  // 不要从 target 列表里猜——里面可能混着之前用错 id 打开的「已阻止」错误页。
  let extId = '';
  try {
    const r = await browser.send('Extensions.loadUnpacked', {
      path: 'D:\\coding\\anti-bubble\\dist',
    });
    extId = r?.id ?? '';
  } catch (e) {
    console.error('loadUnpacked 失败:', e instanceof Error ? e.message : String(e));
  }

  if (!extId) {
    console.error('拿不到扩展 id。');
    process.exit(1);
  }
  console.log('扩展 id:', extId, '(来自 loadUnpacked)');

  const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;
  console.log('打开 popup:', popupUrl);

  const { targetId } = await browser.send('Target.createTarget', { url: popupUrl });
  await new Promise((r) => setTimeout(r, 2500));

  const list = (await httpJson('/json/list')) as any[];
  const popup = list.find((t) => t.id === targetId);
  if (!popup) {
    console.error('popup target 没起来');
    process.exit(1);
  }

  const cdp = await Cdp.connect(popup.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  // 控制台错误
  console.log('\n=== popup 控制台 ===');
  let errs = 0;
  for (const e of cdp.events) {
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
      errs++;
      console.log('[error]', (e.params.args ?? []).map((a: any) => a.value ?? a.description).join(' '));
    }
    if (e.method === 'Runtime.exceptionThrown') {
      errs++;
      console.log('[exception]', e.params.exceptionDetails?.exception?.description?.slice(0, 300));
    }
  }
  if (!errs) console.log('(无错误)');

  // 面板内容是否渲染出来了
  const rendered = await cdp.eval(`JSON.stringify({
    hasApp: !!document.getElementById('app'),
    bodyLen: document.body.innerText.length,
    title: document.querySelector('h1')?.textContent ?? '',
    modeOn: document.querySelector('.seg-btn.on .seg-title')?.textContent ?? '(无选中)',
    hasKeyState: (document.getElementById('keyState')?.textContent ?? '').slice(0, 40),
    profileText: (document.getElementById('profileBox')?.textContent ?? '').trim().slice(0, 80),
    blockedText: (document.getElementById('blockedBox')?.textContent ?? '').trim().slice(0, 40),
  })`);
  console.log('\n=== 面板渲染状态 ===');
  console.log(rendered);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = 'D:\\coding\\anti-bubble\\docs\\popup.png';
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('\n截图已存:', out);

  cdp.close();
  browser.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
