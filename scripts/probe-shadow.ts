
export {};
(() => {
  const app = document.getElementById('commentapp');
  const out: Record<string, any> = { hasApp: !!app };
  if (!app) return JSON.stringify(out);

  out.appChildTags = Array.from(app.children).map((c) => c.tagName);
  out.appChildCount = app.children.length;

  // 逐层看 app 的后代里有没有闭合 shadow root
  const chain: any[] = [];
  let node: Element | null = app;
  for (let depth = 0; depth < 5 && node; depth++) {
    const child = node.firstElementChild;
    if (!child) { chain.push({ depth, stop: 'no child' }); break; }
    const sr = child.shadowRoot;
    chain.push({
      depth,
      tag: child.tagName,
      cls: (typeof child.className === 'string' ? child.className : '').slice(0, 60),
      hasShadowRootProp: 'shadowRoot' in child,
      shadowRootAccessible: !!sr,
      childCount: child.children.length,
      innerLen: sr ? sr.innerHTML.length : (child.innerHTML || '').length,
    });
    node = sr ? sr.firstElementChild : child.firstElementChild;
  }
  out.chain = chain;

  // 全页统计：哪些元素是自定义元素（带 - 的 tag）
  const customTags = new Set();
  for (const el of document.querySelectorAll('*')) {
    if (el.tagName.includes('-')) customTags.add(el.tagName);
  }
  out.customElements = Array.from(customTags).slice(0, 30);

  // 尝试从 shadow host 里读 closed shadow
  const hosts = Array.from(document.querySelectorAll('*')).filter((e) => e.shadowRoot);
  out.openShadowHosts = hosts.map((h) => ({
    tag: h.tagName,
    cls: (typeof h.className === 'string' ? h.className : '').slice(0, 50),
    children: h.shadowRoot?.children.length ?? -1,
  }));

  return JSON.stringify(out, null, 2);
})()
