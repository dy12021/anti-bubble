
export {};
(async () => {
  const out: Record<string, any> = {};
  try {
    out.hasOpener = !!window.opener;
    out.openerIsBili = !!(window.opener && /bilibili/.test(window.opener.location?.href ?? ''));
    try {
      out.openerHref = window.opener?.location?.href ?? null;
    } catch (e) {
      out.openerHref = 'cross-origin: ' + String(e).slice(0, 80);
    }
    out.isBilibiliHost = /bilibili/.test(location.hostname);
    out.referrer = document.referrer || '(空)';
    out.name = window.name || '(空)';
    // 是不是被 window.open 出来的（特征：有 opener、有 name、尺寸小）
    out.outerSmall = window.outerWidth < 700;
    // 页面里的 iframe 情况
    out.iframeCount = document.querySelectorAll('iframe').length;
    out.parentIsSelf = window.parent === window;
    out.topIsSelf = window.top === window;
    out.topHref = (() => { try { return window.top ? window.top.location.href : '(no top)'; } catch { return 'cross-origin'; } })();
    // B 站自己有没有在页面上留「打开新窗口」的痕迹
    out.navPanelExists = !!document.querySelector('[class*="nav-panel"], [class*="header-nav"], .bili-mini-header');
  } catch (e) {
    out.error = String(e);
  }
  return JSON.stringify(out, null, 2);
})()
