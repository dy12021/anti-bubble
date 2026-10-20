// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';

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

const FOLD: Verdict = {
  itemId: '111', action: 'fold', reason: '在引战',
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
      settings: { mode: 'cocoon', enabledPages: { search: false, video: true, feed: true, unknown: false }, masterEnabled: true, collectHistory: true, confidenceThreshold: 0.7 },
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

  it('判定请求带上 items / mode / video', async () => {
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
      payload: { items: ContentItem[]; mode: string; video: unknown };
    };
    expect(msg.type).toBe(MSG.JUDGE_ITEMS);
    expect(msg.payload.mode).toBe('cocoon');
    expect(msg.payload.video).toEqual({ bvid: 'BV1xx', title: '这个视频在讲 Rust' });
    expect(msg.payload.items).toHaveLength(1);
    expect(msg.payload.items[0]!.id).toBe('111');
  });

  it('没有视频上下文时 video 传 null', async () => {
    const d = commentDom();
    const send = vi.fn(async (_msg: unknown) => ({ ok: true, data: { verdicts: [] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await c.start();
    const msg = send.mock.calls[0]![0] as { payload: { video: unknown } };
    expect(msg.payload.video).toBeNull();
  });

  it('fold 判定会折叠对应内容', async () => {
    const d = commentDom();
    const send = vi.fn(async () => ({ ok: true, data: { verdicts: [FOLD] } }));
    const c = new PageController({
      url: 'https://www.bilibili.com/video/BV1xx',
      send, settings: settings(), root: d,
    });
    await c.start();
    expect((d.querySelector('.reply-item') as HTMLElement).style.display).toBe('none');
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
    expect((d.querySelector('.reply-item') as HTMLElement).style.display).not.toBe('none');
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
