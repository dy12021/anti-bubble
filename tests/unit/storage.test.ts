import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Settings, UserProfile } from '../../src/shared/types';
import {
  getJson, setJson, removeKey,
  defaultSettings, getSettings, saveSettings,
  getProfile, saveProfile, clearProfile,
  getLlmConfig, saveLlmConfig,
  getWhitelist, addToWhitelist,
} from '../../src/bg/storage';

/**
 * 内存版 chrome.storage.local。
 *
 * 只实现本层用到的三个方法，行为对齐真实 API：
 * get 只回传存在的键，set/remove 是 callback 风格。
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

const sampleProfile: UserProfile = {
  interests: [{ tag: '前端', weight: 0.8 }],
  dislikes: ['引战'],
  stanceHints: { 'a': '支持' },
  topics: ['编程'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 3,
};

describe('存储层', () => {
  it('读不存在的键返回兜底值', async () => {
    expect(await getJson('missing', 'fallback')).toBe('fallback');
  });

  it('存入的 null 也回落到兜底值', async () => {
    await setJson('k', null);
    expect(await getJson('k', 'fallback')).toBe('fallback');
  });

  it('写入后能读回', async () => {
    await setJson('k', { a: 1 });
    expect(await getJson('k', null)).toEqual({ a: 1 });
  });

  it('removeKey 删掉键', async () => {
    await setJson('k', 1);
    await removeKey('k');
    expect(await getJson('k', 'gone')).toBe('gone');
  });

  it('默认设置是信息茧房模式且三页面都开', () => {
    const s = defaultSettings();
    expect(s.mode).toBe('cocoon');
    expect(s.masterEnabled).toBe(true);
    expect(s.enabledPages.search).toBe(true);
    expect(s.enabledPages.video).toBe(true);
    expect(s.enabledPages.feed).toBe(true);
  });

  it('保存设置只改传入的字段', async () => {
    await setJson('settings', defaultSettings());
    const next = await saveSettings({ mode: 'anti' });
    expect(next.mode).toBe('anti');
    expect(next.masterEnabled).toBe(true);
  });

  it('enabledPages 是浅合并而不是整体替换', async () => {
    await setJson('settings', defaultSettings());
    // 只传部分页面开关：整体传全量的话，「合并」和「替换」的结果一样，测不出差别。
    // 这里不写类型断言——SettingsPatch 就是为了让这个调用在类型上成立。
    const next = await saveSettings({ enabledPages: { search: false } });
    expect(next.enabledPages.search).toBe(false);
    expect(next.enabledPages.video).toBe(true);
    expect(next.enabledPages.feed).toBe(true);
  });

  it('读设置时把存量与默认值合并', async () => {
    await setJson('settings', { mode: 'anti' });
    const s = await getSettings();
    expect(s.mode).toBe('anti');
    expect(s.masterEnabled).toBe(true);
    expect(s.enabledPages.search).toBe(true);
  });

  it('画像可存可读', async () => {
    await saveProfile(sampleProfile);
    expect(await getProfile()).toEqual(sampleProfile);
  });

  it('没有画像时返回 null', async () => {
    expect(await getProfile()).toBeNull();
  });

  it('清空画像后读回 null', async () => {
    await saveProfile(sampleProfile);
    await clearProfile();
    expect(await getProfile()).toBeNull();
  });

  it('清空画像同时清掉 watchLog', async () => {
    await setJson('watchLog', [{ id: 'BV1' }]);
    await clearProfile();
    expect(await getJson('watchLog', null)).toBeNull();
  });

  it('LLM 配置可存可读', async () => {
    const cfg = {
      provider: 'openai' as const,
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test',
      model: 'm1',
      timeoutMs: 5000,
    };
    await saveLlmConfig(cfg);
    expect(await getLlmConfig()).toEqual(cfg);
  });

  it('白名单去重', async () => {
    await addToWhitelist('a');
    await addToWhitelist('a');
    await addToWhitelist('b');
    expect((await getWhitelist()).sort()).toEqual(['a', 'b']);
  });

  it('白名单默认为空数组', async () => {
    expect(await getWhitelist()).toEqual([]);
  });
});
