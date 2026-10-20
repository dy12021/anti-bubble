import { describe, it, expect } from 'vitest';
import { buildListSubject, subjectId, videoSubject } from '../../src/pipeline/subject';
import type { ContentItem, PageType } from '../../src/shared/types';

/**
 * 列表页语境的构造。
 *
 * 回归防护：早先列表页拿不到语境 → 词表恒为空 → 粗筛永不命中 →
 * **列表页的判定从来没真正跑过**（真机验证时 42 张搜索卡片全 pass）。
 * 这些测试锁住「列表页一定有语境」这件事。
 */

function card(title: string, over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'video',
    id: 'BV' + title.slice(0, 4),
    text: title,
    author: 'UP',
    meta: {},
    context: { page: 'search', videoTitle: title },
    ...over,
  };
}

const CARDS = [
  card('华为被制裁了吗'),
  card('国产芯片终于突破'),
  card('某厂又偷工减料'),
  card('理性看待这次事件'),
];

describe('判定语境', () => {
  it('视频页语境保留 bvid', () => {
    const s = videoSubject({ bvid: 'BV1xx', title: '标题' });
    expect(s.kind).toBe('video');
    expect(subjectId(s)).toBe('BV1xx');
  });

  it('搜索页能构造出列表语境', () => {
    const s = buildListSubject(
      'search',
      'https://search.bilibili.com/all?keyword=%E5%8D%8E%E4%B8%BA',
      CARDS,
    );
    expect(s).not.toBeNull();
    expect(s!.kind).toBe('list');
  });

  it('列表语境带上页面主题（搜索关键词）', () => {
    const s = buildListSubject(
      'search',
      'https://search.bilibili.com/all?keyword=%E5%8D%8E%E4%B8%BA',
      CARDS,
    );
    expect(s!.kind).toBe('list');
    if (s!.kind !== 'list') throw new Error('unreachable');
    expect(s!.list.title).toContain('华为');
    expect(s!.list.samples).toHaveLength(4);
    expect(s!.list.samples[0]).toBe('华为被制裁了吗');
  });

  it('列表语境的 id 带 list 前缀，不与真实 bvid 撞车', () => {
    const s = buildListSubject('search', 'https://search.bilibili.com/all?keyword=x', CARDS);
    if (s!.kind !== 'list') throw new Error('unreachable');
    expect(s!.list.id.startsWith('list:')).toBe(true);
    expect(s!.list.id).not.toContain('BV');
  });

  it('同样的页面得到同样的 id（缓存要能命中）', () => {
    const a = buildListSubject('search', 'https://search.bilibili.com/all?keyword=x', CARDS);
    const b = buildListSubject('search', 'https://search.bilibili.com/all?keyword=x', CARDS);
    expect(subjectId(a!)).toBe(subjectId(b!));
  });

  it('搜索词不同 → id 不同（不会串味）', () => {
    const a = buildListSubject('search', 'https://search.bilibili.com/all?keyword=x', CARDS);
    const b = buildListSubject('search', 'https://search.bilibili.com/all?keyword=y', CARDS);
    expect(subjectId(a!)).not.toBe(subjectId(b!));
  });

  it('内容不同 → id 不同', () => {
    const a = buildListSubject('search', 'https://search.bilibili.com/all?keyword=x', CARDS);
    const b = buildListSubject(
      'search',
      'https://search.bilibili.com/all?keyword=x',
      [...CARDS, card('新的一个视频')],
    );
    expect(subjectId(a!)).not.toBe(subjectId(b!));
  });

  it('推荐流也能构造语境', () => {
    const s = buildListSubject('feed', 'https://www.bilibili.com/', CARDS);
    expect(s!.kind).toBe('list');
    if (s!.kind !== 'list') throw new Error('unreachable');
    expect(s!.list.title).toBe('首页推荐流');
  });

  it('视频页不构造列表语境（评论不能拿来当判据，那是循环论证）', () => {
    const s = buildListSubject('video', 'https://www.bilibili.com/video/BV1', CARDS);
    expect(s).toBeNull();
  });

  it('抽不到内容时返回 null（调用方据此跳过判定）', () => {
    const s = buildListSubject('search', 'https://search.bilibili.com/all?keyword=x', []);
    expect(s).toBeNull();
  });

  it('空白标题被过滤掉', () => {
    const s = buildListSubject(
      'search',
      'https://search.bilibili.com/all?keyword=x',
      [card('   '), card('有内容的标题')],
    );
    if (s!.kind !== 'list') throw new Error('unreachable');
    expect(s!.list.samples).toEqual(['有内容的标题']);
  });

  it('抽样标题有上限（多了对 LLM 是噪音）', () => {
    const many = Array.from({ length: 50 }, (_, i) => card(`视频标题编号${i}`));
    const s = buildListSubject('search', 'https://search.bilibili.com/all?keyword=x', many);
    if (s!.kind !== 'list') throw new Error('unreachable');
    expect(s!.list.samples.length).toBeLessThanOrEqual(12);
  });

  it('URL 非法时退回通用主题，不抛异常', () => {
    const s = buildListSubject('search', '不是合法 URL', CARDS);
    if (s!.kind !== 'list') throw new Error('unreachable');
    expect(s!.list.title).toBe('搜索结果');
  });

  it('未知页面不构造语境', () => {
    const page: PageType = 'unknown';
    expect(buildListSubject(page, 'https://www.bilibili.com/read/cv1', CARDS)).toBeNull();
  });
});
