// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WatchTracker, videoProgressSeconds } from '../../src/content/watch';

/**
 * 观看时长追踪。
 *
 * 两件事靠它：① 增量画像的样本（看够就记一条）；② 反向推荐的触发时机
 * （看满 N 秒才推相反观点）。
 *
 * 「观看时长」优先用**视频的实际播放进度**——比「页面可见了多少秒」准，
 * 而且不受标签页可见性/节流的影响。
 */
describe('观看时长追踪', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('没有进度来源时按墙钟计时（页面可见才走）', () => {
    const onSecond = vi.fn();
    const t = new WatchTracker({ thresholdSeconds: 60, onSecond, isVisible: () => true });
    t.start();
    vi.advanceTimersByTime(3000);
    expect(onSecond).toHaveBeenCalledTimes(3);
    expect(t.elapsedSeconds).toBe(3);
    t.stop();
  });

  it('页面不可见时不计时（没有进度来源时）', () => {
    const onSecond = vi.fn();
    const t = new WatchTracker({ thresholdSeconds: 60, onSecond, isVisible: () => false });
    t.start();
    vi.advanceTimersByTime(5000);
    expect(onSecond).not.toHaveBeenCalled();
    expect(t.elapsedSeconds).toBe(0);
    t.stop();
  });

  it('按播放进度累计', () => {
    let pos = 0;
    const onSecond = vi.fn();
    const t = new WatchTracker({
      thresholdSeconds: 60,
      readWatchSeconds: () => pos,
      onSecond,
    });
    t.start();
    pos = 1; vi.advanceTimersByTime(1000);
    pos = 2; vi.advanceTimersByTime(1000);
    pos = 3; vi.advanceTimersByTime(1000);
    expect(onSecond).toHaveBeenCalledTimes(3);
    expect(t.elapsedSeconds).toBe(3);
    t.stop();
  });

  it('播放进度暂停（返回 null）时保持原值，不倒退也不虚增', () => {
    let pos: number | null = 5;
    const onSecond = vi.fn();
    const t = new WatchTracker({
      thresholdSeconds: 60,
      readWatchSeconds: () => pos,
      onSecond,
    });
    t.start();
    vi.advanceTimersByTime(1000);   // pos=5 → 记到 5
    expect(t.elapsedSeconds).toBe(5);
    const callsBefore = onSecond.mock.calls.length;
    pos = null;                        // 暂停了
    vi.advanceTimersByTime(5000);
    expect(t.elapsedSeconds).toBe(5);
    expect(onSecond.mock.calls.length).toBe(callsBefore);
    t.stop();
  });

  it('往回拖进度条不会让观看秒数倒退', () => {
    let pos = 20;
    const t = new WatchTracker({ thresholdSeconds: 60, readWatchSeconds: () => pos });
    t.start();
    vi.advanceTimersByTime(1000);
    expect(t.elapsedSeconds).toBe(20);
    pos = 5;                           // 往回拖
    vi.advanceTimersByTime(1000);
    expect(t.elapsedSeconds).toBe(20);
    t.stop();
  });

  it('到阈值时触发一次（不重复触发）', () => {
    const onThreshold = vi.fn();
    const t = new WatchTracker({ thresholdSeconds: 10, onThreshold, isVisible: () => true });
    t.start();
    vi.advanceTimersByTime(25_000);
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(onThreshold).toHaveBeenCalledWith(10);
    expect(t.thresholdReached).toBe(true);
    t.stop();
  });

  it('阈值前不触发', () => {
    const onThreshold = vi.fn();
    const t = new WatchTracker({ thresholdSeconds: 60, onThreshold, isVisible: () => true });
    t.start();
    vi.advanceTimersByTime(59_000);
    expect(onThreshold).not.toHaveBeenCalled();
    t.stop();
  });

  it('一次 tick 跨多秒时把中间的秒数补上（定时器被节流后不能晚太多才触发）', () => {
    const onThreshold = vi.fn();
    let pos = 0;
    const t = new WatchTracker({
      thresholdSeconds: 60,
      readWatchSeconds: () => pos,
      onThreshold,
    });
    t.start();
    pos = 65;                          // 一口气过了 65 秒
    vi.advanceTimersByTime(1000);
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(t.elapsedSeconds).toBe(65);
    t.stop();
  });

  it('stop() 后不再计时', () => {
    const onSecond = vi.fn();
    const t = new WatchTracker({ thresholdSeconds: 60, onSecond, isVisible: () => true });
    t.start();
    vi.advanceTimersByTime(2000);
    t.stop();
    vi.advanceTimersByTime(5000);
    expect(t.elapsedSeconds).toBe(2);
  });

  it('start() 重复调用不会起两个计时器', () => {
    const onSecond = vi.fn();
    const t = new WatchTracker({ thresholdSeconds: 60, onSecond, isVisible: () => true });
    t.start();
    t.start();
    vi.advanceTimersByTime(2000);
    expect(t.elapsedSeconds).toBe(2);
    t.stop();
  });
});

describe('播放进度取值', () => {
  function domWith(html: string): Document {
    return new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');
  }

  it('没有 video 元素时返回 null', () => {
    expect(videoProgressSeconds(domWith('<div>没有播放器</div>'))).toBeNull();
  });

  it('取正在播放的那个 video 的进度', () => {
    const d = domWith(
      '<video id="ad"></video><video id="main"></video>',
    ) as unknown as Document & { defaultView: Window };
    const vids = d.querySelectorAll('video');
    Object.defineProperty(vids[0]!, 'currentTime', { value: 3, writable: true });
    Object.defineProperty(vids[1]!, 'currentTime', { value: 42, writable: true });
    Object.defineProperty(vids[0]!, 'paused', { value: true });
    Object.defineProperty(vids[1]!, 'paused', { value: false });
    Object.defineProperty(vids[1]!, 'ended', { value: false });
    expect(videoProgressSeconds(d)).toBe(42);
  });

  it('都没在播时取有进度的那个', () => {
    const d = domWith('<video id="a"></video><video id="b"></video>');
    const vids = d.querySelectorAll('video');
    Object.defineProperty(vids[0]!, 'currentTime', { value: 7, writable: true });
    Object.defineProperty(vids[0]!, 'paused', { value: true });
    Object.defineProperty(vids[1]!, 'currentTime', { value: 0, writable: true });
    Object.defineProperty(vids[1]!, 'paused', { value: true });
    expect(videoProgressSeconds(d)).toBe(7);
  });

  it('进度为 0 时返回 null（还没开始播）', () => {
    const d = domWith('<video id="a"></video>');
    const v = d.querySelector('video')!;
    Object.defineProperty(v, 'currentTime', { value: 0, writable: true });
    expect(videoProgressSeconds(d)).toBeNull();
  });
});
