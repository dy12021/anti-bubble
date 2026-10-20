(async () => {
  const out = {};
  try {
    const st = await chrome.storage.local.get(null);
    out.storageKeys = Object.keys(st);
    out.settings = st['settings'] ?? null;
    out.hasProfile = !!st['profile'];
    out.hasLlmConfig = !!st['llmConfig'];
    out.wordlistCacheKeys = st['wordlistCache'] ? Object.keys(st['wordlistCache']).length : 0;
    out.verdictCacheKeys = st['verdictCache'] ? Object.keys(st['verdictCache']).length : 0;
  } catch (e) {
    out.storageError = String(e);
  }

  // service worker 里能不能拿到 B 站 API（预期不能：没有 SESSDATA）
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
    });
    const j = await res.json();
    out.navFromServiceWorker = { code: j.code, isLogin: j.data?.isLogin };
  } catch (e) {
    out.navFromServiceWorker = 'FETCH_FAILED: ' + String(e).slice(0, 200);
  }

  out.manifest = chrome.runtime.getManifest().name + ' v' + chrome.runtime.getManifest().version;
  return JSON.stringify(out, null, 2);
})()
