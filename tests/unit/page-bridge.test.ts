import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createPageBridge,
  handlePageMessage,
  BILI_API_PATTERN,
  DEFAULT_TIMEOUT_MS,
} from '../../src/content/page-bridge';
import type { PageBridgeDeps } from '../../src/content/page-bridge';

interface SentMessage {
  __ab: boolean;
  id: string;
  url: string;
}

/** 造一套假的 window 事件接口，并记录当前挂载的 message 监听器。 */
function makeDeps(timeoutMs?: number) {
  const handlers: Array<(e: MessageEvent) => void> = [];
  const addEventListener = vi.fn((_type: 'message', handler: (e: MessageEvent) => void) => {
    handlers.push(handler);
  });
  const removeEventListener = vi.fn((_type: 'message', handler: (e: MessageEvent) => void) => {
    const i = handlers.indexOf(handler);
    if (i >= 0) handlers.splice(i, 1);
  });
  const postMessage = vi.fn((_msg: unknown) => {});
  const deps: PageBridgeDeps = {
    addEventListener,
    removeEventListener,
    postMessage,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  return { deps, handlers, addEventListener, removeEventListener, postMessage };
}

/** 伪造一条 message 事件。 */
function fakeEvent(data: unknown): { e: MessageEvent; postMessage: ReturnType<typeof vi.fn> } {
  const postMessage = vi.fn();
  const e = { data, source: { postMessage } } as unknown as MessageEvent;
  return { e, postMessage };
}

/** 伪造一个 Response。 */
function fakeResponse(payload: unknown): Response {
  return { json: async () => payload } as unknown as Response;
}

/** 把微任务队列冲干净，等页面脚本那条 async 链跑完。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createPageBridge', () => {
  it('正常请求能拿回 JSON 结果', async () => {
    const { deps, handlers, postMessage } = makeDeps();
    const request = createPageBridge(deps);

    const p = request('https://api.bilibili.com/x/web-interface/nav');

    expect(postMessage).toHaveBeenCalledTimes(1);
    const sent = postMessage.mock.calls[0]![0] as SentMessage;
    expect(sent.__ab).toBe(true);
    expect(sent.id).toMatch(/^ab-/);
    expect(sent.url).toBe('https://api.bilibili.com/x/web-interface/nav');

    // 页面脚本回信
    handlers[0]!({
      data: {
        __ab: true,
        kind: 'res',
        id: sent.id,
        ok: true,
        payload: { code: 0, message: '0', data: { isLogin: true } },
      },
    } as unknown as MessageEvent);

    await expect(p).resolves.toEqual({ code: 0, message: '0', data: { isLogin: true } });
  });

  it('请求 id 形如 ab-<base36时间>-<序号>，且互不相同', async () => {
    const { deps, postMessage } = makeDeps();
    const request = createPageBridge(deps);

    void request('https://api.bilibili.com/a');
    void request('https://api.bilibili.com/b');

    const first = postMessage.mock.calls[0]![0] as SentMessage;
    const second = postMessage.mock.calls[1]![0] as SentMessage;
    expect(first.id).toMatch(/^ab-[0-9a-z]+-[0-9a-z]+$/);
    expect(second.id).not.toBe(first.id);
  });

  it('超时会 resolve 成 null，绝不挂死', async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps(50);
    const request = createPageBridge(deps);

    const p = request('https://api.bilibili.com/x/web-interface/nav');
    let settled: unknown = 'pending';
    void p.then((v) => {
      settled = v;
    });

    await vi.advanceTimersByTimeAsync(60);

    await expect(p).resolves.toBeNull();
    expect(settled).toBeNull();
  });

  it('默认超时是 15 秒', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(15000);
  });

  it('页面脚本报错时 resolve 成 null', async () => {
    const { deps, handlers, postMessage } = makeDeps();
    const request = createPageBridge(deps);

    const p = request('https://api.bilibili.com/x/web-interface/nav');
    const sent = postMessage.mock.calls[0]![0] as SentMessage;

    handlers[0]!({
      data: { __ab: true, kind: 'res', id: sent.id, ok: false, error: 'boom' },
    } as unknown as MessageEvent);

    await expect(p).resolves.toBeNull();
  });

  it('id 对不上的响应被忽略，请求继续等到超时', async () => {
    vi.useFakeTimers();
    const { deps, handlers } = makeDeps(50);
    const request = createPageBridge(deps);

    const p = request('https://api.bilibili.com/x/web-interface/nav');

    handlers[0]!({
      data: { __ab: true, kind: 'res', id: 'ab-not-mine', ok: true, payload: { code: 0 } },
    } as unknown as MessageEvent);

    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    await expect(p).resolves.toBeNull();
  });

  it('非本模块协议的消息被忽略', async () => {
    vi.useFakeTimers();
    const { deps, handlers } = makeDeps(50);
    const request = createPageBridge(deps);

    const p = request('https://api.bilibili.com/x/web-interface/nav');

    handlers[0]!({ data: { hello: 'world' } } as unknown as MessageEvent);
    handlers[0]!({ data: null } as unknown as MessageEvent);

    await vi.advanceTimersByTimeAsync(60);
    await expect(p).resolves.toBeNull();
  });

  it('没有在途请求时会摘掉 message 监听', async () => {
    const { deps, handlers, postMessage, removeEventListener } = makeDeps();
    const request = createPageBridge(deps);

    const p = request('https://api.bilibili.com/x/web-interface/nav');
    const sent = postMessage.mock.calls[0]![0] as SentMessage;
    handlers[0]!({
      data: { __ab: true, kind: 'res', id: sent.id, ok: true, payload: { code: 0 } },
    } as unknown as MessageEvent);

    await p;
    expect(removeEventListener).toHaveBeenCalled();
    expect(handlers).toHaveLength(0);
  });
});

describe('handlePageMessage', () => {
  it('白名单只放行 api.bilibili.com', () => {
    expect(BILI_API_PATTERN.test('https://api.bilibili.com/x/web-interface/nav')).toBe(true);
    expect(BILI_API_PATTERN.test('https://evil.example.com/steal')).toBe(false);
    expect(BILI_API_PATTERN.test('https://api.bilibili.com.evil.com/x')).toBe(false);
    expect(BILI_API_PATTERN.test('http://api.bilibili.com/x')).toBe(false);
  });

  it('非白名单 URL 直接回 blocked url，且不发请求', async () => {
    const { e, postMessage } = fakeEvent({
      __ab: true,
      kind: 'req',
      id: 'ab-1',
      url: 'https://evil.example.com/steal',
    });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => fakeResponse({}));

    handlePageMessage(e, fetchImpl);
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0]).toEqual({
      __ab: true,
      kind: 'res',
      id: 'ab-1',
      ok: false,
      error: 'blocked url',
    });
  });

  it('正常请求带 credentials 与 Accept 头，成功回 payload', async () => {
    const payload = { code: 0, message: '0', data: { isLogin: true } };
    const { e, postMessage } = fakeEvent({
      __ab: true,
      kind: 'req',
      id: 'ab-2',
      url: 'https://api.bilibili.com/x/web-interface/nav',
    });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => fakeResponse(payload));

    handlePageMessage(e, fetchImpl);
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.bilibili.com/x/web-interface/nav');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![0]).toEqual({
      __ab: true,
      kind: 'res',
      id: 'ab-2',
      ok: true,
      payload,
    });
  });

  it('fetch 抛错时回 ok:false 与错误消息', async () => {
    const { e, postMessage } = fakeEvent({
      __ab: true,
      kind: 'req',
      id: 'ab-3',
      url: 'https://api.bilibili.com/x/web-interface/nav',
    });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => {
      throw new Error('network down');
    });

    handlePageMessage(e, fetchImpl);
    await flush();

    expect(postMessage.mock.calls[0]![0]).toEqual({
      __ab: true,
      kind: 'res',
      id: 'ab-3',
      ok: false,
      error: 'network down',
    });
  });

  it('非法消息直接忽略', async () => {
    const { e, postMessage } = fakeEvent({ hello: 'world' });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => fakeResponse({}));

    handlePageMessage(e, fetchImpl);
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('缺 url 的消息被忽略', async () => {
    const { e, postMessage } = fakeEvent({ __ab: true, id: 'ab-4' });
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => fakeResponse({}));

    handlePageMessage(e, fetchImpl);
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
