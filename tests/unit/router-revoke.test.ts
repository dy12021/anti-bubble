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

import { handleMessage } from '../../src/bg/router';
import { MSG } from '../../src/shared/messages';
import type { UserProfile } from '../../src/shared/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.8 }],
  dislikes: ['游戏实况', '引战'],
  stanceHints: {},
  topics: ['Rust'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('撤销屏蔽', () => {
  it('只撤销时写白名单，画像不动', async () => {
    store['profile'] = profile;
    const r = await handleMessage({
      type: MSG.REVOKE, id: 'r1', payload: { itemId: 'BV1' },
    });
    expect(r.ok).toBe(true);
    expect((r.data as { profileUpdated: boolean }).profileUpdated).toBe(false);
    expect(store['whitelist']).toEqual(['BV1']);
    expect((store['profile'] as UserProfile).dislikes).toEqual(['游戏实况', '引战']);
  });

  it('带 updateProfile 时同时改画像：去掉命中的标签 + 加兴趣', async () => {
    store['profile'] = profile;
    const r = await handleMessage({
      type: MSG.REVOKE, id: 'r2',
      payload: {
        itemId: 'BV2',
        matchedTag: '游戏实况',
        text: 'Rust 异步编程实战',
        kind: 'video',
        updateProfile: true,
      },
    });
    expect(r.ok).toBe(true);
    const data = r.data as { profileUpdated: boolean; profile: UserProfile };
    expect(data.profileUpdated).toBe(true);
    expect(data.profile.dislikes).toEqual(['引战']);
    expect(data.profile.interests.map((i) => i.tag)).toContain('Rust 异步编程实战');
    // 白名单也要写：这条用户要看，之后不再判它
    expect(store['whitelist']).toEqual(['BV2']);
  });

  it('手动纠正被单独记一份（自动归纳不会覆盖它）', async () => {
    store['profile'] = profile;
    await handleMessage({
      type: MSG.REVOKE, id: 'r2b',
      payload: {
        itemId: 'BV2b',
        matchedTag: '游戏实况',
        text: 'Rust 异步编程实战',
        kind: 'video',
        updateProfile: true,
      },
    });
    expect(store['profileOverrides']).toEqual({
      removedDislikes: ['游戏实况'],
      addedInterests: ['Rust 异步编程实战'],
    });
  });

  it('只撤销不记纠正', async () => {
    store['profile'] = profile;
    await handleMessage({
      type: MSG.REVOKE, id: 'r2c', payload: { itemId: 'BV2c' },
    });
    expect(store['profileOverrides']).toBeUndefined();
  });

  it('没有画像时只撤销，不报错', async () => {
    const r = await handleMessage({
      type: MSG.REVOKE, id: 'r3',
      payload: { itemId: 'BV3', matchedTag: 'x', updateProfile: true },
    });
    expect(r.ok).toBe(true);
    expect((r.data as { profileUpdated: boolean }).profileUpdated).toBe(false);
    expect(store['whitelist']).toEqual(['BV3']);
  });

  it('缺 itemId 时报错', async () => {
    const r = await handleMessage({ type: MSG.REVOKE, id: 'r4', payload: {} });
    expect(r.ok).toBe(false);
  });
});
