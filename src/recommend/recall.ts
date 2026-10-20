import type { BiliClient } from '../bili/client';
import { searchVideos, fetchComments } from '../bili/api';
import type { SearchItem, CommentItem } from '../bili/types';

export { judgeOpposition, buildOppositionPrompt } from './opposition';

/**
 * 阶段一（召回）：用对立关键词搜索 B 站，合并去重。
 *
 * 搜索失败（网络/风控/密钥拿不到）就当这一轮没召回到东西，
 * 不抛错——召回是锦上添花，不能让它把主流程带崩。
 */
export async function recallOpposite(
  c: BiliClient,
  keywords: string[],
  maxItems: number = 20,
): Promise<SearchItem[]> {
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  for (const kw of keywords.slice(0, 8)) {
    if (!kw.trim()) continue;
    let items: SearchItem[];
    try {
      items = await searchVideos(c, kw);
    } catch {
      // 单个关键词搜失败不影响其它关键词
      continue;
    }
    for (const it of items) {
      if (!it?.bvid || seen.has(it.bvid)) continue;
      seen.add(it.bvid);
      out.push(it);
      if (out.length >= maxItems) return out;
    }
  }
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
