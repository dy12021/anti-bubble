import type { ContentItem } from '../shared/types';
import type { Adapter } from './types';

/** 从各种形式的 B 站视频链接里取 bvid。取不到返回 null。 */
export function extractBvid(href: string): string | null {
  if (!href) return null;
  const m = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return m ? m[1]! : null;
}

/**
 * 搜索页适配器。
 *
 * B 站搜索结果的卡片结构（2026-10）：
 *   .bili-video-card  > a[href*="/video/"]  → 标题 .bili-video-card__info--tit
 *                                        →  作者 .bili-video-card__info--author
 * 结构变了就抽不到 → 返回空数组 → 该页不干预。不会报错。
 */
export const searchAdapter: Adapter = {
  page: 'search',
  collect(root: ParentNode): ContentItem[] {
    const out: ContentItem[] = [];
    const cards = root.querySelectorAll('.bili-video-card');
    for (const card of cards) {
      try {
        const link = card.querySelector<HTMLAnchorElement>('a[href*="/video/"]');
        if (!link) continue;
        const bvid = extractBvid(link.getAttribute('href') ?? '');
        if (!bvid) continue;

        const titleEl = card.querySelector('.bili-video-card__info--tit');
        const authorEl = card.querySelector('.bili-video-card__info--author');
        const title = (titleEl?.textContent ?? '').trim();
        if (!title) continue;

        out.push({
          kind: 'video',
          id: bvid,
          text: title,
          author: (authorEl?.textContent ?? '').trim(),
          meta: {},
          context: { page: 'search' },
        });
      } catch {
        // 单张卡片出错不影响其它卡片
        continue;
      }
    }
    return out;
  },
};
