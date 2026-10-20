import type { PageType } from '../shared/types';
import type { Adapter } from './types';
import { searchAdapter } from './search';
import { videoAdapter } from './video';
import { feedAdapter } from './feed';

export type { Adapter } from './types';
export { searchAdapter, extractBvid } from './search';
export { videoAdapter, extractBvidFromPageUrl } from './video';
export { feedAdapter } from './feed';

/** 按页面类型取适配器。unknown 返回 null（该页不干预）。 */
export function getAdapter(page: PageType): Adapter | null {
  switch (page) {
    case 'search': return searchAdapter;
    case 'video': return videoAdapter;
    case 'feed': return feedAdapter;
    default: return null;
  }
}
