import { describe, it, expect, vi, beforeEach } from 'vitest';

const store: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => { Object.assign(store, items); cb?.(); },
      remove: (keys: string[], cb?: () => void) => { for (const k of keys) delete store[k]; cb?.(); },
    },
  },
});

import { PipelineService } from '../../src/bg/pipeline-service';
import { judgeItems } from '../../src/pipeline/judge';
import { videoSubject } from '../../src/pipeline/subject';
import { MAX_BATCH_ITEMS } from '../../src/shared/constants';
import type { ContentItem, UserProfile } from '../../src/shared/types';
import type { LlmClient } from '../../src/bg/llm/client';
import type { Wordlist } from '../../src/pipeline/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: [],
  stanceHints: {},
  topics: [],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

const video = { bvid: 'BV1', title: '视频标题' };
const subject = videoSubject(video);

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'comment', id: 'c1', text: '普通评论', author: 'u',
    meta: {}, context: { page: 'video', videoId: 'BV1', videoTitle: '视频标题' }, ...over,
  };
}

const WORDLIST: Wordlist = {
  patterns: ['引战'], stance: '支持 A', oppositeKeywords: [], cacheKey: 'k',
};

function clientWith(wordlistJson: string): LlmClient {
  return {
    complete: vi.fn(async (prompt: string) => {
      // 词表 prompt 与精判 prompt 用不同的段落标记区分
      if (prompt.includes('【待判评论】')) {
        return JSON.stringify({
          results: [{ id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.95 }],
        });
      }
      return wordlistJson;
    }),
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('判定缓存真的会被读', () => {
  it('同一批内容判两次，第二次不再调精判', async () => {
    const c = clientWith(JSON.stringify(WORDLIST));
    const svc = new PipelineService(c);
    const items = [item({ id: 'c1', text: '引战' })];

    await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    const callsAfterFirst = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    const callsAfterSecond = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    // 第二次不应产生新的调用（词表已缓存 + 判定已缓存）
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it('缓存命中时仍返回同样的判定结果', async () => {
    const c = clientWith(JSON.stringify(WORDLIST));
    const svc = new PipelineService(c);
    const items = [item({ id: 'c1', text: '引战' })];
    const first = await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    const second = await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    expect(second[0]!.action).toBe(first[0]!.action);
    expect(second[0]!.itemId).toBe(first[0]!.itemId);
  });

  it('换了模式不算命中缓存', async () => {
    const c = clientWith(JSON.stringify(WORDLIST));
    const svc = new PipelineService(c);
    const items = [item({ id: 'c1', text: '引战' })];
    await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    await svc.judge(items, { mode: 'anti', subject, threshold: 0.7 });
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });

  it('结果顺序与输入一致', async () => {
    const c = clientWith(JSON.stringify(WORDLIST));
    const svc = new PipelineService(c);
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const vs = await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    expect(vs.map((v) => v.itemId)).toEqual(['a', 'b', 'c']);
  });
});

describe('判定缓存与词表版本', () => {
  /**
   * 回归防护：缓存键必须带词表版本。
   *
   * 真机验证时踩过：早先一版因为判定请求没带 video，词表是空的，
   * 于是「粗筛没命中 → 全部放行」的结果被写进了判定缓存。
   * 后来代码修对了，但因为缓存键不含词表版本，仍然命中缓存早退，
   * **LLM 再也不会被调用**——插件看起来在运行但什么都不做。
   */
  it('画像更新后旧判定不再命中（词表版本变了）', async () => {
    const c = clientWith(JSON.stringify(WORDLIST));
    const svc = new PipelineService(c);
    const items = [item({ id: 'c1', text: '引战' })];

    // 第一轮：画像版本 1
    store['profile'] = { ...profile, updatedAt: '2026-10-20T00:00:00.000Z' };
    await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    const callsAfterFirst = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    // 第二轮：画像更新了 -> 词表缓存键变了 -> 旧判定不该命中
    store['profile'] = { ...profile, updatedAt: '2026-10-21T00:00:00.000Z' };
    await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('空词表产生的 pass 不入缓存（否则会毒死后续判定）', async () => {
    const c = clientWith(JSON.stringify(WORDLIST));
    const svc = new PipelineService(c);
    const items = [item({ id: 'c1' })];

    // video 传 null -> 词表 provider 返回空表 -> 粗筛没跑成 -> 全部放行
    await svc.judge(items, { mode: 'cocoon', subject: null, threshold: 0.7 });

    // 这种「放行」不是真正的判定，不该被缓存
    const cache = (store['verdictCache'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(cache)).toHaveLength(0);
  });

  it('有词表时判定结果会入缓存', async () => {
    const c = clientWith(JSON.stringify(WORDLIST));
    const svc = new PipelineService(c);
    const items = [item({ id: 'c1', text: '引战' })];

    await svc.judge(items, { mode: 'cocoon', subject, threshold: 0.7 });

    const cache = (store['verdictCache'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(cache).length).toBeGreaterThan(0);
  });
});

describe('精判分批', () => {
  it('超过 MAX_BATCH_ITEMS 会分成多次调用', async () => {
    const complete = vi.fn(async () => JSON.stringify({ results: [] }));
    const items = Array.from({ length: MAX_BATCH_ITEMS * 2 + 5 }, (_, i) => ({
      text: '引战' + i, author: 'u', videoTitle: 't',
    }));
    await judgeItems(
      { complete } as unknown as LlmClient,
      items,
      WORDLIST,
      'cocoon',
      profile,
      0.7,
    );
    expect(complete).toHaveBeenCalledTimes(3);
  });

  it('不超过上限时只调用一次', async () => {
    const complete = vi.fn(async () => JSON.stringify({ results: [] }));
    const items = Array.from({ length: 5 }, (_, i) => ({
      text: '引战' + i, author: 'u', videoTitle: 't',
    }));
    await judgeItems(
      { complete } as unknown as LlmClient,
      items,
      WORDLIST,
      'cocoon',
      profile,
      0.7,
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('某一批失败只降级那一批，不影响其它批', async () => {
    let n = 0;
    const complete = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error('这一批挂了');
      return JSON.stringify({ results: [] });
    });
    const items = Array.from({ length: MAX_BATCH_ITEMS * 2 }, (_, i) => ({
      text: 'x' + i, author: 'u', videoTitle: 't',
    }));
    const vs = await judgeItems(
      { complete } as unknown as LlmClient,
      items,
      WORDLIST,
      'cocoon',
      profile,
      0.7,
    );
    expect(vs).toHaveLength(MAX_BATCH_ITEMS * 2);
    expect(vs.every((v) => v.action === 'pass')).toBe(true);
  });
});
