import type { UserProfile, UserProfileInput, ContentItem } from '../shared/types';
import type { LlmClient } from './llm/client';
import { getProfile, saveProfile, clearProfile, getJson, setJson } from './storage';
import { STORAGE_KEYS, WATCH_SAMPLE_SECONDS } from '../shared/constants';
import { induceProfile } from '../profile/induce';
import { mergeSamples } from '../profile/merge';
import { buildRuleProfile } from '../profile/rules';
import { toSample } from '../profile/collect';

/** 画像最长有效期：24 小时后自动重新归纳。 */
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 重归纳失败后的冷却时间：1 小时内不再重试。
 *
 * 没有它的话，LLM 挂掉时**每次判定**都会去试着重归纳，
 * 而每次都要等 LLM 超时（120 秒）——页面判定会被拖死。
 */
export const PROFILE_RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** 累计观看多少秒才记一条样本。过滤误点即退。 */
export const WATCH_SAMPLE = WATCH_SAMPLE_SECONDS;

/** watchLog 最多保留多少条样本。 */
const MAX_WATCH_LOG = 1000;

/**
 * 画像服务。
 *
 * 负责三件事：
 * 1. 提供当前画像
 * 2. 按需/自动重新归纳（用已存的样本 + LLM 归纳）
 * 3. 记录增量观看
 *
 * 样本来源说明：归纳用的样本来自 `STORAGE_KEYS.watchLog`
 * （增量观看记录 + 冷启动采集的结果）。
 * 冷启动采集（`collectColdStart`）需要 B 站登录态，
 * 由拿到 BiliClient 的一侧写进 watchLog，本服务只负责消费。
 */
export class ProfileService {
  constructor(
    private readonly client: LlmClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(): Promise<UserProfile | null> {
    return getProfile();
  }

  /** 归纳画像。force=true 时忽略缓存强制重算。 */
  async refresh(
    client?: LlmClient,
    opts: { force?: boolean } = {},
  ): Promise<UserProfile> {
    const llm = client ?? this.client;
    const existing = await getProfile();
    if (existing && !opts.force && this.isFresh(existing)) {
      return existing;
    }

    const samples = await this.getSamples();
    const profile = await induceProfile(llm, samples, this.now());
    await saveProfile(profile);
    return profile;
  }

  /**
   * 取「当前该用的」画像：**没有就归纳，过期了就重新归纳**。
   *
   * 与 {@link refresh} 的区别：
   * - `refresh` 是**用户显式触发**的（面板上的「重新归纳」），无脑重算；
   * - 这个是**判定路径上自动**的：只在「没有画像」或「画像过期」时才动。
   *
   * 为什么用「懒刷新」而不是定时任务（`chrome.alarms`）：
   * ① 定时唤醒后台去归纳，用户没在浏览时纯属白花钱；
   * ② MV3 的 service worker 随时被挂起，alarms 还要额外处理重注册；
   * ③ **少一个权限**，商店审核时权限越少越好。
   *
   * 两条护栏：
   * - **没有样本就不调 LLM**（自动路径不该花钱去问一个空画像）；
   * - **失败后一小时内不再重试**，否则 LLM 挂掉时每次判定都要等它超时。
   */
  async getOrRefresh(client?: LlmClient): Promise<UserProfile | null> {
    const existing = await getProfile();
    if (existing && this.isFresh(existing)) return existing;

    // 上次尝试重归纳失败过？先别再试（LLM 可能正挂着）
    const lastAttempt = await getJson<number>(STORAGE_KEYS.profileRefreshAt, 0);
    if (lastAttempt && this.now() - lastAttempt < PROFILE_RETRY_INTERVAL_MS) {
      return existing;
    }

    const samples = await this.getSamples();
    // 没样本可归纳：保留旧画像（哪怕过期）总比没有强
    if (samples.length === 0) return existing;

    await setJson(STORAGE_KEYS.profileRefreshAt, this.now());
    const llm = client ?? this.client;
    // 归纳失败时保留旧画像，别用粗粒度的规则画像把它顶掉
    const profile = await induceProfile(llm, samples, this.now(), existing);
    await saveProfile(profile);
    return profile;
  }

  /** 画像是否还在有效期内。 */
  private isFresh(p: UserProfile): boolean {
    const age = this.now() - Date.parse(p.updatedAt);
    return Number.isFinite(age) && age < PROFILE_MAX_AGE_MS;
  }

  /** 记录一次观看。不足阈值则忽略。 */
  async record(item: ContentItem, watchSeconds: number): Promise<void> {
    if (watchSeconds < WATCH_SAMPLE) return;

    const samples = await this.getSamples();
    const sample = toSample(item, watchSeconds, 'history');
    const merged = mergeSamples([sample, ...samples], this.now());

    // 只保留最近 1000 条，避免无限增长
    await setJson(STORAGE_KEYS.watchLog, merged.slice(0, MAX_WATCH_LOG));

    // 立刻更新一次画像（不等 LLM），
    // 让「刚看完就刷新」的即时行为也能反映到画像里
    const current = await getProfile();
    if (!current) {
      // 还没有画像：写一份规则画像，行为立刻可见。
      await saveProfile(buildRuleProfile(merged, this.now()));
      return;
    }
    // 已经有画像：只同步样本数。
    // 不覆盖 interests / dislikes / stanceHints——那是 LLM 归纳出来的结果，
    // 用粗粒度的分区计数把它顶掉等于把归纳成果扔了。
    // 也不动 updatedAt：它决定「画像是否过期」，每次观看都刷新会让画像永远不过期。
    if (current.sampleCount !== merged.length) {
      await saveProfile({ ...current, sampleCount: merged.length });
    }
  }

  async clear(): Promise<void> {
    await clearProfile();
  }

  /**
   * 并入一批外部采集的样本（冷启动的观看历史/收藏夹）。
   *
   * 为什么要单独一个方法：采集动作发生在**页面上下文**（需要登录态），
   * 而归纳发生在 service worker。所以采集方把样本传过来，由这里落库。
   *
   * 合并规则与 record 一致：按 id 去重，新的排前面，最多留 1000 条。
   */
  async addSamples(samples: UserProfileInput[]): Promise<number> {
    if (!samples.length) {
      const existing = await this.getSamples();
      return existing.length;
    }
    const current = await this.getSamples();
    const merged = mergeSamples([...samples, ...current], this.now());
    await setJson(STORAGE_KEYS.watchLog, merged.slice(0, MAX_WATCH_LOG));
    return merged.length;
  }

  /** 已存的样本（增量观看 + 冷启动采集的结果），按 id 去重、按时间倒序。 */
  private async getSamples(): Promise<UserProfileInput[]> {
    const incremental = await getJson<UserProfileInput[]>(STORAGE_KEYS.watchLog, []);
    return mergeSamples(incremental, this.now());
  }
}
