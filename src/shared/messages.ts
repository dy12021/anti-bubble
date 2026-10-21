import type { ContentItem, Verdict, PageType, Mode, UserProfile, Settings, LlmConfig } from './types';

export const MSG = {
  /** content → bg：请求判定一批内容 */
  JUDGE_ITEMS: 'JUDGE_ITEMS',
  /** content → bg：请求当前页面的动态词表 */
  GET_WORDLIST: 'GET_WORDLIST',
  /** content → bg：请求画像 */
  GET_PROFILE: 'GET_PROFILE',
  /** content → bg：重新归纳画像 */
  REFRESH_PROFILE: 'REFRESH_PROFILE',
  /**
   * content → bg：并入一批冷启动采集的样本并重新归纳。
   * 采集发生在页面上下文（需要登录态），归纳发生在 service worker，
   * 所以采集方把样本传过来由后台落库。
   */
  SYNC_PROFILE_SAMPLES: 'SYNC_PROFILE_SAMPLES',
  /** content → bg：记录用户看过的视频（增量画像） */
  RECORD_WATCH: 'RECORD_WATCH',
  /** content → bg：撤销某个判定 */
  REVOKE: 'REVOKE',
  /** popup → bg：取设置 */
  GET_SETTINGS: 'GET_SETTINGS',
  /** popup → bg：存设置 */
  SET_SETTINGS: 'SET_SETTINGS',
  /** popup → bg：取 LLM 配置（Key 需脱敏） */
  GET_LLM_CONFIG: 'GET_LLM_CONFIG',
  /** popup → bg：存 LLM 配置 */
  SET_LLM_CONFIG: 'SET_LLM_CONFIG',
  /** popup → bg：连通性自测 */
  TEST_LLM: 'TEST_LLM',
  /** popup → bg：取屏蔽记录 */
  GET_BLOCKED_LOG: 'GET_BLOCKED_LOG',
  /** popup → bg：清空屏蔽记录 */
  CLEAR_BLOCKED_LOG: 'CLEAR_BLOCKED_LOG',
  /** popup → bg：取白名单（已撤销、后续不再判定的内容） */
  GET_WHITELIST: 'GET_WHITELIST',
  /** popup → bg：取最近一次失败（人话） */
  GET_LAST_ERROR: 'GET_LAST_ERROR',
  /** popup → bg：取冷启动采集报告（各来源条数与失败原因） */
  GET_COLLECT_REPORT: 'GET_COLLECT_REPORT',
  /** popup → bg：清空画像 */
  CLEAR_PROFILE: 'CLEAR_PROFILE',
  /** bg → content：执行动作 */
  APPLY_VERDICT: 'APPLY_VERDICT',
  /** bg → content：推送反向推荐结果 */
  PUSH_RECOMMENDATIONS: 'PUSH_RECOMMENDATIONS',
  /**
   * content → bg：请后台判定哪些候选视频确实表达相反观点。
   *
   * 拆成两步是因为 B 站搜索必须在页面上下文做（后台拿不到 cookie）：
   * content 先用词表里的 oppositeKeywords 搜出候选，再把候选交给后台做 LLM 立场判定。
   */
  GET_RECOMMENDATIONS: 'GET_RECOMMENDATIONS',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

export interface JudgeItemsPayload {
  items: ContentItem[];
  mode: Mode;
}

export interface RecordWatchPayload {
  item: ContentItem;
  watchSeconds: number;
}

export interface RevokePayload {
  itemId: string;
}

export interface SetSettingsPayload {
  settings: Partial<Settings>;
}

export interface SetLlmConfigPayload {
  config: LlmConfig;
}

export interface TestLlmPayload {
  config?: LlmConfig;
}

export interface MsgRequest {
  type: MsgType;
  id: string;
  payload?: unknown;
}

export interface MsgResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const REQUEST_TYPES = new Set<string>(Object.values(MSG));

/** 运行时校验。service worker 收到的消息不可信，必须挡。 */
export function isRequest(msg: unknown): msg is MsgRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== 'string' || !REQUEST_TYPES.has(m.type)) return false;
  if (typeof m.id !== 'string' || m.id.length === 0) return false;
  return true;
}

let counter = 0;
export function createRequestId(): string {
  counter = (counter + 1) % 0xffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** 判定结果的载荷（bg → content）。 */
export interface ApplyVerdictPayload {
  verdicts: Verdict[];
}

/** 反向推荐结果的载荷（bg → content）。 */
export interface PushRecommendationsPayload {
  videoId: string;
  items: {
    bvid: string;
    title: string;
    author: string;
    /** 为什么推荐这个——必须是人话，说明它表达了相反观点 */
    reason: string;
    url: string;
  }[];
}

export type { ContentItem, Verdict, PageType, Mode, UserProfile, Settings, LlmConfig };
