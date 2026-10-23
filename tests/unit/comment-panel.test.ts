// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommentPanel } from '../../src/content/comment-panel';
import type { CommentItem } from '../../src/bili/types';
import type { Settings } from '../../src/shared/types';

const settings: Settings = {
  mode: 'cocoon',
  enabledPages: { search: true, video: true, feed: true, unknown: false },
  masterEnabled: true,
  collectHistory: true,
  confidenceThreshold: 0.7,
  judgeLevel: 'coarse',
};

function comment(rpid: number, text: string, like = 0): CommentItem {
  return {
    rpid,
    mid: 1,
    ctime: 0,
    like,
    rcount: 0,
    content: { message: text },
    member: { mid: 1, uname: `用户${rpid}`, level: 1 },
  };
}

function setup(opts: {
  comments?: CommentItem[];
  verdicts?: unknown[];
  fetchThrows?: boolean;
} = {}) {
  document.body.innerHTML = `
    <div id="commentapp"><bili-comments></bili-comments></div>
    <div id="anchor"></div>
  `;
  const anchor = document.getElementById('anchor')!;

  const send = vi.fn(async (msg: unknown) => {
    const m = msg as { type?: string };
    if (m.type === 'JUDGE_ITEMS') {
      return { ok: true, data: { verdicts: opts.verdicts ?? [] } };
    }
    return { ok: true, data: null };
  });

  const panel = new CommentPanel({
    root: document,
    aid: 12345,
    fetchComments: async () => {
      if (opts.fetchThrows) throw new Error('network');
      return opts.comments ?? [];
    },
    send,
    settings,
    videoTitle: '视频标题',
    video: { bvid: 'BV1', title: '视频标题' },
  });

  return { panel, anchor, send };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('自有评论区', () => {
  it('挂载后渲染出评论区容器', async () => {
    const { panel, anchor } = setup({ comments: [comment(1, '你好')] });
    panel.mount(anchor);
    await tick();
    expect(document.querySelector('[data-ab-prefix="ab-comments"]')).not.toBeNull();
  });

  it('把取到的评论渲染出来', async () => {
    const { panel, anchor } = setup({ comments: [comment(1, '第一条评论'), comment(2, '第二条评论')] });
    panel.mount(anchor);
    await tick();
    await tick();
    expect(document.querySelectorAll('[data-ab-rpid]')).toHaveLength(2);
    expect(document.body.textContent).toContain('第一条评论');
  });

  it('隐藏 B 站原生评论区', async () => {
    const { panel, anchor } = setup({ comments: [comment(1, 'x')] });
    panel.mount(anchor);
    await tick();
    const native = document.getElementById('commentapp') as HTMLElement;
    expect(native.style.display).toBe('none');
  });

  it('取评论失败时给出可读提示而不是静默', async () => {
    const { panel, anchor } = setup({ fetchThrows: true });
    panel.mount(anchor);
    await tick();
    await tick();
    const status = document.querySelector('[data-ab-prefix="ab-comments"] .ab-comments-status');
    expect(status?.textContent).toContain('失败');
  });

  it('没有评论时提示可能需要登录', async () => {
    const { panel, anchor } = setup({ comments: [] });
    panel.mount(anchor);
    await tick();
    await tick();
    const status = document.querySelector('.ab-comments-status');
    expect(status?.textContent).toContain('登录');
  });

  it('把评论送去判定，且必须带上视频语境', async () => {
    const { panel, anchor, send } = setup({ comments: [comment(11, '要判的评论')] });
    panel.mount(anchor);
    await tick();
    await tick();
    const judgeCall = send.mock.calls.find(
      (c) => (c[0] as { type?: string }).type === 'JUDGE_ITEMS',
    );
    expect(judgeCall).toBeTruthy();
    const payload = (judgeCall![0] as {
      payload: { items: { id: string; text: string }[]; subject?: unknown };
    }).payload;
    expect(payload.items[0]!.id).toBe('11');
    expect(payload.items[0]!.text).toBe('要判的评论');
    // 必须带语境：后台靠它生成动态词表，没词表就没有粗筛，
    // 粗筛不命中就不会调 LLM 精判，评论会全部原样放行。
    expect(payload.subject).toBeTruthy();
    expect((payload.subject as { kind?: string }).kind).toBe('video');
  });

  it('判定为折叠时隐藏内容并给出理由', async () => {
    const { panel, anchor } = setup({
      comments: [comment(21, '引战内容')],
      verdicts: [
        { itemId: '21', action: 'fold', reason: '在引战', reasonCode: 'incitement', confidence: 0.9, revocable: true },
      ],
    });
    panel.mount(anchor);
    await tick();
    await tick();
    await tick();
    const row = document.querySelector('[data-ab-rpid="21"]') as HTMLElement;
    expect(row.style.display).toBe('none');
    expect(document.body.textContent).toContain('在引战');
  });

  it('判定为标识时只加标签、不隐藏', async () => {
    const { panel, anchor } = setup({
      comments: [comment(31, '立场相反的评论')],
      verdicts: [
        { itemId: '31', action: 'mark', reason: '与你立场相反', reasonCode: 'stance_opposite', confidence: 0.8, revocable: false },
      ],
    });
    panel.mount(anchor);
    await tick();
    await tick();
    await tick();
    const row = document.querySelector('[data-ab-rpid="31"]') as HTMLElement;
    expect(row.style.display).not.toBe('none');
    expect(document.querySelector('[data-ab-prefix="ab-mark"]')?.textContent).toContain('与你立场相反');
  });

  it('点「仍要显示」恢复内容并触发撤销', async () => {
    const onRevoke = vi.fn();
    document.body.innerHTML = '<div id="commentapp"></div><div id="anchor"></div>';
    const anchor = document.getElementById('anchor')!;
    const panel = new CommentPanel({
      root: document,
      aid: 1,
      fetchComments: async () => [comment(41, '引战')],
      send: async () => ({
        ok: true,
        data: {
          verdicts: [
            { itemId: '41', action: 'fold', reason: '在引战', reasonCode: 'incitement', confidence: 0.9, revocable: true },
          ],
        },
      }),
      settings,
      onRevoke,
    });
    panel.mount(anchor);
    await tick();
    await tick();
    await tick();

    const btn = document.querySelector('[data-ab-prefix="ab-revoke"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    const row = document.querySelector('[data-ab-rpid="41"]') as HTMLElement;
    expect(row.style.display).not.toBe('none');
    expect(onRevoke).toHaveBeenCalledWith('41');
  });

  it('同一条评论不会被重复判定', async () => {
    const { panel, anchor, send } = setup({ comments: [comment(51, '只判一次')] });
    panel.mount(anchor);
    await tick();
    await tick();
    const before = send.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'JUDGE_ITEMS',
    ).length;
    // 再次触发加载（同样的评论）
    await panel.loadMore?.();
    await tick();
    const after = send.mock.calls.filter(
      (c) => (c[0] as { type?: string }).type === 'JUDGE_ITEMS',
    ).length;
    expect(after).toBe(before);
  });
});
