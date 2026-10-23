// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn(async (msg: unknown) => {
      if ((msg as { type?: string })?.type === 'JUDGE_ITEMS') {
        return { id: 'x', ok: true, data: { verdicts: [] } };
      }
      return { id: 'x', ok: true, data: null };
    }),
  },
});

import { PageController, detectPageType } from '../../src/content/controller';
import { MSG } from '../../src/shared/messages';
import type { ContentItem, Settings, Verdict } from '../../src/shared/types';

function settings(patch?: Partial<Settings>): Settings {
  return {
    mode: 'cocoon',
    enabledPages: { search: true, video: true, feed: true, unknown: false },
    masterEnabled: true,
    collectHistory: true,
    confidenceThreshold: 0.7,
    judgeLevel: 'coarse',
    ...(patch ?? {}),
  };
}

/** 视频页形态：一条带 rpid 的评论。 */
function commentDom(): Document {
  return new DOMParser().parseFromString(
    `<html><body>
      <div class="reply-item" data-rpid="111"><div class="reply-content">引战内容</div></div>
    </body></html>`, 'text/html',
  );
}

/** 搜索页形态：若干张视频卡片。 */
function searchDom(): Document {
  const card = (bvid: string, title: string) => `
    <div class="bili-video-card">
      <a href="/video/${bvid}">
        <h3 class="bili-video-card__info--tit">${title}</h3>
        <span class="bili-video-card__info--author">UP主</span>
      </a>
    </div>`;
  return new DOMParser().parseFromString(
    `<html><body>
      ${card('BV1aa411c7mD', '华为被制裁了吗')}
      ${card('BV1bb411c7mD', '国产芯片终于突破')}
      ${card('BV1cc411c7mD', '理性看待这次事件')}
    </body></html>`, 'text/html',
  );
}

const FOLD: Verdict = {  itemId: '111', action: 'fold', reason: '在引战',
  reasonCode: 'incitement', confidence: 0.9, revocable: true,
};

const MARK: Verdict = {
  itemId: '111', action: 'mark', reason: '与你的立场相反',
  reasonCode: 'stance_opposite', confidence: 0.8, revocable: false,
};

