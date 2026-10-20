import type { ContentItem, PageType } from '../shared/types';
import { contentKey } from '../shared/hash';
import type { ListContext, Subject, VideoContext } from './types';

/**
 * 判定语境的构造。
 *
 * 语境是判定链路的**根**：没有语境 → 没有动态词表 → 规则粗筛永不命中 →
 * 内容全部原样放行（看起来就是「插件没反应」）。
 * 所以语境的构造必须覆盖所有会判定的页面。
 */

/** 语境里抽样标题的条数上限。多了对 LLM 是噪音，少了抓不住主题。 */
const MAX_SAMPLES = 12;

/** 视频页语境。 */
export function videoSubject(video: VideoContext): Subject {
  return { kind: 'video', video };
}

/**
 * 语境的稳定标识。
 *
 * 词表缓存键的一部分：语境变了（换了视频、换了搜索词、内容更新了），
 * 词表就该重新生成。
 */
export function subjectId(subject: Subject): string {
  return subject.kind === 'video' ? subject.video.bvid : subject.list.id;
}

/** 页面主题：搜索页取关键词，推荐流用固定名。 */
function pageTopic(page: PageType, url: string): string {
  if (page === 'search') {
    try {
      const kw = new URL(url).searchParams.get('keyword');
      if (kw) return `搜索：${kw.trim()}`;
    } catch {
      // URL 非法就退回通用标题，不抛
    }
    return '搜索结果';
  }
  if (page === 'feed') return '首页推荐流';
  return '本页内容';
}

/**
 * 从一批内容构造列表页语境。
 *
 * 返回 null 表示「构造不出来」——调用方据此**跳过判定**，
 * 而不是拿一个空语境硬判（空语境 = 空词表 = 全部放行，只是白花一次 LLM）。
 */
export function buildListSubject(
  page: PageType,
  url: string,
  items: ContentItem[],
): Subject | null {
  // 只有列表页才有「这批内容即语境」这回事。
  // 视频页抽到的是评论，用评论当语境是循环论证（拿被审对象定判据）。
  if (page !== 'search' && page !== 'feed') return null;

  const samples: string[] = [];
  for (const item of items) {
    const t = item.text.trim();
    if (t) samples.push(t);
    if (samples.length >= MAX_SAMPLES) break;
  }
  if (samples.length === 0) return null;

  const list: ListContext = {
    id: `list:${contentKey(page, url, samples)}`,
    title: pageTopic(page, url),
    samples,
  };
  return { kind: 'list', list };
}
