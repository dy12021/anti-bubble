import type { LlmConfig } from '../../shared/types';
import { buildChatMessages } from './client';
import type { ChatMessage } from './client';

/**
 * 响应体是外部内容，理论上可能把 Key 原样回显（代理、网关、日志都见过）。
 * 错误信息里绝对不能出现 Key，所以兜底遮一遍。
 */
function redact(text: string, apiKey: string): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

/** OpenAI 兼容协议。DeepSeek / MiniMax / Kimi / Qwen 等都走这个。 */
export async function openAiComplete(
  config: LlmConfig,
  prompt: string,
  system?: string,
  maxTokens?: number,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const messages: ChatMessage[] = buildChatMessages(system, prompt);
  const body = {
    model: config.model,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    throw new Error(`LLM 请求失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    // 只回传状态码与响应体前 200 字，不含请求头（Key 在请求头里）
    const detail = redact((await res.text().catch(() => '')).slice(0, 200), config.apiKey);
    throw new Error(`LLM 返回 HTTP ${res.status}：${detail}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM 响应格式异常：缺少 choices[0].message.content');
  }
  return content;
}
