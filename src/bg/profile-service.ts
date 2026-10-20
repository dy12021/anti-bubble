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

/** 累计观看多少秒才记一条样本。过滤误点即退。 */
export const WATCH_SAMPLE = WATCH_SAMPLE_SECONDS;

/** watchLog 最多保留多少条样本。 */
const MAX_WATCH_LOG = 1000;

/**
 * 画像服务。
 *
 * 负责三件事：
 * 1. 提供当前画像
 * 2. 定期/按需重新归纳（用已存的样本 + LLM 归纳）
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
    if (existing && !opts.force) {
      const age = this.now() - Date.parse(existing.updatedAt);
      if (Number.isFinite(age) && age < PROFILE_MAX_AGE_MS) {
        return existing;
      }
    }

    const samples = await this.getSamples();
    const profile = await induceProfile(llm, samples, this.now());
    await saveProfile(profile);
    return profile;
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
