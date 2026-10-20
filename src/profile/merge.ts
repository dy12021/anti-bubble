import type { UserProfileInput } from '../shared/types';

/** 半衰期（天）。90 天的行为仍有一半权重。 */
export const HALF_LIFE_DAYS = 90;

/**
 * 时间衰减权重。
 *
 * 为什么需要衰减：三个月前的观看记录不能和昨天的等权——
 * 人的口味会变，昨天的行为更能代表当下。
 *
 * 权重公式：w = 0.5 ^ (ageDays / HALF_LIFE_DAYS)
 */
export function sampleWeight(sample: UserProfileInput, now: number): number {
  const t = Date.parse(sample.collectedAt);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86400000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * 合并冷启动样本与增量样本。
 *
 * 规则：
 * 1. 按 id 去重，**先出现的保留**（冷启动样本排在前面，因为它们更权威）；
 * 2. 幂等：合并已合并的结果不变。
 */
export function mergeSamples(
  samples: UserProfileInput[],
  now: number = Date.now(),
): UserProfileInput[] {
  const seen = new Set<string>();
  const out: UserProfileInput[] = [];
  for (const s of samples) {
    if (!s?.id) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  // 按采集时间倒序，让新的排在前面（后续归纳时可取前 N 条）
  out.sort((a, b) => {
    const ta = Date.parse(a.collectedAt);
    const tb = Date.parse(b.collectedAt);
    const va = Number.isNaN(ta) ? 0 : ta;
    const vb = Number.isNaN(tb) ? 0 : tb;
    return vb - va;
  });
  // now 暂时不参与计算：保留参数是为了将来做「按时间加权」的合并。
  void now;
  return out;
}
