import { describe, it, expect, vi } from 'vitest';
import {
  collectColdStart,
  toSample,
  COLD_START_MAX_FOLDERS,
  COLD_START_MAX_PAGES_PER_FOLDER,
  COLD_START_MAX_SAMPLES,
} from '../../src/profile/collect';
import { BiliClient } from '../../src/bili/client';
import type { ContentItem } from '../../src/shared/types';

/**
 * WBI 签名需要先拿到 mixin key，而 mixin key 来自 /x/web-interface/nav。
 * 真实实现里 `fetchHistory` 走的是 `getPaged` → `getSigned`，
 * 所以 mock 必须能回答 nav，否则历史接口根本发不出去。
 * 这里给一份固定的 wbi_img（真实环境由 B 站下发，24 小时轮换）。
 */
const NAV_RESPONSE = {
  code: 0, message: '0',
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f07bf2184b0cbc.png',
    },
  },
};

function clientWith(responses: Record<string, unknown>) {
  return new BiliClient({
    getJson: async (url: string) => {
      if (url.includes('/x/web-interface/nav')) return NAV_RESPONSE;
      for (const [k, v] of Object.entries(responses)) {
        if (url.includes(k)) return v;
      }
      return { code: 0, message: '0', data: null };
    },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  });
}

describe('样本采集', () => {
  it('toSample 把内容单元转成样本', () => {
    const item: ContentItem = {
      kind: 'video', id: 'BV1', text: '标题', author: 'UP',
      meta: { category: '技术' },
      context: { page: 'feed' },
    };
    const s = toSample(item, 120, 'history');
    expect(s.id).toBe('BV1');
    expect(s.category).toBe('技术');
    expect(s.watchSeconds).toBe(120);
    expect(s.origin).toBe('history');
  });

  it('toSample 缺分区时用空串而不是 undefined', () => {
    const item: ContentItem = {
      kind: 'video', id: 'BV1', text: 't', author: 'a', meta: {}, context: { page: 'feed' },
    };
    expect(toSample(item, 10, 'history').category).toBe('');
  });

  it('冷启动拉取历史并转成样本', async () => {
    const c = clientWith({
      '/x/v2/history/cursor': {
        code: 0, message: '0',
        data: {
          list: [{
            history: {
              bvid: 'BV1', title: '历史视频', author_name: 'UP',
              mid: 1, duration: 100, viewed_at: 1_700_000_000, tname: '技术',
            },
          }],
          page: { has_more: false },
        },
      },
    });
    const samples = await collectColdStart(c);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]!.id).toBe('BV1');
    expect(samples[0]!.origin).toBe('history');
  });

  it('关闭 includeHistory 时不拉历史', async () => {
    const seen: string[] = [];
    const c = new BiliClient({
      getJson: async (url: string) => {
        seen.push(url);
        return { code: 0, message: '0', data: { list: [], page: { has_more: false } } };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    await collectColdStart(c, { includeHistory: false });
    expect(seen.some((u) => u.includes('/x/v2/history/cursor'))).toBe(false);
  });

  it('拉取失败时返回空数组而不是抛错', async () => {
    const c = new BiliClient({
      getJson: async () => { throw new Error('net'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await collectColdStart(c)).toEqual([]);
  });

  /**
   * 回归防护：冷启动的请求量必须有上限。
   *
   * 收藏夹多 + 每页 40 条 + 最多 10 页，10 个收藏夹就是 100 个请求，
   * 每个还要等 1.2 秒限流 = 两分钟。而这些请求和「取视频上下文」共用
   * 同一个限流器，于是冷启动会把主流程堵在后面——
   * 表现为「视频页评论区面板迟迟不出现」。
   */
  it('冷启动的请求量有上限，不会淹没主流程', async () => {
    const seen: string[] = [];
    const c = new BiliClient({
      getJson: async (url: string) => {
        seen.push(url);
        if (url.includes('/x/v3/fav/folder/created/list-all')) {
          // 假装用户有 20 个收藏夹
          return {
            code: 0, message: '0',
            data: { list: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'f', media_count: 999 })) },
          };
        }
        if (url.includes('/x/v3/fav/resource/list')) {
          // 每页都满
          return {
            code: 0, message: '0',
            data: { medias: Array.from({ length: 40 }, (_, i) => ({ id: i, type: '2', title: 'v', bvid: 'BV' + i })) },
          };
        }
        return { code: 0, message: '0', data: { list: [], page: { has_more: false } } };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });

    await collectColdStart(c);

    const favCalls = seen.filter((u) => u.includes('/x/v3/fav/resource/list')).length;
    expect(favCalls).toBeLessThanOrEqual(COLD_START_MAX_FOLDERS * COLD_START_MAX_PAGES_PER_FOLDER);
    expect(seen.length).toBeLessThan(30);
  });

  it('样本总数有上限', async () => {
    const c = new BiliClient({
      getJson: async (url: string) => {
        if (url.includes('/x/v3/fav/folder/created/list-all')) {
          return {
            code: 0, message: '0',
            data: { list: Array.from({ length: 20 }, (_, i) => ({ id: i + 1, title: 'f', media_count: 999 })) },
          };
        }
        if (url.includes('/x/v3/fav/resource/list')) {
          return {
            code: 0, message: '0',
            data: { medias: Array.from({ length: 40 }, (_, i) => ({ id: i, type: '2', title: 'v', bvid: 'BV' + i })) },
          };
        }
        return { code: 0, message: '0', data: { list: [], page: { has_more: false } } };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const samples = await collectColdStart(c);
    expect(samples.length).toBeLessThanOrEqual(COLD_START_MAX_SAMPLES);
  });
});
