import { extractKey, mixinKey, signParams, encodeQuery } from './wbi';
import type { BiliEnvelope } from './types';

export type { BiliEnvelope } from './types';

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
   *
   * 两个泛型：P 是页面对象（如 { list, page }），I 是页面里的条目类型。
   * pick 把页面对象映射成条目数组。
   */
  async getPaged<P, I>(
    path: string,
    params: Record<string, string | number>,
    pick: (data: P) => I[],
    maxPages = 20,
  ): Promise<I[]> {
    const out: I[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < maxPages; i++) {
      const p: Record<string, string | number> = { ...params };
      if (cursor) p['cursor'] = cursor;
      const data = await this.getSigned<P>(path, p);
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
