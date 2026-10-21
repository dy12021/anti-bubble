import { describe, it, expect, vi } from 'vitest';
import { buildJudgePrompt, parseJudgments, judgeItems } from '../../src/pipeline/judge';
import type { Wordlist } from '../../src/pipeline/types';
import type { LlmClient } from '../../src/bg/llm/client';
import type { UserProfile } from '../../src/shared/types';

const wl: Wordlist = {
  patterns: ['引战'], stance: '支持 A', oppositeKeywords: [], cacheKey: 'k',
};

function client(text: string | Error): LlmClient {
  return { complete: vi.fn(async () => { if (text instanceof Error) throw text; return text; }) };
}

describe('LLM 精判', () => {
  it('prompt 含评论正文', () => {
    const p = buildJudgePrompt([{ text: '独特评论ABC', author: 'u' }], wl, 'cocoon', null);
    expect(p.user).toContain('独特评论ABC');
  });

  it('prompt 含评论 id 便于对齐结果', () => {
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'cocoon', null);
    expect(p.user).toContain('1');
  });

  it('anti 模式的 prompt 要求标记立场相反', () => {
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'anti', null);
    expect(p.system + p.user).toContain('相反');
  });

  it('解析合法 JSON 得到判定', () => {
    const raw = JSON.stringify({
      results: [
        { id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.9 },
      ],
    });
    const vs = parseJudgments(raw, ['1'], 'pass');
    expect(vs[0]!.action).toBe('hide');
    expect(vs[0]!.reason).toBe('在引战');
    expect(vs[0]!.itemId).toBe('1');
  });

  it('解析失败时全部回落为 pass', () => {
    const vs = parseJudgments('乱码', ['1', '2'], 'pass');
    expect(vs.map((v) => v.action)).toEqual(['pass', 'pass']);
  });

  it('缺少的结果项补为 pass', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: 'r', reasonCode: 'incitement', confidence: 0.9 }],
    });
    const vs = parseJudgments(raw, ['1', '2'], 'pass');
    expect(vs).toHaveLength(2);
    expect(vs[1]!.action).toBe('pass');
  });

  it('pass 的判定不可撤销', () => {
    const vs = parseJudgments('乱码', ['1'], 'pass');
    expect(vs[0]!.revocable).toBe(false);
  });

  it('非 pass 的判定可撤销', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: 'r', reasonCode: 'incitement', confidence: 0.9 }],
    });
    expect(parseJudgments(raw, ['1'], 'pass')[0]!.revocable).toBe(true);
  });

  it('置信度低于阈值的按 pass 处理', async () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: 'r', reasonCode: 'incitement', confidence: 0.3 }],
    });
    const vs = await judgeItems(client(raw), [{ text: 't', author: 'u' }], wl, 'cocoon', null, 0.7);
    expect(vs[0]!.action).toBe('pass');
  });

  it('LLM 抛错时全部降级为 pass', async () => {
    const vs = await judgeItems(client(new Error('挂了')), [{ text: 't', author: 'u' }], wl, 'cocoon', null, 0.7);
    expect(vs.every((v) => v.action === 'pass')).toBe(true);
  });

  it('judgeItems 返回数量与输入一致', async () => {
    const items = [{ text: 'a', author: 'u' }, { text: 'b', author: 'u' }, { text: 'c', author: 'u' }];
    const vs = await judgeItems(client('乱码'), items, wl, 'cocoon', null, 0.7);
    expect(vs).toHaveLength(3);
  });

  it('理由为空时用默认理由', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: '', reasonCode: 'incitement', confidence: 0.9 }],
    });
    expect(parseJudgments(raw, ['1'], 'pass')[0]!.reason.length).toBeGreaterThan(0);
  });
});

/**
 * 判「视频标题」和判「评论」是两回事。
 *
 * 列表页抽到的是视频标题，如果还用评论的框架让模型判，
 * 出来的理由会是「这条评论在引战」——驴唇不对马嘴。
 */
describe('精判的两种对象', () => {
  it('默认按评论判（段落标记是「待判评论」）', () => {
    const p = buildJudgePrompt([{ text: '独特评论ABC', author: 'u' }], wl, 'cocoon', null);
    expect(p.user).toContain('【待判评论】');
    expect(p.user).toContain('内容：');
  });

  it('判标题时段落标记换成「待判视频」，行内标签换成「标题：」', () => {
    const p = buildJudgePrompt(
      [{ text: '独特标题XYZ', author: 'UP' }],
      wl, 'cocoon', null, 'title',
    );
    expect(p.user).toContain('【待判视频】');
    expect(p.user).toContain('标题：独特标题XYZ');
    expect(p.user).not.toContain('【待判评论】');
  });

  it('判标题时 system 明说是标题审核器', () => {
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'cocoon', null, 'title');
    expect(p.system).toContain('标题审核器');
  });

  it('判评论时带上视频标题做语境', () => {
    const p = buildJudgePrompt(
      [{ text: '独特评论ABC', author: 'u', videoTitle: '这个视频在讲 Rust' }],
      wl, 'cocoon', null,
    );
    expect(p.user).toContain('这个视频在讲 Rust');
  });

  it('判标题时不再重复塞「该视频」段落（列表页没有单一视频）', () => {
    const p = buildJudgePrompt(
      [{ text: '独特标题XYZ', author: 'UP', videoTitle: '独特标题XYZ' }],
      wl, 'cocoon', null, 'title',
    );
    expect(p.user).not.toContain('【该视频】');
  });
});

/**
 * 回归防护：**没有画像时不能替用户猜**。
 *
 * 用户实测：首页折叠了「Minecraft 工具问题，与 AI 立场无关」——
 * 那条只是**跑题**，不是**用户不喜欢**。根因是没有画像时，
 * 模型拿「当前页面/视频的主题」当成了用户偏好的替身。
 */
describe('没有画像时必须保守', () => {
  it('没有画像时明说「跑题不是折叠理由」', () => {
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'cocoon', null);
    expect(p.system).toContain('当前没有用户画像，请务必保守');
    expect(p.system).toContain('跑题');
  });

  it('没有画像时 fold 只留给明确引战', () => {
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'cocoon', null);
    expect(p.system).toContain('明确引战');
  });

  it('有画像时按用户偏好判，没有这个保守条款', () => {
    const profile: UserProfile = {
      interests: [{ tag: '科技', weight: 0.9 }],
      dislikes: ['游戏'],
      stanceHints: {},
      topics: [],
      updatedAt: '2026-10-20T00:00:00.000Z',
      sampleCount: 5,
    };
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'cocoon', profile);
    expect(p.system).not.toContain('当前没有用户画像');
    expect(p.system).toContain('用户大概率不喜欢');
  });

  it('画像存在但空空的，等于没有（仍然保守）', () => {
    const empty: UserProfile = {
      interests: [], dislikes: [], stanceHints: {}, topics: [],
      updatedAt: '2026-10-20T00:00:00.000Z', sampleCount: 0,
    };
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'cocoon', empty);
    expect(p.system).toContain('当前没有用户画像，请务必保守');
  });
});
