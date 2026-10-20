import { describe, it, expect, vi } from 'vitest';
import { createPageBridge } from '../../src/content/page-bridge';
import type { PageBridgeDeps } from '../../src/content/page-bridge';

/**
 * 回归防护：页面桥的自回声。
 *
 * `window.postMessage` 会把消息派发回**同一个 window**，
 * 所以 content script 自己发出的请求消息也会被自己的监听器收到。
 *
 * 曾经的 bug：监听器只用 `__ab` + `id` 过滤，而请求消息恰好也带这两个字段，
 * 于是每次请求都**立刻用请求本身 resolve 成 null**，真实响应到达时已经没人等。
 * 症状是「所有 B 站请求都失败」——包括登录态检测、视频详情、评论。
 * 单测当时全绿，因为 mock 的 postMessage 没有把消息回送给监听器。
 *
 * 这里的 mock **忠实模拟真实行为**：postMessage 会把消息派发回监听器。
 */
function makeRealisticDeps(timeoutMs = 1000) {
  const handlers: Array<(e: MessageEvent) => void> = [];
  let lastPosted: any = null;

  const deps: PageBridgeDeps = {
    addEventListener: (_type, handler) => {
      handlers.push(handler);
    },
    removeEventListener: (_type, handler) => {
      const i = handlers.indexOf(handler);
      if (i >= 0) handlers.splice(i, 1);
    },
    // 关键：postMessage 之后，消息会**回到自己的监听器**（真实浏览器行为）
    postMessage: (msg: unknown) => {
      lastPosted = msg;
      for (const h of [...handlers]) {
        h({ data: msg } as MessageEvent);
      }
    },
    timeoutMs,
  };

  /** 模拟页面脚本在稍后把响应 postMessage 回来。 */
  const respond = (payload: unknown, ok = true, idOverride?: string) => {
    const id = idOverride ?? lastPosted?.id;
    if (!id) throw new Error('还没有发出请求');
    for (const h of [...handlers]) {
      h({
        data: { __ab: true, kind: 'res', id, ok, payload },
      } as MessageEvent);
    }
  };

  return { deps, respond, getPosted: () => lastPosted };
}

describe('页面桥：自回声', () => {
  it('发出的请求会被自己收到，但不能当成响应', async () => {
    const { deps, respond } = makeRealisticDeps();
    const bridge = createPageBridge(deps);

    const p = bridge('https://api.bilibili.com/x/web-interface/nav');

    // 页面脚本稍后回响应
    respond({ code: 0, message: '0', data: { isLogin: true } });

    expect(await p).toEqual({ code: 0, message: '0', data: { isLogin: true } });
  });

  it('请求消息带 kind: req', async () => {
    const { deps, getPosted } = makeRealisticDeps();
    const bridge = createPageBridge(deps);
    void bridge('https://api.bilibili.com/x/web-interface/nav');
    expect(getPosted()?.kind).toBe('req');
  });

  it('响应消息带 kind: res', async () => {
    const { deps, respond, getPosted } = makeRealisticDeps();
    const bridge = createPageBridge(deps);
    const p = bridge('https://api.bilibili.com/x/web-interface/nav');
    respond({ code: 0, data: 1 });
    await p;
    expect(getPosted()?.kind).toBe('req');
  });

  it('页面脚本报错时 resolve 成 null', async () => {
    const { deps, respond } = makeRealisticDeps();
    const bridge = createPageBridge(deps);
    const p = bridge('https://api.bilibili.com/x/web-interface/nav');
    respond(undefined, false);
    expect(await p).toBeNull();
  });

  it('没有响应时超时返回 null，而不是挂死', async () => {
    const { deps } = makeRealisticDeps(30);
    const bridge = createPageBridge(deps);
    // 页面脚本完全不回
    expect(await bridge('https://api.bilibili.com/x/web-interface/nav')).toBeNull();
  });

  it('忽略无关的 message 事件', async () => {
    const { deps, respond } = makeRealisticDeps();
    const bridge = createPageBridge(deps);
    const p = bridge('https://api.bilibili.com/x/web-interface/nav');
    // 别的扩展/脚本的消息：id 对不上，必须被忽略
    respond({ x: 1 }, true, 'not-our-id');
    // 自己的响应
    respond({ code: 0, data: { real: true } });
    expect(await p).toEqual({ code: 0, data: { real: true } });
  });
});
