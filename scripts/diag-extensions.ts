/**
 * 诊断：扩展到底有没有被 Chrome 加载。
 * 列出所有 target，并尝试在 chrome://extensions 页面里读扩展列表。
 */
export {};

const HOST = '127.0.0.1';
const PORT = process.env.CDP_PORT ?? '9333';

async function listTargets(): Promise<any[]> {
  const res = await fetch(`http://${HOST}:${PORT}/json/list`);
  return (await res.json()) as any[];
}

async function main(): Promise<void> {
  const targets = await listTargets();
  console.log('=== 全部 target ===');
  for (const t of targets) {
    console.log(`[${t.type}] ${t.title?.slice(0, 40) ?? ''} | ${t.url?.slice(0, 100) ?? ''}`);
  }

  const extTargets = targets.filter(
    (t) => typeof t.url === 'string' && t.url.startsWith('chrome-extension://'),
  );
  console.log('\n=== chrome-extension:// target 数 ===', extTargets.length);
  for (const t of extTargets) console.log('  ', t.url);

  // 打开 chrome://extensions 并读 shadow DOM 里的扩展列表
  const page = targets.find((t) => t.type === 'page');
  if (!page) return;

  const { default: http } = await import('node:http');
  void http;

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((resolve) => {
    ws.addEventListener('open', () => resolve(), { once: true });
  });

  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String((ev as MessageEvent).data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'chrome://extensions' });
  await new Promise((r) => setTimeout(r, 2500));

  // chrome://extensions 用 shadow DOM，直接查 manager 里的列表
  const res = await send('Runtime.evaluate', {
    expression: `(() => {
      const mgr = document.querySelector('extensions-manager');
      const list = mgr && mgr.shadowRoot
        ? mgr.shadowRoot.querySelector('extensions-item-list')
        : null;
      const items = list && list.shadowRoot
        ? Array.from(list.shadowRoot.querySelectorAll('extensions-item'))
        : [];
      return JSON.stringify({
        hasManager: !!mgr,
        itemCount: items.length,
        items: items.map(it => ({
          id: it.id,
          name: it.shadowRoot ? (it.shadowRoot.querySelector('#name')?.textContent ?? '').trim() : '',
          enabled: it.shadowRoot ? !!it.shadowRoot.querySelector('#enableToggle')?.checked : null,
        })),
      });
    })()`,
    returnByValue: true,
  });
  console.log('\n=== chrome://extensions 里的扩展 ===');
  console.log(res?.result?.value ?? JSON.stringify(res));
  ws.close();
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
