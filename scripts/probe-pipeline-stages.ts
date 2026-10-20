/**
 * 逐阶段证明判定链路跑过：
 *   ① 词表缓存 —— LLM 生成过动态词表吗？
 *   ② 判定缓存 —— LLM 精判出过结果吗？
 *   ③ 屏蔽记录 —— 有没有产生非 pass 的判定？
 *   ④ 页面 DOM —— 折叠/标识实际生效了吗？
 *
 * 即使这次抓到的评论全是无害内容（粗筛正常放行），
 * ①② 也能证明 LLM 那一段真的通了。
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
      throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);

  // 唤醒 service worker（懒加载）
  //
  // **注意 1**：这里**不要** reload 页面来唤醒。
  // 端到端测试运行时，reload 会把正在观察的判定状态整个冲掉，
  // 让人误以为「插件没反应」。要 reload 请显式设 RELOAD=1。
  //
  // **注意 2**：必须按扩展 id 过滤 service worker 目标——
  // 浏览器里还有内置扩展的 SW（Google Network Speech 等），连错了会
  // 报 "chrome is not defined"。
  const extId = process.env.EXT_ID ?? 'jlfdpgneomllhbpaiejjhoigophhejid';
  const findOurSw = async (): Promise<any | undefined> => {
    const list = (await httpJson('/json/list')) as any[];
    return list.find(
      (t) => t.type === 'service_worker' && (t.url ?? '').includes(extId),
    );
  };

  const targets = (await httpJson('/json/list')) as any[];
  let sw = await findOurSw();
  if (!sw && process.env.RELOAD === '1') {
    const page = targets.find((t) => t.type === 'page');
    if (page) {
      const pc = await Cdp.connect(page.webSocketDebuggerUrl);
      await pc.send('Page.enable');
      await pc.send('Page.reload', { ignoreCache: true });
      await new Promise((r) => setTimeout(r, 3000));
      pc.close();
    }
    sw = await findOurSw();
  }
  if (!sw) {
    console.error('没有 service worker 目标');
    process.exit(1);
  }

  const swCdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  const storage = await swCdp.eval(`(async () => {
    const st = await chrome.storage.local.get(null);
    const wl = st['wordlistCache'] ?? {};
    const vc = st['verdictCache'] ?? {};
    const bl = st['blockedLog'] ?? [];
    const wlEntries = Object.entries(wl).map(([k, v]) => ({
      key: k,
      patterns: (v && v.patterns) ? v.patterns.length : 0,
      sample: (v && v.patterns) ? v.patterns.slice(0, 5) : [],
      stance: (v && v.stance) ? String(v.stance).slice(0, 60) : '',
      oppositeKeywords: (v && v.oppositeKeywords) ? v.oppositeKeywords : [],
    }));
    return JSON.stringify({
      wordlistCount: wlEntries.length,
      wordlists: wlEntries,
      verdictCount: Object.keys(vc).length,
      verdictActions: Object.values(vc).reduce((m, v) => { m[v.action] = (m[v.action]||0)+1; return m; }, {}),
      verdictSamples: Object.values(vc).slice(0, 4).map(v => ({
        action: v.action, reason: v.reason, reasonCode: v.reasonCode, confidence: v.confidence,
      })),
      blockedLogCount: bl.length,
      blockedLog: bl.slice(0, 5),
    }, null, 2);
  })()`);
  console.log('=== 后台状态（service worker）===');
  console.log(storage);
  swCdp.close();

  // 页面 DOM
  const page = (await httpJson('/json/list')).find((t: any) => t.type === 'page');
  if (page) {
    const pc = await Cdp.connect(page.webSocketDebuggerUrl);
    const dom = await pc.eval(`JSON.stringify({
      panel: !!document.querySelector('[data-ab-prefix="ab-comments"]'),
      comments: document.querySelectorAll('[data-ab-rpid]').length,
      hidden: Array.from(document.querySelectorAll('[data-ab-rpid]')).filter(e => e.style.display === 'none').length,
      notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
      marks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
      count: (document.querySelector('.ab-comments-count')?.textContent || '').trim(),
      noticeTexts: Array.from(document.querySelectorAll('[data-ab-prefix="ab-notice"]')).map(n => (n.textContent||'').trim().slice(0,70)),
    }, null, 2)`);
    console.log('\n=== 页面 DOM ===');
    console.log(dom);
    pc.close();
  }

  browser.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
