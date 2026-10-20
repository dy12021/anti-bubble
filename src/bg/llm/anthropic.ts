import type { LlmConfig } from '../../shared/types';

/** Anthropic 原生协议（Claude）。 */
export async function anthropicComplete(
  config: LlmConfig,
  prompt: string,
  system?: string,
  maxTokens?: number,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const body = {
    model: config.model,
    max_tokens: maxTokens ?? 2048,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  };

  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    throw new Error(`LLM 请求失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    // 同 openai.ts：只回传状态码与响应体前 200 字，绝不回传请求头
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`LLM 返回 HTTP ${res.status}：${detail}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  if (!text) throw new Error('LLM 响应格式异常：缺少 content[].text');
  return text;
}
