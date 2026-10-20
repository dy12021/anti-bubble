// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { videoAdapter, extractBvidFromPageUrl } from '../../src/adapters/video';
// 用 Vite 的 ?raw 直接把 fixture 当字符串导入：省掉 node:fs（仓库没装 @types/node）
import html from '../fixtures/video.html?raw';
const dom = () => new DOMParser().parseFromString(html, 'text/html');

describe('extractBvidFromPageUrl', () => {
  it('取视频页 bvid', () => {
    expect(extractBvidFromPageUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });
  it('非视频页返回 null', () => {
    expect(extractBvidFromPageUrl('https://www.bilibili.com/')).toBeNull();
  });
  it('空串返回 null', () => {
    expect(extractBvidFromPageUrl('')).toBeNull();
  });
});

describe('视频页适配器', () => {
  it('抽出两条评论', () => {
    expect(videoAdapter.collect(dom())).toHaveLength(2);
  });

  it('跳过没有 rpid 的评论', () => {
    const ids = videoAdapter.collect(dom()).map((i) => i.id);
    expect(ids).not.toContain('');
    expect(ids).toHaveLength(2);
  });

  it('抽出正确的 rpid', () => {
    expect(videoAdapter.collect(dom())[0]!.id).toBe('111');
  });

  it('抽出评论正文', () => {
    expect(videoAdapter.collect(dom())[0]!.text).toBe('这是一条普通评论');
  });

  it('抽出评论作者', () => {
    expect(videoAdapter.collect(dom())[0]!.author).toBe('用户甲');
  });

  it('item 的 kind 是 comment', () => {
    expect(videoAdapter.collect(dom())[0]!.kind).toBe('comment');
  });

  it('context.page 是 video', () => {
    expect(videoAdapter.collect(dom())[0]!.context.page).toBe('video');
  });

  it('空 DOM 返回空数组', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(videoAdapter.collect(empty)).toEqual([]);
  });

  it('结构改版抽不到时返回空数组', () => {
    const changed = new DOMParser().parseFromString(
      '<html><body><div class="new-comment-design"></div></body></html>', 'text/html',
    );
    expect(videoAdapter.collect(changed)).toEqual([]);
  });
});
