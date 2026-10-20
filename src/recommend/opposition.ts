import type { LlmClient } from '../bg/llm/client';
import { parseJsonResponse } from '../bg/llm/client';
import type { SearchItem } from '../bili/types';
import type { RecommendItem } from '../actions/recommend';

/** 一次最多给用户看几条相反观点。多了就成了推荐流，用户看不完。 */
const MAX_RECOMMENDATIONS = 5;

/**
 * 立场比对 prompt。**只输出确实相反的**——宁可少推，不要推错。
 *
 * 输出用**序号**而不是 bvid：模型抄长字符串容易出错
 * （大小写、多余空格、记错一位），抄序号几乎不会错。
 * 序号对不上还能退回按 bvid 匹配。
 */
export function buildOppositionPrompt(
  current: { title: string; stance: string },
  candidates: SearchItem[],
): { system: string; user: string } {
  const system = [
    '你是一个立场比对器。输入是当前视频和一个候选视频列表。',
    '请挑出**确实表达相反观点**的候选，输出严格 JSON。',
    '',
    '输出格式：',
    '{ "results": [{"id": 3, "reason": "一句话说明它为什么是相反观点"}] }',
    '',
    '要求：',
    '- id 是候选列表里的**序号**（从 1 开始），不是 bvid',
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

/** bvid 归一化：模型可能带空格或改大小写。 */
function normalizeBvid(b: string): string {
  return b.trim().toUpperCase();
}

/**
 * 阶段二（精排）：让 LLM 判断候选是否真的表达相反观点。
 *
 * 判不出来就丢弃——宁可少推，不要推错。
 * LLM 失败/输出不可解析时返回空数组，绝不抛。
 *
 * **匹配要稳**：模型可能给序号、可能给 bvid、可能大小写不一致。
 * 早先只按 bvid 精确匹配，模型抄错一个字符就被静默丢掉，
 * 结果是「召回到 20 条却一条都没推」——看起来像功能坏了。
 */
export async function judgeOpposition(
  client: LlmClient,
  current: { title: string; stance: string },
  candidates: SearchItem[],
): Promise<RecommendItem[]> {
  if (candidates.length === 0) return [];

  const { system, user } = buildOppositionPrompt(current, candidates);

  try {
    const raw = await client.complete(user, { system });
    const parsed = parseJsonResponse<{
      results?: { id?: unknown; bvid?: unknown; reason?: unknown }[];
    }>(raw);
    const list = parsed?.results ?? [];
    const out: RecommendItem[] = [];
    const used = new Set<string>();

    for (const r of list) {
      const cand = resolveCandidate(r, candidates);
      if (!cand) {
        // 匹配不上就说出来——不然只能看到「什么都没推出来」
        const raw0 = r?.id ?? r?.bvid;
        console.warn(`[anti-bubble] 反向推荐：模型给的候选「${String(raw0)}」匹配不上，已忽略`);
        continue;
      }
      if (used.has(cand.bvid)) continue;
      used.add(cand.bvid);
      const reason =
        typeof r.reason === 'string' && r.reason.trim()
          ? r.reason.trim()
          : '表达了相反的观点';
      out.push({
        bvid: cand.bvid,
        title: cand.title,
        author: cand.author,
        reason,
        url: `https://www.bilibili.com/video/${cand.bvid}`,
      });
      if (out.length >= MAX_RECOMMENDATIONS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** 把模型给的结果对上候选：先按序号，再按归一化的 bvid。 */
function resolveCandidate(
  r: { id?: unknown; bvid?: unknown },
  candidates: SearchItem[],
): SearchItem | null {
  // ① 序号
  const idNum = typeof r.id === 'number' ? r.id : Number(r.id);
  if (Number.isInteger(idNum) && idNum >= 1 && idNum <= candidates.length) {
    return candidates[idNum - 1]!;
  }
  // ② bvid
  if (typeof r.bvid === 'string' && r.bvid.trim()) {
    const want = normalizeBvid(r.bvid);
    const hit = candidates.find((c) => normalizeBvid(c.bvid) === want);
    if (hit) return hit;
  }
  return null;
}
