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

import { ProfileService, PROFILE_MAX_AGE_MS, WATCH_SAMPLE } from '../../src/bg/profile-service';
import type { ContentItem } from '../../src/shared/types';
import type { LlmClient } from '../../src/bg/llm/client';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'video', id: 'BV1', text: '标题', author: 'UP',
    meta: { category: '技术' }, context: { page: 'feed' }, ...over,
  };
}

function client(): LlmClient {
  return {
    complete: vi.fn(async () => JSON.stringify({
      interests: [{ tag: '技术', weight: 0.8 }], dislikes: [],
      stanceHints: {}, topics: ['x'],
    })),
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('画像服务', () => {
  it('没有画像时 get 返回 null', async () => {
    const s = new ProfileService(client(), () => NOW);
    expect(await s.get()).toBeNull();
  });

  it('refresh 后能取到画像', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.refresh(client());
    expect((await s.get())?.interests.length).toBeGreaterThan(0);
  });

  it('未过期时 refresh 不重新调用 LLM', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    await s.refresh(c);
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    await s.refresh(c);
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('force 会强制重新归纳', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    await s.refresh(c);
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    await s.refresh(c, { force: true });
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });

  it('观看不足阈值不记样本', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.record(item(), WATCH_SAMPLE - 1);
    expect(await s.get()).toBeNull();
  });

  it('观看超过阈值记样本', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.record(item(), WATCH_SAMPLE + 1);
    expect(await s.get()).not.toBeNull();
  });

  it('记录后画像样本数增加', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.record(item({ id: 'BV1' }), 100);
    await s.record(item({ id: 'BV2' }), 100);
    expect((await s.get())?.sampleCount).toBeGreaterThanOrEqual(2);
  });

  it('clear 后画像消失', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.refresh(client());
    await s.clear();
    expect(await s.get()).toBeNull();
  });

  it('过期常量为 24 小时', () => {
    expect(PROFILE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});

/**
 * 懒刷新：判定路径上自动维护画像的新鲜度。
 *
 * 回归防护：早先判定时直接 getProfile()，**画像用多久都不会更新**——
 * PROFILE_MAX_AGE_MS 那个 24 小时过期机制在生产路径上从没生效过。
 */
describe('画像懒刷新', () => {
  const OLD = NOW - PROFILE_MAX_AGE_MS - 60_000; // 25 小时前

  it('画像还新鲜时直接用，不调 LLM', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    await s.refresh(c);
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const p = await s.getOrRefresh(c);
    expect(p).not.toBeNull();
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('画像过期且有样本时重新归纳', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    await s.record(item(), 100);            // 有一条样本
    // 把画像的时间改旧
    const cur = (await s.get())!;
    store['profile'] = { ...cur, updatedAt: new Date(OLD).toISOString() };
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    await s.getOrRefresh(c);
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });

  it('画像过期但没有样本时保留旧画像，也不调 LLM', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    await s.refresh(c);
    const cur = (await s.get())!;
    store['profile'] = { ...cur, updatedAt: new Date(OLD).toISOString() };
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;

    const p = await s.getOrRefresh(c);
    expect(p).not.toBeNull();
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('没有画像也没有样本时返回 null，不花钱', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    expect(await s.getOrRefresh(c)).toBeNull();
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('归纳失败时保留旧画像（不用规则画像顶掉）', async () => {
    const bad: LlmClient = { complete: vi.fn(async () => { throw new Error('挂了'); }) };
    const s = new ProfileService(bad, () => NOW);
    await s.record(item(), 100);
    const cur = (await s.get())!;
    store['profile'] = { ...cur, updatedAt: new Date(OLD).toISOString() };

    const p = await s.getOrRefresh(bad);
    expect(p?.interests.length).toBeGreaterThan(0);
  });

  it('失败后一小时内不再重试（LLM 挂掉时不会每次判定都等它超时）', async () => {
    let now = NOW;
    const bad: LlmClient = { complete: vi.fn(async () => { throw new Error('挂了'); }) };
    const s = new ProfileService(bad, () => now);
    await s.record(item(), 100);
    const cur = (await s.get())!;
    store['profile'] = { ...cur, updatedAt: new Date(OLD).toISOString() };

    await s.getOrRefresh(bad);
    const after = (bad.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(after).toBeGreaterThan(0);

    // 一小时内再试：不应该再调 LLM
    now = NOW + 10 * 60 * 1000;
    await s.getOrRefresh(bad);
    expect((bad.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(after);
  });
});
