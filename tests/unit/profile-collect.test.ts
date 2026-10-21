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
    mid: 999,
    isLogin: true,
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
    const r = await collectColdStart(c);
    expect(r.samples.length).toBeGreaterThan(0);
    expect(r.samples[0]!.id).toBe('BV1');
    expect(r.samples[0]!.origin).toBe('history');
    expect(r.counts['history']).toBe(1);
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

  it('拉取失败时不抛错，样本为空并记下原因', async () => {
    const c = new BiliClient({
      getJson: async () => { throw new Error('net'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const r = await collectColdStart(c);
    expect(r.samples).toEqual([]);
    expect(r.loggedIn).toBe(false);
  });

  /**
   * 回归防护：**必填参数不能漏**。
   *
   * 用户实测反馈「没有读取我的收藏」——根因就是
   * `/x/v3/fav/folder/created/list-all` 漏了 `up_mid`，B 站返回 -400。
   * 看起来像「没有收藏」，其实是「参数不对」。
   */
  it('收藏夹列表带 up_mid、收藏夹内容用 media_id', async () => {
    const seen: string[] = [];
    const c = new BiliClient({
      getJson: async (url: string) => {
        seen.push(url);
        if (url.includes('/x/web-interface/nav')) {
          return { code: 0, message: '0', data: { mid: 999, isLogin: true } };
        }
        if (url.includes('/x/v3/fav/folder/created/list-all')) {
          return { code: 0, message: '0', data: { list: [{ id: 42, title: '收藏夹', media_count: 2 }] } };
        }
        if (url.includes('/x/v3/fav/resource/list')) {
          return {
            code: 0, message: '0',
            data: { medias: [{ id: 1, bvid: 'BVfav1', title: '收藏的视频', upper: { name: 'UP' } }] },
          };
        }
        return { code: 0, message: '0', data: null };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const r = await collectColdStart(c);
    const folderCall = seen.find((u) => u.includes('list-all'))!;
    expect(folderCall).toContain('up_mid=999');
    const itemCall = seen.find((u) => u.includes('/x/v3/fav/resource/list'))!;
    expect(itemCall).toContain('media_id=42');
    expect(r.counts['favorite']).toBe(1);
    expect(r.samples.some((s) => s.id === 'BVfav1')).toBe(true);
  });

  it('关注列表带 vmid', async () => {
    const seen: string[] = [];
    const c = new BiliClient({
      getJson: async (url: string) => {
        seen.push(url);
        if (url.includes('/x/web-interface/nav')) {
          return { code: 0, message: '0', data: { mid: 999, isLogin: true } };
        }
        if (url.includes('/x/relation/followings')) {
          return { code: 0, message: '0', data: { list: [{ mid: 5, uname: '关注的UP' }] } };
        }
        return { code: 0, message: '0', data: null };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const r = await collectColdStart(c);
    const call = seen.find((u) => u.includes('/x/relation/followings'))!;
    expect(call).toContain('vmid=999');
    expect(r.counts['following']).toBe(1);
  });

  /**
   * 回归防护：**一个源失败不能拖垮整轮采集**。
   *
   * 早先是「收藏夹接口抛异常 → 整轮采集中断 → 样本 0 条」，
   * 症状是「什么都没读到」，而不是「这个源没读到」。
   */
  it('一个源失败，其它源照常采到（逐源隔离）', async () => {
    const c = new BiliClient({
      getJson: async (url: string) => {
        if (url.includes('/x/web-interface/nav')) {
          return { code: 0, message: '0', data: { mid: 999, isLogin: true } };
        }
        if (url.includes('/x/v3/fav/folder/created/list-all')) {
          throw new Error('收藏夹接口炸了');
        }
        if (url.includes('/x/v2/history/cursor')) {
          return {
            code: 0, message: '0',
            data: { list: [{ history: { bvid: 'BVh1', title: '历史', author_name: 'UP' } }], page: {} },
          };
        }
        return { code: 0, message: '0', data: null };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const r = await collectColdStart(c);
    expect(r.counts['history']).toBe(1);
    expect(r.samples.some((s) => s.id === 'BVh1')).toBe(true);
  });

  it('每个来源的条数分别统计（面板要能看出哪一路没通）', async () => {
    const c = clientWith({
      '/x/v2/history/cursor': {
        code: 0, message: '0',
        data: { list: [{ history: { bvid: 'BV1', title: 't', author_name: 'u' } }], page: {} },
      },
    });
    const r = await collectColdStart(c);
    expect(r.counts['history']).toBe(1);
    expect(r.counts['favorite']).toBe(0);
    expect(Object.keys(r.counts).length).toBeGreaterThanOrEqual(5);
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
        if (url.includes('/x/web-interface/nav')) {
          return { code: 0, message: '0', data: { mid: 999, isLogin: true } };
        }
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
    const r = await collectColdStart(c);
    expect(r.samples.length).toBeLessThanOrEqual(COLD_START_MAX_SAMPLES);
  });
});
