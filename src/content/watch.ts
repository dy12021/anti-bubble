/**
 * 观看时长追踪。
 *
 * 视频页要靠它做两件事：
 * 1. **反向推荐的触发时机**：看满 N 秒才推相反观点
 *    （设计原话是「打开一个表达观点的视频**一段时间后**」——
 *    立刻推就变成了「换个姿势的推荐流」，不是打破信息茧房）。
 * 2. **增量画像**：看够一定时长就记一条样本，让画像跟着浏览行为长。
 *
 * ## 「观看时长」怎么算
 *
 * 优先用**视频的实际播放进度**（`video.currentTime`）——这才是「在看这个视频」。
 * 比「页面可见了多少秒」准得多：
 * - 用户暂停了、或者只是挂在后台，就不该算观看；
 * - B 站可能挂着广告播放器、正片播放器好几个，取正在播的那个。
 *
 * 页面里没有视频时，退回「页面可见时按墙钟计时」——
 * 切到别的标签页、把窗口最小化，那段时间不算观看。
 *
 * 两种来源都**只增不减**：用户往回拖进度条，观看秒数也不该倒退。
 */

export interface WatchTrackerOptions {
  /** 触发阈值（秒）。到达时回调一次。 */
  thresholdSeconds: number;
  /**
   * 累计观看秒数的来源。返回 null 表示「此刻拿不到」，保持原值。
   * 不提供则退回墙钟计时（只在页面可见时累加）。
   */
  readWatchSeconds?: () => number | null;
  /** 每满一整秒回调一次（用来判断「已够记样本」）。 */
  onSecond?: (seconds: number) => void;
  /** 到达阈值时回调一次。 */
  onThreshold?: (seconds: number) => void;
  /** 页面被隐藏时回调（用来把最终时长落库）。 */
  onHidden?: (seconds: number) => void;
  /** 可见性判断，默认用 document.visibilityState。 */
  isVisible?: () => boolean;
}

export class WatchTracker {
  private seconds = 0;
  private lastRaw = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private thresholdFired = false;
  private readonly isVisible: () => boolean;

  constructor(private readonly opts: WatchTrackerOptions) {
    this.isVisible =
      opts.isVisible
      ?? (() => (typeof document !== 'undefined' && document.visibilityState === 'visible'));
  }

  /** 已累计的观看秒数。 */
  get elapsedSeconds(): number {
    return this.seconds;
  }

  /** 阈值是否已经触发过。 */
  get thresholdReached(): boolean {
    return this.thresholdFired;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  private readonly onVisibilityChange = (): void => {
    // 页面被切走时把最终时长交出去（落库画像）。
    if (!this.isVisible()) {
      this.opts.onHidden?.(this.seconds);
    }
  };

  private tick(): void {
    const next = this.readSeconds();
    if (next === null) return;
    // 只增不减：往回拖进度条、换视频都不该让观看秒数倒退。
    if (next <= this.seconds) {
      this.lastRaw = next;
      return;
    }
    // 一次 tick 跨了多秒（比如后台标签页的定时器被节流后补跑），
    // 中间的秒数要补上，不然阈值会晚很多才触发。
    for (let s = this.seconds + 1; s <= next; s++) {
      this.seconds = s;
      this.opts.onSecond?.(s);
      if (!this.thresholdFired && s >= this.opts.thresholdSeconds) {
        this.thresholdFired = true;
        this.opts.onThreshold?.(s);
      }
    }
  }

  /** 取当前累计观看秒数；拿不到返回 null。 */
  private readSeconds(): number | null {
    if (this.opts.readWatchSeconds) {
      const raw = this.opts.readWatchSeconds();
      if (raw === null || !Number.isFinite(raw) || raw < 0) return null;
      return raw;
    }
    // 墙钟：页面不可见就不算
    if (!this.isVisible()) return null;
    return this.seconds + 1;
  }
}

/**
 * 从页面里取「视频播放进度」。
 *
 * B 站页面上可能有多个 `<video>`（广告、正片），
 * 取正在播的那个；都没有播放就取有进度的那个。
 */
export function videoProgressSeconds(root: ParentNode = document): number | null {
  const videos = Array.from(root.querySelectorAll('video'));
  if (videos.length === 0) return null;
  const playing = videos.find((v) => !v.paused && !v.ended && v.currentTime > 0);
  const v = playing ?? videos.find((x) => x.currentTime > 0) ?? videos[0]!;
  return v.currentTime > 0 ? v.currentTime : null;
}
