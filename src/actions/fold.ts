import type { Verdict } from '../shared/types';
import { extractBvid } from '../adapters/search';

/** 注入样式的标识前缀。用它做属性选择器，避免与站点自身样式冲突。 */
export const CSS_PREFIX = 'ab';

const STYLE_ID = `${CSS_PREFIX}-styles`;

/** 注入一次样式。重复调用不会重复插入。 */
export function injectStyles(root: ParentNode): void {
  const doc = ownerDoc(root);
  if (doc.querySelector(`[data-ab-prefix="${STYLE_ID}"]`)) return;
  const style = doc.createElement('style');
  style.setAttribute('data-ab-prefix', STYLE_ID);
  style.textContent = `
.${CSS_PREFIX}-notice {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  padding: 6px 10px; margin: 2px 0;
  font-size: 12px; line-height: 1.6;
  color: #61666d;
  background: rgba(0,0,0,.04);
  border-left: 2px solid #fb7299;
  border-radius: 2px;
}
.${CSS_PREFIX}-notice-reason { flex: 1 1 auto; min-width: 0; }
.${CSS_PREFIX}-revoke {
  cursor: pointer; border: 0; background: transparent;
  color: #fb7299; font-size: 12px; padding: 0 2px;
  margin-left: auto; flex: 0 0 auto;
}
.${CSS_PREFIX}-revoke:hover { text-decoration: underline; }
.${CSS_PREFIX}-mark {
  display: inline-block; margin-left: 6px;
  padding: 0 5px; font-size: 11px; line-height: 1.6;
  color: #fff; background: #fb7299; border-radius: 3px;
  cursor: pointer; user-select: none;
}
.${CSS_PREFIX}-mark:hover { background: #e4628a; }
.${CSS_PREFIX}-recommend {
  margin: 12px 0; padding: 12px;
  border: 1px dashed #fb7299; border-radius: 6px;
  background: rgba(251,114,153,.05);
}
.${CSS_PREFIX}-recommend-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.${CSS_PREFIX}-recommend-item { display: flex; gap: 6px; margin: 6px 0; font-size: 13px; }
.${CSS_PREFIX}-recommend-reason { color: #61666d; font-size: 12px; }
.${CSS_PREFIX}-recommend-empty { color: #9499a0; font-size: 12px; border-style: solid; }

/* --- 自有评论区 --- */
.${CSS_PREFIX}-comments {
  margin: 16px 0; padding: 12px 0 0;
  border-top: 1px solid #e3e5e7;
}
.${CSS_PREFIX}-comments-head {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 10px;
}
.${CSS_PREFIX}-comments-title { font-size: 15px; font-weight: 600; color: #1f2329; }
.${CSS_PREFIX}-comments-count { font-size: 12px; color: #9499a0; }
.${CSS_PREFIX}-comments-toggle {
  margin-left: auto; cursor: pointer;
  border: 1px solid #e3e5e7; border-radius: 5px;
  background: #fff; color: #61666d;
  font-size: 11px; padding: 2px 8px;
}
.${CSS_PREFIX}-comments-toggle:hover { border-color: #c9ccd0; }
.${CSS_PREFIX}-comments-list { display: flex; flex-direction: column; }
.${CSS_PREFIX}-comment { padding: 8px 0; border-bottom: 1px dashed #e3e5e7; }
.${CSS_PREFIX}-comment-meta {
  display: flex; align-items: baseline; gap: 10px;
  font-size: 12px; color: #9499a0;
}
.${CSS_PREFIX}-comment-author { color: #61666d; font-weight: 500; }
.${CSS_PREFIX}-comment-text {
  margin-top: 2px; font-size: 14px; line-height: 1.6; color: #1f2329;
  word-break: break-word;
}
.${CSS_PREFIX}-comments-status { padding: 10px 0; font-size: 12px; color: #9499a0; }
.${CSS_PREFIX}-comments-status.status-err { color: #d63b3b; }
.${CSS_PREFIX}-comments-more {
  display: block; width: 100%; margin-top: 12px;
  padding: 8px; cursor: pointer;
  border: 1px solid #e3e5e7; border-radius: 6px;
  background: #fff; color: #61666d; font-size: 13px;
}
.${CSS_PREFIX}-comments-more:hover:not(:disabled) { border-color: #c9ccd0; }
.${CSS_PREFIX}-comments-more:disabled { color: #c9ccd0; cursor: default; }
`;
  const host = doc.head ?? doc.documentElement;
  host?.appendChild(style);
}

