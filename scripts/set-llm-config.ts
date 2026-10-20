/**
 * 往扩展的 chrome.storage.local 注入 LLM 配置（端到端验证用）。
 *
 * 用法：node --experimental-strip-types scripts/set-llm-config.ts
 * 从 D:\coding\llm-quant\config.toml 读 base_url / api_key / model，
 * 写进扩展的 storage。不打印 key 明文。
 */
import { readFileSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const CFG = 'D:\\coding\\llm-quant\\config.toml';

const text = readFileSync(CFG, 'utf8');
function grab(key: string): string {
  const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1]! : '';
}

const baseUrl = grab('base_url');
const apiKey = grab('api_key');
const model = grab('model');
if (!baseUrl || !apiKey || !model) {
  console.error('config.toml 里没读到 base_url / api_key / model');
  process.exit(1);
}

async function listTargets(): Promise<any[]> {
  const res = await fetch(`http://${HOST}:${PORT}/json/list`);
  return (await res.json()) as any[];
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

async function main(): Promise<void> {
  let targets = await listTargets();
  let sw = targets.find((t) => t.type === 'service_worker');

  // MV3 的 service worker 是懒加载的，闲置 30 秒就休眠。
  // 找不到它的时候，通过刷新页面唤醒——content script 会发消息给后台，
  // 消息一到，service worker 就被拉起来了。
  if (!sw) {
    console.log('service worker 在睡，先刷新页面唤醒它…');
    const page = targets.find((t) => t.type === 'page');
    if (page) {
      const pc = await Cdp.connect(page.webSocketDebuggerUrl);
      await pc.send('Page.enable');
      await pc.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 3000));
      pc.close();
    }
    targets = await listTargets();
    sw = targets.find((t) => t.type === 'service_worker');
  }

  if (!sw) {
    console.error('找不到 service worker 目标。扩展没加载？');
    process.exit(1);
  }
  console.log('SW:', sw.url);

  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  const cfgJson = JSON.stringify({
    provider: 'openai',
    baseUrl,
    apiKey,
    model,
    timeoutMs: 120000,
    maxTokens: 8192,
  });

  // 扩展里 storage key 就是 'llmConfig'
  const out = await cdp.eval(`(async () => {
    const cfg = ${cfgJson};
    await chrome.storage.local.set({ llmConfig: cfg });
    const back = await chrome.storage.local.get(['llmConfig']);
    const c = back.llmConfig;
    return JSON.stringify({
      saved: !!c,
      provider: c?.provider,
      baseUrl: c?.baseUrl,
      model: c?.model,
      keyLen: c?.apiKey?.length ?? 0,
      maxTokens: c?.maxTokens,
    });
  })()`);
  console.log('注入结果:', out);
  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
