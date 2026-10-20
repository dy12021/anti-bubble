/**
 * 端到端验证：真实 B 站视频页 + 真实 LLM + 真实扩展。
 *
 * 步骤：导航到视频页 → 等待判定完成 → 读 DOM 看屏蔽结果与理由 → 截图。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const VIDEO_URL = process.env.VIDEO_URL ?? 'https://www.bilibili.com/video/BV1GJ411x7h7';

async function listTargets(): Promise<any[]> {
  const res = await fetch(`http://${HOST}:${PORT}/json/list`);
  return (await res.json()) as any[];
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
      throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

function consoleLines(events: any[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params;
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      if (text.includes('anti-bubble')) out.push(`[${p.type}] ${text}`);
    } else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      out.push(`[EXCEPTION] ${d?.exception?.description ?? d?.text ?? ''}`.slice(0, 400));
    } else if (e.method === 'Log.entryAdded') {
      const en = e.params.entry;
      const t = `${en.text} ${en.url ?? ''}`;
      if (t.includes('anti-bubble') || t.includes('extension')) out.push(`[log.${en.level}] ${t}`.slice(0, 400));
    }
  }
  return out;
}

async function main(): Promise<void> {
  const targets = await listTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面');

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  console.log('导航到视频页:', VIDEO_URL);
  await cdp.send('Page.navigate', { url: VIDEO_URL });

  // 判定链路要调 LLM（推理模型 8-60 秒），等久一点
  for (let i = 1; i <= 12; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const state = await cdp.eval(`JSON.stringify({
      notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
      marks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
      styles: document.querySelectorAll('[data-ab-prefix="ab-styles"]').length,
      comments: document.querySelectorAll('.reply-item').length,
    })`);
    console.log(`  t+${i * 10}s ${state}`);
    const s = JSON.parse(state);
    if (s.notices > 0 || s.marks > 0) break;
  }

  console.log('\n=== 扩展控制台 ===');
  const lines = consoleLines(cdp.events);
  for (const l of lines) console.log(l);
  if (!lines.length) console.log('(无扩展相关消息)');

  console.log('\n=== 判定结果详情 ===');
  const detail = await cdp.eval(`(() => {
    const notices = Array.from(document.querySelectorAll('[data-ab-prefix="ab-notice"]'));
    const marks = Array.from(document.querySelectorAll('[data-ab-prefix="ab-mark"]'));
    return JSON.stringify({
      noticeCount: notices.length,
      markCount: marks.length,
      notices: notices.slice(0, 5).map(n => ({
        id: n.getAttribute('data-item-id'),
        text: (n.textContent || '').trim().slice(0, 120),
        hasRevoke: !!n.querySelector('[data-ab-prefix="ab-revoke"]'),
      })),
      marks: marks.slice(0, 5).map(m => (m.textContent || '').trim().slice(0, 80)),
    }, null, 2);
  })()`);
  console.log(detail);

  // 截图留证
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const outPath = 'D:\\coding\\anti-bubble\\docs\\e2e-video-page.png';
  writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
  console.log('\n截图已存:', outPath);

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
