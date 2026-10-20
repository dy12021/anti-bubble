import type { Verdict } from '../shared/types';
import { CSS_PREFIX, injectStyles, resolveTarget, ownerDoc } from './fold';

/**
 * 给内容加一个标识标签（不隐藏内容）。
 *
 * 反信息茧房模式用：把「与用户立场相反」的评论标出来，
 * 但**保留**它——用户自己决定看不看。
 *
 * **标识也必须可撤销**（和折叠同一条铁律）：
 * 立场判断是模型的判断，判错了用户得能自己摘掉这个标签，
 * 而且摘掉之后这条内容不该再被重复标识。
 * 所以标签本身可点：点一下就撤掉 + 写进白名单。
 */
export function applyMark(
  root: ParentNode,
  itemId: string,
  verdict: Verdict,
  onRevoke?: (id: string) => void,
): boolean {
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
  mark.setAttribute('role', 'button');
  mark.setAttribute('tabindex', '0');
  mark.setAttribute('title', '点此取消标识');
  mark.textContent = verdict.reason || '立场相反';

  /** 撤掉标识：标签消失 + 告诉上层写白名单（之后不再判它）。 */
  const revoke = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    mark.remove();
    onRevoke?.(itemId);
  };
  mark.addEventListener('click', revoke);
  mark.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter' || ke.key === ' ') revoke(e);
  });

  // 评论挂在正文后面；视频卡片挂到标题后面（挂卡片根上会破坏卡片排版）
  const content =
    target.querySelector('.reply-content')
    ?? target.querySelector('.bili-video-card__info--tit')
    ?? target;
  content.appendChild(mark);
  return true;
}
