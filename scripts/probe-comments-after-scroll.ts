
export {};
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 滚到评论区
  const app = document.getElementById('commentapp');
  if (app) app.scrollIntoView({ block: 'start' });
  else window.scrollTo(0, 1200);
  await sleep(4000);

  // 触发懒加载
  window.scrollBy(0, 400);
  await sleep(3000);

  function deepCount(selector: string) {
    let n = 0;
    const walk = (root: Document | ShadowRoot) => {
      n += root.querySelectorAll(selector).length;
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return n;
  }
  function deepFirst(selector: string) {
    const found: any[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll(selector)) {
        if (found.length < 2) {
          found.push({
            cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
            id: el.id,
            rpid: el.getAttribute?.('data-rpid') ?? el.getAttribute?.('data-id') ?? null,
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
            attrs: Array.from(el.attributes).map((a) => a.name).slice(0, 12),
          });
        }
      }
      for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    return found;
  }

  return JSON.stringify({
    scrollY: Math.round(window.scrollY),
    deep: {
      replyItem: deepCount('.reply-item'),
      replyItemRpid: deepCount('.reply-item[data-rpid]'),
      biliCommentThread: deepCount('.bili-comment-thread-renderer'),
      bpxComment: deepCount('.bpx-comment'),
      replyContent: deepCount('.reply-content'),
      commentItem: deepCount('.comment-item'),
      rootThread: deepCount('.root-thread-container'),
    },
    shadowHosts: (() => { let n = 0; const w = (r) => { for (const e of r.querySelectorAll('*')) if (e.shadowRoot) { n++; w(e.shadowRoot); } }; w(document); return n; })(),
    firstReplyItems: deepFirst('.reply-item'),
    firstBiliThread: deepFirst('.bili-comment-thread-renderer'),
    firstBpxComment: deepFirst('.bpx-comment'),
    commentappChildren: document.getElementById('commentapp')?.children.length ?? -1,
  }, null, 2);
})()
