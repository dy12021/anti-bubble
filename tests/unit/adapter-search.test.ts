// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { searchAdapter, extractBvid } from '../../src/adapters/search';
// 用 Vite 的 ?raw 直接把 fixture 当字符串导入：省掉 node:fs（仓库没装 @types/node）
import html from '../fixtures/search.html?raw';

function dom(): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('extractBvid', () => {
  it('从绝对链接取 bvid', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });
  it('从协议相对链接取 bvid', () => {
    expect(extractBvid('//www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });
  it('带查询参数也能取', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333')).toBe('BV1xx411c7mD');
  });
  it('非视频链接返回 null', () => {
    expect(extractBvid('https://www.bilibili.com/')).toBeNull();
  });
  it('空串返回 null', () => {
    expect(extractBvid('')).toBeNull();
  });
});

describe('搜索页适配器', () => {
  it('抽出两个视频卡片', () => {
    const items = searchAdapter.collect(dom());
    expect(items).toHaveLength(2);
  });

  it('抽出正确的标题', () => {
    const items = searchAdapter.collect(dom());
    expect(items[0]!.text).toContain('第一个视频标题');
  });

  it('抽出正确的 bvid', () => {
    const items = searchAdapter.collect(dom());
    expect(items[0]!.id).toBe('BV1xx411c7mD');
  });

  it('抽出作者', () => {
    const items = searchAdapter.collect(dom());
    expect(items[0]!.author).toBe('UP主甲');
  });

  it('item 的 kind 是 video', () => {
    expect(searchAdapter.collect(dom())[0]!.kind).toBe('video');
  });

  it('context.page 是 search', () => {
    expect(searchAdapter.collect(dom())[0]!.context.page).toBe('search');
  });

  it('空 DOM 返回空数组而不是抛错', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(searchAdapter.collect(empty)).toEqual([]);
  });

  it('结构改版抽不到时返回空数组（硬兜底）', () => {
    const changed = new DOMParser().parseFromString(
      '<html><body><div class="totally-different"></div></body></html>', 'text/html',
    );
    expect(searchAdapter.collect(changed)).toEqual([]);
  });
});
