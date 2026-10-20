import type { Mode, UserProfile } from '../shared/types';

/**
 * 视频元信息。
 *
 * 词表生成只需要标题与简介；bvid 可选——兜底词表的缓存键用不到它。
 * 真正带 bvid 的是 {@link VideoContext}。
 */
export interface VideoMeta {
  bvid?: string;
  title: string;
  description?: string;
  /** B 站官方 AI 总结 */
  summary?: string;
  /** 视频 aid（评论接口的 oid）。从 view 接口拿到后带上，省一次请求。 */
  aid?: number;
  /**
   * 评论区样本（若干条真实评论的片段）。
   *
   * **为什么需要它**：没有样本时，模型只能凭想象产出「刷屏」「接龙」这类
   * *行为描述*，评论里根本不会原样出现 → 规则粗筛永远打不中 →
   * 评论看着「判过了」，其实一条都没进 LLM 精判。
   * 给了真实样本，模型才能写出评论里**真的会出现的字面表达**。
   */
  samples?: string[];
}

/** 视频页语境：当前这个视频。 */
export interface VideoContext extends VideoMeta {
  bvid: string;
}

/**
 * 列表页语境：这一批视频（搜索结果 / 推荐流）。
 *
 * ## 为什么需要它
 *
 * 列表页**没有「当前视频」**——页面上是一堆卡片。
 * 但「没有当前视频」不等于「没有语境」：这批卡片本身就是语境，
 * 把它们抽出来当成一个「列表主题」，照样能生成动态词表、照样能判定。
 *
 * 早期版本只有 {@link VideoContext} 一种语境，列表页拿不到语境 →
 * 词表恒为空 → 规则粗筛永不命中 → **列表页的判定从来没真正跑过**
 * （真机验证时 42 张搜索卡片全 pass，根因就在这里）。
 */
export interface ListContext {
  /**
   * 合成 id：`list:<内容哈希>`。
   *
   * 真实 bvid 恒为 `BV` 开头，所以这个命名空间不会和视频页撞上，
   * 两边的词表缓存也不会互相污染。
   */
  id: string;
  /** 页面主题，如「搜索：华为 手机」「首页推荐流」 */
  title: string;
  /** 抽样标题，给 LLM 当语境。 */
  samples: string[];
}

/**
 * 判定语境。
 *
 * 判「这条内容算不算引战 / 立场相反」必须有语境：
 * 同一句话在不同视频下结论完全不同。语境有两种：
 *
 * - `video`：视频页，当前这个视频
 * - `list`：列表页，页面上这批视频
 */
export type Subject =
  | { kind: 'video'; video: VideoContext }
  | { kind: 'list'; list: ListContext };

/**
 * 动态判据词表。
 *
 * 这是「规则粗筛」能 work 的关键：词表不是固定写死的关键词，
 * 而是 LLM 读完当前语境后**现场生成**的「可能构成引战/立场对立的表达模式」。
 * 规则层拿它做零成本粗筛，命中才调 LLM。
 */
export interface Wordlist {
  /** 表达模式（词或短语），规则层拿它做子串匹配 */
  patterns: string[];
  /** 本语境的立场概述（人话） */
  stance: string;
  /** 对立视角的检索词，反向推荐用 */
  oppositeKeywords: string[];
  /** 缓存键 */
  cacheKey: string;
  /**
   * 生成失败的原因（人话）。
   *
   * 有这个字段 = 这一次词表**没生成出来**，patterns 是空的。
   * 上层据此：① 不把它当有效判据；② 告诉用户「为什么什么都没发生」。
   */
  error?: string;
}

/** 精判的输入。 */
export interface JudgeInput {
  text: string;
  author: string;
  /** 视频标题，给 LLM 做语境 */
  videoTitle?: string;
}

/**
 * 精判的对象类型。
 *
 * - `comment`：视频页的评论
 * - `title`：列表页的视频标题
 *
 * 两者给 LLM 的说法不一样（判评论 vs 判标题），
 * 混着说会让模型把标题当成评论去理解。
 */
export type JudgeTarget = 'comment' | 'title';

/** 精判的输出（未经置信度过滤）。 */
export interface RawJudgeResult {
  action: 'fold' | 'hide' | 'mark' | 'pass';
  reason: string;
  reasonCode: string;
  confidence: number;
}

/** 流水线上下文。 */
export interface PipelineContext {
  mode: Mode;
  profile: UserProfile | null;
  /**
   * 判定语境。
   *
   * null = 没有语境 → 不判定（全部放行）。
   * 「没有语境」和「语境是空的」是两回事，别混。
   */
  subject: Subject | null;
  /** 置信度阈值 */
  threshold: number;
  /**
   * 已经解析好的词表。
   *
   * 存在的意义：service worker 要**先**拿到词表（才能算词表版本的缓存键），
   * 再查判定缓存。把词表塞进 context，Pipeline 就不用解析第二次。
   */
  wordlist?: Wordlist;
}
