import type { Mode, UserProfile } from '../shared/types';
import { parseJsonResponse } from '../bg/llm/client';
import { contentKey } from '../shared/hash';
import type { VideoMeta, Wordlist } from './types';

const MAX_PATTERNS = 60;
const MAX_OPPOSITE = 8;

/**
 * 词表缓存键：视频 id + 画像版本。
 * 画像更新后缓存自然失效（因为判据可能变了）。
 */
export function wordlistCacheKey(videoId: string, profileUpdatedAt: string): string {
  return contentKey('wordlist', videoId, profileUpdatedAt);
}

/**
 * 生成词表的 prompt。
 *
 * **一次调用同时干三件事**（这是成本控制的关键）：
 * 1. 抽取本视频的立场
 * 2. 产出判据词表（用于粗筛）
 * 3. 产出对立检索词（用于反向推荐）
 *
 * 如果拆成三次调用，每个视频要多花两倍的钱。
 */
export function buildWordlistPrompt(
  video: VideoMeta,
  profile: UserProfile | null,
  mode: Mode,
): { system: string; user: string } {
  const isAnti = mode === 'anti';

  const system = [
    '你是一个内容审核与立场分析器。输入是一个 B 站视频的元信息，以及用户的偏好画像。',
    '请输出严格的 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{',
    '  "stance": "该视频的核心立场，一句话；无立场则空串",',
    '  "patterns": ["可能出现在评论里、值得进一步细查的表达模式"],',
    '  "oppositeKeywords": ["对立视角的搜索词，用于检索表达相反观点的视频"]',
    '}',
    '',
    'patterns 的要求：',
    '- 这些是**该视频语境下**可能出现的具体表达，不是通用词表',
    isAnti
      ? '- 包含两类：(a) 引战/挑起仇恨的表达；(b) 表达与用户立场相反的观点的表达'
      : '- 包含两类：(a) 引战/挑起仇恨的表达；(b) 用户大概率不喜欢的表达',
    '- 每条是具体的词或短语，不要写抽象类别',
    '- 最多 ' + MAX_PATTERNS + ' 条；宁缺毋滥',
    '',
    'oppositeKeywords 的要求：',
    '- 用于在 B 站搜索相反观点的视频，所以要是**能拿去搜的关键词**',
    '- 最多 ' + MAX_OPPOSITE + ' 条',
  ].join('\n');

  const vParts = [`标题：${video.title}`];
  if (video.description) vParts.push(`简介：${video.description}`);
  if (video.summary) vParts.push(`内容摘要：${video.summary}`);

  const pParts: string[] = [];
  if (profile) {
    if (profile.interests.length) {
      pParts.push('用户感兴趣：' + profile.interests.map((i) => i.tag).join('、'));
    }
    if (profile.dislikes.length) {
      pParts.push('用户不喜欢：' + profile.dislikes.join('、'));
    }
    if (Object.keys(profile.stanceHints).length) {
      pParts.push(
        '用户立场倾向：' +
        Object.entries(profile.stanceHints).map(([k, v]) => `${k}=${v}`).join('、'),
      );
    }
  } else {
    pParts.push('（暂无用户画像，按通用标准判断引战即可）');
  }

  // 模式要求同时写进 user：user 才是模型真正读的那一段，
  // 只写在 system 里，模型经常忽略。
  const modeHint = isAnti
    ? '本次要找的是两类内容：(a) 引战/挑起仇恨的表达；(b) 与用户立场相反的观点的表达。'
    : '本次要找的是两类内容：(a) 引战/挑起仇恨的表达；(b) 用户大概率不喜欢的表达。';

  const user = [
    '【视频】',
    ...vParts,
    '',
    '【用户画像】',
    ...pParts,
    '',
    '【本次要找什么】',
    modeHint,
  ].join('\n');

  return { system, user };
}

/** 兜底词表：空模式 = 全部放行。LLM 不可用时用这个，保证不误伤。 */
export function buildFallbackWordlist(video: VideoMeta, mode: Mode): Wordlist {
  return {
    patterns: [],
    stance: '',
    oppositeKeywords: [],
    cacheKey: wordlistCacheKey(video.bvid ?? '', ''),
  };
}

/** 解析 LLM 输出，失败回落到兜底词表。 */
export function parseWordlist(raw: string, fallback: Wordlist): Wordlist {
  const parsed = parseJsonResponse<Partial<Wordlist>>(raw);
  if (!parsed || typeof parsed !== 'object') return fallback;

  const patterns = Array.isArray(parsed.patterns)
    ? parsed.patterns
        .filter((p): p is string => typeof p === 'string')
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
        .slice(0, MAX_PATTERNS)
    : fallback.patterns;

  const oppositeKeywords = Array.isArray(parsed.oppositeKeywords)
    ? parsed.oppositeKeywords
        .filter((k): k is string => typeof k === 'string')
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .slice(0, MAX_OPPOSITE)
    : fallback.oppositeKeywords;

  const stance =
    typeof parsed.stance === 'string' ? parsed.stance.trim() : fallback.stance;

  return { patterns, stance, oppositeKeywords, cacheKey: fallback.cacheKey };
}
