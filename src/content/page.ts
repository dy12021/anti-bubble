import type { PageType } from '../shared/types';

/**
 * 识别当前页面属于哪一类干预点。
 * 识别不出来就返回 unknown——适配层据此放弃干预，绝不猜。
 */
export function detectPageType(url: string): PageType {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unknown';
  }
  if (!u.hostname.endsWith('bilibili.com')) return 'unknown';

  const host = u.hostname;
  const path = u.pathname;

  if (host === 'search.bilibili.com') return 'search';
  if (path.startsWith('/video/')) return 'video';
  if (host === 't.bilibili.com') return 'feed';
  if (host === 'www.bilibili.com' || host === 'bilibili.com') {
    if (path === '/' || path === '') return 'feed';
  }
  return 'unknown';
}
