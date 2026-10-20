import type { Mode, UserProfile } from '../shared/types';
import { parseJsonResponse } from '../bg/llm/client';
import { contentKey } from '../shared/hash';
import type { ListContext, Subject, VideoMeta, Wordlist } from './types';
import { subjectId } from './subject';

const MAX_PATTERNS = 60;
const MAX_OPPOSITE = 8;

/**
 * 词表缓存键：语境 id + 画像版本。
 * 画像更新后缓存自然失效（因为判据可能变了）。
 */
export function wordlistCacheKey(subjectKey: string, profileUpdatedAt: string): string {
  return contentKey('wordlist', subjectKey, profileUpdatedAt);
}

/**
 * 生成词表的 prompt（视频页）。
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
    '- **必须是评论里会原样出现的字面表达**（2-6 个字）',
    '- **不要写行为的描述**（如「刷屏」「接龙」「恶作剧」「复读」）——那不是评论里会出现的字面文字，',
    '  拿它做子串匹配永远打不中，等于白筛',
    '- 最多 ' + MAX_PATTERNS + ' 条；宁缺毋滥',
    '',
    'oppositeKeywords 的要求：',
    '- 这些词是用来搜**表达相反观点**的视频的，所以词本身必须**带立场**，',
    '  例如「AI 驳斥末日论」「AI 造福人类」「自动化不会取代人类」',
    '- **不要只给主题词或品类词**（「人工智能」「AI 应用」「数码科技」）——',
    '  那样搜回来的是同主题的内容，不一定相反，筛不出东西',
    '- 想象你要搜到的那个视频标题长什么样，词就照那个标题写',
    '- 最多 ' + MAX_OPPOSITE + ' 条',
  ].join('\n');

  const vParts = [`标题：${video.title}`];
  if (video.description) vParts.push(`简介：${video.description}`);
  if (video.summary) vParts.push(`内容摘要：${video.summary}`);

  const user = [
    '【视频】',
    ...vParts,
    ...commentSampleLines(video.samples),
    '',
    '【用户画像】',
    ...profileLines(profile),
    '',
    '【本次要找什么】',
    modeHint(mode),
  ].join('\n');

  return { system, user };
}

/**
 * 评论区样本段。
 *
 * 有样本时模型能写出**评论里真的会出现的字面表达**；
 * 没有样本时它只能凭空描述行为（「刷屏」「接龙」），
 * 那种词拿去做子串匹配永远打不中，粗筛就废了。
 */
function commentSampleLines(samples: string[] | undefined): string[] {
  if (!samples || samples.length === 0) return [];
  return [
    '',
    '【评论区样本】',
    ...samples.map((s, i) => `${i + 1}. ${s}`),
    '（判据要能从上面这些评论的字面用词里找到或合理推衍，',
    ' 写成评论里会原样出现的短词，不要描述行为）',
  ];
}

/**
 * 生成词表的 prompt（列表页）。
 *
 * 和视频页的**关键差异**：判据要出现在**视频标题**里，不是评论里。
 * 照搬视频页那套（「可能出现在评论里」）会让模型产出
 * 「楼主」「UP主说」这种标题里根本不存在的模式 → 粗筛永不命中 →
 * 列表页又变成全部放行。这个坑必须在这里堵死。
 */
