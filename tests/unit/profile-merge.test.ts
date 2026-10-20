import { describe, it, expect } from 'vitest';
import { mergeSamples, sampleWeight, HALF_LIFE_DAYS } from '../../src/profile/merge';
import type { UserProfileInput } from '../../src/shared/types';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function s(over: Partial<UserProfileInput> = {}): UserProfileInput {
  return {
    id: 'BV1', title: '标题', author: 'UP', category: '科技',
    collectedAt: new Date(NOW).toISOString(), origin: 'history', ...over,
  };
}

describe('样本合并', () => {
  it('相同 id 只保留一条', () => {
    const out = mergeSamples([s(), s({ title: '另一个标题' })], NOW);
    expect(out).toHaveLength(1);
  });

  it('保留先出现的（冷启动优先）', () => {
    const out = mergeSamples([s({ title: '先' }), s({ title: '后' })], NOW);
    expect(out[0]!.title).toBe('先');
  });

  it('不同 id 都保留', () => {
    expect(mergeSamples([s({ id: 'A' }), s({ id: 'B' })], NOW)).toHaveLength(2);
  });

  it('合并是幂等的', () => {
    const a = mergeSamples([s({ id: 'A' }), s({ id: 'B' })], NOW);
    expect(mergeSamples(a, NOW)).toEqual(a);
  });

  it('新样本权重不小于旧样本', () => {
    const old = s({ collectedAt: new Date(NOW - 60 * 86400000).toISOString() });
    const fresh = s({ collectedAt: new Date(NOW).toISOString() });
    expect(sampleWeight(fresh, NOW)).toBeGreaterThan(sampleWeight(old, NOW));
  });

  it('权重随时间单调递减', () => {
    const w1 = sampleWeight(s({ collectedAt: new Date(NOW - 86400000).toISOString() }), NOW);
    const w2 = sampleWeight(s({ collectedAt: new Date(NOW - 10 * 86400000).toISOString() }), NOW);
    expect(w1).toBeGreaterThan(w2);
  });

  it('半衰期处权重约为 0.5', () => {
    const half = s({ collectedAt: new Date(NOW - HALF_LIFE_DAYS * 86400000).toISOString() });
    expect(sampleWeight(half, NOW)).toBeCloseTo(0.5, 2);
  });

  it('权重范围在 0 到 1 之间', () => {
    const veryOld = s({ collectedAt: new Date(NOW - 3650 * 86400000).toISOString() });
    const w = sampleWeight(veryOld, NOW);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1);
  });
});
