// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { feedAdapter } from '../../src/adapters/feed';
import { getAdapter } from '../../src/adapters';
// 用 Vite 的 ?raw 直接把 fixture 当字符串导入：省掉 node:fs（仓库没装 @types/node）
import html from '../fixtures/feed.html?raw';
const dom = () => new DOMParser().parseFromString(html, 'text/html');

describe('推荐流适配器', () => {
  it('抽出两个视频', () => {
    expect(feedAdapter.collect(dom())).toHaveLength(2);
  });
  it('抽出 bvid', () => {
    expect(feedAdapter.collect(dom())[0]!.id).toBe('BV1feed001');
  });
  it('抽出标题', () => {
    expect(feedAdapter.collect(dom())[0]!.text).toContain('推荐流视频一');
  });
  it('context.page 是 feed', () => {
    expect(feedAdapter.collect(dom())[0]!.context.page).toBe('feed');
  });
  it('空 DOM 返回空数组', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(feedAdapter.collect(empty)).toEqual([]);
  });
});

describe('适配器分发', () => {
  it('search 返回搜索适配器', () => {
    expect(getAdapter('search')?.page).toBe('search');
  });
  it('video 返回视频适配器', () => {
    expect(getAdapter('video')?.page).toBe('video');
  });
  it('feed 返回推荐流适配器', () => {
    expect(getAdapter('feed')?.page).toBe('feed');
  });
  it('unknown 返回 null', () => {
    expect(getAdapter('unknown')).toBeNull();
  });
});
