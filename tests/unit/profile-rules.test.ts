import { describe, it, expect } from 'vitest';
import { buildRuleProfile } from '../../src/profile/rules';
import type { UserProfileInput } from '../../src/shared/types';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function s(over: Partial<UserProfileInput> = {}): UserProfileInput {
  return {
    id: 'BV1', title: 'Rust 异步编程', author: 'UP', category: '技术',
    collectedAt: new Date(NOW).toISOString(), origin: 'history', ...over,
  };
}

describe('规则画像', () => {
  it('统计分区出现次数作为兴趣标签', () => {
    const p = buildRuleProfile([s({ id: 'A' }), s({ id: 'B' }), s({ id: 'C' })], NOW);
    const tags = p.interests.map((i) => i.tag);
    expect(tags).toContain('技术');
  });

  it('兴趣权重归一化到 0-1', () => {
    const p = buildRuleProfile([s({ id: 'A' }), s({ id: 'B' })], NOW);
    for (const i of p.interests) {
      expect(i.weight).toBeGreaterThan(0);
      expect(i.weight).toBeLessThanOrEqual(1);
    }
  });

  it('最高权重的兴趣是出现最多的分区', () => {
    const p = buildRuleProfile([
      s({ id: 'A', category: '技术' }),
      s({ id: 'B', category: '游戏' }),
      s({ id: 'C', category: '游戏' }),
    ], NOW);
    expect(p.interests[0]!.tag).toBe('游戏');
  });

  it('没有样本时返回空画像而不是抛错', () => {
    const p = buildRuleProfile([], NOW);
    expect(p.interests).toEqual([]);
    expect(p.sampleCount).toBe(0);
  });

  it('sampleCount 记录样本数', () => {
    const p = buildRuleProfile([s({ id: 'A' }), s({ id: 'B' })], NOW);
    expect(p.sampleCount).toBe(2);
  });

  it('updatedAt 是 ISO 字符串', () => {
    const p = buildRuleProfile([s()], NOW);
    expect(new Date(p.updatedAt).toISOString()).toBe(new Date(NOW).toISOString());
  });

  it('不产生空标签项', () => {
    const p = buildRuleProfile([s({ category: '' })], NOW);
    expect(p.interests.every((i) => i.tag.length > 0)).toBe(true);
  });
});
