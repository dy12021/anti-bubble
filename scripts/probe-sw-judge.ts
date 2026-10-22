/**
 * 在 service worker 里手动跑一次 JUDGE_ITEMS 流程，看真实报错。
 */
export {};

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
      }, 180000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 900));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const targets = (await httpJson('/json/list')) as any[];
  const sw = targets.find((t) => t.type === 'service_worker');
  if (!sw) {
    console.error('没有 service worker');
    process.exit(1);
  }
  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  console.log('=== 手动跑判定（真实 LLM，会比较慢）===');
  const out = await cdp.eval(`(async () => {
    try {
      const mod = await import(chrome.runtime.getURL('assets/router-BH6MOn4W.js')).catch(() => null);
      // 直接测 LLM 客户端 + 词表生成，不走消息层
      const st = await chrome.storage.local.get(['llmConfig']);
      const cfg = st['llmConfig'];
      if (!cfg) return 'no llmConfig';

      const system = '你是一个内容审核器。输出严格 JSON。';
      const user = JSON.stringify({
        video: { title: 'Never Gonna Give You Up' },
        ask: '给出该视频语境下可能出现在评论里的引战表达，输出 {"patterns":[...]}',
      });
      const t0 = Date.now();
      const res = await fetch(cfg.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          max_tokens: cfg.maxTokens,
        }),
      });
      const j = await res.json();
      const content = j.choices?.[0]?.message?.content ?? '';
      return JSON.stringify({
        ms: Date.now() - t0,
        status: res.status,
        contentLen: content.length,
        contentHead: content.slice(0, 300),
        err: j.error?.message ?? null,
      }, null, 2);
    } catch (e) {
      return 'EX: ' + (e instanceof Error ? e.stack : String(e));
    }
  })()`);
  console.log(out);

  console.log('\n=== SW 控制台 ===');
  for (const e of cdp.events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params;
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      console.log(`[${p.type}] ${text}`);
    } else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      console.log('[EXCEPTION] ' + String(d?.exception?.description ?? d?.text).slice(0, 600));
    }
  }

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
