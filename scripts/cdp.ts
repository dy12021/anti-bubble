/**
 * 用 CDP（Chrome DevTools Protocol）驱动一个加载了扩展的 Chrome。
 *
 * 为什么不用 chrome-devtools-mcp 的扩展工具：它们需要 MCP server 带
 * --categoryExtensions 启动，本机没有。但 Node 24 自带全局 WebSocket，
 * 可以直接说 CDP 协议，一样能做到「真机验证」。
 *
 * 用法：
 *   node --experimental-strip-types scripts/cdp.ts <命令> [参数...]
 *
 * 命令：
 *   targets                        列出所有可调试目标（含 service worker）
 *   eval-sw <表达式文件>            在扩展的 service worker 里执行 JS
 *   eval-page <pageIndex> <表达式文件> 在某个页面里执行 JS
 *   console <pageIndex>            打印页面控制台消息
 *   navigate <pageIndex> <url>     导航页面
 *   newpage <url>                  新开页面
 *   shot <pageIndex> <文件路径>     截图
 *
 * 页面索引来自 `targets` 输出里的 [page N]。
 */
export {};


const HOST = process.env.CDP_HOST ?? '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9222';

interface Target {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

async function httpJson(path: string): Promise<unknown> {
  const res = await fetch(`http://${HOST}:${PORT}${path}`);
  return res.json();
}

async function listTargets(): Promise<Target[]> {
  const raw = (await httpJson('/json/list')) as Target[];
  return raw;
}

class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private consoleEvents: any[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String((ev as MessageEvent).data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      } else if (msg.method === 'Runtime.consoleAPICalled') {
        this.consoleEvents.push(msg.params);
      } else if (msg.method === 'Log.entryAdded') {
        this.consoleEvents.push({ source: 'log', ...msg.params.entry });
      } else if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleEvents.push({ source: 'exception', ...msg.params.exceptionDetails });
      }
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', (e) => reject(new Error('ws error: ' + String(e))), { once: true });
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
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    }
    return r.result?.value;
  }

  drainConsole(): any[] {
    const out = this.consoleEvents;
    this.consoleEvents = [];
    return out;
  }

  close(): void {
    this.ws.close();
  }
}

function fmtArgs(argv: string[]): string[] {
  return argv.slice(2);
}

async function main(): Promise<void> {
  const args = fmtArgs(process.argv);
  const cmd = args[0];

  if (cmd === 'targets') {
    const targets = await listTargets();
    let pageIndex = 0;
    for (const t of targets) {
      if (t.type === 'page') {
        console.log(`[page ${pageIndex}] ${t.title.slice(0, 60)} | ${t.url.slice(0, 90)}`);
        pageIndex++;
      } else if (t.type === 'service_worker') {
        console.log(`[sw] ${t.title.slice(0, 60)} | ${t.url.slice(0, 90)}`);
      } else if (t.type === 'background_page') {
        console.log(`[bg] ${t.title.slice(0, 60)} | ${t.url.slice(0, 90)}`);
      }
    }
    return;
  }

  if (cmd === 'eval-sw') {
    const file = args[1];
    if (!file) throw new Error('用法: eval-sw <表达式文件>');
    const expr = await readFile(file);
    const targets = await listTargets();
    const sw = targets.find((t) => t.type === 'service_worker');
    if (!sw) throw new Error('找不到 service worker 目标。扩展可能没加载成功。');
    const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
    const out = await cdp.eval(expr);
    console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    cdp.close();
    return;
  }

  if (cmd === 'eval-page' || cmd === 'console' || cmd === 'navigate' || cmd === 'shot') {
    const pageIndex = Number(args[1]);
    const targets = await listTargets();
    const pages = targets.filter((t) => t.type === 'page');
    const page = pages[pageIndex];
    if (!page) throw new Error(`没有 [page ${pageIndex}]，现有 ${pages.length} 个`);

    if (cmd === 'navigate') {
      const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url: args[2]! });
      await new Promise((r) => setTimeout(r, 3000));
      cdp.close();
      console.log('navigated -> ' + args[2]);
      return;
    }

    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    if (cmd === 'eval-page') {
      const expr = await readFile(args[2]!);
      const out = await cdp.eval(expr);
      console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    } else if (cmd === 'console') {
      await new Promise((r) => setTimeout(r, 1500));
      const events = cdp.drainConsole();
      for (const e of events) {
        if (e.source === 'exception') {
          console.log('[异常] ' + (e.exception?.description ?? e.text ?? JSON.stringify(e)));
        } else if (e.source === 'log') {
          console.log(`[${e.level}] ${e.text} ${e.url ?? ''}`);
        } else {
          const text = (e.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
          console.log(`[${e.type}] ${text}`);
        }
      }
      if (!events.length) console.log('(无控制台消息)');
    } else if (cmd === 'shot') {
      const { writeFileSync } = await import('node:fs');
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(args[2]!, Buffer.from(r.data, 'base64'));
      console.log('saved ' + args[2]);
    }
    cdp.close();
    return;
  }

  if (cmd === 'newpage') {
    const targets = await listTargets();
    const pages = targets.filter((t) => t.type === 'page');
    const cdp = await Cdp.connect(pages[0]!.webSocketDebuggerUrl);
    await cdp.send('Target.createTarget', { url: args[1]! });
    cdp.close();
    console.log('opened ' + args[1]);
    return;
  }

  throw new Error('未知命令: ' + cmd);
}

async function readFile(p: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(p, 'utf8');
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
