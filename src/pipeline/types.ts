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
}

/** 视频上下文，词表与精判都要用。 */
export interface VideoContext extends VideoMeta {
  bvid: string;
}

/**
 * 动态判据词表。
 *
 * 这是「规则粗筛」能 work 的关键：词表不是固定写死的关键词，
 * 而是 LLM 读完当前视频后**现场生成**的「可能构成引战/立场对立的表达模式」。
 * 规则层拿它做零成本粗筛，命中才调 LLM。
 */
export interface Wordlist {
  /** 表达模式（词或短语），规则层拿它做子串匹配 */
  patterns: string[];
  /** 本视频的立场概述（人话） */
  stance: string;
  /** 对立视角的检索词，反向推荐用 */
  oppositeKeywords: string[];
  /** 缓存键 */
  cacheKey: string;
}

/** 精判的输入。 */
export interface JudgeInput {
  text: string;
  author: string;
  /** 视频标题，给 LLM 做语境 */
  videoTitle?: string;
}

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
  video: VideoContext | null;
  /** 置信度阈值 */
  threshold: number;
}
