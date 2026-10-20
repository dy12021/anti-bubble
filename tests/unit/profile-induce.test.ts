import { describe, it, expect, vi } from 'vitest';
import { buildInductionPrompt, induceProfile, parseProfile } from '../../src/profile/induce';
import { buildRuleProfile } from '../../src/profile/rules';
import type { UserProfileInput } from '../../src/shared/types';
import type { LlmClient } from '../../src/bg/llm/client';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function s(over: Partial<UserProfileInput> = {}): UserProfileInput {
  return {
    id: 'BV1', title: 'Rust 异步编程', author: 'UP', category: '技术',
    collectedAt: new Date(NOW).toISOString(), origin: 'history', ...over,
  };
}

function fakeClient(text: string | Error): LlmClient {
  return {
    complete: vi.fn(async () => {
      if (text instanceof Error) throw text;
      return text;
    }),
  };
}

describe('画像归纳', () => {
  it('prompt 里包含视频标题', () => {
    const p = buildInductionPrompt([s({ title: '独特标题XYZ' })]);
    expect(p.user).toContain('独特标题XYZ');
  });

  it('prompt 里包含分区', () => {
    const p = buildInductionPrompt([s({ category: '游戏区' })]);
    expect(p.user).toContain('游戏区');
  });

  it('prompt 有 system 段', () => {
    const p = buildInductionPrompt([s()]);
    expect(p.system.length).toBeGreaterThan(0);
  });

  it('样本过多时截断', () => {
    const many = Array.from({ length: 500 }, (_, i) => s({ id: 'BV' + i }));
    const p = buildInductionPrompt(many, 50);
    expect(p.user.split('\n').length).toBeLessThanOrEqual(60);
  });

  it('解析合法 JSON 得到画像', () => {
    const fallback = buildRuleProfile([s()], NOW);
    const raw = JSON.stringify({
      interests: [{ tag: '技术', weight: 0.9 }],
      dislikes: ['游戏'],
      stanceHints: { 'AI': '谨慎乐观' },
      topics: ['Rust'],
    });
    const p = parseProfile(raw, fallback);
    expect(p.interests[0]!.tag).toBe('技术');
    expect(p.dislikes).toEqual(['游戏']);
  });

  it('解析带 markdown 包裹的 JSON', () => {
    const fallback = buildRuleProfile([s()], NOW);
    const raw = '```json\n{"interests":[{"tag":"X","weight":0.5}],"dislikes":[],"stanceHints":{},"topics":[]}\n```';
    expect(parseProfile(raw, fallback).interests[0]!.tag).toBe('X');
  });

  it('解析失败时回落到规则画像', () => {
    const fallback = buildRuleProfile([s()], NOW);
    expect(parseProfile('完全不是 JSON', fallback)).toEqual(fallback);
  });

  it('解析时补齐缺失字段', () => {
    const fallback = buildRuleProfile([s()], NOW);
    const p = parseProfile('{"interests":[]}', fallback);
    expect(p.dislikes).toEqual([]);
    expect(p.stanceHints).toEqual({});
    expect(Array.isArray(p.topics)).toBe(true);
  });

  it('LLM 成功时返回归纳结果', async () => {
    const client = fakeClient(JSON.stringify({
      interests: [{ tag: '技术', weight: 0.8 }],
      dislikes: [], stanceHints: {}, topics: ['Rust'],
    }));
    const p = await induceProfile(client, [s()], NOW);
    expect(p.interests[0]!.tag).toBe('技术');
  });

  it('LLM 抛错时降级为规则画像而不是抛出', async () => {
    const client = fakeClient(new Error('LLM 挂了'));
    const p = await induceProfile(client, [s()], NOW);
    expect(p.interests.length).toBeGreaterThan(0);
    expect(p.sampleCount).toBe(1);
  });

  it('LLM 返回垃圾时降级为规则画像', async () => {
    const client = fakeClient('我不知道你在说什么');
    const p = await induceProfile(client, [s()], NOW);
    expect(p.interests.length).toBeGreaterThan(0);
  });
});
