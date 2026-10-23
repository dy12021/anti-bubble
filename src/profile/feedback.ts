import type { UserProfile, ItemKind } from '../shared/types';

/**
 * 画像反馈：用户撤销屏蔽时顺手修正画像。
 *
 * ## 为什么需要
 *
 * 画像里的「不喜欢」是 LLM 归纳出来的，**会错**。
 * 用户点「仍要显示」就是在说「这条其实我想看」——
 * 如果不修正画像，同题材的内容下次还会被折叠，用户会觉得「撤销了也没用」。
 *
 * 所以撤销时给用户多一个选择：**顺手把画像改了**。
 *
 * ## 改什么
 *
 * 1. 去掉命中的那个「不喜欢」标签（这是确定要改的）；
 * 2. 把这条的题材加进「感兴趣」（只对视频做，评论当兴趣没意义）。
 *
 * 不做的事：不伪造观看样本。样本数是给用户看的统计，
 * 拿一次点击去充数会让这个数字失真。
 */

/** 一条反馈。 */
export interface ProfileFeedback {
  /** 命中的「不喜欢」标签（只有 dislike_match 才有）。 */
  matchedTag?: string;
  /** 内容文本：视频标题 / 评论正文。 */
  text?: string;
  /** 内容类型。 */
  kind?: ItemKind;
}

/** 兴趣标签的最长字数。太长的标签在面板上没法看，也没法当题材用。 */
const MAX_TAG_LENGTH = 20;

/** 标题开头的方括号/书名号块：【】〔〕（）()[]「」『』《》〈〉 */
const LEADING_BRACKET =
  /^[【〔（(［[「『《〈][^】〕）)］］」』》〉]{0,24}[】〕）)］］」』》〉]?\s*/;

/** 断句与分隔符。取第一个片段当题材。 */
const SEPARATOR = /[，,。．.！!？?；;：:｜|/\\·、~～—–\-]+/;

/**
 * 通用词：**不带题材信息**，当兴趣标签只会污染画像。
 *
 * 「合集」「记录」这类词描述的是**栏目的形式**，不是题材——
 * 把它们写进「用户感兴趣：合集」对 LLM 判偏好毫无帮助，
 * 只会让画像越用越脏。
 */
const GENERIC_WORDS = new Set([
  '记录', '录像', '回放', '直播', '预告', '花絮', '正片', '全集', '单集',
  '连载', '完结', '更新', '高清', '修复', '独家', '原创', '转载', '收藏',
  '干货', '教程', '科普', '混剪', '盘点', '评测', '攻略', '试片', '体验',
  '分享', '日常', '打包', '全部', '完整版', '入门', '基础', '第一集', '上集',
  '中集', '下集', '合集', '震惊', '惊呆', '绝了', '离谱', '重磅', '首次',
]);

/** 通用**句式**：整段带这些特征的一律不收。 */
const GENERIC_PATTERNS: RegExp[] = [
  /合集/,                                 // 「咖啡合集」——形式，不是题材
  /第[0-9一二三四五六七八九十百千]+[集季部篇话]/, // 「第二季」「第 3 集」
  /vlog/i,                                // 「Vlog58｜…」
];

/**
 * 从标题里派生一个题材标签。
 *
 * 中文没有分词，直接拿整条标题当标签没有意义（「震惊！某国选手被曝黑幕」当兴趣标签毫无信息量）。
 * 所以这里做一个**保守**的切分：
 * 去掉开头的方括号块（【科普中国】这种是栏目名，不是题材），
 * 再按标点取片段。
 *
 * **只收有题材信息的片段**：通用词（合集/记录/教程…）与通用句式（第X集/Vlog…）
 * 一律跳过；全都跳不过就返回 null——
 * 宁可什么都不加，也不要往画像里塞垃圾标签。
 */
export function deriveInterestTag(text: string): string | null {
  let s = (text ?? '').trim();
  if (!s) return null;

  // 反复剥掉开头的括号块：【科普】AI 到底会不会… → AI 到底会不会…
  for (let i = 0; i < 3; i++) {
    const next = s.replace(LEADING_BRACKET, '');
    if (next === s) break;
    s = next.trim();
  }
  if (!s) return null;

  // 最多试三个片段：第一个不行就换下一个，全不行就放弃
  const fragments = s.split(SEPARATOR).map((x) => x.trim()).filter((x) => x.length > 0);
  for (const frag of fragments.slice(0, 3)) {
    const tag = frag.length > MAX_TAG_LENGTH ? frag.slice(0, MAX_TAG_LENGTH).trim() : frag;
    if (tag.length < 2) continue;
    if (GENERIC_WORDS.has(tag)) continue;
    if (GENERIC_PATTERNS.some((p) => p.test(tag))) continue;
    return tag;
  }
  return null;
}

/**
 * 把一条反馈应用到画像上。**纯函数**：不改原对象，返回新画像。
 */