/**
 * 拿到 root 所属的 Document。
 *
 * root 可能是 document，也可能是某个元素（父节点）——
 * 元素上是没有 createElement 的，所以统一走 ownerDocument。
 */
export function ownerDoc(root: ParentNode): Document {
  return (root as Document).ownerDocument ?? (root as Document);
}

/**
 * itemId 只会是 rpid（纯数字）或 bvid（BV + 字母数字），
 * 两者都能安全地拼进属性选择器。这里再挡一道，
 * 免得将来有人把 LLM 返回的任意字符串塞进选择器里。
 */
const SAFE_ITEM_ID = /^[A-Za-z0-9_-]+$/;

/**
 * 找到要干预的那个 DOM 节点。找不到返回 null。
 *
 * 两种形态：
 * - 评论：`.reply-item[data-rpid="123"]`
 * - 视频卡片：链接里带 `/video/BVxxx` 的 `.bili-video-card`
 *
 * 视频卡片本身没有 id 属性，只能靠链接里的 bvid 反查。
 * 这样不用往站点 DOM 上加自定义属性（不改站点原有结构）。
 */
export function resolveTarget(root: ParentNode, itemId: string): Element | null {
  if (!SAFE_ITEM_ID.test(itemId)) return null;

  const doc = ownerDoc(root);
  const byRpid = doc.querySelector(`[data-rpid="${itemId}"]`);
  if (byRpid) return byRpid;

  const links = doc.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]');
  for (const link of links) {
    if (extractBvid(link.getAttribute('href') ?? '') === itemId) {
      return link.closest('.bili-video-card') ?? link;
    }
  }
  return null;
}

/**
 * 折叠一条内容，并插入「理由 + 仍要显示」。
 *
 * **就地替换，不在旁边插一条**：把卡片藏掉、再把说明插到它旁边，
 * 说明就变成了网格里的**另一个单元**——整排卡片会被挤歪、错位。
 * 所以这里改成：卡片留在原来的位置，把它的内容换成「理由 + 仍要显示」。
 *
 * 点「仍要显示」→ 恢复原来的内容 + 调用 onRevoke（上层写白名单）。
 */
export function applyFold(
  root: ParentNode,
  itemId: string,
  verdict: Verdict,
  onRevoke: (id: string) => void,
): boolean {
  const doc = ownerDoc(root);
  const target = resolveTarget(doc, itemId);
  if (!target) return false;

  injectStyles(doc);

  const el = target as HTMLElement;

  // 已经插过说明就不重复
  if (doc.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"][data-item-id="${itemId}"]`)) {
    return true;
  }

  // 把原内容收起来（记住原样，撤销时要还原）
  const hidden: HTMLElement[] = [];
  for (const child of Array.from(el.children)) {
    if (child.getAttribute('data-ab-prefix') === `${CSS_PREFIX}-notice`) continue;
    hidden.push(child as HTMLElement);
    (child as HTMLElement).style.display = 'none';
  }

  const notice = doc.createElement('div');
  notice.className = `${CSS_PREFIX}-notice`;
  notice.setAttribute('data-ab-prefix', `${CSS_PREFIX}-notice`);
  notice.setAttribute('data-item-id', itemId);

  const reason = doc.createElement('span');
  reason.className = `${CSS_PREFIX}-notice-reason`;
  reason.textContent = `已屏蔽（${verdict.reason || '未说明原因'}）`;

  const btn = doc.createElement('button');
  btn.className = `${CSS_PREFIX}-revoke`;
  btn.setAttribute('data-ab-prefix', `${CSS_PREFIX}-revoke`);
  btn.textContent = '仍要显示';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    for (const c of hidden) c.style.display = '';
    notice.remove();
    onRevoke(itemId);
  });

  notice.appendChild(reason);
  notice.appendChild(btn);
  el.appendChild(notice);
  return true;
}
