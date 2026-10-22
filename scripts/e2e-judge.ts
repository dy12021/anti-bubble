/**
 * 端到端：真实 B 站视频页 + 真实 LLM -> 验证评论真的被折叠、带理由、能撤销。
 *
 * 推理模型每次调用 10-60 秒，词表 + 精判两次调用，所以要等 2-3 分钟。
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：从脚本自身位置推算，换机器/换盘符都不用改代码。
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const URL_ = process.env.TARGET_URL ?? 'https://www.bilibili.com/video/BV1GJ411x7h7/';
const WAIT_MS = Number(process.env.WAIT_MS ?? 150000);

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
      }, 300000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const currentUrl = (await cdp.eval('location.href')) as string;
  if (currentUrl.split('?')[0] === URL_.split('?')[0]) {
    await cdp.send('Page.reload', { ignoreCache: true });
  } else {
    await cdp.send('Page.navigate', { url: URL_ });
  }
  console.log(`等待 ${WAIT_MS / 1000}s 让 LLM 判定完成…`);

  let state: any = null;
  for (let i = 0; i < WAIT_MS / 10000; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    state = JSON.parse(
      (await cdp.eval(`JSON.stringify({
        comments: document.querySelectorAll('[data-ab-rpid]').length,
        notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
        marks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
        count: (document.querySelector('.ab-comments-count')?.textContent || '').trim(),
        hidden: Array.from(document.querySelectorAll('[data-ab-rpid]')).filter(e => e.style.display === 'none').length,
      })`)) as string,
    );
    console.log(`  t+${(i + 1) * 10}s ${JSON.stringify(state)}`);
    if (state.notices > 0 || state.marks > 0) break;
  }

  console.log('\n=== 扩展日志 ===');
  for (const e of cdp.events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params;
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      if (text.includes('anti-bubble')) console.log(`[${p.type}] ${text}`);
    }
  }

  console.log('\n=== 判定结果 ===');
  const detail = await cdp.eval(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-ab-rpid]'));
    const notices = Array.from(document.querySelectorAll('[data-ab-prefix="ab-notice"]'));
    return JSON.stringify({
      commentCount: rows.length,
      hiddenCount: rows.filter(r => r.style.display === 'none').length,
      noticeCount: notices.length,
      markCount: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
      count: (document.querySelector('.ab-comments-count')?.textContent || '').trim(),
      notices: notices.map(n => ({
        id: n.getAttribute('data-item-id'),
        text: (n.textContent || '').trim().slice(0, 80),
        hasRevoke: !!n.querySelector('[data-ab-prefix="ab-revoke"]'),
      })),
      marks: Array.from(document.querySelectorAll('[data-ab-prefix="ab-mark"]')).map(m => ({
        text: (m.textContent || '').trim().slice(0, 60),
        inRow: (m.closest('[data-ab-rpid]')?.textContent || '').trim().slice(0, 70),
      })),
      comments: rows.map(r => ({
        id: r.getAttribute('data-ab-rpid'),
        text: (r.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60),
        hidden: r.style.display === 'none',
      })),
    }, null, 2);
  })()`);
  console.log(detail);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = join(REPO, 'docs', 'e2e-result.png');
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('\n截图已存:', out);

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