describe('页面控制器', () => {
  it('未知页面不启动任何适配器', async () => {
    const c = new PageController({ url: 'https://www.bilibili.com/read/cv1', send: async () => ({ ok: true, data: null }) });
    await c.start();
    expect(c.items).toHaveLength(0);
  });

  it('总开关关闭时不判定', async () => {
    const send = vi.fn(async () => ({ ok: true, data: null }));
    const c = new PageController({ url: 'https://search.bilibili.com/all?keyword=x', send });
    await c.start();
    expect(send).not.toHaveBeenCalled();
  });

  it('页面级开关关闭时不判定该页', async () => {
    const send = vi.fn(async () => ({ ok: true, data: null }));
    const c = new PageController({
      url: 'https://search.bilibili.com/all?keyword=x',
      send,
      settings: { mode: 'cocoon', enabledPages: { search: false, video: true, feed: true, unknown: false }, masterEnabled: true, collectHistory: true, confidenceThreshold: 0.7, judgeLevel: 'coarse' },
    });
    await c.start();
    expect(send).not.toHaveBeenCalled();
  });

  it('masterEnabled 为 false 时不判定', async () => {
    const send = vi.fn(async () => ({ ok: true, data: null }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send,
      settings: settings({ masterEnabled: false }),
    });
    await c.start();
    expect(send).not.toHaveBeenCalled();
  });

  it('抽不到内容时不发判定请求', async () => {
    const d = new DOMParser().parseFromString(
      '<html><body><div class="totally-different"></div></body></html>', 'text/html',
    );
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://search.bilibili.com/all?keyword=x',
      send, settings: settings(), root: d,
    });
    await c.start();
    expect(send).not.toHaveBeenCalled();
    expect(c.items).toHaveLength(0);
  });

  it('判定请求带上 items / mode / 视频语境', async () => {
    const d = commentDom();
    const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send,
      settings: settings(),
      video: { bvid: 'BV1xx', title: '这个视频在讲 Rust' },
      root: d,
    });
    await c.start();

    const msg = send.mock.calls[0]![0] as {
      type: string;
      payload: { items: ContentItem[]; mode: string; subject: unknown };
    };
    expect(msg.type).toBe(MSG.JUDGE_ITEMS);
    expect(msg.payload.mode).toBe('cocoon');
    expect(msg.payload.subject).toEqual({
      kind: 'video',
      video: { bvid: 'BV1xx', title: '这个视频在讲 Rust' },
    });
    expect(msg.payload.items).toHaveLength(1);
    expect(msg.payload.items[0]!.id).toBe('111');
  });

  it('视频页没有视频上下文时语境传 null', async () => {
    const d = commentDom();
    const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await c.start();
    const msg = send.mock.calls[0]![0] as { payload: { subject: unknown } };
    expect(msg.payload.subject).toBeNull();
  });

  it('fold 判定会折叠对应内容', async () => {
    const d = commentDom();
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [FOLD] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await c.start();
    // 折叠是就地替换：原内容收起来，说明就地显示
    expect((d.querySelector('.reply-content') as HTMLElement).style.display).toBe('none');
    expect(d.querySelector('[data-ab-prefix="ab-notice"]')?.textContent).toContain('在引战');
  });

  it('mark 判定只加标识不隐藏', async () => {
    const d = commentDom();
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [MARK] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await c.start();
    expect((d.querySelector('.reply-item') as HTMLElement).style.display).not.toBe('none');
    expect(d.querySelector('[data-ab-prefix="ab-mark"]')).not.toBeNull();
  });

  it('撤销会回调用 onRevoke', async () => {
    const d = commentDom();
    const onRevoke = vi.fn();
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [FOLD] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d, onRevoke,
    });
    await c.start();
    const btn = d.querySelector('[data-ab-prefix="ab-revoke"]') as HTMLElement;
    btn.click();
    expect(onRevoke).toHaveBeenCalledWith('111');
    expect((d.querySelector('.reply-content') as HTMLElement).style.display).not.toBe('none');
  });

  /**
   * 设计要求：「全局总开关，一键恢复所有屏蔽」。
   * 用户关掉插件时，页面上不该还留着被折掉的卡片。
   */
  it('总开关关掉后，被折叠的内容全部恢复', async () => {
    const d = commentDom();
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [FOLD] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await c.start();
    expect((d.querySelector('.reply-content') as HTMLElement).style.display).toBe('none');

    c.setEnabled(false);
    expect((d.querySelector('.reply-content') as HTMLElement).style.display).not.toBe('none');
    expect(d.querySelector('[data-ab-prefix="ab-notice"]')).toBeNull();
  });

  it('总开关关掉后不再判定新内容', async () => {
    const dom = searchDom();
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://search.bilibili.com/all?keyword=x',
      send, settings: settings(), root: dom,
    });
    await c.start();
    const before = send.mock.calls.length;
    c.setEnabled(false);
    // 触发一次重新采集（新增一张卡片）
    const card = dom.createElement('div');
    card.className = 'bili-video-card';
    card.innerHTML = '<a href="/video/BV1yy411c7mD"><h3 class="bili-video-card__info--tit">新卡片</h3></a>';
    dom.body.appendChild(card);
    await new Promise((r) => setTimeout(r, 1200));
    expect(send.mock.calls.length).toBe(before);
  });

  it('总开关恢复后重新判定', async () => {
    const dom = searchDom();
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://search.bilibili.com/all?keyword=x',
      send, settings: settings(), root: dom,
    });
    await c.start();
    c.setEnabled(false);
    c.setEnabled(true);
    const before = send.mock.calls.length;
    const card = dom.createElement('div');
    card.className = 'bili-video-card';
    card.innerHTML = '<a href="/video/BV1zz411c7mD"><h3 class="bili-video-card__info--tit">新卡片</h3></a>';
    dom.body.appendChild(card);
    await new Promise((r) => setTimeout(r, 1200));
    expect(send.mock.calls.length).toBeGreaterThan(before);
  });

  it('后台抛错时静默降级，不影响页面', async () => {
    const d = commentDom();
    const send = vi.fn(async () => { throw new Error('boom'); });
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await expect(c.start()).resolves.toBeUndefined();
    expect((d.querySelector('.reply-item') as HTMLElement).style.display).not.toBe('none');
  });

  it('stop() 之后不再执行动作', async () => {
    const d = commentDom();
    let c: PageController | undefined;
    const send = vi.fn(async () => {
      c?.stop();
      return { ok: true, data: { verdicts: [FOLD] } };
    });
    c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await c.start();
    expect((d.querySelector('.reply-item') as HTMLElement).style.display).not.toBe('none');
  });

  /**
   * 回归防护：列表页必须有判定语境。
   *
   * 早先列表页一律传 null 语境 → 词表恒为空 → 粗筛永不命中 →
   * 搜索页 42 张卡片全 pass，判定从来没跑过。
   */
  it('搜索页用这批内容本身构造列表语境', async () => {
    const d = searchDom();
    const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://search.bilibili.com/all?keyword=%E5%8D%8E%E4%B8%BA',
      send, settings: settings(), root: d,
    });
    await c.start();

    const msg = send.mock.calls[0]![0] as {
      payload: { items: ContentItem[]; subject: { kind: string; list?: { title: string; samples: string[] } } };
    };
    expect(msg.payload.subject.kind).toBe('list');
    expect(msg.payload.subject.list!.title).toContain('华为');
    expect(msg.payload.subject.list!.samples.length).toBeGreaterThan(0);
    expect(msg.payload.items.length).toBeGreaterThan(0);
  });

  it('搜索页的语境 id 带 list 前缀', async () => {
    const d = searchDom();
    const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://search.bilibili.com/all?keyword=x',
      send, settings: settings(), root: d,
    });
    await c.start();
    const msg = send.mock.calls[0]![0] as {
      payload: { subject: { kind: string; list?: { id: string } } };
    };
    expect(msg.payload.subject.list!.id.startsWith('list:')).toBe(true);
  });

  /**
   * 列表页的内容是异步加载 + 无限滚动的。
   * 只判第一次 = 大部分卡片从来没被判过。
   */
  describe('列表页增量判定', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('新卡片进来会补判，且只送新的那一条', async () => {
      const d = searchDom();
      const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
      const c = new PageController({
        url: 'https://search.bilibili.com/all?keyword=x',
        send, settings: settings(), root: d,
      });
      await c.start();
      expect(send).toHaveBeenCalledTimes(1);

      // 模拟滚动：新卡片插进来
      const card = d.createElement('div');
      card.className = 'bili-video-card';
      card.innerHTML =
        '<a href="/video/BV1dd411c7mD"><h3 class="bili-video-card__info--tit">新进来的视频标题</h3>' +
        '<span class="bili-video-card__info--author">UP主</span></a>';
      d.body.appendChild(card);

      await vi.advanceTimersByTimeAsync(1200);
      expect(send).toHaveBeenCalledTimes(2);

      const second = send.mock.calls[1]![0] as { payload: { items: { id: string }[] } };
      expect(second.payload.items).toHaveLength(1);
      expect(second.payload.items[0]!.id).toBe('BV1dd411c7mD');
      c.stop();
    });

    it('语境只建一次（否则词表缓存永远不命中）', async () => {
      const d = searchDom();
      const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
      const c = new PageController({
        url: 'https://search.bilibili.com/all?keyword=x',
        send, settings: settings(), root: d,
      });
      await c.start();
      const first = send.mock.calls[0]![0] as { payload: { subject: { list?: { id: string } } } };

      const card = d.createElement('div');
      card.className = 'bili-video-card';
      card.innerHTML =
        '<a href="/video/BV1ee411c7mD"><h3 class="bili-video-card__info--tit">又一个视频</h3>' +
        '<span class="bili-video-card__info--author">UP主</span></a>';
      d.body.appendChild(card);
      await vi.advanceTimersByTimeAsync(1200);

      const second = send.mock.calls[1]![0] as { payload: { subject: { list?: { id: string } } } };
      expect(second.payload.subject.list!.id).toBe(first.payload.subject.list!.id);
      c.stop();
    });

    it('stop() 之后不再补判', async () => {
      const d = searchDom();
      const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
      const c = new PageController({
        url: 'https://search.bilibili.com/all?keyword=x',
        send, settings: settings(), root: d,
      });
      await c.start();
      c.stop();

      const card = d.createElement('div');
      card.className = 'bili-video-card';
      card.innerHTML =
        '<a href="/video/BV1ff411c7mD"><h3 class="bili-video-card__info--tit">停止后的视频</h3>' +
        '<span class="bili-video-card__info--author">UP主</span></a>';
      d.body.appendChild(card);
      await vi.advanceTimersByTimeAsync(1200);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('视频页不做增量判定（评论由自有面板按需加载）', async () => {
      const d = commentDom();
      const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
      const c = new PageController({
        url: 'https://www.bilibili.com/video/BV1xx',
        send, settings: settings(), root: d,
      });
      await c.start();
      const extra = d.createElement('div');
      extra.className = 'reply-item';
      extra.setAttribute('data-rpid', '222');
      extra.innerHTML = '<div class="reply-content">后来的评论</div>';
      d.body.appendChild(extra);
      await vi.advanceTimersByTimeAsync(1200);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it('反向推荐渲染成独立区块且每条带理由', () => {
    const d = new DOMParser().parseFromString(
      '<html><body><div id="anchor"></div></body></html>', 'text/html',
    );
    const c = new PageController({ url: 'https://www.bilibili.com/video/BV1xx', send: async () => null });
    const ok = c.showRecommendations(d.querySelector('#anchor')!, [
      { bvid: 'BV1', title: '相反观点视频', author: 'UP', reason: '它主张相反的观点', url: 'https://www.bilibili.com/video/BV1' },
    ]);
    expect(ok).toBe(true);
    expect(d.querySelector('[data-ab-prefix="ab-recommend"]')).not.toBeNull();
    expect(d.body?.textContent).toContain('它主张相反的观点');
  });
});

describe('页面类型识别', () => {
  it('搜索页', () => {
    expect(detectPageType('https://search.bilibili.com/all?keyword=test')).toBe('search');
  });
  it('视频页', () => {
    expect(detectPageType('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('video');
  });
  it('首页推荐流', () => {
    expect(detectPageType('https://www.bilibili.com/')).toBe('feed');
  });
  it('动态页算 feed', () => {
    expect(detectPageType('https://t.bilibili.com/')).toBe('feed');
  });
  it('其他页面为 unknown', () => {
    expect(detectPageType('https://www.bilibili.com/read/cv123')).toBe('unknown');
    expect(detectPageType('https://example.com/')).toBe('unknown');
  });
  it('非法 url 不抛异常', () => {
    expect(detectPageType('not a url')).toBe('unknown');
    expect(detectPageType('')).toBe('unknown');
  });
});
