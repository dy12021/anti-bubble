/**
 * 找出 B 站评论接口能通通的参数/请求头组合。
 *
 * 背景：裸调 /x/v2/reply/wbi/main 返回 -403 访问权限不足。
 * 逐项加东西，看哪个是关键。
 */
export {};

(async () => {
  const MIXIN_KEY_ENC_TAB = [
    46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,
    33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,
    61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,
    36,20,34,44,52,
  ];
  function md5(input) {
    const bytes: number[] = [];
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
      for (let i = 0; i < 16; i++) { const j = off + i*4; M[i] = (bytes[j] | (bytes[j+1]<<8) | (bytes[j+2]<<16) | (bytes[j+3]<<24)) >>> 0; }
      let A=a0,B=b0,C=c0,D=d0;
      for (let i = 0; i < 64; i++) {
        let F,g;
        if (i<16){F=(B&C)|(~B&D);g=i;} else if(i<32){F=(D&B)|(~D&C);g=(5*i+1)%16;}
        else if(i<48){F=B^C^D;g=(3*i+5)%16;} else {F=C^(B|~D);g=(7*i)%16;}
        F=(F+A+K[i]+M[g])>>>0; A=D; D=C; C=B; B=(B+rot(F,S[i]))>>>0;
      }
      a0=(a0+A)>>>0;b0=(b0+B)>>>0;c0=(c0+C)>>>0;d0=(d0+D)>>>0;
    }
    const le=(n)=>{const b=new Uint8Array(4);b[0]=n&0xff;b[1]=(n>>>8)&0xff;b[2]=(n>>>16)&0xff;b[3]=(n>>>24)&0xff;return b;};
    const o=new Uint8Array([...le(a0),...le(b0),...le(c0),...le(d0)]);
    let hex=''; for(const b of o) hex+=b.toString(16).padStart(2,'0');
    return hex;
  }

  const out: Record<string, any> = { steps: [] };
  const get = async (url, headers = {}) => {
    const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', ...headers } });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 150), __status: r.status }; }
  };

  // nav -> 密钥
  const nav = await get('https://api.bilibili.com/x/web-interface/nav');
  const keyOf = (u) => (u.match(/\/([^/]+)\.[^./]+$/) || [])[1] || '';
  const rawKey = keyOf(nav.data?.wbi_img?.img_url || '') + keyOf(nav.data?.wbi_img?.sub_url || '');
  let mixin = '';
  for (const i of MIXIN_KEY_ENC_TAB) { if (i < rawKey.length) mixin += rawKey[i]; if (mixin.length === 32) break; }

  const sign = (params) => {
    const s: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) s[k] = String(v).replace(/[!'()*]/g, '');
    s['wts'] = Math.floor(Date.now() / 1000);
    const q = Object.keys(s).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(s[k])}`).join('&');
    return { ...s, w_rid: md5(q + mixin) };
  };

  const bvid = 'BV1GJ411x7h7';
  const view = await get('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
  const aid = view.data?.aid;
  out.aid = aid;

  // 拿 w_webid 指纹
  let spi: any = null;
  try {
    spi = await get('https://api.bilibili.com/x/frontend/finger/spi');
    out.spiCode = spi.code;
    out.w_webid = spi.data?.w_webid;
  } catch (e) { out.spiErr = String(e); }

  const variants = [
    { name: 'A 裸参数', params: { type: 1, oid: aid, mode: 3, ps: 20 }, headers: {} },
    { name: 'B +web_location', params: { type: 1, oid: aid, mode: 3, ps: 20, web_location: 1315875 }, headers: {} },
    { name: 'C +web_location+Referer', params: { type: 1, oid: aid, mode: 3, ps: 20, web_location: 1315875 }, headers: { Referer: 'https://www.bilibili.com/video/' + bvid + '/' } },
    { name: 'D +w_webid', params: { type: 1, oid: aid, mode: 3, ps: 20, web_location: 1315875, w_webid: out.w_webid }, headers: { Referer: 'https://www.bilibili.com/video/' + bvid + '/' } },
    { name: 'E +dm_* 系列', params: { type: 1, oid: aid, mode: 3, ps: 20, web_location: 1315875, w_webid: out.w_webid, dm_img_list: '[]', dm_img_str: 'V2ViR0wgMS4', dm_cover_img_str: 'QU5HTE9DS0lLQUQ', dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}' }, headers: { Referer: 'https://www.bilibili.com/video/' + bvid + '/' } },
  ];

  for (const v of variants) {
    const p = sign(v.params);
    const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(p[k])}`).join('&');
    const r = await get('https://api.bilibili.com/x/v2/reply/wbi/main?' + q, v.headers);
    const rec: Record<string, any> = {
      name: v.name,
      code: r.code,
      msg: r.message,
      count: r.data?.replies?.length ?? 0,
    };
    if (rec.count) rec.sample = (r.data.replies[0]?.content?.message ?? '').slice(0, 40);
    out.steps.push(rec);
    await new Promise((r2) => setTimeout(r2, 1200));
  }

  return JSON.stringify(out, null, 2);
})()
