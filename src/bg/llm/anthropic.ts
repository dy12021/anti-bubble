import type { LlmConfig } from '../../shared/types';
import { DEFAULT_MAX_TOKENS } from '../../shared/constants';

/**
 * 响应体是外部内容，理论上可能把 Key 原样回显。
 * 错误信息里绝对不能出现 Key，所以兜底遮一遍。
 */
function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

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
    max_tokens: maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
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
    const detail = redact((await res.text().catch(() => '')).slice(0, 200), config.apiKey);
    throw new Error(`LLM 返回 HTTP ${res.status}：${detail}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  if (!text.trim()) {
    // Claude 的 extended thinking 也会把 max_tokens 预算吃掉，
    // 最终只返回 thinking 块而没有 text 块——同样要说清楚，别静默。
    const hasThinking = (data.content ?? []).some((c) => c.type === 'thinking');
    throw new Error(
      hasThinking
        ? 'LLM 只返回了思考过程、没有最终答案——token 预算不够。请调大 maxTokens 或换用非推理模型。'
        : 'LLM 响应格式异常：缺少 content[].text',
    );
  }
  return text;
}
