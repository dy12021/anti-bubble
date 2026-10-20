import type { UserProfileInput, UserProfile } from '../shared/types';
import { sampleWeight } from './merge';

/**
 * 分区名 → 题材标签候选。
 *
 * 分区（B 站的「技术」「知识」「游戏」……）粒度太粗，
 * 同一分区里可以是完全不同的题材。这张表用于把分区展开成更细的题材，
 * 供后续的题材级匹配使用。
 *
 * 注意：`buildRuleProfile` **不会**用它替换标签——
 * 规则画像的标签必须保持成分区原名（画像的第一版就是分区计数），
 * 否则「分区计数」这件事就失去了可解释性。
 */
export const TOPIC_KEYWORDS: Record<string, string[]> = {
  技术: ['编程', '数码', '人工智能', '科学'],
  知识: ['科普', '人文', '社科', '财经'],
  游戏: ['电子竞技', '单机游戏', '手游'],
  音乐: ['流行', '独立音乐', '古典'],
  影视: ['电影', '电视剧', '纪录片'],
  动画: ['番剧', '国创', '动画制作'],
  美食: ['做饭', '探店', '美食纪录片'],
  生活: ['日常', '家居', '穿搭'],
  运动: ['健身', '球类', '户外'],
  资讯: ['时事', '科技资讯'],
};

/**
 * 规则画像：不依赖 LLM 的降级实现。
 *
 * 存在的意义：LLM 归纳可能失败（没配 Key、被限流、网络不通），
 * 此时插件不能整个瘫掉——至少还能按分区做粗粒度的偏好判断。
 */
export function buildRuleProfile(
  samples: UserProfileInput[],
  now: number = Date.now(),
): UserProfile {
  const scores = new Map<string, number>();
  const total = new Map<string, number>();

  for (const s of samples) {
    const cat = (s.category ?? '').trim();
    if (!cat) continue;
    const w = sampleWeight(s, now);
    scores.set(cat, (scores.get(cat) ?? 0) + w);
    total.set(cat, (total.get(cat) ?? 0) + 1);
  }

  const max = Math.max(0, ...scores.values());
  const interests = [...scores.entries()]
    .map(([tag, score]) => ({ tag, weight: max > 0 ? score / max : 0 }))
    .sort((a, b) => b.weight - a.weight);

  return {
    interests,
    dislikes: [],
    stanceHints: {},
    topics: interests.slice(0, 10).map((i) => i.tag),
    updatedAt: new Date(now).toISOString(),
    sampleCount: samples.length,
  };
}
