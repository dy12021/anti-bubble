/**
 * 适配器「真实现状体检」：在真实 B 站页面上，验证三个适配器的选择器还能不能抽到东西。
 *
 * 重点怀疑视频页——B 站新版评论区在 Shadow DOM 里，
 * 普通的 querySelector 穿不过去，会导致「一条评论都抽不到」。
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

const PROBE = `(() => {
  const q = (s) => document.querySelectorAll(s).length;
  // 递归钻进所有 shadow root，统计真实存在的评论节点
  function deepCount(selector) {
    let n = 0;
    const walk = (root) => {
      n += root.querySelectorAll(selector).length;
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return n;
  }
  function deepSample(selector) {
    const found = [];
    const walk = (root) => {
      for (const el of root.querySelectorAll(selector)) {
        if (found.length < 3) found.push((el.textContent || '').trim().slice(0, 60));
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    return found;
  }
  return JSON.stringify({
    url: location.href.slice(0, 80),
    // 浅层（普通 querySelector 能看到的）
    shallow: {
      replyItem: q('.reply-item'),
      replyItemWithRpid: q('.reply-item[data-rpid]'),
      biliVideoCard: q('.bili-video-card'),
      commentThread: q('.bili-comment-thread-renderer'),
      bpxComment: q('.bpx-comment'),
    },
    // 深度（钻进 shadow root）
    deep: {
      replyItem: deepCount('.reply-item'),
      replyItemWithRpid: deepCount('.reply-item[data-rpid]'),
      biliCommentThread: deepCount('.bili-comment-thread-renderer'),
      bpxComment: deepCount('.bpx-comment'),
      replyContent: deepCount('.reply-content'),
    },
    shadowHostCount: (() => {
      let n = 0;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { n++; walk(el.shadowRoot); }
      };
      walk(document);
      return n;
    })(),
    samples: deepSample('.reply-item, .bili-comment-thread-renderer, .bpx-comment'),
  }, null, 2);
})()`;

async function check(url: string, label: string): Promise<void> {
  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page');
  if (!page) { console.log('没有页面'); return; }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 7000));
  const out = await cdp.eval(PROBE);
  console.log(`\n=== ${label} (${url}) ===`);
  console.log(out);
  cdp.close();
}

async function main(): Promise<void> {
  await check('https://search.bilibili.com/all?keyword=Rust', '搜索页');
  await check('https://www.bilibili.com/video/BV1GJ411x7h7/', '视频页');
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
