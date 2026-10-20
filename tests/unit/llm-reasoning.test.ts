import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLlmClient, parseJsonResponse } from '../../src/bg/llm/client';
import { parseJudgments } from '../../src/pipeline/judge';
import { DEFAULT_MAX_TOKENS } from '../../src/shared/constants';
import type { LlmClient } from '../../src/bg/llm/client';

afterEach(() => vi.restoreAllMocks());

function cfg(over: Partial<import('../../src/shared/types').LlmConfig> = {}) {
  return {
    provider: 'openai' as const,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    model: 'm1',
    timeoutMs: 5000,
    ...over,
  };
}

describe('推理模型的 token 预算', () => {
  it('默认用 DEFAULT_MAX_TOKENS（给思考留空间）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const c = createLlmClient(cfg());
    await c.complete('hi');
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body['max_tokens']).toBe(DEFAULT_MAX_TOKENS);
  });

  it('配置的 maxTokens 覆盖默认值', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const c = createLlmClient(cfg({ maxTokens: 12345 }));
    await c.complete('hi');
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body['max_tokens']).toBe(12345);
  });

  it('useMaxCompletionTokens 时改用 max_completion_tokens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const c = createLlmClient(cfg({ useMaxCompletionTokens: true, maxTokens: 999 }));
    await c.complete('hi');
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body['max_completion_tokens']).toBe(999);
    expect(body['max_tokens']).toBeUndefined();
  });

  it('不配置 reasoningEffort 时不发这个字段（部分模型会 400）', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const c = createLlmClient(cfg());
    await c.complete('hi');
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body['reasoning_effort']).toBeUndefined();
  });

  it('配置了 reasoningEffort 才发', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const c = createLlmClient(cfg({ reasoningEffort: 'low' }));
    await c.complete('hi');
    const body = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(body['reasoning_effort']).toBe('low');
  });
});

describe('空 content 的处理', () => {
  it('只有 reasoning_content 时给出可操作的错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: '思考了一堆…' } }],
        }),
        { status: 200 },
      ),
    );
    const c = createLlmClient(cfg());
    await expect(c.complete('hi')).rejects.toThrow(/token 预算不够/);
  });

  it('错误信息不含 API Key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'x' } }] }),
        { status: 200 },
      ),
    );
    const c = createLlmClient(cfg({ apiKey: 'sk-supersecret' }));
    await expect(c.complete('hi')).rejects.not.toThrow(/sk-supersecret/);
  });

  it('content 缺失且没有 reasoning 时报格式异常', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 }),
    );
    const c = createLlmClient(cfg());
    await expect(c.complete('hi')).rejects.toThrow(/格式异常/);
  });

  it('Anthropic 只有 thinking 块时也给出可操作的错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ content: [{ type: 'thinking', thinking: '...' }] }),
        { status: 200 },
      ),
    );
    const c = createLlmClient(cfg({ provider: 'anthropic' }));
    await expect(c.complete('hi')).rejects.toThrow(/token 预算不够/);
  });
});

describe('reasonCode 归一化', () => {
  it('action=pass 时 reasonCode 归为 none', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'pass', reason: '正常内容', reasonCode: 'stance_opposite', confidence: 0.9 }],
    });
    const v = parseJudgments(raw, ['1'], 'pass')[0]!;
    expect(v.action).toBe('pass');
    expect(v.reasonCode).toBe('none');
  });

  it('action=hide 时保留合法 reasonCode', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.9 }],
    });
    expect(parseJudgments(raw, ['1'], 'pass')[0]!.reasonCode).toBe('incitement');
  });

  it('action=hide 且 reasonCode 非法时归为 off_topic', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: 'r', reasonCode: '瞎编的码', confidence: 0.9 }],
    });
    expect(parseJudgments(raw, ['1'], 'pass')[0]!.reasonCode).toBe('off_topic');
  });
});

describe('parseJsonResponse 对空串的健壮性', () => {
  it('空串返回 null 而不是抛错', () => {
    expect(parseJsonResponse('')).toBeNull();
    expect(parseJsonResponse('   ')).toBeNull();
  });

  it('只有思考过程没有 JSON 时返回 null', () => {
    expect(parseJsonResponse('让我想想...最终答案应该在下面对吧')).toBeNull();
  });
});
