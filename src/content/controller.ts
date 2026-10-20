import type { ContentItem, Verdict, Settings, PageType } from '../shared/types';
import type { VideoContext } from '../pipeline/types';
import { getAdapter } from '../adapters';
import { applyFold } from '../actions/fold';
import { applyMark } from '../actions/mark';
import { renderRecommendations } from '../actions/recommend';
import type { RecommendItem } from '../actions/recommend';
import { MSG } from '../shared/messages';
import { detectPageType } from './page';

export { detectPageType } from './page';

export interface ControllerDeps {
  url: string;
  send: (msg: unknown) => Promise<unknown>;
  settings?: Settings | null;
  /** 当前视频上下文；后台拿不到 B 站 cookie，所以由 content script 取好传进来 */
  video?: VideoContext | null;
  root?: ParentNode;
  onRevoke?: (id: string) => void;
}

/**
 * 页面控制器：抽 → 判 → 执行。
 *
 * **任何一步失败都静默降级**，绝不让 B 站页面报错或卡住。
 */
export class PageController {
  items: ContentItem[] = [];
  private stopped = false;

  constructor(private readonly deps: ControllerDeps) {}

  async start(): Promise<void> {
    const settings = this.deps.settings;
    // 没配置就什么都不做
    if (!settings || !settings.masterEnabled) return;

    const page = detectPageType(this.deps.url);
    if (!settings.enabledPages[page]) return;

    const adapter = getAdapter(page);
    if (!adapter) return;

    const root = this.getRoot();
    if (!root) return;

    try {
      this.items = adapter.collect(root);
    } catch {
      this.items = [];
      return;
    }
    if (this.items.length === 0) return;

    const verdicts = await this.requestJudgments(this.items, settings);
    if (this.stopped) return;
    this.apply(verdicts);
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * 渲染反向推荐区块。
   *
   * bg 通过 MSG.PUSH_RECOMMENDATIONS 把结果推过来时由 content script 调用。
   * 独立区块，不混入 B 站原生推荐流。
   */
  showRecommendations(anchor: Element, items: RecommendItem[]): boolean {
    const root = this.getRoot();
    if (!root) return false;
    try {
      return renderRecommendations(root, anchor, items);
    } catch {
      return false;
    }
  }

  /** 拿 DOM 根。拿不到就返回 null——不硬造一个 document，那会炸。 */
  private getRoot(): ParentNode | null {
    if (this.deps.root) return this.deps.root;
    if (typeof document !== 'undefined') return document;
    return null;
  }

  private async requestJudgments(
    items: ContentItem[],
    settings: Settings,
  ): Promise<Verdict[]> {
    try {
      const resp = (await this.deps.send({
        type: MSG.JUDGE_ITEMS,
        id: `ab-${Date.now().toString(36)}`,
        payload: { items, mode: settings.mode, video: this.deps.video ?? null },
      })) as { ok?: boolean; data?: { verdicts?: Verdict[] } };
      if (!resp?.ok) return [];
      return resp.data?.verdicts ?? [];
    } catch {
      return [];
    }
  }

  private apply(verdicts: Verdict[]): void {
    const root = this.getRoot();
    if (!root) return;
    for (const v of verdicts) {
      try {
        if (v.action === 'fold' || v.action === 'hide') {
          // hide 与 fold 走同一条路径：都藏起来 + 给理由 + 给撤销。
          // 「可撤销」是铁律，隐藏类动作不能没有出口。
          applyFold(root, v.itemId, v, (id) => this.deps.onRevoke?.(id));
        } else if (v.action === 'mark') {
          applyMark(root, v.itemId, v);
        }
      } catch {
        // 单条失败不影响其它
        continue;
      }
    }
  }
}
