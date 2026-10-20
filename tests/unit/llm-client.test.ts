import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLlmClient, parseJsonResponse, buildChatMessages } from '../../src/bg/llm/client';
import type { LlmConfig } from '../../src/shared/types';

const openAiConfig: LlmConfig = {
  provider: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'm1',
  timeoutMs: 5000,
};

const anthropicConfig: LlmConfig = {
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'ak-test',
  model: 'm2',
  timeoutMs: 5000,
};

afterEach(() => vi.restoreAllMocks());

describe('LLM 客户端', () => {
  it('OpenAI 协议打到正确端点并带 Key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }),
    );
    const c = createLlmClient(openAiConfig);
    const out = await c.complete('hello');
    expect(out).toBe('hi');

    const call = fetchSpy.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call!;
    expect(String(url)).toContain('/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' });
  });

  it('OpenAI 请求体带 model 与 messages，且不含 Key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }),
    );
    const c = createLlmClient(openAiConfig);
    await c.complete('hello', { system: 'sys', maxTokens: 128 });

    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens?: number;
    };
    expect(body.model).toBe('m1');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    expect(body.max_tokens).toBe(128);
    expect(String(init.body)).not.toContain('sk-test');
    // 超时必须靠 AbortSignal.timeout，而不是没有上限地等
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('Anthropic 协议用 x-api-key 头', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'yo' }] }), { status: 200 }),
    );
    const c = createLlmClient(anthropicConfig);
    expect(await c.complete('hello')).toBe('yo');

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/v1/messages');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'ak-test' });
  });

  it('Anthropic 只拼接 type==="text" 的内容', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(
        JSON.stringify({
          content: [
            { type: 'text', text: 'a' },
            { type: 'thinking', text: 'IGNORED' },
            { type: 'text', text: 'b' },
          ],
        }),
        { status: 200 },
      ),
    );
    const c = createLlmClient(anthropicConfig);
    expect(await c.complete('hello')).toBe('ab');
  });

  it('HTTP 错误抛出可读信息且不含 Key', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('boom', { status: 500 }),
    );
    const c = createLlmClient({ ...openAiConfig, apiKey: 'sk-secret' });
    await expect(c.complete('x')).rejects.toThrow(/500/);
    await expect(c.complete('x')).rejects.not.toThrow(/sk-secret/);
  });

  it('响应体回显 Key 时也被遮掉', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"invalid key sk-secret"}', { status: 401 }),
    );
    const c = createLlmClient({ ...openAiConfig, apiKey: 'sk-secret' });
    await expect(c.complete('x')).rejects.not.toThrow(/sk-secret/);
    await expect(c.complete('x')).rejects.toThrow(/401/);
  });

  it('网络异常被包装成错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const c = createLlmClient(openAiConfig);
    await expect(c.complete('x')).rejects.toThrow(/network down/);
    await expect(c.complete('x')).rejects.toThrow(/^LLM 请求失败：/);
  });
});

/**
 * 自愈重试：服务商不认某个可选字段时，摘掉它再试一次。
 *
 * `max_tokens` / `max_completion_tokens` / `reasoning_effort` 各家接受程度不同，
 * 让用户自己猜该填什么是不友好的——能自己试出来就别麻烦用户。
 */
describe('服务商差异自愈', () => {
  it('400 抱怨 reasoning_effort 时摘掉它重试', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      if ('reasoning_effort' in body) {
        return new Response('{"error":"reasoning_effort is not supported"}', { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    });
    const c = createLlmClient({ ...openAiConfig, reasoningEffort: 'low' });
    expect(await c.complete('x')).toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
    expect('reasoning_effort' in retryBody).toBe(false);
  });

  it('400 要求 max_completion_tokens 时改用它重试', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_u, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
      if (!('max_completion_tokens' in body)) {
        return new Response('{"error":"use max_completion_tokens instead"}', { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 });
    });
    const c = createLlmClient(openAiConfig);
    expect(await c.complete('x')).toBe('ok');
    const retryBody = JSON.parse(String((fetchSpy.mock.calls[1]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(retryBody['max_completion_tokens']).toBe(8192);
    expect('max_tokens' in retryBody).toBe(false);
  });

  it('400 跟可选字段无关时直接报错（不乱重试）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"model not found"}', { status: 400 }),
    );
    const c = createLlmClient(openAiConfig);
    await expect(c.complete('x')).rejects.toThrow(/400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('400 且报错里带 Key 时被遮掉', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('{"error":"bad key sk-secret"}', { status: 400 }),
    );
    const c = createLlmClient({ ...openAiConfig, apiKey: 'sk-secret' });
    await expect(c.complete('x')).rejects.not.toThrow(/sk-secret/);
  });
});

describe('parseJsonResponse', () => {
  it('能剥掉 markdown 包裹', () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('能从废话里抠出 JSON', () => {
    expect(parseJsonResponse('好的，结果如下：{"a":1} 希望有用')).toEqual({ a: 1 });
  });

  it('遇到非 JSON 返回 null', () => {
    expect(parseJsonResponse('完全不是 JSON')).toBeNull();
  });

  it('正常 JSON 原样解析', () => {
    expect(parseJsonResponse('{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });
});

describe('buildChatMessages', () => {
  it('有 system 时产出两条消息', () => {
    const m = buildChatMessages('sys', 'usr');
    expect(m).toHaveLength(2);
    expect(m[0]!.role).toBe('system');
    expect(m[0]!.content).toBe('sys');
    expect(m[1]!.role).toBe('user');
    expect(m[1]!.content).toBe('usr');
  });

  it('system 为 undefined 时只产出 user 一条', () => {
    const m = buildChatMessages(undefined, 'usr');
    expect(m).toHaveLength(1);
    expect(m[0]!.role).toBe('user');
    expect(m[0]!.content).toBe('usr');
  });
});
