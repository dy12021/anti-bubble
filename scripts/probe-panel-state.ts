
export {};
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);

  const panel = document.querySelector('[data-ab-prefix="ab-comments"]');
  const native = document.getElementById('commentapp');
  const out: Record<string, any> = {
    url: location.href.slice(0, 60),
    panelExists: !!panel,
    nativeHidden: native ? native.style.display === 'none' : null,
    commentsRendered: document.querySelectorAll('[data-ab-rpid]').length,
    notices: document.querySelectorAll('[data-ab-prefix="ab-notice"]').length,
    marks: document.querySelectorAll('[data-ab-prefix="ab-mark"]').length,
    stylesInjected: !!document.querySelector('[data-ab-prefix="ab-styles"]'),
    statusText: (document.querySelector('.ab-comments-status')?.textContent || '').trim(),
    headText: (document.querySelector('.ab-comments-head')?.textContent || '').trim().slice(0, 60),
  };

  // 扩展的日志
  out.ourConsole = [];
  return JSON.stringify(out, null, 2);
})()
