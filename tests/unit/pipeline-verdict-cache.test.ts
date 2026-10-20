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

import { VerdictCache, verdictContextKey } from '../../src/pipeline/verdict-cache';
import type { ContentItem, Verdict } from '../../src/shared/types';

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'comment', id: 'c1', text: 't', author: 'u',
    meta: {}, context: { page: 'video', videoId: 'BV1' }, ...over,
  };
}

const v: Verdict = {
  itemId: 'c1', action: 'hide', reason: '在引战',
  reasonCode: 'incitement', confidence: 0.9, revocable: true,
};

describe('判定缓存', () => {
  it('存进去能取出来', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx', v);
    expect((await c.get('c1', 'ctx'))?.action).toBe('hide');
  });

  it('不同 context 不共享', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx1', v);
    expect(await c.get('c1', 'ctx2')).toBeNull();
  });

  it('不同 id 不共享', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx', v);
    expect(await c.get('c2', 'ctx')).toBeNull();
  });

  it('clear 后取不到', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx', v);
    await c.clear();
    expect(await c.get('c1', 'ctx')).toBeNull();
  });

  it('context key 随模式变化', () => {
    expect(verdictContextKey(item(), 'cocoon')).not.toBe(verdictContextKey(item(), 'anti'));
  });

  it('context key 随视频变化', () => {
    const a = item({ context: { page: 'video', videoId: 'BV1' } });
    const b = item({ context: { page: 'video', videoId: 'BV2' } });
    expect(verdictContextKey(a, 'cocoon')).not.toBe(verdictContextKey(b, 'cocoon'));
  });
});