export function applyProfileFeedback(
  profile: UserProfile,
  feedback: ProfileFeedback,
  now: number = Date.now(),
): UserProfile {
  const matched = (feedback.matchedTag ?? '').trim();
  const matchedKey = matched.toLowerCase();

  // ① 去掉命中的「不喜欢」标签
  const dislikes = matchedKey
    ? profile.dislikes.filter((d) => d.trim().toLowerCase() !== matchedKey)
    : [...profile.dislikes];

  // topics 里可能也有同一个标签，一并去掉（免得 prompt 里还留着）
  const topics = matchedKey
    ? profile.topics.filter((t) => t.trim().toLowerCase() !== matchedKey)
    : [...profile.topics];

  // ② 把题材加进兴趣（只对视频）
  const interests = [...profile.interests];
  let added: string | null = null;
  if (feedback.kind === 'video' && feedback.text) {
    const tag = deriveInterestTag(feedback.text);
    if (tag) {
      const existing = interests.find((i) => i.tag === tag);
      if (existing) {
        // 已经有这个标签 → 提一提权重
        existing.weight = Math.min(1, Math.max(existing.weight, 0.5));
      } else {
        interests.push({ tag, weight: 0.5 });
        added = tag;
      }
      interests.sort((a, b) => b.weight - a.weight);
    }
  }

  return {
    ...profile,
    interests,
    dislikes,
    topics,
    // updatedAt 要更新：判定缓存键与词表缓存键都带画像版本，
    // 画像改了，之前的判定就该失效。
    updatedAt: new Date(now).toISOString(),
  };
}

/** 这次反馈实际改了什么（给日志/返回值用）。 */
export interface ProfileFeedbackResult {
  removedTag: string | null;
  addedInterest: string | null;
}

/**
 * 用户手动纠正过的画像项。
 *
 * **为什么要单独记一份**：画像是 LLM 从观看样本归纳出来的，
 * 每 24 小时会重算一遍（ProfileService.getOrRefresh）。
 * 用户点「我喜欢这类」是一次**显式纠正**——
 * 它必须比自动归纳更持久，否则 24 小时后同题材又被折叠，
 * 用户会觉得「我明明说了想看，怎么还在挡」。
 *
 * 所以：纠正单独存，每次归纳完再叠加上去。
 */
export interface ProfileOverrides {
  /** 用户明确表示「别再按这个标签屏蔽我」的标签 */
  removedDislikes: string[];
  /** 用户明确表示「想看这类」的题材标签 */
  addedInterests: string[];
}

export const EMPTY_OVERRIDES: ProfileOverrides = {
  removedDislikes: [],
  addedInterests: [],
};

/**
 * 把纠正叠加到画像上。**纯函数**。
 *
 * 归纳之后调用它，用户的手动纠正就不会被自动归纳顶掉。
 */
export function applyProfileOverrides(
  profile: UserProfile,
  overrides: ProfileOverrides,
): UserProfile {
  if (
    overrides.removedDislikes.length === 0 &&
    overrides.addedInterests.length === 0
  ) {
    return profile;
  }

  const removed = new Set(overrides.removedDislikes.map((t) => t.trim().toLowerCase()));
  const dislikes = profile.dislikes.filter((d) => !removed.has(d.trim().toLowerCase()));
  const topics = profile.topics.filter((t) => !removed.has(t.trim().toLowerCase()));

  const interests = [...profile.interests];
  for (const tag of overrides.addedInterests) {
    const t = tag.trim();
    if (!t) continue;
    const existing = interests.find((i) => i.tag === t);
    if (existing) {
      existing.weight = Math.min(1, Math.max(existing.weight, 0.5));
    } else {
      interests.push({ tag: t, weight: 0.5 });
    }
  }
  interests.sort((a, b) => b.weight - a.weight);

  return { ...profile, interests, dislikes, topics };
}

/**
 * 把一次反馈记进「纠正清单」。
 *
 * 幂等：同一条反馈重复记也不会重复写。
 */
export function recordProfileOverride(
  overrides: ProfileOverrides,
  feedback: ProfileFeedback,
): ProfileOverrides {
  const removedDislikes = [...overrides.removedDislikes];
  const addedInterests = [...overrides.addedInterests];

  const tag = (feedback.matchedTag ?? '').trim();
  if (tag && !removedDislikes.some((t) => t.trim().toLowerCase() === tag.toLowerCase())) {
    removedDislikes.push(tag);
  }

  // 只有视频才算「想看这类」——评论当兴趣没意义（与 applyProfileFeedback 一致）
  if (feedback.kind === 'video' && feedback.text) {
    const interest = deriveInterestTag(feedback.text);
    if (interest && !addedInterests.includes(interest)) {
      addedInterests.push(interest);
    }
  }

  return { removedDislikes, addedInterests };
}

/** 算一下反馈会改什么，但不落库。给调用方做「改了什么」的提示。 */
export function describeProfileFeedback(
  profile: UserProfile,
  feedback: ProfileFeedback,
): ProfileFeedbackResult {
  const matched = (feedback.matchedTag ?? '').trim();
  const matchedKey = matched.toLowerCase();
  const removedTag =
    matchedKey && profile.dislikes.some((d) => d.trim().toLowerCase() === matchedKey)
      ? matched
      : null;

  let addedInterest: string | null = null;
  if (feedback.kind === 'video' && feedback.text) {
    const tag = deriveInterestTag(feedback.text);
    if (tag && !profile.interests.some((i) => i.tag === tag)) addedInterest = tag;
  }

  return { removedTag, addedInterest };
}
