import { describe, it, expect, vi } from 'vitest';
import { BiliClient } from '../../src/bili/client';

/** nav 接口返回体：带 WBI 密钥，getSigned 要靠它签名。 */
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

/** 一个「时间一直在往前跳」的时钟：保证限流逻辑永远等不到、不会真的 sleep。 */
function advancingClock(step = 10_000): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

describe('BiliClient.get', () => {
  it('成功时返回 data', async () => {
    const getJson = vi.fn(async (_url: string) => ({ code: 0, message: '0', data: { isLogin: true, mid: 42 } }));
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    const nav = await c.get<{ isLogin: boolean; mid: number }>('/x/web-interface/nav');

    expect(nav).toEqual({ isLogin: true, mid: 42 });
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(getJson.mock.calls[0]![0]).toBe('https://api.bilibili.com/x/web-interface/nav');
  });

  it('code !== 0 时返回 null', async () => {
    const getJson = vi.fn(async (_url: string) => ({ code: -101, message: '账号未登录', data: null }));
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await expect(c.get('/x/web-interface/nav')).resolves.toBeNull();
    // 非风控码不重试。
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it('网络异常时返回 null，并且会重试', async () => {
    const getJson = vi.fn(async (_url: string) => {
      throw new Error('network down');
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await expect(c.get('/x/web-interface/nav')).resolves.toBeNull();
    expect(getJson).toHaveBeenCalledTimes(3);
  });

  it('重试用尽后返回 null，退避是指数的', async () => {
    const getJson = vi.fn(async (_url: string) => {
      throw new Error('network down');
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await expect(c.get('/x/web-interface/nav')).resolves.toBeNull();
    expect(getJson).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c2) => c2[0])).toEqual([1200, 2400, 4800]);
  });

  it('风控码 -352 会退避重试', async () => {
    let n = 0;
    const getJson = vi.fn(async () => {
      n += 1;
      if (n < 3) return { code: -352, message: 'risk control', data: null };
      return { code: 0, message: '0', data: { ok: 1 } };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await expect(c.get('/x/web-interface/nav')).resolves.toEqual({ ok: 1 });
    expect(getJson).toHaveBeenCalledTimes(3);
  });

  it('连续请求之间调用了 sleep（限流）', async () => {
    const getJson = vi.fn(async (_url: string) => ({ code: 0, message: '0', data: { ok: 1 } }));
    const sleep = vi.fn(async (_ms: number) => {});
    // 固定时钟：两次请求间隔被判定为 0ms，于是必须等满 BASE_INTERVAL_MS。
    const c = new BiliClient({ getJson, now: () => 1_000_000, sleep });

    await c.get('/a');
    await c.get('/b');

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1200);
  });

  it('URL 里带上查询参数', async () => {
    const getJson = vi.fn(async (_url: string) => ({ code: 0, message: '0', data: { ok: 1 } }));
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await c.get('/x/web-interface/view', { bvid: 'BV1xx' });

    expect(getJson.mock.calls[0]![0]).toBe('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx');
  });
});

describe('BiliClient.getSigned', () => {
  it('URL 里含 w_rid= 和 wts=', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/nav')) return NAV_OK;
      return { code: 0, message: '0', data: { result: [] } };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await c.getSigned('/x/web-interface/wbi/search/type', { keyword: '测试' });

    // 第 0 次是取 WBI 密钥的 nav，第 1 次才是签名后的请求。
    expect(getJson).toHaveBeenCalledTimes(2);
    const signedUrl = getJson.mock.calls[1]![0];
    expect(signedUrl).toContain('w_rid=');
    expect(signedUrl).toContain('wts=');
    expect(signedUrl).toContain('keyword=%E6%B5%8B%E8%AF%95');
  });

  it('取不到 WBI 密钥时返回 null', async () => {
    const getJson = vi.fn(async (_url: string) => ({ code: 0, message: '0', data: {} }));
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await expect(
      c.getSigned('/x/web-interface/wbi/search/type', { keyword: 'x' }),
    ).resolves.toBeNull();
    // 拿不到密钥就不该再发第二个请求。
    expect(getJson).toHaveBeenCalledTimes(1);
  });

  it('签名失败（code !== 0）时返回 null', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/nav')) return NAV_OK;
      return { code: -403, message: 'access denied', data: null };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    await expect(
      c.getSigned('/x/web-interface/wbi/search/type', { keyword: 'x' }),
    ).resolves.toBeNull();
  });
});

describe('BiliClient.getPaged', () => {
  it('按游标翻页，把两页都取回来', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/nav')) return NAV_OK;
      if (url.includes('cursor=page2')) {
        return {
          code: 0,
          message: '0',
          data: { list: [{ history: { bvid: 'BV2' } }], page: { has_more: false } },
        };
      }
      return {
        code: 0,
        message: '0',
        data: {
          list: [{ history: { bvid: 'BV1' } }],
          page: { has_more: true, cursor: 'page2' },
        },
      };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    type Item = { history: { bvid: string } };
    const items = await c.getPaged<
      { list: Item[]; page: { has_more?: boolean; cursor?: string } },
      Item
    >('/x/v2/history/cursor', { type: 'all' }, (d) => d.list ?? []);

    expect(items).toHaveLength(2);
    expect(items[0]!.history.bvid).toBe('BV1');
    expect(items[1]!.history.bvid).toBe('BV2');

    const pagedUrls = getJson.mock.calls
      .map((c2) => c2[0])
      .filter((u) => u.includes('history/cursor'));
    expect(pagedUrls).toHaveLength(2);
    expect(pagedUrls[1]!).toContain('cursor=page2');
  });

  it('单页失败即停止，返回已拿到的部分', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/nav')) return NAV_OK;
      if (url.includes('cursor=page2')) return { code: -101, message: '未登录', data: null };
      return {
        code: 0,
        message: '0',
        data: {
          list: [{ history: { bvid: 'BV1' } }],
          page: { has_more: true, cursor: 'page2' },
        },
      };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    type Item = { history: { bvid: string } };
    const items = await c.getPaged<
      { list: Item[]; page: { has_more?: boolean; cursor?: string } },
      Item
    >('/x/v2/history/cursor', { type: 'all' }, (d) => d.list ?? []);

    expect(items).toHaveLength(1);
    expect(items[0]!.history.bvid).toBe('BV1');
  });

  it('空页直接停止', async () => {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('/x/web-interface/nav')) return NAV_OK;
      return { code: 0, message: '0', data: { list: [], page: { has_more: true, cursor: 'page2' } } };
    });
    const sleep = vi.fn(async (_ms: number) => {});
    const c = new BiliClient({ getJson, now: advancingClock(), sleep });

    const items = await c.getPaged<
      { list: unknown[]; page: { has_more?: boolean; cursor?: string } },
      unknown
    >('/x/v2/history/cursor', { type: 'all' }, (d) => d.list ?? []);

    expect(items).toEqual([]);
  });
});
