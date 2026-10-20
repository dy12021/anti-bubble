import { describe, it, expect } from 'vitest';
import { coarseMatch, coarseMatchAll } from '../../src/pipeline/coarse';
import type { Wordlist } from '../../src/pipeline/types';

const wl: Wordlist = {
  patterns: ['引战', '地域攻击', 'XX粉'],
  stance: '支持',
  oppositeKeywords: [],
  cacheKey: 'k',
};

describe('规则粗筛', () => {
  it('命中模式返回 true', () => {
    expect(coarseMatch('这内容就是在引战', wl)).toBe(true);
  });

  it('未命中返回 false', () => {
    expect(coarseMatch('今天天气不错', wl)).toBe(false);
  });

  it('空词表永远不命中（等于全部放行）', () => {
    expect(coarseMatch('任何内容', { ...wl, patterns: [] })).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(coarseMatch('xx粉真无语', { ...wl, patterns: ['XX粉'] })).toBe(true);
  });

  it('批量匹配返回等长数组', () => {
    const r = coarseMatchAll(['引战', '无关', '地域攻击'], wl);
    expect(r).toEqual([true, false, true]);
  });

  it('空数组返回空数组', () => {
    expect(coarseMatchAll([], wl)).toEqual([]);
  });

  it('忽略空模式', () => {
    expect(coarseMatch('任意', { ...wl, patterns: ['', '  '] })).toBe(false);
  });
});
