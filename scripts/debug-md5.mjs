// 定位 MD5 实现偏差：与 node:crypto 逐输入对比
// 用 tsx-free 方式：把 wbi.ts 的 md5 抽出来单独跑，避免加载 vite.config.ts
import { createHash } from 'node:crypto';

function utf8Bytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) { out.push(c); }
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      i++;
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function leftRotate(x: number, c: number): number {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

function md5(input: string): string {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const lenBytes = [];
  let bl = bitLen;
  for (let i = 0; i < 8; i++) {
    lenBytes.unshift(bl & 0xff);
    bl = Math.floor(bl / 256);
  }
  bytes.push(...lenBytes);

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

  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = (bytes[j]! | (bytes[j + 1]! << 8) | (bytes[j + 2]! << 16) | (bytes[j + 3]! << 24)) >>> 0;
    }
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

  const le = (n: number) => {
    const b = new Uint8Array(4);
    b[0] = n & 0xff; b[1] = (n >>> 8) & 0xff;
    b[2] = (n >>> 16) & 0xff; b[3] = (n >>> 24) & 0xff;
    return b;
  };
  const out = new Uint8Array([...le(a0), ...le(b0), ...le(c0), ...le(d0)]);
  let hex = '';
  for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}

const cases = ['', 'a', 'ab', 'abc', 'abcd', 'abcdefgh', 'a'.repeat(55), 'a'.repeat(56),
  'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), '中文测试'];

let fails = 0;
for (const s of cases) {
  const mine = md5(s);
  const ref = createHash('md5').update(s, 'utf8').digest('hex');
  const label = s.length > 12 ? `len=${s.length}` : `"${s}"`;
  const ok = mine === ref;
  if (!ok) fails++;
  console.log(
    (ok ? 'OK  ' : 'FAIL') + ' ' + label.padEnd(14) +
    ' mine=' + mine + (ok ? '' : ' ref=' + ref),
  );
}
console.log('\nfails=' + fails);
