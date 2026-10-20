# 计划 02：B 站 API 客户端

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个健壮的 B 站 API 客户端——WBI 签名、限速退避、密钥缓存、分页游标——为后续画像与判定提供可靠的数据来源。

**Architecture:** 分三层：`wbi.ts`（签名，纯函数，易测）、`client.ts`（请求执行：限速 + 退避 + 错误分类）、`api.ts`（具体端点）。请求在**页面上下文**发起（content script 注入的 page script），因此浏览器自动带 `SESSDATA`，用户无需导出凭据。

**Tech Stack:** TypeScript 5.5.2、Vitest 2.1.1

**依赖:** 计划 01（类型契约、消息协议、存储层）。

---

## Global Constraints

- 请求必须在页面上下文发起（`credentials: 'include'`），**不得**要求用户导出 Cookie
- WBI 密钥缓存 24 小时，**不得**每次请求重拉（会被限频）
- 签名时空格必须编码成 `%20`，**不能**用 `+`
- 连续请求间隔 ≥ 1200ms；遇 `-352` / 412 触发指数退避
- 错误信息**不得**包含用户 Cookie 或 Key
- 客户端对 B 站接口错误**一律降级不抛**给上层（上层按"拿不到"处理）

---

## File Structure

```
src/
└── bili/
    ├── wbi.ts         # WBI 签名（纯函数）
    ├── client.ts     # 请求执行：限速、退避、错误分类
    ├── page-bridge.ts# 页面上下文请求桥（content script 侧）
    ├── api.ts        # 具体端点
    └── types.ts      # B 站响应类型
tests/
└── unit/
    ├── wbi.test.ts
    ├── bili-client.test.ts
    └── bili-api.test.ts
```

---

## Task 1: WBI 签名

**Files:**
- Create: `src/bili/types.ts`
- Create: `src/bili/wbi.ts`
- Test: `tests/unit/wbi.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `mixinKey(imgKey: string, subKey: string): string`——按 MIXIN_KEY_ENC_TAB 置换拼接出 32 位 mixin key
  - `signParams(params: Record<string, string | number>, mixinKey: string): Record<string, string>`——加 `wts`、排序、剔除特殊字符、算 `w_rid`
  - `encodeQuery(params: Record<string, string>): string`——**空格用 %20** 的查询串编码
  - `MIXIN_KEY_ENC_TAB: number[]`

- [ ] **Step 1: 写失败测试**

`tests/unit/wbi.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { mixinKey, signParams, encodeQuery, MIXIN_KEY_ENC_TAB } from '../../src/bili/wbi';

