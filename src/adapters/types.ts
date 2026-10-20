import type { ContentItem, PageType } from '../shared/types';

/**
 * 页面适配器。
 *
 * **硬兜底约定**：collect() 抽不到内容时必须返回空数组，
 * 不得抛错、不得让页面报错。B 站改版时表现为「这个页面不干预」。
 */
export interface Adapter {
  page: PageType;
  collect(root: ParentNode): ContentItem[];
}
