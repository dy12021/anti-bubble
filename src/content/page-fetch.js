/**
 * 页面上下文（main world）里的 fetch 代理。
 *
 * 为什么必须在**页面上下文**执行才能带上 Cookie
 * ----------------------------------------------
 * B 站 API 的鉴权靠 Cookie `SESSDATA`。页面上下文（main world）与页面共享
 * 同一个 origin 和同一份 cookie jar，浏览器会按同源策略自动把 SESSDATA 附在
 * fetch 上——所以用户完全不需要手动导出任何凭据。
 *
 * 而 content script 跑在**隔离世界**里：它既改不了页面的 window，MV3 也禁用
 * `eval` / `new Function`，没法在页面里动态生成代码去发请求。所以唯一的路是
 * 由 content script 把这个文件当普通 <script> 注入进来，让它在页面里跑，
 * 然后两边用 window.postMessage 配对。
 *
 * 本文件是**纯 JavaScript**：它会在页面上下文里原样执行，不能带任何 TS 语法。
 *
 * 协议（与 src/content/page-bridge.ts 保持一致）：
 *   请求 { __ab: true, id, url }
 *   响应 { __ab: true, id, ok: true, payload } | { __ab: true, id, ok: false, error }
 */
(function () {
  'use strict';

  // 防重复注入：同一页面可能反复注入，重复监听会重复发请求。
  if (window.__antiBubblePageFetch) return;
  window.__antiBubblePageFetch = true;

  /** 只允许 B 站 API 域名。页面里的任何脚本都能 postMessage 过来，
   *  这个通道绝不能变成任意地址的代理。 */
  var BILI_API_PATTERN = /^https:\/\/api\.bilibili\.com\//;

  function post(msg) {
    window.postMessage(msg, '*');
  }

  window.addEventListener('message', function (e) {
    var data = e.data;
    if (!data || data.__ab !== true) return;
    if (typeof data.id !== 'string' || !data.id) return;
    if (typeof data.url !== 'string' || !data.url) return;

    var id = data.id;
    var url = data.url;

    if (!BILI_API_PATTERN.test(url)) {
      post({ __ab: true, id: id, ok: false, error: 'blocked url' });
      return;
    }

    // credentials: 'include' —— 浏览器自动带上 SESSDATA，不需要用户导出 Cookie。
    fetch(url, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        return res.json();
      })
      .then(function (payload) {
        post({ __ab: true, id: id, ok: true, payload: payload });
      })
      .catch(function (err) {
        var message = err && err.message ? err.message : String(err);
        post({ __ab: true, id: id, ok: false, error: message });
      });
  });
})();
