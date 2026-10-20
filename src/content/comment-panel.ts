import type { ContentItem, Verdict, Settings } from '../shared/types';
import type { CommentItem } from '../bili/types';
import type { VideoContext } from '../pipeline/types';
import { MSG } from '../shared/messages';
import { CSS_PREFIX, injectStyles } from '../actions/fold';

/**
 * 自有评论区。
 *
 * ## 为什么必须自己渲染
 *
 * B 站现在的评论 DOM 是这样的：
 *   #commentapp > <bili-comments>            ← open shadow root（可访问）
 *                  └─ <div> 的 closed shadow  ← 评论在这里，**closed = 读不到**
 *
 * closed shadow root 连页面主世界的脚本都进不去，content script 更进不去。
 * 所以「从 DOM 抽评论 + 在 DOM 上折叠」这条路在今天的 B 站视频页是**走不通的**。
 *
 * 结论：视频页的评论走 **API 取 + 自己渲染**。
 * 好处是我们完全掌控 DOM，折叠/标识/撤销想怎么做怎么做；
 * 代价是失去 B 站原生的楼中楼、点赞、表情等交互——所以做成可切换的：
 * 面板顶部有「显示 B 站原生评论」开关。
 *
 * 搜索页 / 推荐流不受影响——那里的卡片是普通 DOM，DOM 适配器照常工作。
 */

export interface CommentPanelOptions {
  /** 页面根，注入点用 */
  root: ParentNode;
  /** 视频 aid（评论接口的 oid） */
  aid: number;
  /** 从页面上下文取评论（已走 B 站 API + 登录态） */
  fetchComments: (oid: number, mode: 3 | 2, parent?: number) => Promise<CommentItem[]>;
  /** 向 service worker 请求判定 */
  send: (msg: unknown) => Promise<unknown>;
  /** 当前设置 */
  settings: Settings;
  /** 撤销回调 */
  onRevoke?: (id: string) => void;
  /** 视频标题，作为判定语境 */
  videoTitle?: string;
  /**
   * 视频上下文（bvid/标题/简介/官方 AI 总结）。
   *
   * **必须带上**：后台要用它生成动态词表，没有词表就没有粗筛，
   * 粗筛不命中就不会调 LLM 精判 —— 评论会全部原样放行。
   */
  video?: VideoContext | null;
}

const PAGE_SIZE = 20;

export class CommentPanel {
  private container: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private moreBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private cursor: string | undefined;
  private done = false;
  private loading = false;
  /** 已判定过的评论 id，避免重复判定 */
  private judged = new Set<string>();

  constructor(private readonly opts: CommentPanelOptions) {}

  /** 把面板挂到 anchor 之后。 */
  mount(anchor: Element): void {
    if (this.container) return;
    const doc = this.ownerDoc();
    injectStyles(doc);

    const box = doc.createElement('section');
    box.className = `${CSS_PREFIX}-comments`;
    box.setAttribute('data-ab-prefix', `${CSS_PREFIX}-comments`);

    const head = doc.createElement('header');
    head.className = `${CSS_PREFIX}-comments-head`;

    const title = doc.createElement('span');
    title.className = `${CSS_PREFIX}-comments-title`;
    title.textContent = '评论';
    head.appendChild(title);

    this.countEl = doc.createElement('span');
    this.countEl.className = `${CSS_PREFIX}-comments-count`;
    head.appendChild(this.countEl);

    const toggle = doc.createElement('button');
    toggle.type = 'button';
    toggle.className = `${CSS_PREFIX}-comments-toggle`;
    toggle.textContent = '显示 B 站原生评论';
    toggle.addEventListener('click', () => {
      const native = doc.getElementById('commentapp');
      if (native) {
        const hidden = native.style.display === 'none';
        native.style.display = hidden ? '' : 'none';
        toggle.textContent = hidden ? '隐藏 B 站原生评论' : '显示 B 站原生评论';
        box.style.display = hidden ? '' : 'none';
      }
    });
    head.appendChild(toggle);

    box.appendChild(head);

    this.list = doc.createElement('div');
    this.list.className = `${CSS_PREFIX}-comments-list`;
    box.appendChild(this.list);

    this.statusEl = doc.createElement('div');
    this.statusEl.className = `${CSS_PREFIX}-comments-status`;
    box.appendChild(this.statusEl);

    this.moreBtn = doc.createElement('button');
    this.moreBtn.type = 'button';
    this.moreBtn.className = `${CSS_PREFIX}-comments-more`;
    this.moreBtn.textContent = '加载更多评论';
    this.moreBtn.addEventListener('click', () => void this.loadMore());
    box.appendChild(this.moreBtn);

    anchor.parentNode?.insertBefore(box, anchor.nextSibling);
    this.container = box;

    // 原生评论区先藏起来
    const native = doc.getElementById('commentapp');
    if (native) native.style.display = 'none';

    void this.loadMore();
  }

