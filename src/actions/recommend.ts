import { CSS_PREFIX, injectStyles, ownerDoc } from './fold';

export interface RecommendItem {
  bvid: string;
  title: string;
  author: string;
  /** 为什么这是相反观点——必须是人话，否则用户会以为是系统抽风 */
  reason: string;
  url: string;
}

/**
 * 渲染反向推荐区块。
 *
 * 插在 anchor 之后，作为**独立区块**，不混入 B 站原生推荐流——
 * 混进去用户会以为是站点自己的推荐。
 */
export function renderRecommendations(
  root: ParentNode,
  anchor: Element,
  items: RecommendItem[],
): boolean {
  if (!items.length) return false;
  const doc = ownerDoc(root);
  injectStyles(doc);

  const box = doc.createElement('div');
  box.className = `${CSS_PREFIX}-recommend`;
  box.setAttribute('data-ab-prefix', `${CSS_PREFIX}-recommend`);

  const title = doc.createElement('div');
  title.className = `${CSS_PREFIX}-recommend-title`;
  title.textContent = '相反的观点';
  box.appendChild(title);

  for (const it of items) {
    const row = doc.createElement('div');
    row.className = `${CSS_PREFIX}-recommend-item`;
    row.setAttribute('data-ab-prefix', `${CSS_PREFIX}-recommend-item`);

    const a = doc.createElement('a');
    a.href = it.url || `https://www.bilibili.com/video/${it.bvid}`;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = it.title;

    const reason = doc.createElement('span');
    reason.className = `${CSS_PREFIX}-recommend-reason`;
    reason.textContent = `（${it.reason}）`;

    row.appendChild(a);
    row.appendChild(reason);
    box.appendChild(row);
  }

  anchor.parentNode?.insertBefore(box, anchor.nextSibling);
  return true;
}
