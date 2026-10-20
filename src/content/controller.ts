import type { ContentItem, Verdict, Settings, PageType } from '../shared/types';
import type { Subject, VideoContext } from '../pipeline/types';
import { buildListSubject, videoSubject } from '../pipeline/subject';
import { getAdapter } from '../adapters';
import type { Adapter } from '../adapters';
import { applyFold } from '../actions/fold';
import { applyMark } from '../actions/mark';
import { renderRecommendations } from '../actions/recommend';
import type { RecommendItem } from '../actions/recommend';
import { MSG } from '../shared/messages';
import { detectPageType } from './page';

export { detectPageType } from './page';

/** 列表页重新采集的防抖间隔（毫秒）。 */
const WATCH_DEBOUNCE_MS = 800;

/**
 * 列表页最多重新采集多少轮。
 *
 * 没有上限的话，无限滚动 + 页面自己的 DOM 抖动能一直触发下去，
 * 变成后台不停在跑判定。上限是「够用且不失控」的折中。
 */
const MAX_WATCH_ROUNDS = 40;

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

  /** 已经送出去判定过的内容 id。重新采集时只判新的。 */
  private readonly submitted = new Set<string>();
  /**
   * 判定语境**只建一次**。
   *
   * 语境 id 里含抽样标题，滚动一次换一批标题 → id 变 → 词表缓存永远不命中 →
   * 每滚一次就重新生成一份词表（一次 LLM 调用）。所以语境要固定住。
   */
  private subject: Subject | null = null;

  private page: PageType = 'unknown';
  private settings: Settings | null = null;
  private root: ParentNode | null = null;
  private adapter: Adapter | null = null;
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rounds = 0;

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

    this.page = page;
    this.settings = settings;
    this.root = root;
    this.adapter = adapter;

    await this.process();

    // 列表页的内容是**异步加载**的（首页推荐、搜索结果都是 JS 渲染），
    // 而且能无限滚动。只判第一次 = 大部分卡片从来没被判过。
    // 所以列表页要盯着 DOM，新内容进来就补判。
    if (page === 'search' || page === 'feed') this.watch();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
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

  /**
   * 抽 → 判 → 执行一轮。
   *
   * 只判**没送过**的内容：重复判定会白花 LLM 的钱
   * （判定缓存在后台，重复送也只是多一次存储读写）。
   */
  private async process(): Promise<void> {
    if (this.stopped) return;
    const root = this.root;
    const adapter = this.adapter;
    const settings = this.settings;
    if (!root || !adapter || !settings) return;

    let items: ContentItem[];
    try {
      items = adapter.collect(root);
    } catch {
      items = [];
    }
    if (items.length === 0) return;

    const fresh = items.filter((i) => !this.submitted.has(i.id));
    if (fresh.length === 0) return;
    for (const i of fresh) this.submitted.add(i.id);

    this.items = items;

    if (!this.subject) {
      this.subject = this.buildSubject(this.page, items);
    }
    const verdicts = await this.requestJudgments(fresh, settings, this.subject);
    if (this.stopped) return;
    this.apply(verdicts);
  }

  /**
   * 构造判定语境。
   *
   * 视频页有「当前视频」→ 视频语境。
   * 列表页（搜索结果 / 推荐流）**没有当前视频**，但**这批内容本身就是语境**——
   * 把它们当成一个列表主题，照样能生成动态词表、照样能判定。
   *
   * 早先这里一律返回 null，导致列表页的词表恒为空 → 粗筛永不命中 →
   * **列表页的判定从来没生效过**（真机验证时 42 张搜索卡片全 pass）。
   */
  private buildSubject(page: PageType, items: ContentItem[]): Subject | null {
    if (this.deps.video) return videoSubject(this.deps.video);
    return buildListSubject(page, this.deps.url, items);
  }

  /** 盯着列表页：新卡片进来就补判。 */
  private watch(): void {
    const root = this.root;
    if (!root || typeof MutationObserver === 'undefined') return;
    const target = (root as Document).body ?? (root as Element);
    if (!target) return;
    try {
      this.observer = new MutationObserver(() => this.scheduleProcess());
      this.observer.observe(target, { childList: true, subtree: true });
    } catch {
      // 观察器起不来就只判一次，不影响主流程
      this.observer = null;
    }
  }

  private scheduleProcess(): void {
    if (this.stopped) return;
    if (this.rounds >= MAX_WATCH_ROUNDS) {
      this.observer?.disconnect();
      this.observer = null;
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rounds++;
      void this.process();
    }, WATCH_DEBOUNCE_MS);
  }

  private async requestJudgments(
    items: ContentItem[],
    settings: Settings,
    subject: Subject | null,
  ): Promise<Verdict[]> {
    try {
      const resp = (await this.deps.send({
        type: MSG.JUDGE_ITEMS,
        id: `ab-${Date.now().toString(36)}`,
        payload: { items, mode: settings.mode, subject },
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
          // 标识同样可撤销：点标签就撤掉 + 写白名单。
          applyMark(root, v.itemId, v, (id) => this.deps.onRevoke?.(id));
        }
      } catch {
        // 单条失败不影响其它
        continue;
      }
    }
  }
}
