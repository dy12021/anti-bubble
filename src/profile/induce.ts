import type { UserProfile, UserProfileInput } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { parseJsonResponse } from '../bg/llm/client';
import { buildRuleProfile } from './rules';

/**
 * 让 LLM 从观看/收藏样本里归纳用户画像。
 *
 * 设计要点：
 * 1. **必须能降级**。LLM 没配 Key / 被限流 / 网络不通时，
 *    插件要退回到规则画像，不能整个瘫掉。
 * 2. **输入只含视频元信息**（标题/分区/UP主），不含浏览行为之外的隐私。
 */

const MAX_SAMPLES = 200;

export function buildInductionPrompt(
  samples: UserProfileInput[],
  maxSamples: number = MAX_SAMPLES,
): { system: string; user: string } {
  const system = [
    '你是一个用户画像归纳器。输入是用户近期在 B 站观看/收藏的视频摘要。',
    '请归纳这个用户的偏好，输出严格的 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{',
    '  "interests": [{"tag": "题材标签", "weight": 0.0-1.0}],',
    '  "dislikes": ["用户明确不喜欢的题材"],',
    '  "stanceHints": {"话题": "用户在该话题上的倾向，如 谨慎/支持/反对/中立"},',
    '  "topics": ["用户关注的话题"]',
    '}',
    '',
    '要求：',
    '- interests 按权重从高到低，最多 12 项',
    '- dislikes 只写有明确证据的，最多 8 项',
    '- stanceHints 最多 8 项，只在样本有明确立场时写',
    '- 不要编造样本里没有的偏好',
  ].join('\n');

  const lines = samples.slice(0, maxSamples).map((s) => {
    const parts = [`标题：${s.title}`];
    if (s.category) parts.push(`分区：${s.category}`);
    if (s.author) parts.push(`UP主：${s.author}`);
    return `- ${parts.join('｜')}`;
  });

  const user = [
    `以下是用户最近观看的 ${Math.min(samples.length, maxSamples)} 个视频：`,
    '',
    ...lines,
  ].join('\n');

  return { system, user };
}

/** 解析 LLM 输出，失败时回落到规则画像。 */
export function parseProfile(raw: string, fallback: UserProfile): UserProfile {
  const parsed = parseJsonResponse<Partial<UserProfile>>(raw);
  if (!parsed || typeof parsed !== 'object') return fallback;

  const interests = Array.isArray(parsed.interests)
    ? parsed.interests
        .filter(
          (i): i is { tag: string; weight: number } =>
            !!i && typeof i.tag === 'string' && i.tag.length > 0 &&
            typeof i.weight === 'number',
        )
        .map((i) => ({ tag: i.tag, weight: Math.max(0, Math.min(1, i.weight)) }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 12)
    : fallback.interests;

  const dislikes = Array.isArray(parsed.dislikes)
    ? parsed.dislikes.filter((d): d is string => typeof d === 'string' && d.length > 0).slice(0, 8)
    : fallback.dislikes;

  const stanceHints =
    parsed.stanceHints && typeof parsed.stanceHints === 'object' && !Array.isArray(parsed.stanceHints)
      ? Object.fromEntries(
          Object.entries(parsed.stanceHints as Record<string, unknown>)
            .filter((e): e is [string, string] => typeof e[1] === 'string')
            .slice(0, 8),
        )
      : fallback.stanceHints;

  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 12)
    : fallback.topics;

  return {
    interests,
    dislikes,
    stanceHints,
    topics,
    updatedAt: fallback.updatedAt,
    sampleCount: fallback.sampleCount,
  };
}

/**
 * 归纳画像。LLM 失败时降级为规则画像，**不抛异常**。
 *
 * 注意：样本为空时**仍然**会问一次 LLM。
 * 理由：refresh 是用户显式触发的动作（「重新归纳」），
 * 空样本直接跳过 LLM 会让「点了没反应」与「没配 Key」无法区分；
 * 提示词里已经写明「不要编造样本里没有的偏好」，
 * 模型在没有样本时给空画像是预期行为。
 */
export async function induceProfile(
  client: LlmClient,
  samples: UserProfileInput[],
  now: number = Date.now(),
): Promise<UserProfile> {
  const fallback = buildRuleProfile(samples, now);

  const { system, user } = buildInductionPrompt(samples);
  try {
    const raw = await client.complete(user, { system, maxTokens: 2000 });
    return parseProfile(raw, fallback);
  } catch {
    // 降级：规则画像
    return fallback;
  }
}
