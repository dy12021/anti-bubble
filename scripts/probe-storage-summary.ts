/**
 * 读扩展的 storage：LLM 配置 + 画像 + 词表缓存 + 判定缓存摘要。
 * 只读，不发任何请求。
 */
const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const EXT_ID = process.env.EXT_ID ?? 'jlfdpgneomllhbpaiejjhoigophhejid';

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, 30000);
    });
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result?.value;
  }
  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const version = await httpJson('/json/version');
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/src/popup/index.html` });
  await new Promise((r) => setTimeout(r, 1500));
  const list = (await httpJson('/json/list')) as any[];
  const popup = list.find((t) => t.id === targetId);
  const cdp = await Cdp.connect(popup!.webSocketDebuggerUrl);
  const out = await cdp.eval(`(async () => {
    const st = await chrome.storage.local.get(null);
    const cfg = st['llmConfig'] ?? null;
    const prof = st['profile'] ?? null;
    const wl = st['wordlistCache'] ?? {};
    const vc = st['verdictCache'] ?? {};
    const bl = st['blockedLog'] ?? [];
    return JSON.stringify({
      llmConfig: cfg ? { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: cfg.timeoutMs, maxTokens: cfg.maxTokens, hasKey: !!(cfg.apiKey && cfg.apiKey.length > 4), keyLen: (cfg.apiKey||'').length } : null,
      profile: prof ? { sampleCount: prof.sampleCount, updatedAt: prof.updatedAt, interests: (prof.interests||[]).map(i=>i.tag), dislikes: prof.dislikes } : null,
      wordlistCount: Object.keys(wl).length,
      wordlists: Object.entries(wl).slice(0,3).map(([k,v]) => ({ key: k, subjectKey: v.subjectKey, patternCount: (v.patterns||[]).length, patterns: (v.patterns||[]).slice(0,10), stance: String(v.stance||'').slice(0,120) })),
      verdictCacheCount: Object.keys(vc).length,
      blockedLogCount: bl.length,
      blockedLogSample: bl.slice(0,5).map(b => ({ id: b.itemId, action: b.action, reason: b.reason, excerpt: String(b.excerpt||'').slice(0,50) })),
      allStorageKeys: Object.keys(st),
    }, null, 2);
  })()`);
  console.log(out);
  cdp.close();
  await browser.send('Target.closeTarget', { targetId });
  browser.close();
}

main().catch((e) => { console.error('ERROR: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
