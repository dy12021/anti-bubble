import { describe, it, expect, vi } from 'vitest';
import { BiliClient } from '../../src/bili/client';
import {
  fetchHistory,
  fetchVideo,
  fetchVideoIdByBvid,
  searchVideos,
  fetchComments,
} from '../../src/bili/api';
import type { HistoryItem, VideoItem, SearchItem, CommentItem } from '../../src/bili/types';

/** nav 接口：getSigned 要靠它拿 WBI 密钥。 */
const NAV_OK = {
  code: 0,
  message: '0',
  data: {
    wbi_img: {
      img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
      sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
    },
  },
};

type RoutePayload = unknown | ((url: string) => unknown);

/**
 * 造一个真 BiliClient，但把网络层换掉：按 URL 子串匹配返回不同响应。
 * 这样上层 api.ts 的真实逻辑（拼参数、翻页、取值）都会被覆盖到。
 */
function makeClient(routes: Array<[string, RoutePayload]>) {
  const all: Array<[string, RoutePayload]> = [['/x/web-interface/nav', NAV_OK], ...routes];
  const getJson = vi.fn(async (url: string) => {
    for (const [needle, payload] of all) {
      if (url.includes(needle)) {
        return typeof payload === 'function'
          ? (payload as (u: string) => unknown)(url)
          : payload;
      }
    }
    return { code: 0, message: '0', data: null };
  });
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new BiliClient({ getJson, now: () => 1_000_000, sleep });
  return { client, getJson, sleep };
}

/** 只要某个接口被调过。 */
function urlsOf(getJson: ReturnType<typeof vi.fn>, needle: string): string[] {
  return getJson.mock.calls.map((c) => c[0]).filter((u) => u.includes(needle));
}

const HISTORY_1: HistoryItem = {
  history: {
    bvid: 'BV1page1',
    title: '第一个',
    author_name: 'A',
    mid: 1,
    cover: '',
    duration: 60,
    viewed_at: 1,
    business: 'archive',
  },
};

const HISTORY_2: HistoryItem = {
  history: {
    bvid: 'BV2page2',
    title: '第二个',
    author_name: 'B',
    mid: 2,
    cover: '',
    duration: 120,
    viewed_at: 2,
    business: 'archive',
  },
};

describe('fetchHistory', () => {
  it('能翻页取回', async () => {
    const { client, getJson } = makeClient([
      [
        '/x/v2/history/cursor',
        (url: string) =>
          url.includes('cursor=page2')
            ? { code: 0, message: '0', data: { list: [HISTORY_2], page: { has_more: false } } }
            : {
                code: 0,
                message: '0',
                data: { list: [HISTORY_1], page: { has_more: true, cursor: 'page2' } },
              },
      ],
    ]);

    const items = await fetchHistory(client);

    expect(items).toHaveLength(2);
    expect(items[0]!.history.bvid).toBe('BV1page1');
    expect(items[1]!.history.bvid).toBe('BV2page2');
    expect(urlsOf(getJson, 'history/cursor')).toHaveLength(2);
  });

  it('maxItems 会截断', async () => {
    const { client } = makeClient([
      [
        '/x/v2/history/cursor',
        {
          code: 0,
          message: '0',
          data: { list: [HISTORY_1, HISTORY_2], page: { has_more: false } },
        },
      ],
    ]);

    const items = await fetchHistory(client, 1);

    expect(items).toHaveLength(1);
    expect(items[0]!.history.bvid).toBe('BV1page1');
  });
});

describe('fetchVideo', () => {
  const VIDEO: VideoItem = {
    bvid: 'BV1xx',
    aid: 100,
    title: '标题',
    author: 'UP',
    mid: 5,
    duration: 300,
    description: '简介',
    pic: '',
    pubdate: 1,
    owner: { mid: 5, name: 'UP' },
    stat: { view: 1, danmaku: 0, reply: 0, favorite: 0, like: 0 },
  };

  it('命中 /x/web-interface/view', async () => {
    const { client, getJson } = makeClient([
      ['/x/web-interface/view', { code: 0, message: '0', data: VIDEO }],
    ]);

    const v = await fetchVideo(client, 'BV1xx');

    expect(v).not.toBeNull();
    expect(v!.bvid).toBe('BV1xx');
    const urls = urlsOf(getJson, '/x/web-interface/view');
    expect(urls).toHaveLength(1);
    expect(urls[0]!).toContain('bvid=BV1xx');
  });
});

