/**
 * 端到端（唯一入口）：真实 B 站视频页 + 真实 LLM。
 *
 * 一个进程做完所有事，避免多个脚本抢同一个页面互相破坏状态：
 *   装扩展 → 注入 LLM 配置 → 刷新页面 → 轮询判定结果 → 报告
 *
 * 推理模型每次调用 10-60 秒，词表 + 精判两次调用，所以要等 2-3 分钟。
 */
import { writeFileSync, readFileSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const URL_ = process.env.TARGET_URL ?? 'https://www.bilibili.com/video/BV1GJ411x7h7/';
const WAIT_MS = Number(process.env.WAIT_MS ?? 180000);

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
      throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
    }
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);

  // ① 装扩展
  const loaded = await browser.send('Extensions.loadUnpacked', {
    path: 'D:\\coding\\anti-bubble\\dist',
  });
  const extId = loaded?.id as string;
  console.log('扩展 id:', extId);

  // ② 注入 LLM 配置
  //
  // 用**扩展页面**（popup）注入，不用 service worker：
  // SW 刚被 loadUnpacked 拉起时，CDP 连上去的默认执行上下文还没就绪，
  // 会报 "chrome is not defined"。扩展页面则一定有完整的 chrome.* API。
  const toml = readFileSync('D:\\coding\\llm-quant\\config.toml', 'utf8');
  const grab = (k: string): string => {
    const m = toml.match(new RegExp(`^\\s*${k}\\s*=\\s*"([^"]*)"`, 'm'));
    return m ? m[1]! : '';
  };
  const cfg = {
    provider: 'openai',
    baseUrl: grab('base_url'),
    apiKey: grab('api_key'),
    model: grab('model'),
    timeoutMs: 120000,
    maxTokens: 8192,
  };
  if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
    console.error('从 config.toml 读 LLM 配置失败');
    process.exit(1);
  }

  const { targetId: popupId } = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extId}/src/popup/index.html`,
  });
  await new Promise((r) => setTimeout(r, 2000));
  const popupList = (await httpJson('/json/list')) as any[];
  const popupTarget = popupList.find((t) => t.id === popupId);
  if (!popupTarget) {
    console.error('popup 页面没起来');
    process.exit(1);
  }
  const popupCdp = await Cdp.connect(popupTarget.webSocketDebuggerUrl);
  const injected = await popupCdp.eval(`(async () => {
    const cfg = ${JSON.stringify(cfg)};
    await chrome.storage.local.set({ llmConfig: cfg });
    const back = await chrome.storage.local.get(['llmConfig']);
    return JSON.stringify({ saved: !!back.llmConfig, model: back.llmConfig?.model, maxTokens: back.llmConfig?.maxTokens });
  })()`);
  console.log('LLM 配置注入:', injected);
  popupCdp.close();
  await browser.send('Target.closeTarget', { targetId: popupId });

  // ③ 找到页面并刷新
  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page');
  if (!page) {
    console.error('没有页面');
    process.exit(1);
  }
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
        panel: !!document.querySelector('[data-ab-prefix="ab-comments"]'),
        comments: document.querySelectorAll('[data-ab-rpid]').length,
        notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
        marks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
        hidden: Array.from(document.querySelectorAll('[data-ab-rpid]')).filter(e => e.style.display === 'none').length,
        count: (document.querySelector('.ab-comments-count')?.textContent || '').trim(),
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
    } else if (e.method === 'Runtime.exceptionThrown') {
      const d = e.params.exceptionDetails;
      const desc = String(d?.exception?.description ?? d?.text ?? '');
      if (desc.includes('anti-bubble') || desc.includes('chunk')) {
        console.log('[EXCEPTION] ' + desc.slice(0, 400));
      }
    }
  }

  // 后台各阶段
  const sw2 = (await httpJson('/json/list')).find((t: any) => t.type === 'service_worker');
  if (sw2) {
    const s2 = await Cdp.connect(sw2.webSocketDebuggerUrl);
    const bg = await s2.eval(`(async () => {
      const st = await chrome.storage.local.get(null);
      const wl = st['wordlistCache'] ?? {};
      const vc = st['verdictCache'] ?? {};
      const bl = st['blockedLog'] ?? [];
      return JSON.stringify({
        wordlistCount: Object.keys(wl).length,
        wordlists: Object.values(wl).slice(0, 2).map(v => ({
          patterns: v.patterns?.slice(0, 6) ?? [],
          stance: String(v.stance ?? '').slice(0, 80),
          oppositeKeywords: v.oppositeKeywords ?? [],
        })),
        verdictCount: Object.keys(vc).length,
        verdictActions: Object.values(vc).reduce((m, v) => { m[v.action] = (m[v.action]||0)+1; return m; }, {}),
        nonPass: Object.values(vc).filter(v => v.action !== 'pass').slice(0, 5).map(v => ({
          action: v.action, reason: v.reason, reasonCode: v.reasonCode, confidence: v.confidence,
        })),
        blockedLogCount: bl.length,
        blockedLog: bl.slice(0, 5),
      }, null, 2);
    })()`);
    console.log('\n=== 后台状态 ===');
    console.log(bg);
    s2.close();
  }

  console.log('\n=== 页面最终状态 ===');
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
  const out = 'D:\\coding\\anti-bubble\\docs\\e2e-result.png';
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('\n截图已存:', out);

  cdp.close();
  browser.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
