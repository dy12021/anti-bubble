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
import { defaultSettings } from '../../src/bg/storage';
import type { ContentItem, Verdict } from '../../src/shared/types';

function video(text: string): ContentItem {
  return {
    kind: 'video', id: 'BV1', text, author: 'UP', meta: {},
    context: { page: 'search', videoTitle: text },
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('判定档位（路由层）', () => {
  it('仅关键词档：没配 LLM Key 也能判（这一档不依赖 LLM）', async () => {
    store['settings'] = { ...defaultSettings(), judgeLevel: 'keyword' };
    const r = await handleMessage({
      type: MSG.JUDGE_ITEMS, id: 'j1',
      payload: { items: [video('你真是傻逼')], mode: 'cocoon', subject: null },
    });
    expect(r.ok).toBe(true);
    const verdicts = (r.data as { verdicts: Verdict[] }).verdicts;
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.action).toBe('fold');
    expect(verdicts[0]!.reason).toContain('命中');
  });

  it('仅关键词档：没命中就放行', async () => {
    store['settings'] = { ...defaultSettings(), judgeLevel: 'keyword' };
    const r = await handleMessage({
      type: MSG.JUDGE_ITEMS, id: 'j2',
      payload: { items: [video('今天天气不错')], mode: 'cocoon', subject: null },
    });
    const verdicts = (r.data as { verdicts: Verdict[] }).verdicts;
    expect(verdicts[0]!.action).toBe('pass');
  });

  it('其它档位：没配 LLM Key 判不了（全部放行，不报错）', async () => {
    store['settings'] = { ...defaultSettings(), judgeLevel: 'coarse' };
    const r = await handleMessage({
      type: MSG.JUDGE_ITEMS, id: 'j3',
      payload: { items: [video('你真是傻逼')], mode: 'cocoon', subject: null },
    });
    expect(r.ok).toBe(true);
    const verdicts = (r.data as { verdicts: Verdict[] }).verdicts;
    expect(verdicts).toHaveLength(0);
  });

  it('默认档位是「关键词初筛」', () => {
    expect(defaultSettings().judgeLevel).toBe('coarse');
  });
});
