import type { ContentItem } from '../shared/types';
import type { Adapter } from './types';

/** 从页面 URL 取 bvid。 */
export function extractBvidFromPageUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return m ? m[1]! : null;
}

/**
 * 视频页适配器：抽评论 + 视频标题。
 *
 * B 站评论节点（2026-10，两种形态都兼容）：
 *   旧版 .reply-item[data-rpid] > .user-name / .reply-content
 *   新版 Shadow DOM（.bili-comment-thread-renderer）——
 *     **Shadow DOM 里的内容 querySelector 抽不到**，
 *     所以这里只处理普通 DOM。新版由 content controller 另行处理，
 *     抽不到就返回空数组（该页不干预），不做兜底猜测。
 */
export const videoAdapter: Adapter = {
  page: 'video',
  collect(root: ParentNode): ContentItem[] {
    const out: ContentItem[] = [];

    const videoTitle =
      root.querySelector('.video-title')?.textContent?.trim() ?? '';
    const bvid = extractBvidFromPageUrl(
      typeof location !== 'undefined' ? location.href : '',
    );

    const nodes = root.querySelectorAll('.reply-item[data-rpid]');
    for (const node of nodes) {
      try {
        const rpid = node.getAttribute('data-rpid');
        if (!rpid) continue;
        const contentEl = node.querySelector('.reply-content');
        const text = (contentEl?.textContent ?? '').trim();
        if (!text) continue;
        const author = (
          node.querySelector('.user-name')?.textContent ?? ''
        ).trim();

        out.push({
          kind: 'comment',
          id: rpid,
          text,
          author,
          meta: {},
          context: {
            page: 'video',
            videoId: bvid ?? undefined,
            videoTitle: videoTitle || undefined,
          },
        });
      } catch {
        continue;
      }
    }

    return out;
  },
};
