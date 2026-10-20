import type { BiliClient } from '../bili/client';
import { searchVideos, fetchComments } from '../bili/api';
import type { SearchItem, CommentItem } from '../bili/types';

export { judgeOpposition, buildOppositionPrompt } from './opposition';

/**
 * 一次最多搜几个关键词。
 *
 * B 站搜索接口对短时间内的连续请求会风控（-352 / -412）。
 * 一个关键词通常就能召回 20+ 条候选（精排最多只留 5 条），
 * 所以搜 4 个已经足够；搜 8 个只会平白多打 4 次请求、
 * 大概率中途撞风控，然后整轮召回作废。
 */
const MAX_KEYWORDS = 4;

/**
 * 阶段一（召回）：用对立关键词搜索 B 站，合并去重。
 *
 * 搜索失败（网络/风控/密钥拿不到）就当这一轮没召回到东西，
 * 不抛错——召回是锦上添花，不能让它把主流程带崩。
 * 但**必须打日志**：否则「没召回到」和「被风控了」在用户眼里完全一样。
 */
export async function recallOpposite(
  c: BiliClient,
  keywords: string[],
  maxItems: number = 20,
): Promise<SearchItem[]> {
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  const used = keywords.filter((k) => k.trim()).slice(0, MAX_KEYWORDS);
  for (const kw of used) {
    let items: SearchItem[];
    try {
      items = await searchVideos(c, kw);
    } catch (e) {
      // 单个关键词搜失败不影响其它关键词
      console.warn(
        `[anti-bubble] 反向召回：搜索「${kw}」失败：${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }
    if (items.length === 0) {
      console.warn(`[anti-bubble] 反向召回：搜索「${kw}」没有结果`);
      continue;
    }
    for (const it of items) {
      if (!it?.bvid || seen.has(it.bvid)) continue;
      seen.add(it.bvid);
      out.push(it);
      if (out.length >= maxItems) {
        console.info(`[anti-bubble] 反向召回：候选 ${out.length} 条（搜了 ${used.length} 个关键词）`);
        return out;
      }
    }
  }
  console.info(`[anti-bubble] 反向召回：候选 ${out.length} 条（搜了 ${used.length} 个关键词）`);
  return out;
}

/**
 * 补充信号：从当前视频的评论区挖反对意见，提取关键词作为额外检索入口。
 *
 * 做法：取点赞数较高且带反对意味的评论，用 LLM 提取其中的检索词。
 * 拿不到就返回空数组（这是补充信号，不该影响主流程）。
 */
export async function mineCommentOpposition(
  c: BiliClient,
  oid: number,
  maxComments: number = 30,
): Promise<string[]> {
  let comments: CommentItem[];
  try {
    comments = await fetchComments(c, oid, 3);
  } catch {
    return [];
  }
  if (comments.length === 0) return [];

  const top = comments
    .filter((x) => typeof x.like === 'number')
    .sort((a, b) => (b.like ?? 0) - (a.like ?? 0))
    .slice(0, maxComments);

  const texts = top
    .map((x) => x.content?.message ?? '')
    .filter((t) => t.length > 0);
  if (texts.length === 0) return [];

  // 关键词提取交给调用方的 LLM（这里只做数据准备与轻量过滤）
  return texts
    .filter((t) => t.length >= 6 && t.length <= 60)
    .slice(0, 10);
}
