
export {};
(async () => {
  const out: Record<string, any> = {};
  try {
    const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    out.status = res.status;
    out.ok = res.ok;
    out.contentType = res.headers.get('content-type');
    const text = await res.text();
    out.bodyLen = text.length;
    out.bodyHead = text.slice(0, 300);
  } catch (e) {
    out.error = String(e);
  }
  return JSON.stringify(out, null, 2);
})()