export function buildListWordlistPrompt(
  list: ListContext,
  profile: UserProfile | null,
  mode: Mode,
): { system: string; user: string } {
  const isAnti = mode === 'anti';

  const system = [
    '你是一个内容审核与立场分析器。输入是 B 站一个列表页（搜索结果或推荐流）里的若干条视频标题，以及用户的偏好画像。',
    '请输出严格的 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{',
    '  "stance": "这批视频的整体倾向，一句话；无明显倾向则空串",',
    '  "patterns": ["可能出现在视频标题里、值得进一步细查的表达模式"],',
    '  "oppositeKeywords": ["对立视角的搜索词，用于检索表达相反观点的视频"]',
    '}',
    '',
    'patterns 的要求：',
    '- 这些是**会出现在视频标题里**的具体表达，不是通用词表，也不是评论用语',
    isAnti
      ? '- 包含两类：(a) 引战/挑起仇恨的标题；(b) 表达与用户立场相反的标题'
      : '- 包含两类：(a) 引战/挑起仇恨的标题；(b) 用户大概率不感兴趣的标题',
    '- 每条是具体的词或短语（2-8 个字），不要写抽象类别',
    '- **必须带立场或情绪**：质疑、贬损、嘲讽、反问、给某个群体贴标签',
    '- **不要用话题标签**（#干货分享、#好物推荐、#数码科技 这类）——它们几乎每条标题都有，命中等于没筛',
    '- **不要用主题词本身**（页面主题里的那个词）——它也出现在每一条标题里',
    '- **不要用纯功能词/品类词/促销词**（全新正品、四大区别、真机上手、618 促销）——它们不带立场，命中只是噪声',
    '- **自检**：一条判据如果会命中上面列出的标题里 1/3 以上，就换一条',
    '- 最多 ' + MAX_PATTERNS + ' 条；宁缺毋滥，宁可漏判不要误判',
    '',
    'oppositeKeywords 的要求：',
    '- 这些词是用来搜**表达相反观点**的视频的，所以词本身必须**带立场**，',
    '  例如「AI 造福人类」「AI 不会取代工作」「AI 风险被夸大」',
    '- **不要只给主题词或品类词**（「人工智能」「手机推荐」「数码科技」）——',
    '  那样搜回来的是同主题的内容，不一定相反，筛不出东西',
    '- 想象你要搜到的那个视频标题长什么样，词就照那个标题写',
    '- 最多 ' + MAX_OPPOSITE + ' 条',
  ].join('\n');

  const sampleLines = list.samples.map((s, i) => `${i + 1}. ${s}`);

  const user = [
    '【本页主题】',
    list.title,
    '',
    '【本页视频标题（抽样）】',
    ...sampleLines,
    '',
    '【用户画像】',
    ...profileLines(profile),
    '',
    '【本次要找什么】',
    modeHint(mode),
  ].join('\n');

  return { system, user };
}

/** 按语境类型选对应的 prompt。 */
export function buildSubjectPrompt(
  subject: Subject,
  profile: UserProfile | null,
  mode: Mode,
): { system: string; user: string } {
  return subject.kind === 'video'
    ? buildWordlistPrompt(subject.video, profile, mode)
    : buildListWordlistPrompt(subject.list, profile, mode);
}

/** 画像段。画像为空时明说「没有画像」，别让模型自己脑补一个。 */
function profileLines(profile: UserProfile | null): string[] {
  if (!profile) return ['（暂无用户画像，按通用标准判断引战即可）'];
  const lines: string[] = [];
  if (profile.interests.length) {
    lines.push('用户感兴趣：' + profile.interests.map((i) => i.tag).join('、'));
  }
  if (profile.dislikes.length) {
    lines.push('用户不喜欢：' + profile.dislikes.join('、'));
  }
  if (Object.keys(profile.stanceHints).length) {
    lines.push(
      '用户立场倾向：' +
        Object.entries(profile.stanceHints).map(([k, v]) => `${k}=${v}`).join('、'),
    );
  }
  return lines.length ? lines : ['（暂无用户画像，按通用标准判断引战即可）'];
}

/**
 * 本次要找什么。
 *
 * **同时写进 system 和 user**：user 才是模型真正读的那一段，
 * 只写在 system 里，模型经常忽略。
 */
function modeHint(mode: Mode): string {
  return mode === 'anti'
    ? '本次要找的是两类内容：(a) 引战/挑起仇恨的表达；(b) 与用户立场相反的观点的表达。'
    : '本次要找的是两类内容：(a) 引战/挑起仇恨的表达；(b) 用户大概率不喜欢的表达。';
}

/**
 * 兜底词表：空模式 = 全部放行。LLM 不可用时用这个，保证不误伤。
 *
 * 兜底与模式无关——两种模式下「判不了」都意味着「全放行」，
 * 所以这里不接 mode 参数。
 */
export function buildFallbackWordlist(subject: Subject): Wordlist {
  return {
    patterns: [],
    stance: '',
    oppositeKeywords: [],
    cacheKey: wordlistCacheKey(subjectId(subject), ''),
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
