import { describe, it, expect } from 'vitest';
import {
  buildWordlistPrompt, parseWordlist, buildFallbackWordlist, wordlistCacheKey,
} from '../../src/pipeline/wordlist';
import type { UserProfile } from '../../src/shared/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: ['游戏'],
  stanceHints: { 'AI': '谨慎' },
  topics: ['Rust'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

describe('动态词表', () => {
  it('prompt 含视频标题', () => {
    const p = buildWordlistPrompt({ title: '独特标题ABC' }, profile, 'cocoon');
    expect(p.user).toContain('独特标题ABC');
  });

  it('prompt 含视频简介', () => {
    const p = buildWordlistPrompt({ title: 't', description: '独特简介XYZ' }, profile, 'cocoon');
    expect(p.user).toContain('独特简介XYZ');
  });

  it('prompt 含画像信息', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.user).toContain('技术');
    expect(p.user).toContain('游戏');
  });

  it('cocoon 模式要求找不喜欢的内容', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.user).toContain('不喜欢');
  });

  it('anti 模式要求找对立立场', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'anti');
    expect(p.user).toContain('相反');
  });

  it('解析合法 JSON 得到词表', () => {
    const raw = JSON.stringify({
      patterns: ['引战', '地域攻击'],
      stance: '支持国产芯片',
      oppositeKeywords: ['芯片 反驳', '国产 争议'],
    });
    const w = parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon'));
    expect(w.patterns).toEqual(['引战', '地域攻击']);
    expect(w.oppositeKeywords).toHaveLength(2);
  });

  it('解析带 markdown 包裹的 JSON', () => {
    const raw = '```json\n{"patterns":["a"],"stance":"s","oppositeKeywords":[]}\n```';
    expect(parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon')).patterns).toEqual(['a']);
  });

  it('解析失败回落到兜底词表', () => {
    const fb = buildFallbackWordlist({ title: 't' }, 'cocoon');
    expect(parseWordlist('乱码', fb)).toEqual(fb);
  });

  it('兜底词表 patterns 为空（等于全部放行）', () => {
    const fb = buildFallbackWordlist({ title: 't' }, 'cocoon');
    expect(fb.patterns).toEqual([]);
  });

  it('解析时过滤空模式', () => {
    const raw = JSON.stringify({ patterns: ['a', '', '  ', 'b'], stance: '', oppositeKeywords: [] });
    const w = parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon'));
    expect(w.patterns).toEqual(['a', 'b']);
  });

  it('解析时限制模式数量上限', () => {
    const raw = JSON.stringify({
      patterns: Array.from({ length: 200 }, (_, i) => 'p' + i),
      stance: '', oppositeKeywords: [],
    });
    expect(parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon')).patterns.length)
      .toBeLessThanOrEqual(60);
  });

  it('缓存键随视频 id 变化', () => {
    expect(wordlistCacheKey('BV1', 't')).not.toBe(wordlistCacheKey('BV2', 't'));
  });

  it('缓存键随画像版本变化', () => {
    expect(wordlistCacheKey('BV1', 't1')).not.toBe(wordlistCacheKey('BV1', 't2'));
  });

  it('缓存键是稳定的', () => {
    expect(wordlistCacheKey('BV1', 't')).toBe(wordlistCacheKey('BV1', 't'));
  });
});
