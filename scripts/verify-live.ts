/**
 * 真机验证：扩展在真实 Chrome 里是否正常工作。
 *
 * 流程：连上页面 → 开启 Runtime/Log → 重载 → 收集控制台 → 定位我们的 SW → 查它的状态。
 */
const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';

interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function listTargets(): Promise<Target[]> {
  const res = await fetch(`http://${HOST}:${PORT}/json/list`);
  return (await res.json()) as Target[];
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

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
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
      }, 30000);
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

function fmtEvents(events: any[]): string[] {
  const lines: string[] = [];
  for (const e of events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params;
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      lines.push(`[console.${p.type}] ${text}`);
    } else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      lines.push(`[EXCEPTION] ${d?.exception?.description ?? d?.text ?? JSON.stringify(d).slice(0, 300)}`);
    } else if (e.method === 'Log.entryAdded') {
      const en = e.params.entry;
      lines.push(`[log.${en.level}] ${en.text} ${en.url ?? ''}`);
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const targets = await listTargets();
  const pages = targets.filter((t) => t.type === 'page');
  if (!pages.length) throw new Error('没有页面');
  const page = pages[0]!;

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');

  console.log('=== 重新加载页面（触发 content script）===');
  await cdp.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 6000));

  const lines = fmtEvents(cdp.events);
  console.log('\n=== 页面控制台 ===');
  if (!lines.length) console.log('(无消息)');
  for (const l of lines) console.log(l);

  // 页面里扩展注入的痕迹
  console.log('\n=== 页面 DOM 中的扩展痕迹 ===');
  const dom = await cdp.eval(`JSON.stringify({
    hasPageFetch: typeof window.__antiBubblePageFetch !== 'undefined',
    abStyles: document.querySelectorAll('[data-ab-prefix="ab-styles"]').length,
    abNotices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
    abMarks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
    scripts: Array.from(document.scripts).filter(s => s.src.includes('page-fetch')).map(s => s.src),
  })`);
  console.log(dom);

  cdp.close();

  // 现在再找一次 SW —— content script 发消息会唤醒我们的 SW
  await new Promise((r) => setTimeout(r, 1500));
  console.log('\n=== 重新列出目标（找我们的 SW）===');
  const targets2 = await listTargets();
  for (const t of targets2) {
    if (t.type === 'service_worker' || t.type === 'background_page') {
      console.log(`[${t.type}] ${t.url}`);
    }
  }
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
