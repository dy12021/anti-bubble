
export {};
(() => {
  const app = document.getElementById('commentapp');
  const out: Record<string, any> = {};
  if (!app) return JSON.stringify({ err: 'no #commentapp' });

  const bili = app.querySelector('bili-comments');
  const sr = bili?.shadowRoot ?? null;
  out.biliExists = !!bili;
  out.shadowAccessible = !!sr;
  out.srTextLen = sr ? (sr.textContent || '').length : -1;
  out.srText = sr ? (sr.textContent || '').trim().replace(/\s+/g, ' | ').slice(0, 400) : '';
  out.srHtmlHead = sr ? sr.innerHTML.slice(0, 600) : '';
  out.appText = (app.textContent || '').trim().replace(/\s+/g, ' | ').slice(0, 300);

  // 页面里有没有登录提示
  const bodyText = document.body.innerText;
  out.hasLoginPrompt = /登录后|请先登录|需要登录|评论功能/.test(bodyText);
  out.loginPromptSnippets = (bodyText.match(/.{0,20}(登录后|请先登录|需要登录).{0,20}/g) || []).slice(0, 3);

  // 页面是否处于未登录状态
  out.isLoginHeader = !!(document.querySelector('.bili-mini-header .login-btn, .header-entry .login-btn, [class*="login-btn"]'));

  return JSON.stringify(out, null, 2);
})()