describe('WBI 签名', () => {
  it('mixin key 长度恒为 32', () => {
    const k = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    expect(k).toHaveLength(32);
  });

  it('mixin key 是确定性的', () => {
    const a = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    const b = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    expect(a).toBe(b);
  });

  it('不同密钥产出不同 mixin key', () => {
    expect(mixinKey('aaa', 'bbb')).not.toBe(mixinKey('ccc', 'ddd'));
  });

  it('置换表长度是 64', () => {
    expect(MIXIN_KEY_ENC_TAB).toHaveLength(64);
  });

  it('签名会加上 wts 与 w_rid', () => {
    const s = signParams({ keyword: 'test' }, mixinKey('a', 'b'));
    expect(s['wts']).toBeTruthy();
    expect(s['w_rid']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('签名对同样输入是稳定的（除 wts 外）', () => {
    const mk = mixinKey('a', 'b');
    const s1 = signParams({ keyword: 'test' }, mk);
    const s2 = signParams({ keyword: 'test' }, mk);
    expect(s1['w_rid']).toBe(s2['w_rid']);
  });

  it('参数不同则签名不同', () => {
    const mk = mixinKey('a', 'b');
    expect(signParams({ keyword: 'a' }, mk)['w_rid'])
      .not.toBe(signParams({ keyword: 'b' }, mk)['w_rid']);
  });

  it('剔除 !() 字符', () => {
    const mk = mixinKey('a', 'b');
    const s = signParams({ title: "a!b'c(d)e*f" }, mk);
    expect(s['title']).not.toContain('!');
    expect(s['title']).not.toContain('(');
    expect(s['title']).not.toContain('*');
  });

  it('encodeQuery 用 %20 而不是 +', () => {
    expect(encodeQuery({ keyword: 'a b' })).toContain('%20');
    expect(encodeQuery({ keyword: 'a b' })).not.toContain('+');
  });

  it('encodeQuery 正确转义中文', () => {
    expect(encodeQuery({ keyword: '测试' })).toBe('keyword=%E6%B5%8B%E8%AF%95');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/bili/wbi'`

- [ ] **Step 3: 写 types.ts**

`src/bili/types.ts`：
```ts
/** B 站接口的响应信封。code === 0 才算成功。 */
export interface BiliEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface NavData {
  isLogin: boolean;
  mid: number;
  uname: string;
  wbi_img: { img_url: string; sub_url: string };
}

export interface VideoItem {
  bvid: string;
  aid: number;
  title: string;
  author: string;
  mid: number;
  duration: number;
  description: string;
  pic: string;
  pubdate: number;
  owner: { mid: number; name: string };
  stat: { view: number; danmaku: number; reply: number; favorite: number; like: number };
  tname?: string;
}

export interface HistoryItem {
  history: {
    bvid: string;
    title: string;
    author_name: string;
    mid: number;
    cover: string;
    duration: number;
    viewed_at: number;
    business: string;
    tname?: string;
  };
}

export interface FavoriteFolder {
  id: number;
  title: string;
  media_count: number;
}

export interface FavoriteItem {
  id: number;
  type: string;
  title: string;
  upper?: { mid: number; name: string };
  duration?: number;
  bvid?: string;
  cover?: string;
  intro?: string;
  attr?: number;
  ctime?: number;
}

export interface CommentItem {
  rpid: number;
  mid: number;
  ctime: number;
  like: number;
  rcount: number;
  content: { message: string };
  member: { mid: number; uname: string; level: number };
  reply_control?: { reply_main_content?: { message: string } };
}

export interface SearchItem {
  bvid: string;
  title: string;
  author: string;
  mid: number;
  duration: string;
  description: string;
  pubdate: number;
  pic: string;
}

export interface ConclusionData {
  model_result?: string;
  outline?: { part_id: number; start_time: number; part_title: string; content: string }[];
}
```

- [ ] **Step 4: 写 wbi.ts**

`src/bili/wbi.ts`：
```ts
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
  // MD5 —— 这里用同步实现，因为 Web Crypto 的 digest 是异步的，
  // 而 signParams 在同步的签名路径上被调用。
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
 * **实现要点（实测踩过的坑）**：字节提字必须用 DataView.getUint32(littleEndian)，
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，wbi 相关 11 个测试全绿

- [ ] **Step 6: 验证 MD5 实现正确（对照已知向量）**

MD5 是自己实现的，必须对照标准向量验证。追加到 `tests/unit/wbi.test.ts`：

```ts
import { md5 } from '../../src/bili/wbi';

describe('MD5 实现', () => {
  it('空串', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
  it('abc', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
  it('a', () => {
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
  });
  it('中文', () => {
    expect(md5('中文')).toHaveLength(32);
  });
  it('长字符串', () => {
    expect(md5('a'.repeat(1000))).toHaveLength(32);
  });

  /**
   * 回归防护：曾经的 bug 是手写位运算提字（`bytes[j] | (bytes[j+1] << 8) | ...`），
   * JS 的 `<<` 是有符号 32 位运算，0x80 << 24 溢出成负数。
   * 症状极其隐蔽：**只有全零输入正确**（空串能过），任何含非零字节的输入全错。
   * 所以必须有一个非零输入的向量盯着。
   */
  it('非零输入不与全零结果相同', () => {
    expect(md5('a')).not.toBe(md5('b'));
    expect(md5('a')).not.toBe(md5('aa'));
  });
});
```

Run: `npm run test`
Expected: PASS。

> **实测踩坑（2026-10-20，已修）**：上面这段 MD5 最初是手写位运算提字，
> 结果**只有空串能过**，`'abc'` 全错。根因：JS 的 `<<` 是**有符号 32 位**运算，
> `0x80 << 24` 溢出成负数，`|` 在有符号上下文里运算，末尾再 `>>> 0` 已经晚了。
>
> **修法**：字节提字改用 `DataView.getUint32(offset, true)`（小端），彻底绕开符号问题。
>
> **教训**：「空串向量能过」是**假绿灯**——全零输入会掩盖这类 bug。
> **任何自实现的哈希/编码，必须至少有一个含非零字节的向量。**
>
> Step 3 的 `md5()` 实现请直接采用修正后的 DataView 版本。

- [ ] **Step 7: 提交**

```bash
git add src/bili tests/unit/wbi.test.ts
git commit -m "feat: 实现 WBI 签名与同步 MD5"
```

---

## Task 2: 请求执行器（限速 + 退避 + 错误分类）

**Files:**
- Create: `src/bili/client.ts`
- Test: `tests/unit/bili-client.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `signParams` / `mixinKey` / `extractKey` / `encodeQuery`
- Produces:
  - `class BiliClient`——构造参数 `{ getJson: (url: string) => Promise<unknown>, now: () => number, sleep: (ms: number) => Promise<void> }`
  - `get<T>(path: string, params?: Record<string, string | number>): Promise<T | null>`——**失败返回 null，不抛**
  - `getSigned<T>(path: string, params?: Record<string, string | number>): Promise<T | null>`——自动加 WBI 签名
  - `getPaged<T>(path: string, params, pick: (d: T) => T[]): Promise<T[]>`——按游标翻页
  - `BiliError` 类，带 `code` 字段

- [ ] **Step 1: 写失败测试**

`tests/unit/bili-client.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { BiliClient } from '../../src/bili/client';

function makeClient(responder: (url: string, n: number) => unknown, opts: { failFirst?: number } = {}) {
  let n = 0;
  const sleep = vi.fn(async () => {});
  const c = new BiliClient({
    getJson: async (url: string) => {
      const r = responder(url, n++);
      if (r instanceof Error) throw r;
      return r;
    },
    now: () => 1_700_000_000_000,
    sleep,
  });
  return { c, sleep };
}

describe('BiliClient', () => {
  it('成功时返回 data', async () => {
    const { c } = makeClient(() => ({ code: 0, message: '0', data: { ok: 1 } }));
    expect(await c.get('/x/web-interface/view')).toEqual({ ok: 1 });
  });

  it('code 非 0 时返回 null 而不是抛异常', async () => {
    const { c } = makeClient(() => ({ code: -101, message: '账号未登录', data: null }));
    expect(await c.get('/x/web-interface/nav')).toBeNull();
  });

  it('网络异常时返回 null', async () => {
    const { c } = makeClient(() => new Error('network'));
    expect(await c.get('/x/web-interface/view')).toBeNull();
  });

  it('网络异常后会重试', async () => {
    let calls = 0;
    const c = new BiliClient({
      getJson: async () => {
        calls++;
        if (calls <= 2) throw new Error('network');
        return { code: 0, message: '0', data: { v: 1 } };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await c.get('/x/web-interface/view')).toEqual({ v: 1 });
    expect(calls).toBe(3);
  });

  it('重试用尽后返回 null', async () => {
    let calls = 0;
    const c = new BiliClient({
      getJson: async () => { calls++; throw new Error('always'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await c.get('/x/web-interface/view')).toBeNull();
    expect(calls).toBeGreaterThan(1);
  });

  it('连续请求之间有间隔', async () => {
    const { c, sleep } = makeClient(() => ({ code: 0, message: '0', data: 1 }));
    await c.get('/a');
    await c.get('/b');
    expect(sleep).toHaveBeenCalled();
  });

  it('getSigned 会带上 w_rid 与 wts', async () => {
    const seen: string[] = [];
    const c = new BiliClient({
      getJson: async (url: string) => { seen.push(url); return { code: 0, message: '0', data: 1 }; },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    await c.getSigned('/x/web-interface/wbi/search/type', { keyword: 'test' });
    expect(seen[0]).toContain('w_rid=');
    expect(seen[0]).toContain('wts=');
  });

  it('getSigned 失败时返回 null', async () => {
    const c = new BiliClient({
      getJson: async () => ({ code: 0, message: '0', data: { wbi_img: { img_url: '', sub_url: '' } } }),
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    // nav 拿不到 wbi_img -> 签名失败 -> 返回 null
    expect(await c.getSigned('/x/web-interface/wbi/search/type', { keyword: 'x' })).toBeNull();
  });

  it('getPaged 会按游标翻页直到取完', async () => {
    const pages = [
      { code: 0, message: '0', data: { list: [{ id: 1 }], page: { has_more: true, cursor: 'c1' } } },
      { code: 0, message: '0', data: { list: [{ id: 2 }], page: { has_more: false } } },
    ];
    let i = 0;
    const c = new BiliClient({
      getJson: async () => pages[i++]!,
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const all = await c.getPaged<{ list: { id: number }[]; page: { has_more: boolean; cursor?: string } }>(
      '/x/v2/history/cursor', {}, (d) => d.list,
    );
    expect(all.map((x) => x.id)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/bili/client'`

- [ ] **Step 3: 写实现**

`src/bili/client.ts`：
```ts
import { extractKey, mixinKey, signParams, encodeQuery } from './wbi';

export interface BiliEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

export class BiliError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = 'BiliError';
  }
}

export interface BiliClientOptions {
  /**
   * 在**页面上下文**发起请求并返回已解析的 JSON。
   * 浏览器会自动带上 SESSDATA —— 这是用户无需导出凭据的原因。
   */
  getJson: (url: string) => Promise<unknown>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_LIMIT = 3;
const BASE_INTERVAL_MS = 1200;
/** -352 是 B 站风控码，412 是风控页。两者都要退避。 */
const RISK_CODES = new Set([-352]);

export class BiliClient {
  private lastRequestAt = 0;
  private mixinKeyCache: { key: string; expiresAt: number } | null = null;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: BiliClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** 未签名的 GET。失败一律返回 null。 */
  async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
    const url = this.buildUrl(path, params);
    const env = await this.request(url);
    if (!env) return null;
    if (env.code !== 0) return null;
    return (env.data ?? null) as T | null;
  }

  /** 需要 WBI 签名的 GET。密钥取不到时返回 null。 */
  async getSigned<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
    const mk = await this.getMixinKey();
    if (!mk) return null;
    const signed = signParams(params, mk);
    const url = this.buildUrl(path, signed);
    const env = await this.request(url);
    if (!env) return null;
    if (env.code !== 0) return null;
    return (env.data ?? null) as T | null;
  }

  /**
   * 游标翻页。B 站评论/历史接口用 next 游标而非页号。
   * 单页失败即停止，返回已拿到的部分（不抛）。
   */
  async getPaged<T>(
    path: string,
    params: Record<string, string | number>,
    pick: (data: T) => T[],
    maxPages = 20,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const p: Record<string, string | number> = { ...params };
      if (cursor) p['cursor'] = cursor;
      const data = await this.getSigned<T>(path, p);
      if (!data) break;
      const items = pick(data);
      if (items.length === 0) break;
      out.push(...items);
      const page = (data as { page?: { has_more?: boolean; cursor?: string } }).page;
      if (!page?.has_more || !page.cursor) break;
      cursor = page.cursor;
    }
    return out;
  }

  /** 取 mixin key，24 小时内缓存。取不到返回 null。 */
  private async getMixinKey(): Promise<string | null> {
    const now = this.now();
    if (this.mixinKeyCache && this.mixinKeyCache.expiresAt > now) {
      return this.mixinKeyCache.key;
    }
    const nav = await this.get<{ wbi_img?: { img_url?: string; sub_url?: string } }>(
      '/x/web-interface/nav',
    );
    if (!nav?.wbi_img?.img_url || !nav.wbi_img.sub_url) return null;
    const mk = mixinKey(extractKey(nav.wbi_img.img_url), extractKey(nav.wbi_img.sub_url));
    if (!mk) return null;
    // B 站密钥 24 小时轮换。留 1 小时余量，避免边界失效。
    this.mixinKeyCache = { key: mk, expiresAt: now + 23 * 60 * 60 * 1000 };
    return mk;
  }

  private buildUrl(path: string, params: Record<string, string | number>): string {
    const qs = encodeQuery(
      Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    );
    return `https://api.bilibili.com${path}${qs ? '?' + qs : ''}`;
  }

  /** 执行请求：限速 + 重试 + 退避。返回信封或 null。 */
  private async request(url: string): Promise<BiliEnvelope<unknown> | null> {
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
      await this.throttle();
      try {
        const raw = await this.opts.getJson(url);
        const env = raw as BiliEnvelope<unknown>;
        if (env && typeof env.code === 'number') {
          if (RISK_CODES.has(env.code)) {
            // 被风控：指数退避
            await this.sleep(BASE_INTERVAL_MS * Math.pow(2, attempt));
            continue;
          }
          return env;
        }
        return null;
      } catch {
        await this.sleep(BASE_INTERVAL_MS * Math.pow(2, attempt));
      }
    }
    return null;
  }

  /** 两次请求之间至少隔 BASE_INTERVAL_MS（5-8 次/分钟会被风控）。 */
  private async throttle(): Promise<void> {
    const elapsed = this.now() - this.lastRequestAt;
    if (elapsed < BASE_INTERVAL_MS) {
      await this.sleep(BASE_INTERVAL_MS - elapsed);
    }
    this.lastRequestAt = this.now();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，bili-client 相关 8 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/bili/client.ts tests/unit/bili-client.test.ts
git commit -m "feat: 新增 B 站请求执行器（限速、退避、错误降级）"
```

---

## Task 3: 页面上下文请求桥

**Files:**
- Create: `src/content/page-bridge.ts`
- Modify: `src/content/index.ts`
- Test: `tests/unit/page-bridge.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `BiliClient`
- Produces:
  - `createPageGetJson(): (url: string) => Promise<unknown>`——在页面上下文发 `fetch` 并返回解析后的 JSON
  - content script 通过 `window.postMessage` 与注入的 page script 通信
  - 页面脚本源码作为独立文件 `src/content/page-fetch.js`（**不能**用 eval 注入，MV3 禁止）

**为什么需要桥**：content script 处于隔离世界，`fetch` 出去不带 Cookie（除非声明 `host_permissions` 且用 `credentials:'include'`，但 B 站 API 对 `api.bilibili.com` 的跨域凭据策略不稳）。**在页面上下文注入一个脚本**是最可靠的做法，Cookie 由浏览器按同源策略自动带上。

- [ ] **Step 1: 写失败测试**

`tests/unit/page-bridge.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { createPageBridge } from '../../src/content/page-bridge';

describe('页面请求桥', () => {
  it('给页面脚本发请求并拿回 JSON', async () => {
    const posted: unknown[] = [];
    const addEventListener = vi.fn((_t: string, _h: (e: MessageEvent) => void) => {
      // 模拟页面脚本回应
      setTimeout(() => {
        _h({ data: { __ab: true, id: 'r1', ok: true, payload: { code: 0, data: { v: 7 } } } } as MessageEvent);
      }, 0);
    });
    const postMessage = vi.fn((m: unknown) => { posted.push(m); });
    const removeEventListener = vi.fn();

    const bridge = createPageBridge({
      addEventListener,
      removeEventListener,
      postMessage,
      timeoutMs: 1000,
    });

    const result = await bridge('https://api.bilibili.com/x/web-interface/nav');
    expect(result).toEqual({ code: 0, data: { v: 7 } });
    expect(posted).toHaveBeenCalled();
  });

  it('超时返回 null 而不是挂死', async () => {
    const bridge = createPageBridge({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      timeoutMs: 20,
    });
    expect(await bridge('https://api.bilibili.com/x')).toBeNull();
  });

  it('页面脚本报错时返回 null', async () => {
    const bridge = createPageBridge({
      addEventListener: vi.fn((_t: string, h: (e: MessageEvent) => void) => {
        setTimeout(() => h({ data: { __ab: true, id: 'r1', ok: false, error: 'boom' } } as MessageEvent), 0);
      }),
      removeEventListener: vi.fn(),
      postMessage: vi.fn(),
      timeoutMs: 1000,
    });
    expect(await bridge('https://api.bilibili.com/x')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/content/page-bridge'`

- [ ] **Step 3: 写实现**

`src/content/page-bridge.ts`：
```ts
/**
 * 页面上下文请求桥。
 *
 * 为什么需要它：content script 跑在隔离世界，向 api.bilibili.com 发跨域请求时
 * Cookie 不可靠。而 B 站自己的前端是在页面上下文里调这些接口的，
 * 浏览器会按同源策略自动带上 SESSDATA —— 这就是「用户无需导出凭据」的实现基础。
 *
 * 通信走 window.postMessage，带随机 id 配对，页面脚本只在页面内读取 URL 并 fetch。
 */

export interface PageBridgeDeps {
  addEventListener: (type: 'message', handler: (e: MessageEvent) => void) => void;
  removeEventListener: (type: 'message', handler: (e: MessageEvent) => void) => void;
  postMessage: (msg: unknown) => void;
  timeoutMs?: number;
}

interface BridgeResponse {
  __ab: true;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
}

export function createPageBridge(deps: PageBridgeDeps): (url: string) => Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? 15000;
  const pending = new Map<string, (r: BridgeResponse) => void>();
  let seq = 0;

  const handler = (e: MessageEvent) => {
    const d = e.data as BridgeResponse | undefined;
    if (!d || d.__ab !== true) return;
    const resolve = pending.get(d.id);
    if (!resolve) return;
    pending.delete(d.id);
    resolve(d);
  };

  deps.addEventListener('message', handler);

  return (url: string) =>
    new Promise((resolve) => {
      const id = `ab-${Date.now().toString(36)}-${(seq++).toString(36)}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve({ __ab: true, id, ok: false, error: 'timeout' });
      }, timeoutMs);

      pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });

      deps.postMessage({ __ab: true, id, url });
    });
}

/** 页面脚本侧的响应处理函数。 */
export function handlePageMessage(
  e: MessageEvent,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
): void {
  const d = e.data as { __ab?: boolean; id?: string; url?: string } | undefined;
  if (!d || d.__ab !== true || !d.id || !d.url) return;
  // 只允许打 B 站自己的 API，防止消息被滥用
  if (!/^https:\/\/api\.bilibili\.com\//.test(d.url)) {
    window.postMessage({ __ab: true, id: d.id, ok: false, error: 'blocked url' }, window.location.origin);
    return;
  }
  fetchImpl(d.url, { credentials: 'include', headers: { Accept: 'application/json' } })
    .then(async (res) => {
      const payload = await res.json().catch(() => null);
      window.postMessage({ __ab: true, id: d.id, ok: true, payload }, window.location.origin);
    })
    .catch((err: unknown) => {
      window.postMessage(
        { __ab: true, id: d.id, ok: false, error: err instanceof Error ? err.message : String(err) },
        window.location.origin,
      );
    });
}
```

- [ ] **Step 4: 写页面脚本**

`src/content/page-fetch.js`（**纯 JS，不经打包**，因为要在页面上下文运行）：
```js
/**
 * 注入到页面上下文的请求脚本。
 * 必须在页面上下文执行才能带上 Cookie，所以不能用 eval——MV3 禁止，
 * 而是用 manifest 的 web_accessible_resources 声明后由 <script src> 注入。
 */
(function () {
  if (window.__antiBubblePageFetch) return;
  window.__antiBubblePageFetch = true;

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__ab !== true || !d.id || !d.url) return;
    if (!/^https:\/\/api\.bilibili\.com\//.test(d.url)) {
      window.postMessage({ __ab: true, id: d.id, ok: false, error: 'blocked url' }, window.location.origin);
      return;
    }
    fetch(d.url, { credentials: 'include', headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (payload) {
        window.postMessage({ __ab: true, id: d.id, ok: true, payload: payload }, window.location.origin);
      })
      .catch(function (err) {
        window.postMessage({
          __ab: true, id: d.id, ok: false,
          error: err && err.message ? err.message : String(err),
        }, window.location.origin);
      });
  });
})();
```

- [ ] **Step 5: 在 manifest 里声明 web_accessible_resources**

修改 `manifest.json`，加入：
```json
  "web_accessible_resources": [
    {
      "resources": ["content/page-fetch.js"],
      "matches": ["https://*.bilibili.com/*"]
    }
  ]
