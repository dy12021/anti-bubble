import type { LlmConfig } from '../../shared/types';
import { buildChatMessages } from './client';
import type { ChatMessage } from './client';
import { DEFAULT_MAX_TOKENS } from '../../shared/constants';

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
  const budget = maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };
  // 有些 OpenAI 兼容服务商会忽略 max_tokens，要求用 max_completion_tokens。
  if (config.useMaxCompletionTokens) body['max_completion_tokens'] = budget;
  else body['max_tokens'] = budget;
  // 只有服务商明确支持时才发。MiniMax-M3.1 强制 adaptive thinking，
  // 传 none 会被 400 拒绝，所以这个字段默认不发。
  if (config.reasoningEffort) body['reasoning_effort'] = config.reasoningEffort;

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
    choices?: {
      message?: { content?: string | null; reasoning_content?: string | null };
      finish_reason?: string;
    }[];
  };
  const message = data.choices?.[0]?.message;
  const content = message?.content;

  if (typeof content !== 'string' || content.trim() === '') {
    // 推理模型把预算烧在思考上、最终答案没输出——这是最常见的一种失败，
    // 必须说清楚，否则上层只能静默降级，用户只看到「插件没反应」。
    const reasoning = message?.reasoning_content ?? '';
    if (reasoning.length > 0) {
      throw new Error(
        'LLM 只返回了思考过程、没有最终答案——token 预算不够。' +
          '请调大 maxTokens（推理模型需要给思考留空间）或换用非推理模型。',
      );
    }
    throw new Error(
      'LLM 响应格式异常：缺少 choices[0].message.content' +
        (data.choices?.[0]?.finish_reason ? `（finish_reason=${data.choices[0].finish_reason}）` : ''),
    );
  }

  return content;
}
