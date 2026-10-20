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
import { videoSubject } from '../../src/pipeline/subject';
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
    const wl = await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    expect(wl.patterns).toEqual(['引战']);
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('第二次命中缓存不再调 LLM', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('画像更新后缓存失效', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), { ...profile, updatedAt: '2026-10-21T00:00:00.000Z' }, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('不同视频各自生成', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    await s.get(videoSubject({ bvid: 'BV2', title: 't' }), profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('LLM 失败时返回兜底词表（空模式，等于放行）', async () => {
    const c: LlmClient = { complete: vi.fn(async () => { throw new Error('挂了'); }) };
    const s = new WordlistService(c);
    const wl = await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    expect(wl.patterns).toEqual([]);
  });

  it('invalidate 后重新生成', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    await s.invalidate('BV1');
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  /**
   * 回归防护：一次网络抖动不能让某个页面「从此再也不判定」。
   *
   * 早先失败时也会把空词表写进缓存 —— 于是这个语境的词表永久是空的，
   * 粗筛永不命中，页面看上去就是「插件坏了」，而且再也不会自己恢复。
   */
  it('LLM 失败时不写缓存（下次还会重试）', async () => {
    const c: LlmClient = { complete: vi.fn(async () => { throw new Error('挂了'); }) };
    const s = new WordlistService(c);
    await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    const cache = (store['wordlistCache'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(cache)).toHaveLength(0);
  });

  it('失败时把原因带出来（用户要能看见为什么什么都没发生）', async () => {
    const c: LlmClient = { complete: vi.fn(async () => { throw new Error('网络超时'); }) };
    const s = new WordlistService(c);
    const wl = await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    expect(wl.error).toContain('网络超时');
    expect(wl.patterns).toEqual([]);
  });

  it('解析出空 patterns 也算失败（不缓存、带原因）', async () => {
    const c: LlmClient = { complete: vi.fn(async () => JSON.stringify({ patterns: [], stance: '' })) };
    const s = new WordlistService(c);
    const wl = await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    expect(wl.error).toBeTruthy();
    const cache = (store['wordlistCache'] ?? {}) as Record<string, unknown>;
    expect(Object.keys(cache)).toHaveLength(0);
  });

  it('成功时不带 error 字段', async () => {
    const s = new WordlistService(client());
    const wl = await s.get(videoSubject({ bvid: 'BV1', title: 't' }), profile, 'cocoon');
    expect(wl.error).toBeUndefined();
  });
});
