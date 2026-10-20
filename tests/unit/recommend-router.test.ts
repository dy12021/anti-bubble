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

import { handleMessage } from '../../src/bg/router';
import { MSG } from '../../src/shared/messages';
import type { SearchItem } from '../../src/bili/types';

const video = { bvid: 'BV1', title: '当前视频标题' };

function candidate(bvid: string, title: string): SearchItem {
  return {
    bvid, title, author: 'UP', mid: 1, duration: '10:00',
    description: '', pubdate: 0, pic: '',
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('反向推荐路由', () => {
  it('没有 LLM 配置时报错', async () => {
    const r = await handleMessage({
      type: MSG.GET_RECOMMENDATIONS, id: 'r1',
      payload: { video, candidates: [candidate('BVx', 'x')] },
    });
    expect(r.ok).toBe(false);
  });

  it('没有候选时返回空数组而不是报错', async () => {
    const r = await handleMessage({
      type: MSG.GET_RECOMMENDATIONS, id: 'r2',
      payload: { video, candidates: [] },
    });
    expect(r.ok).toBe(true);
    expect((r.data as { items: unknown[] }).items).toEqual([]);
  });

  it('配了 LLM 后按候选判定，返回带理由的推荐', async () => {
    // 假 LLM：词表请求返回词表，立场判定请求返回结果
    const complete = vi.fn(async (prompt: string) => {
      if (prompt.includes('【待判评论】')) {
        return JSON.stringify({ results: [] });
      }
      if (prompt.includes('候选视频')) {
        return JSON.stringify({
          results: [{ bvid: 'BVop', reason: '它主张相反的观点' }],
        });
      }
      return JSON.stringify({
        stance: '支持 A',
        patterns: ['引战'],
        oppositeKeywords: ['A 反驳'],
      });
    });

    await handleMessage({
      type: MSG.SET_LLM_CONFIG, id: 'r3',
      payload: {
        config: {
          provider: 'openai', baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test', model: 'm1', timeoutMs: 5000,
        },
      },
    });

    // 替换掉内部 LLM 客户端：直接用 stubGlobal 覆盖 fetch
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const user = body.messages?.[body.messages.length - 1]?.content ?? '';
      const content = await complete(user);
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200 },
      );
    });

    const r = await handleMessage({
      type: MSG.GET_RECOMMENDATIONS, id: 'r4',
      payload: { video, candidates: [candidate('BVop', '相反观点视频')] },
    });
    fetchSpy.mockRestore();

    expect(r.ok).toBe(true);
    const items = (r.data as { items: { bvid: string; reason: string; url: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.bvid).toBe('BVop');
    expect(items[0]!.reason).toBe('它主张相反的观点');
    // 每条推荐都必须带可点击的链接
    expect(items[0]!.url).toContain('BVop');
  });
});
