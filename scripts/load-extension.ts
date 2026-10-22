/**
 * 用 CDP 的 Extensions.loadUnpacked 加载未打包扩展。
 *
 * Chrome 142+ 删除了 DisableLoadExtensionCommandLineSwitch，
 * --load-extension 在稳定版彻底失效。唯一可行的自动化路径是 CDP 的
 * Extensions 域（需要 --enable-unsafe-extension-debugging）。
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库根目录：从脚本自身位置推算，换机器/换盘符都不用改代码。
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const DIST = process.env.EXT_DIST ?? join(REPO, 'dist');

async function httpJson(path: string): Promise<any> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  return res.json();
}

/** 浏览器级 CDP 连接走 /json/version 里的 webSocketDebuggerUrl。 */
async function browserWsUrl(): Promise<string> {
  const v = await httpJson('/json/version');
  if (!v?.webSocketDebuggerUrl) throw new Error('拿不到 browser websocket url');
  return v.webSocketDebuggerUrl;
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
      }, 20000);
    });
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const url = await browserWsUrl();
  console.log('browser ws:', url);
  const cdp = await Cdp.connect(url);

  // 看看 Extensions 域在不在
  try {
    const res = await cdp.send('Extensions.loadUnpacked', { path: DIST });
    console.log('loadUnpacked 成功:', JSON.stringify(res));
  } catch (e) {
    console.error('loadUnpacked 失败:', e instanceof Error ? e.message : String(e));
    // 看看有哪些 Extensions 域的命令可用
    try {
      const domains = await cdp.send('Schema.getDomains', { domain: 'Extensions' });
      console.log('Extensions 域 schema:', JSON.stringify(domains).slice(0, 2000));
    } catch (e2) {
      console.error('Schema.getDomains 也失败:', e2 instanceof Error ? e2.message : String(e2));
    }
    cdp.close();
    process.exit(1);
  }

  cdp.close();

  // 装完后再看 targets，确认 service worker 起来了
  await new Promise((r) => setTimeout(r, 1500));
  const targets = (await httpJson('/json/list')) as any[];
  console.log('\n=== targets ===');
  for (const t of targets) {
    if (t.type === 'service_worker' || t.type === 'background_page' || t.type === 'page') {
      console.log(`[${t.type}] ${t.title?.slice(0, 40) ?? ''} | ${t.url?.slice(0, 90) ?? ''}`);
    }
  }
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