  unmount(): void {
    this.container?.remove();
    this.container = null;
  }

  private ownerDoc(): Document {
    return (this.opts.root as Document) ?? document;
  }

  /** 加载下一页评论。对外公开，方便「加载更多」按钮与测试调用。 */
  async loadMore(): Promise<void> {
    if (this.loading || this.done) return;
    this.loading = true;
    if (this.moreBtn) {
      this.moreBtn.disabled = true;
      this.moreBtn.textContent = '加载中…';
    }
    this.setStatus('正在加载评论…');

    let items: CommentItem[] = [];
    try {
      items = await this.opts.fetchComments(this.opts.aid, 3);
    } catch {
      this.setStatus('评论加载失败（可能需要登录 B 站，或触发了风控）', 'err');
      this.finish();
      return;
    }

    if (items.length === 0) {
      this.setStatus(
        this.judged.size
          ? '没有更多评论了'
          : '没有加载到评论。可能需要先登录 B 站，或触发了风控。',
      );
      this.finish();
      return;
    }

    for (const c of items) {
      this.list?.appendChild(this.renderComment(c));
    }
    this.setStatus('');

    // 批量送去判定
    void this.judge(items);

    this.loading = false;
    if (this.moreBtn) {
      this.moreBtn.disabled = false;
      this.moreBtn.textContent = '加载更多评论';
    }
  }

  private finish(): void {
    this.done = true;
    this.loading = false;
    if (this.moreBtn) {
      this.moreBtn.disabled = true;
      this.moreBtn.textContent = '没有更多了';
    }
  }

