/**
 * 在页面上下文里实打实验证：B 站评论 API 能不能调通（带 WBI 签名）。
 *
 * 这决定了视频页的方案：DOM 读不到（closed shadow root），
 * 只能走 API + 自渲染评论区。
 */
(async () => {
  const out = {};

  // --- WBI 签名（与扩展里同一套算法）---
  const MIXIN_KEY_ENC_TAB = [
    46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
    33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,
    61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,
    36,20,34,44,52,
  ];

  function md5(input) {
    const bytes = [];
    for (let i = 0; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    let bl = bitLen;
    for (let i = 0; i < 8; i++) { bytes.unshift(bl & 0xff); bl = Math.floor(bl / 256); }
    const M = new Uint32Array(16);
    const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K = new Uint32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
    const rot = (x,c) => ((x << c) | (x >>> (32 - c))) >>> 0;
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        M[i] = (bytes[j] | (bytes[j+1] << 8) | (bytes[j+2] << 16) | (bytes[j+3] << 24)) >>> 0;
      }
      let A=a0,B=b0,C=c0,D=d0;
      for (let i = 0; i < 64; i++) {
        let F,g;
        if (i<16) { F=(B&C)|(~B&D); g=i; }
        else if (i<32) { F=(D&B)|(~D&C); g=(5*i+1)%16; }
        else if (i<48) { F=B^C^D; g=(3*i+5)%16; }
        else { F=C^(B|~D); g=(7*i)%16; }
        F=(F+A+K[i]+M[g])>>>0;
        A=D; D=C; C=B; B=(B+rot(F,S[i]))>>>0;
      }
      a0=(a0+A)>>>0; b0=(b0+B)>>>0; c0=(c0+C)>>>0; d0=(d0+D)>>>0;
    }
    const le=(n)=>{const b=new Uint8Array(4);b[0]=n&0xff;b[1]=(n>>>8)&0xff;b[2]=(n>>>16)&0xff;b[3]=(n>>>24)&0xff;return b;};
    const o=new Uint8Array([...le(a0),...le(b0),...le(c0),...le(d0)]);
    let hex=''; for(const b of o) hex+=b.toString(16).padStart(2,'0');
    return hex;
  }

  const get = async (url) => {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 200), __status: r.status }; }
  };

  // 1) nav 拿 WBI 密钥
  const nav = await get('https://api.bilibili.com/x/web-interface/nav');
  out.navCode = nav.code;
  out.hasWbi = !!nav.data?.wbi_img?.img_url;
  if (!out.hasWbi) {
    out.navRaw = JSON.stringify(nav).slice(0, 300);
    return JSON.stringify(out, null, 2);
  }
  const keyOf = (u) => (u.match(/\/([^/]+)\.[^./]+$/) || [])[1] || '';
  const raw = keyOf(nav.data.wbi_img.img_url) + keyOf(nav.data.wbi_img.sub_url);
  let mixin = '';
  for (const i of MIXIN_KEY_ENC_TAB) { if (i < raw.length) mixin += raw[i]; if (mixin.length === 32) break; }

  const sign = (params) => {
    const s = {};
    for (const [k, v] of Object.entries(params)) s[k] = String(v).replace(/[!'()*]/g, '');
    s['wts'] = Math.floor(Date.now() / 1000);
    const q = Object.keys(s).sort()
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(s[k])}`).join('&');
    return { ...s, w_rid: md5(q + mixin) };
  };

  // 2) 视频详情拿 aid
  const bvid = (location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) || [])[1];
  out.bvid = bvid;
  const view = await get('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
  out.viewCode = view.code;
  const aid = view.data?.aid;
  out.aid = aid;
  if (!aid) { out.viewRaw = JSON.stringify(view).slice(0, 300); return JSON.stringify(out, null, 2); }

  // 3) 评论接口（带 WBI 签名）
  const p = sign({ type: 1, oid: aid, mode: 3, ps: 20, web_location: 1315875 });
  const q = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join('&');
  const cmt = await get('https://api.bilibili.com/x/v2/reply/wbi/main?' + q);
  out.commentCode = cmt.code;
  out.commentMsg = cmt.message;
  const replies = cmt.data?.replies ?? [];
  out.replyCount = replies.length;
  out.hasMore = cmt.data?.page?.has_more;
  out.cursor = cmt.data?.page?.cursor;
  out.samples = replies.slice(0, 3).map((r) => ({
    rpid: r.rpid,
    user: r.member?.uname,
    text: (r.content?.message ?? '').slice(0, 50),
    like: r.like,
  }));
  return JSON.stringify(out, null, 2);
})()
