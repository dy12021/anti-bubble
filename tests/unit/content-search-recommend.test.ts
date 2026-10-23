import { describe, it, expect, vi } from 'vitest';
import { fetchSearchOppositeRecommendations, SEARCH_ANTI_VIDEOS } from '../../src/content/search-recommend';
import type { ContentItem, Settings } from '../../src/shared/types';
import type { BiliClient } from '../../src/bili/client';
import type { SearchItem } from '../../src/bili/types';

const settings: Settings = {
  mode: 'anti',
  enabledPages: { search: true, video: true, feed: true, unknown: false },
  masterEnabled: true,
  collectHistory: true,
  confidenceThreshold: 0.7,
  judgeLevel: 'coarse',
};

function card(id: string, title: string): ContentItem {
  return {
    kind: 'video', id, text: title, author: 'UP', meta: {},
    context: { page: 'search', videoTitle: title },
  };
}

/** 假 BiliClient：搜索接口返回一个候选。 */
function fakeBili(): BiliClient {
  const item: SearchItem = {
    bvid: 'BVopp1', title: 'AI造福人类', author: 'UP', mid: 1,
    duration: '10:00', description: '', pubdate: 0, pic: '',
  };
  return {
    getSigned: vi.fn(async () => ({ result: [item] })),
  } as unknown as BiliClient;
}

describe('搜索页的反向推荐', () => {
  it('非反信息茧房模式不触发', async () => {
    const send = vi.fn();
    const out = await fetchSearchOppositeRecommendations(
      [card('BV1', '标题')],
      { ...settings, mode: 'cocoon' },
      { bili: fakeBili(), send },
    );
    expect(out).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('没有内容时什么都不做', async () => {
    const send = vi.fn();
    expect(await fetchSearchOppositeRecommendations([], settings, { bili: fakeBili(), send })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('没有立场的视频不触发（不是所有视频都表达观点）', async () => {
    const send = vi.fn(async (msg: unknown) => {
      const t = (msg as { type?: string }).type;
      if (t === 'GET_WORDLIST') {
        return { ok: true, data: { stance: '', oppositeKeywords: ['AI 造福人类'] } };
      }
      return { ok: true, data: { items: [{ bvid: 'BVopp1', title: 'x', author: 'y', reason: 'r', url: 'u' }] } };
    });
    const out = await fetchSearchOppositeRecommendations(
      [card('BV1', '红黑榜选购指南')],
      settings,
      { bili: fakeBili(), send },
    );
    expect(out).toEqual([]);
  });

  it('没有对立检索词也不触发', async () => {
    const send = vi.fn(async () => ({
      ok: true, data: { stance: '推荐购买', oppositeKeywords: [] },
    }));
    const out = await fetchSearchOppositeRecommendations(
      [card('BV1', '红黑榜选购指南')],
      settings,
      { bili: fakeBili(), send },
    );
    expect(out).toEqual([]);
  });

  it('有立场且选出相反观点时返回推荐', async () => {
    const send = vi.fn(async (msg: unknown) => {
      const t = (msg as { type?: string }).type;
      if (t === 'GET_WORDLIST') {
        return { ok: true, data: { stance: 'AI 会毁灭人类', oppositeKeywords: ['AI 造福人类'] } };
      }
      return {
        ok: true,
        data: { items: [{ bvid: 'BVopp1', title: 'AI造福人类', author: 'UP', reason: '主张相反', url: 'u' }] },
      };
    });
    const out = await fetchSearchOppositeRecommendations(
      [card('BV1', 'AI末日论')],
      settings,
      { bili: fakeBili(), send },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.bvid).toBe('BVopp1');
  });

  it('只处理最靠前的几个（成本封顶）', async () => {
    const many = Array.from({ length: 10 }, (_, i) => card(`BV${i}`, `标题${i}`));
    const send = vi.fn(async (msg: unknown) => {
      const t = (msg as { type?: string }).type;
      if (t === 'GET_WORDLIST') {
        return { ok: true, data: { stance: '立场', oppositeKeywords: ['x'] } };
      }
      return { ok: true, data: { items: [] } };
    });
    await fetchSearchOppositeRecommendations(many, settings, { bili: fakeBili(), send });
    const wordlistCalls = send.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'GET_WORDLIST',
    );
    expect(wordlistCalls).toHaveLength(SEARCH_ANTI_VIDEOS);
  });

  it('同一个候选不会重复出现', async () => {
    const send = vi.fn(async (msg: unknown) => {
      const t = (msg as { type?: string }).type;
      if (t === 'GET_WORDLIST') {
        return { ok: true, data: { stance: '立场', oppositeKeywords: ['x'] } };
      }
      return {
        ok: true,
        data: { items: [{ bvid: 'BVopp1', title: 't', author: 'a', reason: 'r', url: 'u' }] },
      };
    });
    const out = await fetchSearchOppositeRecommendations(
      [card('BV1', '甲'), card('BV2', '乙')],
      settings,
      { bili: fakeBili(), send },
    );
    expect(out).toHaveLength(1);
  });

  it('后台报错时静默跳过，不影响页面', async () => {
    const send = vi.fn(async () => { throw new Error('boom'); });
    const out = await fetchSearchOppositeRecommendations(
      [card('BV1', '标题')],
      settings,
      { bili: fakeBili(), send },
    );
    expect(out).toEqual([]);
  });
});
