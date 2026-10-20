import { describe, it, expect, vi } from 'vitest';
import { Pipeline, matchProfile } from '../../src/pipeline/pipeline';
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

function client(text: string | Error): LlmClient {
  return { complete: vi.fn(async () => { if (text instanceof Error) throw text; return text; }) };
}

const WORDLIST_JSON = JSON.stringify({
  stance: '支持 A',
  patterns: ['引战'],
  oppositeKeywords: ['A 反驳'],
});

/** 粗筛用的词表。内容固定，方便预期哪些条目会进精判。 */
const WL: Wordlist = {
  patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
};

/**
 * 模拟真实词表服务的成本。
 *
 * 真实实现里「生成词表」本身就是一次 LLM 调用（每个视频 1 次，命中缓存则 0 次），
 * 所以这里让 provider 也打一次 client，调用次数断言才有意义：
 * 断言里的「1」= 词表那一次；如果流水线额外发了精判请求，次数会变成 2，测试立刻红。
 */
function provider(c: LlmClient) {
  return async (): Promise<Wordlist> => {
    await c.complete('生成词表');
    return WL;
  };
}

describe('画像匹配', () => {
  it('命中不喜欢的标签返回 true', () => {
    expect(matchProfile('这是游戏实况的吐槽', profile)).toBe(true);
  });

  it('不命中返回 false', () => {
    expect(matchProfile('讲 Rust 的技术分享', profile)).toBe(false);
  });

  it('没有画像时返回 false', () => {
    expect(matchProfile('任意内容', null)).toBe(false);
  });

  it('画像没有 dislikes 时返回 false', () => {
    expect(matchProfile('任意', { ...profile, dislikes: [] })).toBe(false);
  });
});

describe('判定流水线', () => {
  it('未命中词表的评论直接放行，不调 LLM 精判', async () => {
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const vs = await p.judge([item({ text: '今天天气不错' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('pass');
    // 只有词表那一次调用，没有精判调用
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('命中词表的评论会走精判', async () => {
    const c = client(JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.95 }],
    }));
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const vs = await p.judge([item({ text: '这就是引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('hide');
    expect(vs[0]!.reason).toBe('在引战');
  });

  it('画像命中时直接 fold，不花精判的钱', async () => {
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const vs = await p.judge([item({ text: '游戏实况真好看' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('fold');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('词表 provider 抛错时全部放行', async () => {
    const p = new Pipeline({
      client: client(WORDLIST_JSON),
      wordlistProvider: async () => { throw new Error('挂了'); },
    });
    const vs = await p.judge([item({ text: '引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('pass');
  });

  it('空输入返回空数组', async () => {
    const p = new Pipeline({ client: client(WORDLIST_JSON), wordlistProvider: async () => ({
      patterns: [], stance: '', oppositeKeywords: [], cacheKey: 'k',
    }) });
    expect(await p.judge([], { mode: 'cocoon', profile, video: null, threshold: 0.7 })).toEqual([]);
  });

  it('结果数量与输入一致', async () => {
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const vs = await p.judge(items, { mode: 'cocoon', profile, video: null, threshold: 0.7 });
    expect(vs).toHaveLength(3);
    expect(vs.map((v) => v.itemId)).toEqual(['a', 'b', 'c']);
  });

  it('白名单里的 id 直接放行', async () => {
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({
      client: c,
      wordlistProvider: provider(c),
      whitelist: ['c1'],
    });
    const vs = await p.judge([item({ id: 'c1', text: '引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('pass');
  });

  it('每个非 pass 判定都带理由', async () => {
    const c = client(JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.95 }],
    }));
    const p = new Pipeline({ client: c, wordlistProvider: provider(c) });
    const vs = await p.judge([item({ text: '引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs.filter((v) => v.action !== 'pass').every((v) => v.reason.length > 0)).toBe(true);
  });

  it('成本红线：粗筛未命中时流水线自己一次 LLM 都不发', async () => {
    // 词表由外部提供（不花 LLM），此时调用次数必须是 0：
    // 未命中词表的内容不允许触发任何精判请求。
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({
      client: c,
      wordlistProvider: async () => WL,
    });
    await p.judge([item({ text: '今天天气不错' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
