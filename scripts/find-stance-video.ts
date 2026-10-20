/**
 * 找一个「有明确立场」的视频，用来验反信息茧房模式的反向推荐。
 *
 * 反向推荐需要视频本身有立场（不然「相反」无从谈起）。
 * 所以先在 B 站搜一个有争议的话题，取前几个结果出来挑。
 */
const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const QUERY = process.env.SEARCH_QUERY ?? '人工智能 取代 人类 工作';

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')); } }, 60000);
    });
  }
  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('JS: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result?.value;
  }
  close(): void { this.ws.close(); }
}

async function main(): Promise<void> {
  const targets = (await httpJson('/json/list')) as any[];
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
  const cdp = await Cdp.connect(page!.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', {
    url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(QUERY)}`,
  });
  await new Promise((r) => setTimeout(r, 9000));
  const raw = await cdp.eval(`JSON.stringify(
    Array.from(document.querySelectorAll('.bili-video-card')).map(card => {
      const a = card.querySelector('a[href*="/video/"]');
      const t = card.querySelector('.bili-video-card__info--tit');
      const m = (a ? a.getAttribute('href') : '') || '';
      return { bv: (m.match(/\\/video\\/(BV[0-9A-Za-z]+)/) || [])[1] || '', title: (t ? t.textContent : '').trim() };
    }).filter(x => x.bv && x.title).slice(0, 12)
  )`);
  const list = JSON.parse(raw) as { bv: string; title: string }[];
  console.log(`搜索「${QUERY}」前 ${list.length} 条：`);
  for (const x of list) console.log(`  ${x.bv}  ${x.title.slice(0, 50)}`);
  cdp.close();
}

main().catch((e) => { console.error('ERROR: ' + (e instanceof Error ? e.message : String(e))); process.exit(1); });