```
并把 `src/content/page-fetch.js` 加进 `vite.config.ts` 的 `rollupOptions.input`：
```ts
      input: {
        popup: 'src/popup/index.html',
        background: 'src/bg/index.ts',
        content: 'src/content/index.ts',
        'page-fetch': 'src/content/page-fetch.js',
      },
```

- [ ] **Step 6: 改 content script 入口**

`src/content/index.ts`：
```ts
import { createPageBridge } from './page-bridge';

/**
 * 注入页面上下文脚本。
 * MV3 不允许 eval/new Function，所以用 web_accessible_resources + <script src>。
 */
function injectPageFetch(): void {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/page-fetch.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch {
    // 注入失败不影响页面，只是请求能力不可用
  }
}

injectPageFetch();

const getJson = createPageBridge({
  addEventListener: (t, h) => window.addEventListener(t, h as EventListener),
  removeEventListener: (t, h) => window.removeEventListener(t, h as EventListener),
  postMessage: (m) => window.postMessage(m, window.location.origin),
});

console.info('[anti-bubble] content script loaded, bridge ready:', typeof getJson);
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，page-bridge 3 个测试全绿

- [ ] **Step 8: 跑构建**

Run: `npm run build`
Expected: 退出码 0，`dist/content/page-fetch.js` 存在

