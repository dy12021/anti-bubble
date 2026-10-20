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

import { ProfileService } from '../../src/bg/profile-service';
import { handleMessage } from '../../src/bg/router';
import { MSG } from '../../src/shared/messages';
import type { LlmClient } from '../../src/bg/llm/client';
import type { UserProfileInput } from '../../src/shared/types';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function client(): LlmClient {
  return {
    complete: vi.fn(async () => JSON.stringify({
      interests: [{ tag: '技术', weight: 0.8 }],
      dislikes: [],
      stanceHints: {},
      topics: ['Rust'],
    })),
  };
}

function sample(over: Partial<UserProfileInput> = {}): UserProfileInput {
  return {
    id: 'BV1', title: '标题', author: 'UP', category: '技术',
    collectedAt: new Date(NOW).toISOString(), origin: 'history', ...over,
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('冷启动样本落库', () => {
  it('addSamples 把样本并进 watchLog', async () => {
    const svc = new ProfileService(client(), () => NOW);
    const n = await svc.addSamples([sample({ id: 'A' }), sample({ id: 'B' })]);
    expect(n).toBe(2);
    expect((store['watchLog'] as unknown[]).length).toBe(2);
  });

  it('addSamples 按 id 去重', async () => {
    const svc = new ProfileService(client(), () => NOW);
    await svc.addSamples([sample({ id: 'A' })]);
    const n = await svc.addSamples([sample({ id: 'A' }), sample({ id: 'B' })]);
    expect(n).toBe(2);
  });

  it('addSamples 空数组不改动已有数据', async () => {
    const svc = new ProfileService(client(), () => NOW);
    await svc.addSamples([sample({ id: 'A' })]);
    await svc.addSamples([]);
    expect((store['watchLog'] as unknown[]).length).toBe(1);
  });

  it('addSamples 后 refresh 能用这些样本归纳出画像', async () => {
    const c = client();
    const svc = new ProfileService(c, () => NOW);
    await svc.addSamples([sample({ id: 'A' })]);
    const profile = await svc.refresh(c, { force: true });
    expect(profile.sampleCount).toBe(1);
    expect(profile.interests.length).toBeGreaterThan(0);
  });
});

describe('SYNC_PROFILE_SAMPLES 路由', () => {
  it('没有 LLM 配置时报错而不是静默成功', async () => {
    const r = await handleMessage({
      type: MSG.SYNC_PROFILE_SAMPLES, id: 'r1',
      payload: { samples: [sample()] },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('配了 LLM 后落库并返回画像', async () => {
    await handleMessage({
      type: MSG.SET_LLM_CONFIG, id: 'r2',
      payload: {
        config: {
          provider: 'openai', baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test', model: 'm1', timeoutMs: 5000,
        },
      },
    });
    const r = await handleMessage({
      type: MSG.SYNC_PROFILE_SAMPLES, id: 'r3',
      payload: { samples: [sample({ id: 'A' }), sample({ id: 'B' })] },
    });
    expect(r.ok).toBe(true);
    const data = r.data as { profile: { sampleCount: number }; sampleCount: number };
    expect(data.sampleCount).toBe(2);
    expect(data.profile.sampleCount).toBe(2);
    expect((store['watchLog'] as unknown[]).length).toBe(2);
  });
});