  private setStatus(text: string, kind: 'info' | 'err' = 'info'): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = text;
    this.statusEl.className = `${CSS_PREFIX}-comments-status status-${kind}`;
  }

  private renderComment(c: CommentItem): HTMLElement {
    const doc = this.ownerDoc();
    const row = doc.createElement('div');
    row.className = `${CSS_PREFIX}-comment`;
    row.setAttribute('data-ab-rpid', String(c.rpid));
    row.setAttribute('data-ab-prefix', `${CSS_PREFIX}-comment`);

    const meta = doc.createElement('div');
    meta.className = `${CSS_PREFIX}-comment-meta`;

    const author = doc.createElement('span');
    author.className = `${CSS_PREFIX}-comment-author`;
    author.textContent = c.member?.uname ?? '用户';
    meta.appendChild(author);

    if (typeof c.like === 'number') {
      const like = doc.createElement('span');
      like.className = `${CSS_PREFIX}-comment-like`;
      like.textContent = `♥ ${c.like}`;
      meta.appendChild(like);
    }
    row.appendChild(meta);

    const text = doc.createElement('div');
    text.className = `${CSS_PREFIX}-comment-text`;
    text.textContent = c.content?.message ?? '';
    row.appendChild(text);

    return row;
  }

  /** 把这批评论送去判定，然后按判定结果改 DOM。 */
  private async judge(items: CommentItem[]): Promise<void> {
    const fresh = items.filter((c) => !this.judged.has(String(c.rpid)));
    if (fresh.length === 0) return;
    for (const c of fresh) this.judged.add(String(c.rpid));

    const contentItems: ContentItem[] = fresh.map((c) => ({
      kind: 'comment' as const,
      id: String(c.rpid),
      text: c.content?.message ?? '',
      author: c.member?.uname ?? '',
      meta: { like: c.like, rcount: c.rcount },
      context: {
        page: 'video' as const,
        videoTitle: this.opts.videoTitle,
      },
    }));

    let verdicts: Verdict[] = [];
    try {
      const resp = (await this.opts.send({
        type: MSG.JUDGE_ITEMS,
        id: `ab-cmt-${Date.now().toString(36)}`,
        payload: {
          items: contentItems,
          mode: this.opts.settings.mode,
          // 必须带 video：后台靠它生成动态词表，没词表就没有粗筛，
          // 粗筛不命中就不会调 LLM 精判，评论会全部原样放行。
          video: this.opts.video ?? null,
        },
      })) as { ok?: boolean; data?: { verdicts?: Verdict[] } };
      if (resp?.ok) verdicts = resp.data?.verdicts ?? [];
    } catch {
      return;
    }

    for (const v of verdicts) {
      const row = this.list?.querySelector(
        `[data-ab-rpid="${v.itemId}"]`,
      ) as HTMLElement | null;
      if (!row) continue;
      if (v.action === 'fold' || v.action === 'hide') {
        this.applyFold(row, v);
      } else if (v.action === 'mark') {
        this.applyMark(row, v);
      }
    }
    this.updateCount();
  }

  private applyFold(row: HTMLElement, v: Verdict): void {
    const doc = this.ownerDoc();
    row.style.display = 'none';

    const notice = doc.createElement('div');
    notice.className = `${CSS_PREFIX}-notice`;
    notice.setAttribute('data-ab-prefix', `${CSS_PREFIX}-notice`);
    notice.setAttribute('data-item-id', v.itemId);

    const reason = doc.createElement('span');
    reason.className = `${CSS_PREFIX}-notice-reason`;
    reason.textContent = `已屏蔽（${v.reason || '未说明原因'}）`;
    notice.appendChild(reason);

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = `${CSS_PREFIX}-revoke`;
    btn.setAttribute('data-ab-prefix', `${CSS_PREFIX}-revoke`);
    btn.textContent = '仍要显示';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      row.style.display = '';
      notice.remove();
      this.opts.onRevoke?.(v.itemId);
      this.updateCount();
    });
    notice.appendChild(btn);

    row.parentNode?.insertBefore(notice, row);
  }

  private applyMark(row: HTMLElement, v: Verdict): void {
    const doc = this.ownerDoc();
    if (row.querySelector(`[data-ab-prefix="${CSS_PREFIX}-mark"]`)) return;
    const mark = doc.createElement('span');
    mark.className = `${CSS_PREFIX}-mark`;
    mark.setAttribute('data-ab-prefix', `${CSS_PREFIX}-mark`);
    mark.textContent = v.reason || '立场相反';
    row.querySelector(`.${CSS_PREFIX}-comment-text`)?.appendChild(mark);
  }

  private updateCount(): void {
    if (!this.countEl) return;
    const folded = this.list?.querySelectorAll(
      `[data-ab-prefix="${CSS_PREFIX}-notice"]`,
    ).length ?? 0;
    const marked = this.list?.querySelectorAll(
      `[data-ab-prefix="${CSS_PREFIX}-mark"]`,
    ).length ?? 0;
    const parts: string[] = [];
    if (folded) parts.push(`已屏蔽 ${folded}`);
    if (marked) parts.push(`已标识 ${marked}`);
    this.countEl.textContent = parts.length ? `（${parts.join('，')}）` : '';
  }
}