- [ ] **Step 9: 提交**

```bash
git add src/content manifest.json vite.config.ts tests/unit/page-bridge.test.ts
git commit -m "feat: 新增页面上下文请求桥以自动携带登录态"
```

---

## Task 4: 具体端点封装

**Files:**
- Create: `src/bili/api.ts`
- Test: `tests/unit/bili-api.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `BiliClient`
- Produces:
  - `fetchNav(c: BiliClient): Promise<NavData | null>`
  - `fetchHistory(c: BiliClient, maxItems?: number): Promise<HistoryItem[]>`
  - `fetchFavorites(c: BiliClient): Promise<FavoriteFolder[]>`
  - `fetchFavoriteItems(c: BiliClient, fid: number): Promise<FavoriteItem[]>`
  - `fetchFollowing(c: BiliClient): Promise<{ mid: number; name: string }[]>`
  - `fetchVideo(c: BiliClient, bvid: string): Promise<VideoItem | null>`
  - `fetchConclusion(c: BiliClient, bvid: string, cid: number, upMid: number): Promise<ConclusionData | null>`
  - `searchVideos(c: BiliClient, keyword: string): Promise<SearchItem[]>`
  - `fetchComments(c: BiliClient, oid: number, mode: 3 | 2, parent?: number): Promise<CommentItem[]>`
  - `fetchVideoIdByBvid(c: BiliClient, bvid: string): Promise<{ aid: number; cid: number; upMid: number } | null>`

- [ ] **Step 1: 写失败测试**

`tests/unit/bili-api.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import {
  fetchHistory, fetchVideo, searchVideos, fetchComments, fetchVideoIdByBvid,
} from '../../src/bili/api';
import { BiliClient } from '../../src/bili/client';

