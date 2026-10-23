/**
 * 扩展内所有存储键的单一来源。改这里等于改 storage 布局。
 */
export const STORAGE_KEYS = {
  profile: 'profile',
  llmConfig: 'llmConfig',
  wordlistCache: 'wordlistCache',
  verdictCache: 'verdictCache',
  whitelist: 'whitelist',
  watchLog: 'watchLog',
  settings: 'settings',
  blockedLog: 'blockedLog',
  /** 最近一次失败（人话）。用户要能看见「为什么什么都没发生」。 */
  lastError: 'lastError',
  /** 上次尝试重归纳画像的时间。失败后 1 小时内不再重试。 */
  profileRefreshAt: 'profileRefreshAt',
  /** 冷启动采集报告：每个来源各采到多少、哪些没通。 */
  collectReport: 'collectReport',
  /**
   * 用户手动纠正过的画像项。
   *
   * **为什么要单独存**：画像每 24 小时会被 LLM 重新归纳一遍（从观看样本重算）。
   * 用户在页面上点「我喜欢这类」是一次**显式纠正**，
   * 它不该 24 小时后被重新归纳抹掉——所以把纠正单独记下来，
   * 每次归纳完再叠加上去。
   */
  profileOverrides: 'profileOverrides',
} as const;

export const VERDICT_ACTIONS = ['pass', 'fold', 'hide', 'mark', 'recommend'] as const;
export const MODES = ['cocoon', 'anti'] as const;
export const PAGE_TYPES = ['search', 'video', 'feed', 'unknown'] as const;

/**
 * 判定档位：内容判定（折叠/隐藏/标识）要走多重的流程。
 *
 * - `all`：全部内容都送 LLM 精判。判得最准，**每条都花钱**。
 * - `coarse`：先用动态词表（LLM 按当前语境生成）粗筛，命中的才送 LLM。
 *   命中缓存时词表 0 次调用。默认档，精度与成本平衡。
 * - `keyword`：只用内置关键词表，**一次 LLM 都不调**。零成本、零延迟，
 *   判不准（内置词库覆盖不到语境相关的表达），且不需要配置 API Key。
 */
export const JUDGE_LEVELS = ['all', 'coarse', 'keyword'] as const;

/** 默认档位：与插件上线时的行为一致（粗筛 + 精判）。 */
export const DEFAULT_JUDGE_LEVEL = 'coarse';

export const REASON_CODES = [
  'dislike_match',      // 命中用户画像里的「不喜欢」
  'incitement',         // 引战 / 挑起仇恨
  'stance_opposite',    // 与用户可能支持的立场相反
  'off_topic',          // 与画像明显无关
  'recommendation',     // 反向推荐：确实是相反观点
  'none',               // 放行
] as const;

/** 单次 LLM 请求允许的最大评论条数。批量判定时用，超过就分批。 */
export const MAX_BATCH_ITEMS = 20;

/** 反向推荐的触发阈值：视频页累计观看秒数。 */
export const ANTI_TRIGGER_WATCH_SECONDS = 60;

/**
 * 累计观看多少秒才记一条画像样本。
 * 过滤误点即退（点开看了一眼就关掉的不算「看过」）。
 */
export const WATCH_SAMPLE_SECONDS = 30;

/** B 站风控阈值：连续请求间隔（毫秒）。5-8 次/分钟即会被拦。 */
export const BILI_REQUEST_INTERVAL_MS = 1200;

/**
 * LLM 单次请求的默认输出 token 上限。
 *
 * 为什么给这么大：推理模型（thinking）会先思考再回答，
 * **思考过程和最终答案共用这个预算**。给小了，思考把预算烧光，
 * 最终 content 就是空串 -> JSON 解析失败 -> 判定链路静默失效。
 *
 * 实测 MiniMax-M3.1-Flash-Preview：max_tokens=2000 时 content 时而为空、
 * 时而正常（adaptive thinking 长度会波动），8000 才稳定。
 */
export const DEFAULT_MAX_TOKENS = 8192;
