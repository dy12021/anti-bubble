import { describe, it, expect, vi } from 'vitest';
import { recallOpposite, judgeOpposition, mineCommentOpposition } from '../../src/recommend/recall';
import { BiliClient } from '../../src/bili/client';
import type { LlmClient } from '../../src/bg/llm/client';
import type { SearchItem } from '../../src/bili/types';

/** nav 接口：getSigned 要靠它拿 WBI 密钥，否则搜索直接返回空。 */
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

const ITEM_A: SearchItem = {
  bvid: 'BV1', title: 'A', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '',
};
const ITEM_B: SearchItem = {
  bvid: 'BV2', title: 'B', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '',
};

describe('反向推荐召回', () => {
  it('多个关键词的结果合并去重', async () => {
    const c = new BiliClient({
      getJson: async (url: string) => {
        if (url.includes('/x/web-interface/nav')) return NAV_OK;
        return {
          code: 0, message: '0',
          data: { result: [
            ITEM_A,
            ...(url.includes('kw2') ? [ITEM_B] : []),
          ] },
        };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const r = await recallOpposite(c, ['kw1', 'kw2']);
    const ids = r.map((x) => x.bvid);
    expect(new Set(ids).size).toBe(ids.length);
    // 两个关键词都召回到了，且重复的 BV1 只保留一份
    expect(ids).toEqual(['BV1', 'BV2']);
  });

  it('搜索失败返回空数组', async () => {
    const c = new BiliClient({
      getJson: async () => { throw new Error('net'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await recallOpposite(c, ['kw'])).toEqual([]);
  });

  it('LLM 判不出的候选被剔除', async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => JSON.stringify({ results: [] })),
    };
    const r = await judgeOpposition(
      client,
      { title: 't', stance: '支持 A' },
      [{ bvid: 'BV1', title: 'x', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' }],
    );
    expect(r).toHaveLength(0);
  });

  it('LLM 判定为相反观点的候选被保留且带理由', async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => JSON.stringify({
        results: [{ bvid: 'BV1', reason: '它主张相反观点' }],
      })),
    };
    const r = await judgeOpposition(
      client,
      { title: 't', stance: '支持 A' },
      [{ bvid: 'BV1', title: 'x', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' }],
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.reason).toBe('它主张相反观点');
  });

  it('LLM 抛错时返回空数组', async () => {
    const client: LlmClient = { complete: vi.fn(async () => { throw new Error('x'); }) };
    const r = await judgeOpposition(
      client,
      { title: 't', stance: 's' },
      [{ bvid: 'BV1', title: 'x', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' }],
    );
    expect(r).toEqual([]);
  });

  it('评论区挖掘失败返回空数组', async () => {
    const c = new BiliClient({
      getJson: async () => { throw new Error('net'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await mineCommentOpposition(c, 123)).toEqual([]);
  });

  it('判定出的推荐带 bvid 与可点链接', async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => JSON.stringify({
        results: [{ bvid: 'BV1', reason: '它主张相反观点' }],
      })),
    };
    const r = await judgeOpposition(client, { title: 't', stance: 's' }, [ITEM_A]);
    expect(r[0]!.bvid).toBe('BV1');
    expect(r[0]!.url).toContain('BV1');
    expect(r[0]!.title).toBe('A');
  });

  it('LLM 说了候选里没有的 bvid 就丢弃', async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => JSON.stringify({
        results: [{ bvid: 'BV不存在', reason: '编的' }],
      })),
    };
    const r = await judgeOpposition(client, { title: 't', stance: 's' }, [ITEM_A]);
    expect(r).toEqual([]);
  });

  it('挖到高赞评论作为检索入口', async () => {
    const c = new BiliClient({
      getJson: async (url: string) => {
        if (url.includes('/x/web-interface/nav')) return NAV_OK;
        return {
          code: 0, message: '0',
          data: {
            replies: [
              { rpid: 1, mid: 1, ctime: 0, like: 10, rcount: 0, content: { message: '这段说得完全不对' }, member: { mid: 1, uname: 'u', level: 1 } },
              { rpid: 2, mid: 2, ctime: 0, like: 99, rcount: 0, content: { message: '短的' }, member: { mid: 2, uname: 'u', level: 1 } },
            ],
          },
        };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const r = await mineCommentOpposition(c, 123);
    // 太短的被滤掉，只留下够长、能当检索词的那条
    expect(r).toEqual(['这段说得完全不对']);
  });
});
