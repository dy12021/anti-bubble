/**
 * 识别页面上那个浮层小窗口是什么。
 * 用 DOM.getNodeForLocation 反查坐标处的元素，再看它的 class/id/所属脚本。
 */
export {};

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';
const X = Number(process.env.PROBE_X ?? 470);
const Y = Number(process.env.PROBE_Y ?? 245);

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
      }, 20000);
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
  const targets = await listTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有页面');
  console.log('页面:', page.url);

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  await cdp.send('DOM.enable');
  await cdp.send('Runtime.enable');

  // 1) 反查坐标处的元素
  try {
    const hit = await cdp.send('DOM.getNodeForLocation', { x: X, y: Y, includeUserAgentShadowDOM: true });
    const nodeId = hit?.backendNodeId;
    const desc = await cdp.send('DOM.describeNode', { backendNodeId: nodeId });
    const attrs = desc?.node?.attributes ?? [];
    const attrMap: Record<string, string> = {};
    for (let i = 0; i < attrs.length; i += 2) attrMap[attrs[i]] = attrs[i + 1];
    console.log('\n=== 坐标处的元素 ===');
    console.log('tag     :', desc?.node?.nodeName);
    console.log('id      :', attrMap['id'] ?? '(无)');
    console.log('class   :', (attrMap['class'] ?? '(无)').slice(0, 200));
  } catch (e) {
    console.log('getNodeForLocation 失败:', e instanceof Error ? e.message : String(e));
  }

  // 2) 找出页面上所有看起来像浮层/弹窗的容器
  const overlays = await cdp.eval(`(() => {
    const out = [];
    const sels = ['[class*="float"]','[class*="popup"]','[class*="panel"]','[class*="mask"]',
                   '[class*="modal"]','[class*="drawer"]','[class*="dropdown"]','[class*="mega"]',
                   '[class*="header-nav"]','[class*="nav-bar"]','[class*="nav_panel"]'];
    const seen = new Set();
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 150) continue;
        if (r.top > 900 || r.left > 1200) continue;
        const key = el.className + '|' + Math.round(r.left) + '|' + Math.round(r.top);
        if (seen.has(key)) continue;
        seen.add(key);
        const cs = getComputedStyle(el);
        out.push({
          sel,
          cls: String(el.className).slice(0, 90),
          id: el.id || '',
          rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          position: cs.position,
          zIndex: cs.zIndex,
          display: cs.display,
          visibility: cs.visibility,
          isOurExt: String(el.className).includes('ab-') || el.hasAttribute('data-ab-prefix'),
        });
      }
    }
    return JSON.stringify(out, null, 2);
  })()`);
  console.log('\n=== 页面上符合浮层特征的容器 ===');
  console.log(overlays);

  // 3) 扩展自己往页面里塞了什么
  const ours = await cdp.eval(`(() => {
    const ab = Array.from(document.querySelectorAll('[data-ab-prefix]'));
    const st = document.querySelector('[data-ab-prefix="ab-styles"]');
    return JSON.stringify({
      ourElementCount: ab.length,
      ourKinds: ab.reduce((m, e) => { const k = e.getAttribute('data-ab-prefix'); m[k] = (m[k]||0)+1; return m; }, {}),
      styleInjected: !!st,
      styleText: st ? (st.textContent || '').slice(0, 120) : '',
      styleParent: st ? st.parentElement?.tagName : null,
    }, null, 2);
  })()`);
  console.log('\n=== 扩展注入的东西 ===');
  console.log(ours);

  cdp.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