function clientWith(responses: Record<string, unknown>) {
  const urls: string[] = [];
  const c = new BiliClient({
    getJson: async (url: string) => {
      urls.push(url);
      for (const [k, v] of Object.entries(responses)) {
        if (url.includes(k)) return v;
      }
      return { code: 0, message: '0', data: null };
    },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  });
  return { c, urls };
}

describe('B 站端点', () => {
  it('fetchHistory 翻页取回全部', async () => {
    const { c } = clientWith({
      '/x/v2/history/cursor': { code: 0, message: '0', data: { list: [{ history: { bvid: 'BV1' } }], page: { has_more: false } } },
    });
    const h = await fetchHistory(c);
    expect(h).toHaveLength(1);
  });

  it('fetchVideo 命中详情接口', async () => {
    const { c, urls } = clientWith({
      '/x/web-interface/view': { code: 0, message: '0', data: { bvid: 'BV1', aid: 1, title: 't' } },
    });
    const v = await fetchVideo(c, 'BV1');
    expect(v?.bvid).toBe('BV1');
    expect(urls[0]).toContain('/x/web-interface/view');
  });

  it('fetchVideoIdByBvid 从详情里取 aid/cid/upMid', async () => {
    const { c } = clientWith({
      '/x/web-interface/view': {
        code: 0, message: '0',
        data: { aid: 123, cid: 456, owner: { mid: 789 } },
      },
    });
    expect(await fetchVideoIdByBvid(c, 'BV1')).toEqual({ aid: 123, cid: 456, upMid: 789 });
  });

  it('fetchVideoIdByBvid 缺字段返回 null', async () => {
    const { c } = clientWith({
      '/x/web-interface/view': { code: 0, message: '0', data: { aid: 1 } },
    });
    expect(await fetchVideoIdByBvid(c, 'BV1')).toBeNull();
  });

  it('searchVideos 返回结果数组', async () => {
    const { c, urls } = clientWith({
      '/x/web-interface/wbi/search/type': {
        code: 0, message: '0',
        data: { result: [{ bvid: 'BV2', title: 'x' }] },
      },
    });
    const s = await searchVideos(c, '关键词');
    expect(s[0]?.bvid).toBe('BV2');
    expect(urls[0]).toContain('wbi/sign');
  });

  it('searchVideos 无结果时返回空数组', async () => {
    const { c } = clientWith({
      '/x/web-interface/wbi/search/type': { code: 0, message: '0', data: { result: [] } },
    });
    expect(await searchVideos(c, 'x')).toEqual([]);
  });

  it('fetchComments 取 mode=3 的主楼', async () => {
    const { c, urls } = clientWith({
      '/x/v2/reply/wbi/main': {
        code: 0, message: '0',
        data: { replies: [{ rpid: 1, content: { message: 'hi' } }] },
      },
    });
    const cm = await fetchComments(c, 999, 3);
    expect(cm).toHaveLength(1);
    expect(urls[0]).toContain('mode=3');
  });

  it('fetchComments 带 parent 时取 mode=2 的回复', async () => {
    const { c, urls } = clientWith({
      '/x/v2/reply/wbi/main': { code: 0, message: '0', data: { replies: [] } },
    });
    await fetchComments(c, 999, 2, 555);
    expect(urls[0]).toContain('mode=2');
    expect(urls[0]).toContain('root=555');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/bili/api'`

- [ ] **Step 3: 写实现**

`src/bili/api.ts`：
```ts
import type { BiliClient } from './client';
import type {
  NavData, HistoryItem, FavoriteFolder, FavoriteItem, VideoItem,
  SearchItem, CommentItem, ConclusionData,
} from './types';

/**
 * B 站端点封装。
 *
 * 约定：每个函数内部失败都返回 null / 空数组，绝不抛。
 * 上层拿不到数据就当作「没有」，不让异常冒到页面上。
 */

/** 登录态 + WBI 密钥来源。 */
export async function fetchNav(c: BiliClient): Promise<NavData | null> {
  return c.get<NavData>('/x/web-interface/nav');
}

/** 观看历史。仅最近 ~1000 条 / 3 个月。 */
export async function fetchHistory(c: BiliClient, maxItems = 1000): Promise<HistoryItem[]> {
  const items = await c.getPaged<{
    list: HistoryItem[];
    page: { has_more?: boolean; cursor?: string };
  }>('/x/v2/history/cursor', { type: 'all' }, (d) => d.list ?? []);
  return items.slice(0, maxItems);
}

/** 收藏夹列表。 */
export async function fetchFavorites(c: BiliClient): Promise<FavoriteFolder[]> {
  const data = await c.get<{ list?: FavoriteFolder[] }>('/x/v3/fav/folder/created/list-all');
  return data?.list ?? [];
}

/** 某个收藏夹的内容。ps 上限 40。 */
export async function fetchFavoriteItems(c: BiliClient, fid: number): Promise<FavoriteItem[]> {
  const out: FavoriteItem[] = [];
  for (let pn = 1; pn <= 10; pn++) {
    const data = await c.get<{ medias?: FavoriteItem[] }>('/x/v3/fav/resource/list', {
      fid, pn, ps: 40,
    });
    const items = data?.medias ?? [];
    if (items.length === 0) break;
    out.push(...items);
    if (items.length < 40) break;
  }
  return out;
}

/** 关注列表。 */
export async function fetchFollowing(c: BiliClient): Promise<{ mid: number; name: string }[]> {
  const data = await c.get<{ list?: { mid: number; uname: string }[] }>('/x/relation/followings');
  return (data?.list ?? []).map((u) => ({ mid: u.mid, name: u.uname }));
}

/** 视频详情（无需签名）。 */
export async function fetchVideo(c: BiliClient, bvid: string): Promise<VideoItem | null> {
  return c.get<VideoItem>('/x/web-interface/view', { bvid });
}

/** 从视频详情里取 aid / cid / upMid（评论与 AI 总结都要用）。 */
export async function fetchVideoIdByBvid(
  c: BiliClient,
  bvid: string,
): Promise<{ aid: number; cid: number; upMid: number } | null> {
  const v = await c.get<{ aid?: number; cid?: number; owner?: { mid?: number } }>(
    '/x/web-interface/view', { bvid },
  );
  if (!v || typeof v.aid !== 'number' || typeof v.cid !== 'number' || typeof v.owner?.mid !== 'number') {
    return null;
  }
  return { aid: v.aid, cid: v.cid, upMid: v.owner.mid };
}

/** B 站官方 AI 总结。视频没生成过就返回 null。 */
export async function fetchConclusion(
  c: BiliClient,
  bvid: string,
  cid: number,
  upMid: number,
): Promise<ConclusionData | null> {
  return c.getSigned<ConclusionData>('/x/web-interface/view/conclusion/get', {
    bvid, cid, up_mid: upMid,
  });
}

/** 搜索视频（需 WBI 签名）。 */
export async function searchVideos(c: BiliClient, keyword: string): Promise<SearchItem[]> {
  const data = await c.getSigned<{ result?: SearchItem[] }>(
    '/x/web-interface/wbi/search/type',
    { keyword, search_type: 'video' },
  );
  return data?.result ?? [];
}

/**
 * 评论。mode=3 取主楼，mode=2 取楼中楼（需传 parent 作为 root）。
 * 分页用 next 游标，不是页号。
 */
export async function fetchComments(
  c: BiliClient,
  oid: number,
  mode: 3 | 2 = 3,
  parent?: number,
): Promise<CommentItem[]> {
  const params: Record<string, string | number> = { type: 1, oid, mode, ps: 20 };
  if (parent !== undefined) params['root'] = parent;
  const items = await c.getPaged<{
    replies?: CommentItem[];
    page?: { has_more?: boolean; cursor?: string };
  }>('/x/v2/reply/wbi/main', params, (d) => d.replies ?? []);
  return items;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，bili-api 相关 7 个测试全绿

- [ ] **Step 5: 跑类型检查与构建**

Run: `npm run typecheck && npm run build`
Expected: 两条命令退出码均为 0

- [ ] **Step 6: 提交**

```bash
git add src/bili/api.ts tests/unit/bili-api.test.ts
git commit -m "feat: 封装 B 站历史/收藏/关注/视频/搜索/评论端点"
```

---

## Task 5: 端到端自检

**Files:**
- Create: `docs/testing-checklist.md`（追加本计划章节）
- Modify: `src/content/index.ts`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: content script 能真实拉到 B 站数据

- [ ] **Step 1: 在 content script 里接上客户端，做一次真实 nav 拉取**

`src/content/index.ts` 追加：
```ts
import { BiliClient } from '../bili/client';
import { fetchNav } from '../bili/api';

const bili = new BiliClient({ getJson });

// 调试用：验证登录态与 WBI 密钥能拿到
void fetchNav(bili).then((nav) => {
  if (nav) {
    console.info('[anti-bubble] nav ok, login=', nav.isLogin, 'uname=', nav.uname);
  } else {
    console.warn('[anti-bubble] nav 获取失败（可能未登录或被风控）');
  }
});
```

- [ ] **Step 2: 跑构建**

Run: `npm run build`
Expected: 退出码 0

- [ ] **Step 3: 人工验证（需在 Chrome 里登录 B 站）**

1. `npm run build`
2. 加载 `dist/` 到 Chrome
3. 登录 bilibili.com
4. 打开任意 B 站页面 → 控制台应出现 `[anti-bubble] nav ok, login= true, uname= <你的昵称>`
5. 若出现 `nav 获取失败`：多半是未登录或被风控，等 1 分钟再试

- [ ] **Step 4: 追加测试清单**

在 `docs/testing-checklist.md` 末尾追加：
```markdown
## 计划 02（B 站 API 客户端）

- [ ] MD5 标准向量通过（`''` → d41d8cd...，`'abc'` → 900150...）
- [ ] 登录状态下 content script 控制台出现 `nav ok, login= true`
- [ ] 搜索接口可用（计划 04 会用到）
- [ ] 连续请求不触发 -352
```

- [ ] **Step 5: 提交**

```bash
git add src/content/index.ts docs/testing-checklist.md
git commit -m "feat: 接入 B 站客户端并补充测试清单"
```

---

## 完成标准

- [ ] `npm run typecheck` 退出码 0
- [ ] `npm run test` 全部通过
- [ ] `npm run build` 产出 `dist/`
- [ ] MD5 对照标准向量通过
- [ ] 真实 B 站页面能拉到 nav（登录态）
- [ ] 全部代码已提交
- [ ] 计划 03 可以直接开始
