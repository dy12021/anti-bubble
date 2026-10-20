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
 * 找「插在哪儿」。
 *
 * **不能插在标题旁边**：B 站视频页的标题 h1 挂在
 * `.video-info-title-inner` 里，那个容器是 **flex 行**，
 * 往里塞一个 div 会被当成第三个 flex item 挤到右边，
 * 结果是区块压在播放器上面、还把原布局挤歪。
 *
 * 正确做法是插在**整个信息区下面**（`#viewbox_report` 之后），
 * 成为一个整宽的独立区块——这也正是设计要的「独立区块，不混入原生推荐流」。
 */
export function resolveRecommendationAnchor(root: ParentNode): Element | null {
  const doc = ownerDoc(root);
  // 优先：整个视频信息区（标题 + 简介）的容器
  const info = doc.querySelector('#viewbox_report');
  if (info?.parentElement) return info;
  // 退而求其次：标题容器
  const titleBox = doc.querySelector('.video-info-title');
  if (titleBox?.parentElement) return titleBox;
  const title = doc.querySelector('.video-title');
  if (title?.parentElement) return title.parentElement;
  return null;
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

/**
 * 「找过了，但没有相反观点」的空状态。
 *
 * 为什么要有：反信息茧房模式下，**大多数视频本来就找不到明确相反观点**。
 * 这时候如果什么都不显示，用户看到的是「插件没反应」——
 * 分不清是「确实没有」还是「功能坏了」。
 * 说清楚一句，比沉默强。
 */
export function renderNoOpposition(root: ParentNode, anchor: Element): boolean {
  const doc = ownerDoc(root);
  injectStyles(doc);
  const box = doc.createElement('div');
  box.className = `${CSS_PREFIX}-recommend ${CSS_PREFIX}-recommend-empty`;
  box.setAttribute('data-ab-prefix', `${CSS_PREFIX}-recommend-empty`);
  box.textContent = '（反）信息茧房：没找到明确表达相反观点的视频';
  anchor.parentNode?.insertBefore(box, anchor.nextSibling);
  return true;
}
