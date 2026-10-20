import type { ContentItem, Settings } from '../shared/types';
import type { VideoContext } from '../pipeline/types';
import type { BiliClient } from '../bili/client';
import type { RecommendItem } from '../actions/recommend';
import { recallOpposite } from '../recommend/recall';
import { videoSubject } from '../pipeline/subject';
import { MSG } from '../shared/messages';

/**
 * 搜索页的反向推荐（设计 §3.4 的第二个触发点）。
 *
 * > **搜索页** | 用户提交一次搜索后，对该次搜索结果中的高曝光视频做立场判定，
 * > 命中「表达观点」的才进入反向推荐
 *
 * ## 为什么要挑「高曝光」的几个
 *
 * 搜索结果几十条，全做一遍就是几十次词表 + 几十次搜索 + 几十次精排——
 * 又贵又容易撞 B 站搜索风控。所以只取**最靠前的几个**
 * （用户第一眼会看到的那几个）。
 *
 * ## 为什么要先判「有没有立场」
 *
 * 不是所有视频都表达观点。一个纯参数评测的「红黑榜选购指南」没有立场，
 * 硬给它找「相反观点」只会推出来一堆同类型的评测视频，纯噪声。
 * 判据：词表里的 stance 为空（模型认为它没立场）→ 不触发。
 */

/** 搜索页最多处理几个高曝光视频。 */
export const SEARCH_ANTI_VIDEOS = 2;

/** 每个视频最多用几个对立检索词去搜（搜多了容易撞风控）。 */
const SEARCH_ANTI_KEYWORDS = 2;

export interface SearchRecommendDeps {
  bili: BiliClient;
  send: (msg: unknown) => Promise<unknown>;
}

/**
 * 对搜索结果里的高曝光视频做反向推荐。
 *
 * 任何一步失败都静默跳过——推荐是锦上添花，不该影响主流程。
 */
export async function fetchSearchOppositeRecommendations(
  items: ContentItem[],
  settings: Settings | null,
  deps: SearchRecommendDeps,
): Promise<RecommendItem[]> {
  if (!settings || settings.mode !== 'anti') return [];
  if (items.length === 0) return [];

  const out: RecommendItem[] = [];
  const seen = new Set<string>();

  for (const item of items.slice(0, SEARCH_ANTI_VIDEOS)) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);

    // 视频语境：bvid + 标题。标题就在卡片里，不用再打一次 API。
    const video: VideoContext = { bvid: item.id, title: item.text };

    // ① 词表：立场摘要 + 对立检索词（一次调用同时拿两样）
    let wlResp: {
      ok?: boolean;
      data?: { stance?: string; oppositeKeywords?: string[] };
    } | null = null;
    try {
      wlResp = (await deps.send({
        type: MSG.GET_WORDLIST, id: `wl-${item.id}`,
        payload: { subject: videoSubject(video), mode: settings.mode },
      })) as {
        ok?: boolean;
        data?: { stance?: string; oppositeKeywords?: string[] };
      } | null;
    } catch {
      // 后台不可用（service worker 正在重启等）→ 跳过这个视频
      continue;
    }

    const stance = (wlResp?.data?.stance ?? '').trim();
    const keywords = (wlResp?.data?.oppositeKeywords ?? []).filter((k) => k.trim());
    // 没有立场 → 不触发（「不是所有视频都表达观点」）
    if (!wlResp?.ok || !stance || keywords.length === 0) {
      console.info(`[anti-bubble] 搜索页反向推荐：${item.text.slice(0, 20)} 没有明确立场，跳过`);
      continue;
    }

    // ② 召回：拿对立检索词去搜 B 站
    let candidates: Awaited<ReturnType<typeof recallOpposite>>;
    try {
      candidates = await recallOpposite(deps.bili, keywords.slice(0, SEARCH_ANTI_KEYWORDS));
    } catch {
      continue;
    }
    if (candidates.length === 0) continue;

    // ③ 精排：只留确实相反的
    let judged: RecommendItem[] = [];
    try {
      const judgeResp = (await deps.send({
        type: MSG.GET_RECOMMENDATIONS, id: `rec-${item.id}`,
        payload: { video, candidates },
      })) as { ok?: boolean; data?: { items?: RecommendItem[] } } | null;
      judged = judgeResp?.ok ? (judgeResp.data?.items ?? []) : [];
    } catch {
      continue;
    }
    for (const j of judged) {
      if (out.some((x) => x.bvid === j.bvid)) continue;
      out.push(j);
    }
  }

  return out;
}
