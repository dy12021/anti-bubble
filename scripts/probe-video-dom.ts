(() => {
  const names = new Set();
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      const cn = typeof el.className === 'string' ? el.className : '';
      if (cn) {
        for (const c of cn.split(/\s+/)) {
          if (/comment|reply|bili-|bpx-/i.test(c)) names.add(c);
        }
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  // 评论区容器在哪
  const containers = Array.from(document.querySelectorAll('div,section,aside'))
    .filter((el) => {
      const id = el.id || '';
      const cn = typeof el.className === 'string' ? el.className : '';
      return /comment|reply/i.test(id + ' ' + cn);
    })
    .slice(0, 12)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id,
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        childCount: el.children.length,
        shadow: !!el.shadowRoot,
      };
    });

  return JSON.stringify({
    url: location.href.slice(0, 80),
    bodyTextLen: document.body.innerText.length,
    bodyTextHead: document.body.innerText.slice(0, 300).replace(/\n+/g, ' | '),
    candidateClasses: Array.from(names).slice(0, 60),
    containers,
    scrollHeight: document.documentElement.scrollHeight,
  }, null, 2);
})()
