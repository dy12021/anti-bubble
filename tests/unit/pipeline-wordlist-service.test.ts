import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 内存版 chrome.storage.local（callback 风格）。
 * 行为对齐真实 API：get 只回传存在的键，set/remove 是 callback 风格。
 */
let store: Record<string, unknown>;

beforeEach(() => {
  store = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in store) out[k] = store[k];
          cb(out);
        },
        set: (items: Record<string, unknown>, cb?: () => void) => {
          Object.assign(store, items);
          cb?.();
        },
        remove: (keys: string[], cb?: () => void) => {
          for (const k of keys) delete store[k];
          cb?.();
        },
      },
    },
  });
});

import { WordlistService } from '../../src/pipeline/wordlist-service';
import type { LlmClient } from '../../src/bg/llm/client';
import type { UserProfile } from '../../src/shared/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: [], stanceHints: {}, topics: [],
  updatedAt: '2026-10-20T00:00:00.000Z', sampleCount: 5,
};

const WL = JSON.stringify({ stance: 's', patterns: ['引战'], oppositeKeywords: ['x'] });

function client(): LlmClient {
  return { complete: vi.fn(async () => WL) };
}

describe('词表服务', () => {
  it('第一次生成词表', async () => {
    const c = client();
    const s = new WordlistService(c);
    const wl = await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect(wl.patterns).toEqual(['引战']);
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('第二次命中缓存不再调 LLM', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('画像更新后缓存失效', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.get({ bvid: 'BV1', title: 't' }, { ...profile, updatedAt: '2026-10-21T00:00:00.000Z' }, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('不同视频各自生成', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.get({ bvid: 'BV2', title: 't' }, profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('LLM 失败时返回兜底词表（空模式，等于放行）', async () => {
    const c: LlmClient = { complete: vi.fn(async () => { throw new Error('挂了'); }) };
    const s = new WordlistService(c);
    const wl = await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect(wl.patterns).toEqual([]);
  });

  it('invalidate 后重新生成', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.invalidate('BV1');
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});
