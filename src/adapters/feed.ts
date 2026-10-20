import type { ContentItem } from '../shared/types';
import type { Adapter } from './types';
import { extractBvid } from './search';

/**
 * 推荐流适配器。
 *
 * 首页推荐与搜索结果的卡片结构一致（.bili-video-card），
 * 所以复用同一套选择器。
 */
export const feedAdapter: Adapter = {
  page: 'feed',
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
        const title = (titleEl?.textContent ?? '').trim();
        if (!title) continue;
        out.push({
          kind: 'video',
          id: bvid,
          text: title,
          author: (card.querySelector('.bili-video-card__info--author')?.textContent ?? '').trim(),
          meta: {},
          context: { page: 'feed' },
        });
      } catch {
        continue;
      }
    }
    return out;
  },
};
