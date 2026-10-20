/**
 * 真机验证主脚本。
 *
 * 一次性做完：装扩展 → 注 LLM 配置 → 清缓存 → 打开目标页 → 等判定 → 报告。
 *
 * ## 两个必须知道的坑
 *
 * 1. **Service Worker ScriptCache 会跑旧代码**
 *    重新 build 之后，同一个 Chrome profile 里 `Extensions.loadUnpacked`
 *    加载的扩展，Chrome 仍然从 profile 的 Service Worker/ScriptCache 里
 *    取**旧的** service worker 脚本。于是新代码改了却看不到效果，
 *    还会返回旧版本的错误串（当时排查这个花了不少时间）。
 *    → 所以每次验证必须用**全新的 profile 目录**。
 *
 * 2. **Key 不进代码、不进日志**
 *    LLM 配置从 llm-quant 的 config.toml 读，注入到扩展 storage，
 *    整个过程不打印 Key。
 *
 * 用法：
 *   node --experimental-strip-types scripts/e2e-verify.ts
 *   PAGE=search|video|feed node --experimental-strip-types scripts/e2e-verify.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const DIST = 'D:\\coding\\anti-bubble\\dist';
const CONFIG_TOML = 'D:\\coding\\llm-quant\\config.toml';
const PAGE = process.env.PAGE ?? 'search';
const MODE = process.env.MODE ?? 'cocoon';
const WAIT_S = Number(process.env.WAIT_S ?? 240);
const QUERY = process.env.SEARCH_QUERY ?? '华为 手机';

function log(s: string): void {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
}

/** 从 llm-quant 的 config.toml 读 [llm] 段。Key 只进内存，不打印。 */
function readLlmConfig(): { provider: string; baseUrl: string; apiKey: string; model: string; timeoutMs: number; maxTokens: number } {
  const raw = readFileSync(CONFIG_TOML, 'utf8');
  // 只取 [llm] 段内的键
  const section = raw.split(/\r?\n/).filter((l) => !/^\s*\[/.test(l) || /^\s*\[llm\]/.test(l));
  const llmSection: string[] = [];
  let inLlm = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { inLlm = /^\s*\[llm\]/.test(line); continue; }
    if (inLlm) llmSection.push(line);
  }
  void section;
  const pick = (key: string): string => {
    for (const line of llmSection) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["'](.*)["']`));
      if (m) return m[1]!;
    }
    return '';
  };
  const apiKey = pick('api_key');
  const baseUrl = pick('base_url');
  const model = pick('model');
  if (!apiKey || !baseUrl || !model) throw new Error('config.toml 里读不到 llm 配置');
  return {
    provider: 'openai',
    baseUrl,
    apiKey,
    model,
    timeoutMs: 240000,
    maxTokens: Number(pick('max_completion_tokens') || 8192),
    // 判据抽取/立场分类是简单活，深度思考纯属浪费：实测 low 4.8s vs 默认 20s+。
    reasoningEffort: (process.env.EFFORT ?? 'low') as 'low' | 'medium' | 'high',
  };
}

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
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)); }
      }, 300000);
    });
  }

  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result?.value;
  }

  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);

  // ① 装扩展（用 loadUnpacked 的返回值拿 id，别写死）
  const loaded = await browser.send('Extensions.loadUnpacked', { path: DIST });
  const extId = loaded?.id as string;
  log(`扩展已加载 id=${extId}`);

  // ② 注 LLM 配置 + 清缓存
  const cfg = readLlmConfig();
  const { targetId: popupId } = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extId}/src/popup/index.html`,
  });
  await new Promise((r) => setTimeout(r, 1800));
  const pl = (await httpJson('/json/list')) as any[];
  const popup = pl.find((t) => t.id === popupId);
  const popupCdp = await Cdp.connect(popup!.webSocketDebuggerUrl);

  const injected = await popupCdp.eval(`(async () => {
    await chrome.storage.local.set({ llmConfig: ${JSON.stringify(cfg)} });
    await chrome.storage.local.remove(['verdictCache', 'wordlistCache', 'blockedLog', 'profile']);
    // 注入一份画像（可选）：验证「画像 → 折叠」这条路径——
    // 冷启动画像需要登录 B 站，测试环境未登录，只能用注入的方式验。
    const injectProfile = ${JSON.stringify(process.env.INJECT_PROFILE ?? '')};
    if (injectProfile) {
      const dislikes = injectProfile.split(',').map(s => s.trim()).filter(Boolean);
      await chrome.storage.local.set({
        profile: {
          interests: [{ tag: '数码', weight: 0.8 }],
          dislikes,
          stanceHints: {},
          topics: ['手机'],
          updatedAt: new Date().toISOString(),
          sampleCount: 10,
        },
      });
    }
    // 模式切换（cocoon=信息茧房 / anti=反信息茧房）
    await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: 'SET_SETTINGS', id: 'set-mode',
          payload: {
            settings: {
              mode: ${JSON.stringify(MODE)},
              ...(${JSON.stringify(MODE)} === 'anti'
                ? { antiTriggerSeconds: Number(${JSON.stringify(process.env.ANTI_TRIGGER_S ?? '15')}) }
                : {}),
            },
          },
        },
        () => { void chrome.runtime.lastError; resolve(null); },
      );
    });
    const st = await chrome.storage.local.get(['llmConfig', 'settings', 'profile']);
    const c = st['llmConfig'];
    return JSON.stringify({ model: c.model, baseUrl: c.baseUrl, maxTokens: c.maxTokens, keyLen: (c.apiKey||'').length, mode: st['settings']?.mode, profileDislikes: st['profile']?.dislikes ?? null });
  })()`);
  log('LLM 配置已注入: ' + injected);
  popupCdp.close();
  await browser.send('Target.closeTarget', { targetId: popupId });

  // ③ 打开目标页
  const videoBvid = process.env.VIDEO_BVID ?? 'BV1GJ411x7h7';
  const url =
    PAGE === 'search' ? `https://search.bilibili.com/all?keyword=${encodeURIComponent(QUERY)}`
    : PAGE === 'feed' ? 'https://www.bilibili.com/'
    : `https://www.bilibili.com/video/${videoBvid}`;

  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  if (!page) { console.error('没有内容页面'); process.exit(1); }
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  log('打开 ' + url);
  await cdp.send('Page.navigate', { url });
  await new Promise((r) => setTimeout(r, 6000));

  // ④ 轮询等判定
  let state: any = null;
  const trigger = Number(process.env.ANTI_TRIGGER_S ?? '15');
  for (let i = 0; i < WAIT_S / 10; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    // 模拟「用户已经看了一会儿」。
    //
    // 自动化环境里标签页是 hidden 的，Chrome 会把后台媒体的播放
    // 限速到 1/25 左右，所以等真机 60 秒根本不现实。
    // 直接把播放进度拖到阈值之后，触发器就会到位——
    // 验证的是「到点会不会触发」，不是「播放速率」。
    if (MODE === 'anti') {
      const seekRes = await cdp.eval(`(() => {
        const v = document.querySelector('video');
        if (!v) return 'no-video';
        v.muted = true;
        try { void v.play(); } catch (e) {}
        if (v.currentTime < ${trigger + 15}) v.currentTime = ${trigger + 15};
        return 'ct=' + v.currentTime + ' paused=' + v.paused + ' rs=' + v.readyState;
      })()`);
      log(`  拖进度: ${seekRes}`);
    }
    state = JSON.parse((await cdp.eval(`JSON.stringify({
      url: location.href,
      cards: document.querySelectorAll('.bili-video-card').length,
      comments: document.querySelectorAll('.ab-comment').length,
      notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
      marks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
      hidden: Array.from(document.querySelectorAll('.bili-video-card')).filter(e => e.style.display === 'none').length,
      recBlock: !!document.querySelector('[data-ab-prefix="ab-recommend"]'),
      recItems: document.querySelectorAll('[data-ab-prefix="ab-recommend-item"]').length,
    })`)) as string);
    log(`  t+${(i + 1) * 10}s ${JSON.stringify(state)}`);
    if (state.notices > 0 || state.marks > 0 || state.recItems > 0) break;
  }

  // ⑤ 扩展日志
  log('=== 页面控制台（扩展）===');
  for (const e of cdp.events) {
    if (e.method === 'Runtime.consoleAPICalled') {
      const p = e.params;
      const text = (p.args ?? []).map((a: any) => a.value ?? a.description ?? a.type).join(' ');
      if (text.includes('anti-bubble')) log(`[${p.type}] ${text}`);
    }
  }

  // ⑥ 后台状态 + 折叠详情
  const { targetId: p2 } = await browser.send('Target.createTarget', {
    url: `chrome-extension://${extId}/src/popup/index.html`,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const l2 = (await httpJson('/json/list')) as any[];
  const p2cdp = await Cdp.connect(l2.find((t) => t.id === p2)!.webSocketDebuggerUrl);
  const bg = await p2cdp.eval(`(async () => {
    const st = await chrome.storage.local.get(['wordlistCache','verdictCache','blockedLog','profile','watchLog','settings']);
    const wl = st['wordlistCache'] ?? {};
    const vc = st['verdictCache'] ?? {};
    const bl = st['blockedLog'] ?? [];
    const acts = {};
    for (const v of Object.values(vc)) acts[v.action] = (acts[v.action]||0)+1;
    const watchLog = st['watchLog'] ?? [];
    return JSON.stringify({
      mode: st['settings']?.mode ?? null,
      watchLogCount: Array.isArray(watchLog) ? watchLog.length : 0,
      watchLogSample: Array.isArray(watchLog) ? watchLog.slice(0,3).map(s => ({
        id: s.id, title: String(s.title||'').slice(0,40), watchSeconds: s.watchSeconds, category: s.category,
      })) : [],
      wordlistCount: Object.keys(wl).length,
      wordlists: Object.values(wl).slice(0,2).map(v => ({
        subjectKey: v.subjectKey, patternCount: (v.patterns||[]).length,
        patterns: (v.patterns||[]).slice(0,12), stance: String(v.stance||'').slice(0,160),
        oppositeKeywords: (v.oppositeKeywords||[]).slice(0,8),
      })),
      verdictCacheCount: Object.keys(vc).length, verdictActions: acts,
      blockedLogCount: bl.length,
      blockedLog: bl.slice(0,8).map(b => ({ id: b.itemId, action: b.action, reason: b.reason, code: b.reasonCode, excerpt: String(b.excerpt||'').slice(0,60) })),
      profile: st['profile'] ? { sampleCount: st['profile'].sampleCount, dislikes: st['profile'].dislikes } : null,
    }, null, 2);
  })()`);
  log('=== 后台状态 ===\n' + bg);
  p2cdp.close();
  await browser.send('Target.closeTarget', { targetId: p2 });

  // ⑦ 撤销验证：折叠走「仍要显示」按钮，标识走「点标签」
  const revoke = await cdp.eval(`(() => {
    const out = {};
    const notice = document.querySelector('[data-ab-prefix="ab-notice"]');
    if (notice) {
      const id = notice.getAttribute('data-item-id');
      const btn = notice.querySelector('[data-ab-prefix="ab-revoke"]');
      const hiddenBefore = Array.from(document.querySelectorAll('.bili-video-card')).filter(e => e.style.display === 'none').length;
      const reason = (notice.textContent || '').trim().slice(0, 80);
      if (btn) btn.click();
      const hiddenAfter = Array.from(document.querySelectorAll('.bili-video-card')).filter(e => e.style.display === 'none').length;
      out.fold = { found: true, id, reason, hasRevoke: !!btn, hiddenBefore, hiddenAfter,
        noticeGone: !document.querySelector('[data-ab-prefix="ab-notice"][data-item-id="' + id + '"]') };
    } else {
      out.fold = { found: false };
    }

    const mark = document.querySelector('[data-ab-prefix="ab-mark"]');
    if (mark) {
      const id = mark.getAttribute('data-item-id');
      const text = (mark.textContent || '').trim().slice(0, 50);
      mark.click();
      out.mark = { found: true, id, text, gone: !document.querySelector('[data-ab-prefix="ab-mark"][data-item-id="' + id + '"]') };
    } else {
      out.mark = { found: false };
    }

    const rec = document.querySelector('[data-ab-prefix="ab-recommend"]');
    if (rec) {
      out.recommend = {
        found: true,
        title: (rec.querySelector('.ab-recommend-title')||{}).textContent || '',
        items: Array.from(rec.querySelectorAll('[data-ab-prefix="ab-recommend-item"]')).map(r => ({
          title: (r.querySelector('a')||{}).textContent || '',
          reason: (r.querySelector('.ab-recommend-reason')||{}).textContent || '',
          href: (r.querySelector('a')||{}).getAttribute?.('href') || '',
        })),
      };
    } else {
      const empty = document.querySelector('[data-ab-prefix="ab-recommend-empty"]');
      out.recommend = empty
        ? { found: false, emptyState: (empty.textContent || '').trim().slice(0, 60) }
        : { found: false };
    }
    return JSON.stringify(out);
  })()`);
  log('=== 撤销 / 推荐验证 ===\n' + revoke);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const out = `D:\\coding\\anti-bubble\\docs\\e2e-${PAGE}.png`;
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  log('截图: ' + out);

  cdp.close();
  browser.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
