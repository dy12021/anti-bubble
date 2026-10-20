import type { Verdict } from '../shared/types';
import { CSS_PREFIX, injectStyles, resolveTarget, ownerDoc } from './fold';

/**
 * 给内容加一个标识标签（不隐藏内容）。
 *
 * 反信息茧房模式用：把「与用户立场相反」的评论标出来，
 * 但**保留**它——用户自己决定看不看。
 */
export function applyMark(root: ParentNode, itemId: string, verdict: Verdict): boolean {
  const doc = ownerDoc(root);
  const target = resolveTarget(doc, itemId);
  if (!target) return false;

  injectStyles(doc);

  // 同一条内容已标识过就不重复（不同内容互不影响）
  if (doc.querySelector(`[data-ab-prefix="${CSS_PREFIX}-mark"][data-item-id="${itemId}"]`)) {
    return true;
  }

  const mark = doc.createElement('span');
  mark.className = `${CSS_PREFIX}-mark`;
  mark.setAttribute('data-ab-prefix', `${CSS_PREFIX}-mark`);
  mark.setAttribute('data-item-id', itemId);
  mark.textContent = verdict.reason || '立场相反';

  // 评论挂在正文后面；视频卡片挂到标题后面（挂卡片根上会破坏卡片排版）
  const content =
    target.querySelector('.reply-content')
    ?? target.querySelector('.bili-video-card__info--tit')
    ?? target;
  content.appendChild(mark);
  return true;
}
