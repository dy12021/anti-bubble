import { describe, it, expect, vi } from 'vitest';
import { Pipeline, matchProfileTag } from '../../src/pipeline/pipeline';
import type { ContentItem, UserProfile } from '../../src/shared/types';
import type { LlmClient } from '../../src/bg/llm/client';
import type { Wordlist } from '../../src/pipeline/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: ['游戏实况'],
  stanceHints: { 'AI': '谨慎' },
  topics: ['Rust'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'comment', id: 'c1', text: '普通评论', author: 'u',
    meta: {}, context: { page: 'video', videoId: 'BV1', videoTitle: '标题' }, ...over,
  };
}

/** 词表：只含「引战」一个判据。 */
const WL: Wordlist = {
  patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
};

const WORDLIST_JSON = JSON.stringify({
  stance: '支持 A', patterns: ['引战'], oppositeKeywords: ['A 驳斥'],
});

/**
 * 假 LLM：按 prompt 内容区分「生成词表」与「精判」。
 * 精判的 prompt 里带「【待判评论】」/「【待判视频】」。
 */
function client(judgeRaw: string) {
  const complete = vi.fn(async (prompt: string) => {
    if (prompt.includes('【待判')) return judgeRaw;
    return WORDLIST_JSON;
  });
  return { complete } as unknown as LlmClient;
}

function provider(c: LlmClient) {
  return async (): Promise<Wordlist> => {
    await c.complete('生成词表');
    return WL;
  };
}

const calls = (c: LlmClient): string[] =>
  (c.complete as unknown as ReturnType<typeof vi.fn>).mock.calls.map((x) => String(x[0]));

const judgeCalls = (c: LlmClient): string[] =>
  calls(c).filter((p) => p.includes('【待判'));

describe('画像匹配（带标签）', () => {
  it('返回命中的那个标签', () => {
    expect(matchProfileTag('这是游戏实况的吐槽', profile)).toBe('游戏实况');
  });

  it('不命中返回 null', () => {
    expect(matchProfileTag('讲 Rust 的技术分享', profile)).toBeNull();
  });
});

describe('判定档位：仅关键词', () => {
  it('命中内置关键词就折叠，且一次 LLM 都不调', async () => {
    // client 传 null：这一档不该用到 LLM，给 null 才能证明它真的没调。
    const p = new Pipeline({ client: null });
    const vs = await p.judge([item({ text: '你真是傻逼' })], {
      mode: 'cocoon', profile: null, subject: null, threshold: 0.7, judgeLevel: 'keyword',
    });
    expect(vs[0]!.action).toBe('fold');
    expect(vs[0]!.reason).toContain('命中');
    expect(vs[0]!.reasonCode).toBe('incitement');
  });

  it('没命中内置关键词就放行', async () => {
    const p = new Pipeline({ client: null });
    const vs = await p.judge([item({ text: '今天天气不错，讲讲 Rust 挺好' })], {
      mode: 'cocoon', profile: null, subject: null, threshold: 0.7, judgeLevel: 'keyword',
    });
    expect(vs[0]!.action).toBe('pass');
  });

  it('画像里的「不喜欢」在这一档照样生效，并带上标签', async () => {
    const p = new Pipeline({ client: null });
    const vs = await p.judge([item({ text: '游戏实况真好看' })], {
      mode: 'cocoon', profile, subject: null, threshold: 0.7, judgeLevel: 'keyword',
    });
    expect(vs[0]!.action).toBe('fold');
    expect(vs[0]!.reasonCode).toBe('dislike_match');
    // 标签要带上：用户撤销时靠它更新画像
    expect(vs[0]!.matchedTag).toBe('游戏实况');
  });

  it('白名单里的内容直接放行', async () => {
    const p = new Pipeline({ client: null, whitelist: ['c1'] });
    const vs = await p.judge([item({ id: 'c1', text: '你真是傻逼' })], {
      mode: 'cocoon', profile: null, subject: null, threshold: 0.7, judgeLevel: 'keyword',
    });
    expect(vs[0]!.action).toBe('pass');
  });

  it('不生成词表（生成词表本身就是一次 LLM 调用）', async () => {
    const c = client('{}');
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    await p.judge([item({ text: '普通内容' })], {
      mode: 'cocoon', profile: null, subject: null, threshold: 0.7, judgeLevel: 'keyword',
    });
    expect(calls(c)).toHaveLength(0);
  });
});

describe('判定档位：全部 LLM', () => {
  it('没命中词表的内容也会送进精判', async () => {
    const c = client(JSON.stringify({
      results: [
        { id: '1', action: 'pass', reason: '', reasonCode: 'none', confidence: 0.9 },
        { id: '2', action: 'pass', reason: '', reasonCode: 'none', confidence: 0.9 },
      ],
    }));
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    await p.judge(
      [item({ id: 'a', text: '普通内容' }), item({ id: 'b', text: '引战' })],
      { mode: 'cocoon', profile: null, subject: null, threshold: 0.7, judgeLevel: 'all' },
    );
    const judged = judgeCalls(c);
    expect(judged).toHaveLength(1);
    expect(judged[0]).toContain('普通内容');
    expect(judged[0]).toContain('引战');
  });

  it('画像命中的内容也交给 LLM 判（不本地折叠）', async () => {
    const c = client(JSON.stringify({
      results: [{ id: '1', action: 'pass', reason: '', reasonCode: 'none', confidence: 0.9 }],
    }));
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const vs = await p.judge([item({ text: '游戏实况真好看' })], {
      mode: 'cocoon', profile, subject: null, threshold: 0.7, judgeLevel: 'all',
    });
    expect(vs[0]!.action).toBe('pass');
    expect(vs[0]!.matchedTag).toBeUndefined();
    expect(judgeCalls(c)).toHaveLength(1);
  });
});

describe('判定档位：关键词初筛（默认档）', () => {
  it('没命中词表的内容不进精判', async () => {
    const c = client(JSON.stringify({ results: [] }));
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const vs = await p.judge([item({ text: '今天天气不错' })], {
      mode: 'cocoon', profile: null, subject: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('pass');
    expect(judgeCalls(c)).toHaveLength(0);
  });

  it('画像命中直接折叠，并带上标签', async () => {
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const vs = await p.judge([item({ text: '游戏实况真好看' })], {
      mode: 'cocoon', profile, subject: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('fold');
    expect(vs[0]!.matchedTag).toBe('游戏实况');
  });
});