describe('fetchVideoIdByBvid', () => {
  it('从详情里取 aid/cid/upMid', async () => {
    const { client } = makeClient([
      [
        '/x/web-interface/view',
        { code: 0, message: '0', data: { aid: 123, cid: 456, owner: { mid: 789 } } },
      ],
    ]);

    const ids = await fetchVideoIdByBvid(client, 'BV1xx');

    expect(ids).toEqual({ aid: 123, cid: 456, upMid: 789 });
  });

  it('缺字段时返回 null', async () => {
    const { client } = makeClient([
      ['/x/web-interface/view', { code: 0, message: '0', data: { aid: 123 } }],
    ]);

    await expect(fetchVideoIdByBvid(client, 'BV1xx')).resolves.toBeNull();
  });

  it('接口失败时返回 null', async () => {
    const { client } = makeClient([
      ['/x/web-interface/view', { code: -404, message: '啥都木有', data: null }],
    ]);

    await expect(fetchVideoIdByBvid(client, 'BV1xx')).resolves.toBeNull();
  });
});

describe('searchVideos', () => {
  const SEARCH_RESULT: SearchItem = {
    bvid: 'BVsearch',
    title: '搜索结果',
    author: 'UP',
    mid: 9,
    duration: '10:00',
    description: '',
    pubdate: 1,
    pic: '',
  };

  it('返回结果数组', async () => {
    const { client, getJson } = makeClient([
      [
        '/x/web-interface/wbi/search/type',
        { code: 0, message: '0', data: { result: [SEARCH_RESULT] } },
      ],
    ]);

    const items = await searchVideos(client, '关键词');

    expect(items).toHaveLength(1);
    expect(items[0]!.bvid).toBe('BVsearch');
    const urls = urlsOf(getJson, 'search/type');
    expect(urls).toHaveLength(1);
    expect(urls[0]!).toContain('keyword=%E5%85%B3%E9%94%AE%E8%AF%8D');
  });

  it('无结果时返回空数组', async () => {
    const { client } = makeClient([
      ['/x/web-interface/wbi/search/type', { code: 0, message: '0', data: {} }],
    ]);

    await expect(searchVideos(client, '关键词')).resolves.toEqual([]);
  });
});

describe('fetchComments', () => {
  const REPLY: CommentItem = {
    rpid: 1,
    mid: 2,
    ctime: 3,
    like: 4,
    rcount: 0,
    content: { message: '好看' },
    member: { mid: 2, uname: '路人', level: 3 },
  };

  it('mode=3 时 URL 含 mode=3', async () => {
    const { client, getJson } = makeClient([
      [
        '/x/v2/reply/wbi/main',
        { code: 0, message: '0', data: { replies: [REPLY], page: { has_more: false } } },
      ],
    ]);

    const items = await fetchComments(client, 999);

    expect(items).toHaveLength(1);
    expect(items[0]!.content.message).toBe('好看');
    const urls = urlsOf(getJson, 'reply/wbi/main');
    expect(urls).toHaveLength(1);
    expect(urls[0]!).toContain('mode=3');
    expect(urls[0]!).not.toContain('root=');
  });

  it('带 parent 时 URL 含 mode=2 且含 root=555', async () => {
    const { client, getJson } = makeClient([
      [
        '/x/v2/reply/wbi/main',
        { code: 0, message: '0', data: { replies: [REPLY], page: { has_more: false } } },
      ],
    ]);

    const items = await fetchComments(client, 999, 2, 555);

    expect(items).toHaveLength(1);
    const urls = urlsOf(getJson, 'reply/wbi/main');
    expect(urls).toHaveLength(1);
    expect(urls[0]!).toContain('mode=2');
    expect(urls[0]!).toContain('root=555');
  });

  it('接口失败时返回空数组', async () => {
    const { client } = makeClient([
      ['/x/v2/reply/wbi/main', { code: -101, message: '未登录', data: null }],
    ]);

    await expect(fetchComments(client, 999)).resolves.toEqual([]);
  });
});
