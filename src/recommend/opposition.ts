import type { LlmClient } from '../bg/llm/client';
import { parseJsonResponse } from '../bg/llm/client';
import type { SearchItem } from '../bili/types';
import type { RecommendItem } from '../actions/recommend';

/** 一次最多给用户看几条相反观点。多了就成了推荐流，用户看不完。 */
const MAX_RECOMMENDATIONS = 5;

/** 立场比对 prompt。**只输出确实相反的**——宁可少推，不要推错。 */
export function buildOppositionPrompt(
  current: { title: string; stance: string },
  candidates: SearchItem[],
): { system: string; user: string } {
  const system = [
    '你是一个立场比对器。输入是当前视频和一个候选视频列表。',
    '请挑出**确实表达相反观点**的候选，输出严格 JSON。',
    '',
    '输出格式：',
    '{ "results": [{"bvid": "BVxxx", "reason": "一句话说明它为什么是相反观点"}] }',
    '',
    '要求：',
    '- 只输出确实立场相反的；只是不同话题、补充信息、不同立场的都**不要**输出',
    '- reason 必须是能直接展示给用户的人话，不超过 30 字',
    '- 最多输出 5 条',
  ].join('\n');

  const user = [
    `当前视频：${current.title}`,
    `当前视频立场：${current.stance || '（未判定）'}`,
    '',
    '候选视频：',
    ...candidates.map((c2, i) => `${i + 1}. [${c2.bvid}] ${c2.title}｜${c2.author}`),
  ].join('\n');

  return { system, user };
}

/**
 * 阶段二（精排）：让 LLM 判断候选是否真的表达相反观点。
 *
 * 判不出来就丢弃——宁可少推，不要推错。
 * LLM 失败/输出不可解析时返回空数组，绝不抛。
 */
export async function judgeOpposition(
  client: LlmClient,
  current: { title: string; stance: string },
  candidates: SearchItem[],
): Promise<RecommendItem[]> {
  if (candidates.length === 0) return [];

  const { system, user } = buildOppositionPrompt(current, candidates);

  try {
    const raw = await client.complete(user, { system, maxTokens: 1000 });
    const parsed = parseJsonResponse<{ results?: { bvid?: string; reason?: string }[] }>(raw);
    const list = parsed?.results ?? [];
    const out: RecommendItem[] = [];
    for (const r of list) {
      const bvid = typeof r.bvid === 'string' ? r.bvid : '';
      if (!bvid) continue;
      const cand = candidates.find((c2) => c2.bvid === bvid);
      if (!cand) continue;
      const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : '表达了相反的观点';
      out.push({
        bvid,
        title: cand.title,
        author: cand.author,
        reason,
        url: `https://www.bilibili.com/video/${bvid}`,
      });
      if (out.length >= MAX_RECOMMENDATIONS) break;
    }
    return out;
  } catch {
    return [];
  }
}
