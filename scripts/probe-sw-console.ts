/**
 * 查 service worker 的控制台错误 + 原始 storage 键。
 * 用于定位「词表没生成」到底是因为 video 为 null、LLM 报错，还是消息没到。
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
      }, 20000);
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
  let sw = targets.find((t) => t.type === 'service_worker');
  if (!sw) {
    const page = targets.find((t) => t.type === 'page');
    if (page) {
      const pc = await Cdp.connect(page.webSocketDebuggerUrl);
      await pc.send('Page.enable');
      await pc.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 3000));
      pc.close();
    }
    sw = (await httpJson('/json/list')).find((t: any) => t.type === 'service_worker');
  }
  if (!sw) {
    console.error('没有 service worker');
    process.exit(1);
  }
  console.log('SW:', sw.url);

  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const keys = await cdp.eval(`(async () => {
    const st = await chrome.storage.local.get(null);
    const wl = st['wordlistCache'];
    return JSON.stringify({
      allKeys: Object.keys(st),
      wordlistCacheType: wl === undefined ? 'undefined' : Array.isArray(wl) ? 'array' : typeof wl,
      wordlistCacheKeys: wl ? Object.keys(wl) : null,
      watchLogLen: Array.isArray(st['watchLog']) ? st['watchLog'].length : null,
      verdictCacheCount: st['verdictCache'] ? Object.keys(st['verdictCache']).length : 0,
    }, null, 2);
  })()`);
  console.log('=== storage 原始状态 ===');
  console.log(keys);

  // 手动跑一次词表生成，看真实报错
  console.log('\n=== 手动触发一次判定（看真实报错）===');
  const manual = await cdp.eval(`(async () => {
    try {
      const st = await chrome.storage.local.get(['llmConfig']);
      const cfg = st['llmConfig'];
      if (!cfg) return 'no llmConfig';
      const res = await fetch(cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '回复 ok' }],
          max_tokens: cfg.maxTokens,
        }),
      });
      const j = await res.json();
      return JSON.stringify({
        status: res.status,
        content: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) ?? null,
        reasoningLen: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.reasoning_content || '').length,
        err: j.error ? j.error.message : null,
      });
    } catch (e) {
      return 'EX: ' + String(e);
    }
  })()`);
  console.log(manual);

  console.log('\n=== SW 控制台 ===');
  let n = 0;
  for (const e of cdp.events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params;
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      console.log(`[${p.type}] ${text}`);
      n++;
    } else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      console.log('[EXCEPTION] ' + String(d?.exception?.description ?? d?.text).slice(0, 500));
      n++;
    }
  }
  if (!n) console.log('(无消息)');

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
