import type {
  VERDICT_ACTIONS, MODES, PAGE_TYPES, REASON_CODES,
} from './constants';

export type PageType = (typeof PAGE_TYPES)[number];
export type ItemKind = 'video' | 'comment';
export type VerdictAction = (typeof VERDICT_ACTIONS)[number];
export type Mode = (typeof MODES)[number];
export type VerdictReasonCode = (typeof REASON_CODES)[number];

/** 内容所处的上下文。判定需要它来理解「这条评论在回应什么」。 */
export interface ItemContext {
  page: PageType;
  /** 视频页/评论所属的视频 id；搜索页与推荐流为 undefined */
  videoId?: string;
  /** 视频标题或简介摘要，作为立场判定的语境 */
  videoTitle?: string;
  /** 父评论 id，楼中楼用 */
  parentId?: string;
}

/**
 * 适配层产出、判定层消费的统一内容单元。
 * 适配器抽不到内容时返回空数组，绝不抛错。
 */
export interface ContentItem {
  kind: ItemKind;
  /** video → bvid；comment → rpid */
  id: string;
  /** 视频标题+简介片段，或评论正文 */
  text: string;
  /** UP主昵称 / 评论者昵称 */
  author: string;
  /** 分区、时长、播放量、点赞数等。语义随 kind 而定。 */
  meta: Record<string, unknown>;
  context: ItemContext;
}

/** 判定层产出、动作层执行的结果。 */
export interface Verdict {
  itemId: string;
  action: VerdictAction;
  /** 展示给用户的人话理由。每个非 pass 判定都必须有。 */
  reason: string;
  reasonCode: VerdictReasonCode;
  /** 0-1。低于阈值按 pass 处理。 */
  confidence: number;
  /** 是否可撤销。pass 不可撤销。 */
  revocable: boolean;
}

/** 画像的输入样本：一条观看/收藏记录。 */
export interface UserProfileInput {
  /** bvid */
  id: string;
  title: string;
  author: string;
  /** 分区名或 id */
  category: string;
  /** 观看时长（秒）；收藏夹样本没有，填 undefined */
  watchSeconds?: number;
  /** 样本采集时间 ISO 字符串，用于时间衰减 */
  collectedAt: string;
  /** 来源：history / favorite / follow / live */
  origin: 'history' | 'favorite' | 'follow' | 'live';
}

/** LLM 归纳出的用户画像。 */
export interface UserProfile {
  interests: { tag: string; weight: number }[];
  dislikes: string[];
  stanceHints: Record<string, string>;
  topics: string[];
  updatedAt: string;
  /** 样本总数，供 UI 展示 */
  sampleCount: number;
}

/**
 * LLM 配置。用户自带 Key。
 *
 * 三个可选项是给「推理模型」准备的：这类模型会先思考再回答，
 * 思考过程和最终答案**共用 token 预算**。预算给小了，最终答案就是空的，
 * 判定链路会静默失效（看起来像「插件没反应」）。
 */
export interface LlmConfig {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
  /**
   * 单次请求的最大输出 token。留空则用 DEFAULT_MAX_TOKENS。
   * 推理模型需要留足思考空间——实测 MiniMax-M3.1 用 2000 会把预算全烧在
   * reasoning_content 上，最终 content 为空串。
   */
  maxTokens?: number;
  /**
   * 推理强度。**不是所有模型都支持**：
   * MiniMax-M3.1-Flash-Preview 强制 adaptive thinking，传 none 会被 400 拒绝。
   * 只有确定服务商支持时才填。
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /**
   * 用 `max_completion_tokens` 而不是 `max_tokens`。
   * 部分 OpenAI 兼容服务商会忽略 max_tokens，要求用前者。
   */
  useMaxCompletionTokens?: boolean;
}

/** 全局设置。 */
export interface Settings {
  mode: Mode;
  /** 每个页面类型可独立开关 */
  enabledPages: Record<PageType, boolean>;
  /** 总开关 */
  masterEnabled: boolean;
  /** 是否拉取观看历史做冷启动 */
  collectHistory: boolean;
  /** 判定置信度阈值，低于此值按 pass 处理 */
  confidenceThreshold: number;
  /**
   * 反向推荐的触发条件：视频累计观看多少秒之后才推相反观点。
   *
   * 默认 60 秒（见 constants 的 ANTI_TRIGGER_WATCH_SECONDS）。
   * 设计原话是「打开一个表达观点的视频**一段时间后**」——
   * 一进页面就推就成了「换个姿势的推荐流」，不是打破信息茧房。
   */
  antiTriggerSeconds?: number;
}

/**
 * 设置的增量更新。
 *
 * 不能直接用 `Partial<Settings>`：那样 `enabledPages` 也变成可选的整体，
 * 传 `{ enabledPages: { search: false } }` 会因为缺其它三个页面而编译不过，
 * 但运行时我们恰恰要做**浅合并**（只关一个页面，不动其它）。
 */
export type SettingsPatch = Omit<Partial<Settings>, 'enabledPages'> & {
  enabledPages?: Partial<Record<PageType, boolean>>;
};
