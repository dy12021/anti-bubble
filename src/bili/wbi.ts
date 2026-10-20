/**
 * B 站 WBI 签名。
 *
 * 算法要点（2026-10 实测确认）：
 * 1. 从 /x/web-interface/nav 的 wbi_img 取 img_url / sub_url 的文件名（去扩展名）作为 imgKey / subKey；
 * 2. 按 MIXIN_KEY_ENC_TAB 置换拼接两个密钥的前 32 位，得到 mixinKey；
 * 3. 参数按 key 字典序排序，剔除 !'()* 字符，加 wts（秒级时间戳）；
 * 4. 拼成 query string 后拼 mixinKey，MD5 取 32 位小写作为 w_rid。
 *
 * 关键坑：query string 里的空格必须编码成 %20，用 + 会导致签名不匹配并触发 CORS 错误。
 */

/** B 站固定的字符置换表。 */
export const MIXIN_KEY_ENC_TAB: number[] = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

/** 从 wbi_img 的 URL 里取出密钥（文件名去掉扩展名）。 */
export function extractKey(url: string): string {
  const m = url.match(/\/([^/]+)\.[^./]+$/);
  return m ? m[1]! : '';
}

/** 按置换表拼接出 32 位 mixin key。 */
export function mixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    if (idx < raw.length) out += raw[idx];
    if (out.length === 32) break;
  }
  return out;
}

/** 剔除 B 站签名时不允许出现的字符。 */
function sanitize(value: string): string {
  return value.replace(/[!'()*]/g, '');
}

/**
 * query string 编码。**空格用 %20，不用 +**。
 * 这是 B 站签名的硬性要求，用 + 会导致签名校验失败并抛 CORS 错误。
 */
export function encodeQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join('&');
}

/** 给参数加上 wts 与 w_rid。 */
export function signParams(
  params: Record<string, string | number>,
  mk: string,
): Record<string, string> {
  const wts = Math.floor(Date.now() / 1000).toString();
  const sanitized: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    sanitized[k] = sanitize(String(v));
  }
  sanitized['wts'] = wts;

  const query = encodeQuery(sanitized);
  const wRid = md5(query + mk);
  return { ...sanitized, 'w_rid': wRid };
}

/**
 * 同步 MD5。
 *
 * 为什么不用 crypto.subtle.digest：它是异步的，会把整条签名链路拖成 async，
 * 而 WBI 密钥缓存/复用的判断需要在同步路径上完成。
 * 这不是安全场景（签名本身是公开算法），只是缓存寻址。
 *
 * **实现要点（踩过的坑）**：字节提字必须用 DataView.getUint32(littleEndian)，
 * 不能手写 `bytes[j] | (bytes[j+1] << 8) | ...`。
 * JS 的 `<<` 是有符号 32 位运算，`0x80 << 24` 会溢出成负数，
 * `|` 在有符号上下文里运算，最后再 `>>> 0` 也已经晚了——
 * 症状是**只有全零输入正确**（空串能过），任何含非零字节的输入全错。
 */
export function md5(input: string): string {
  const enc = new TextEncoder().encode(input);
  const bitLen = enc.length * 8;
  // 末尾留 8 字节写长度，总长必须是 64 的倍数
  const padded = new Uint8Array(((enc.length + 8) >> 6 << 6) + 64);
  padded.set(enc);
  padded[enc.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i]! + M[g]!) >>> 0;
      A = D; D = C; C = B;
      B = (B + leftRotate(F, S[i]!)) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);
  let hex = '';
  for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function leftRotate(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

