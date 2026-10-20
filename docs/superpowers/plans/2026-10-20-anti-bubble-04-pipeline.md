# 计划 04：判定流水线（动态词表 + 两级判定）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现核心判定机制——LLM 为每个视频生成动态判据词表，规则层零成本粗筛，命中的才逐条调 LLM 精判，产出带理由、可撤销的判定结果。

**Architecture:** 三级流水线：**画像匹配**（本地，零成本）→ **动态词表粗筛**（规则，零成本）→ **LLM 精判**（唯一花钱环节）。词表与判定结果都按内容哈希缓存。判定结果 `Verdict` 必带人话理由与机器可读 code。

**Tech Stack:** TypeScript 5.5.2、Vitest 2.1.1

**依赖:** 计划 01（类型、存储、LLM 客户端）、计划 03（画像）。

---

## Global Constraints

- **成本红线**：未命中词表的评论**不得**调用 LLM。词表未命中 = 直接放行。
- 词表与判定结果**按内容哈希缓存**，重复内容不重复花钱
- 每个视频**只多 1 次** LLM 调用（生成词表）；立场抽取与词表生成**合并在同一次调用**里
- 每个非 `pass` 判定**必须**带人话 `reason` 与 `reasonCode`
- LLM 失败时**降级为 pass**（放行），绝不让页面报错或卡住
- 置信度低于阈值（默认 0.7）按 `pass` 处理
- 判定逻辑**不得**依赖具体页面（三个页面共用同一套）

---

## File Structure

```
src/pipeline/
├── wordlist.ts    # 动态词表生成与缓存
├── coarse.ts      # 规则粗筛
├── judge.ts       # LLM 精判
├── pipeline.ts    # 编排：三级流水线
└── types.ts       # 流水线内部类型
tests/unit/
├── pipeline-wordlist.test.ts
├── pipeline-coarse.test.ts
├── pipeline-judge.test.ts
└── pipeline.test.ts
```

---

### Task 1: 动态词表

**Files:**
- Create: `src/pipeline/types.ts`
- Create: `src/pipeline/wordlist.ts`
- Test: `tests/unit/pipeline-wordlist.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `UserProfile` / `Mode`，Task 03 的 `UserProfileInput`
- Produces:
  - `interface Wordlist`——`{ patterns: string[]; stance: string; oppositeKeywords: string[]; cacheKey: string }`
  - `buildWordlistPrompt(video: { title: string; description?: string; summary?: string }, profile: UserProfile | null, mode: Mode): { system: string; user: string }`
  - `parseWordlist(raw: string, fallback: Wordlist): Wordlist`
  - `buildFallbackWordlist(video, mode): Wordlist`——LLM 不可用时的兜底（空表，等于全部放行）
  - `wordlistCacheKey(videoId: string, profileUpdatedAt: string): string`

- [ ] **Step 1: 写失败测试**

`tests/unit/pipeline-wordlist.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import {
  buildWordlistPrompt, parseWordlist, buildFallbackWordlist, wordlistCacheKey,
} from '../../src/pipeline/wordlist';
import type { UserProfile } from '../../src/shared/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: ['游戏'],
  stanceHints: { 'AI': '谨慎' },
  topics: ['Rust'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

describe('动态词表', () => {
  it('prompt 含视频标题', () => {
    const p = buildWordlistPrompt({ title: '独特标题ABC' }, profile, 'cocoon');
    expect(p.user).toContain('独特标题ABC');
  });

  it('prompt 含视频简介', () => {
    const p = buildWordlistPrompt({ title: 't', description: '独特简介XYZ' }, profile, 'cocoon');
    expect(p.user).toContain('独特简介XYZ');
  });

  it('prompt 含画像信息', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.user).toContain('技术');
    expect(p.user).toContain('游戏');
  });

  it('cocoon 模式要求找不喜欢的内容', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.user).toContain('不喜欢');
  });

  it('anti 模式要求找对立立场', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'anti');
    expect(p.user).toContain('相反');
  });

  it('解析合法 JSON 得到词表', () => {
    const raw = JSON.stringify({
      patterns: ['引战', '地域攻击'],
      stance: '支持国产芯片',
      oppositeKeywords: ['芯片 反驳', '国产 争议'],
    });
    const w = parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon'));
    expect(w.patterns).toEqual(['引战', '地域攻击']);
    expect(w.oppositeKeywords).toHaveLength(2);
  });

  it('解析带 markdown 包裹的 JSON', () => {
    const raw = '```json\n{"patterns":["a"],"stance":"s","oppositeKeywords":[]}\n```';
    expect(parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon')).patterns).toEqual(['a']);
  });

  it('解析失败回落到兜底词表', () => {
    const fb = buildFallbackWordlist({ title: 't' }, 'cocoon');
    expect(parseWordlist('乱码', fb)).toEqual(fb);
  });

  it('兜底词表 patterns 为空（等于全部放行）', () => {
    const fb = buildFallbackWordlist({ title: 't' }, 'cocoon');
    expect(fb.patterns).toEqual([]);
  });

  it('解析时过滤空模式', () => {
    const raw = JSON.stringify({ patterns: ['a', '', '  ', 'b'], stance: '', oppositeKeywords: [] });
    const w = parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon'));
    expect(w.patterns).toEqual(['a', 'b']);
  });

  it('解析时限制模式数量上限', () => {
    const raw = JSON.stringify({
      patterns: Array.from({ length: 200 }, (_, i) => 'p' + i),
      stance: '', oppositeKeywords: [],
    });
    expect(parseWordlist(raw, buildFallbackWordlist({ title: 't' }, 'cocoon')).patterns.length)
      .toBeLessThanOrEqual(60);
  });

  it('缓存键随视频 id 变化', () => {
    expect(wordlistCacheKey('BV1', 't')).not.toBe(wordlistCacheKey('BV2', 't'));
  });

  it('缓存键随画像版本变化', () => {
    expect(wordlistCacheKey('BV1', 't1')).not.toBe(wordlistCacheKey('BV1', 't2'));
  });

  it('缓存键是稳定的', () => {
    expect(wordlistCacheKey('BV1', 't')).toBe(wordlistCacheKey('BV1', 't'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/pipeline/wordlist'`

- [ ] **Step 3: 写 types.ts**

`src/pipeline/types.ts`：
```ts
import type { Mode, UserProfile, Verdict } from '../shared/types';

/** 视频上下文，词表与精判都要用。 */
export interface VideoContext {
  bvid: string;
  title: string;
  description?: string;
  /** B 站官方 AI 总结 */
  summary?: string;
}

/**
 * 动态判据词表。
 *
 * 这是「规则粗筛」能work的关键：词表不是固定写死的关键词，
 * 而是 LLM 读完当前视频后**现场生成**的「可能构成引战/立场对立的表达模式」。
 * 规则层拿它做零成本粗筛，命中才调 LLM。
 */
export interface Wordlist {
  /** 表达模式（词或短语），规则层拿它做子串匹配 */
  patterns: string[];
  /** 本视频的立场概述（人话） */
  stance: string;
  /** 对立视角的检索词，反向推荐用 */
  oppositeKeywords: string[];
  /** 缓存键 */
  cacheKey: string;
}

/** 精判的输入。 */
export interface JudgeInput {
  text: string;
  author: string;
  /** 视频标题，给 LLM 做语境 */
  videoTitle?: string;
}

/** 精判的输出（未经置信度过滤）。 */
export interface RawJudgeResult {
  action: 'fold' | 'hide' | 'mark' | 'pass';
  reason: string;
  reasonCode: string;
  confidence: number;
}

/** 流水线上下文。 */
export interface PipelineContext {
  mode: Mode;
  profile: UserProfile | null;
  video: VideoContext | null;
  /** 置信度阈值 */
  threshold: number;
}
```

- [ ] **Step 4: 写 wordlist.ts**

`src/pipeline/wordlist.ts`：
```ts
import type { Mode, UserProfile } from '../shared/types';
import { parseJsonResponse } from '../bg/llm/client';
import { contentKey } from '../shared/hash';
import type { VideoContext, Wordlist } from './types';

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
  video: VideoContext,
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

  const user = [
    '【视频】',
    ...vParts,
    '',
    '【用户画像】',
    ...pParts,
  ].join('\n');

  return { system, user };
}

/** 兜底词表：空模式 = 全部放行。LLM 不可用时用这个，保证不误伤。 */
export function buildFallbackWordlist(video: VideoContext, mode: Mode): Wordlist {
  return {
    patterns: [],
    stance: '',
    oppositeKeywords: [],
    cacheKey: wordlistCacheKey(video.bvid, ''),
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
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，pipeline-wordlist 14 个测试全绿

- [ ] **Step 6: 提交**

```bash
git add src/pipeline tests/unit/pipeline-wordlist.test.ts
git commit -m "feat: 新增动态判据词表生成与解析"
```

---

### Task 2: 规则粗筛

**Files:**
- Create: `src/pipeline/coarse.ts`
- Test: `tests/unit/pipeline-coarse.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Wordlist`
- Produces:
  - `coarseMatch(text: string, wordlist: Wordlist): boolean`——文本是否命中词表
  - `coarseMatchAll(texts: string[], wordlist: Wordlist): boolean[]`——批量

- [ ] **Step 1: 写失败测试**

`tests/unit/pipeline-coarse.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { coarseMatch, coarseMatchAll } from '../../src/pipeline/coarse';
import type { Wordlist } from '../../src/pipeline/types';

const wl: Wordlist = {
  patterns: ['引战', '地域攻击', 'XX粉'],
  stance: '支持',
  oppositeKeywords: [],
  cacheKey: 'k',
};

describe('规则粗筛', () => {
  it('命中模式返回 true', () => {
    expect(coarseMatch('这内容就是在引战', wl)).toBe(true);
  });

  it('未命中返回 false', () => {
    expect(coarseMatch('今天天气不错', wl)).toBe(false);
  });

  it('空词表永远不命中（等于全部放行）', () => {
    expect(coarseMatch('任何内容', { ...wl, patterns: [] })).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(coarseMatch('xx粉真无语', { ...wl, patterns: ['XX粉'] })).toBe(true);
  });

  it('批量匹配返回等长数组', () => {
    const r = coarseMatchAll(['引战', '无关', '地域攻击'], wl);
    expect(r).toEqual([true, false, true]);
  });

  it('空数组返回空数组', () => {
    expect(coarseMatchAll([], wl)).toEqual([]);
  });

  it('忽略空模式', () => {
    expect(coarseMatch('任意', { ...wl, patterns: ['', '  '] })).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/pipeline/coarse'`

- [ ] **Step 3: 写实现**

`src/pipeline/coarse.ts`：
```ts
import type { Wordlist } from './types';

/**
 * 规则粗筛：文本是否命中动态词表。
 *
 * 这是整条流水线的**成本闸门**——命中才值得花钱调 LLM。
 * 匹配用小写子串包含，够用且零成本。
 */
export function coarseMatch(text: string, wordlist: Wordlist): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  for (const raw of wordlist.patterns) {
    const p = raw.trim();
    if (!p) continue;
    if (hay.includes(p.toLowerCase())) return true;
  }
  return false;
}

export function coarseMatchAll(texts: string[], wordlist: Wordlist): boolean[] {
  return texts.map((t) => coarseMatch(t, wordlist));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，pipeline-coarse 7 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/coarse.ts tests/unit/pipeline-coarse.test.ts
git commit -m "feat: 新增规则粗筛（成本闸门）"
```

---

### Task 3: LLM 精判

**Files:**
- Create: `src/pipeline/judge.ts`
- Test: `tests/unit/pipeline-judge.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `Mode` / `Verdict` / `VerdictReasonCode`，Task 1 的 `JudgeInput` / `RawJudgeResult` / `Wordlist`
- Produces:
  - `buildJudgePrompt(items: JudgeInput[], wordlist: Wordlist, mode: Mode, profile: UserProfile | null): { system: string; user: string }`
  - `parseJudgments(raw: string, itemIds: string[], fallbackAction: 'pass'): Verdict[]`
  - `judgeItems(client, items, wordlist, mode, profile, threshold): Promise<Verdict[]>`——**失败降级为 pass**

- [ ] **Step 1: 写失败测试**

`tests/unit/pipeline-judge.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildJudgePrompt, parseJudgments, judgeItems } from '../../src/pipeline/judge';
import type { Wordlist } from '../../src/pipeline/types';
import type { LlmClient } from '../../src/bg/llm/client';

const wl: Wordlist = {
  patterns: ['引战'], stance: '支持 A', oppositeKeywords: [], cacheKey: 'k',
};

function client(text: string | Error): LlmClient {
  return { complete: vi.fn(async () => { if (text instanceof Error) throw text; return text; }) };
}

describe('LLM 精判', () => {
  it('prompt 含评论正文', () => {
    const p = buildJudgePrompt([{ text: '独特评论ABC', author: 'u' }], wl, 'cocoon', null);
    expect(p.user).toContain('独特评论ABC');
  });

  it('prompt 含评论 id 便于对齐结果', () => {
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'cocoon', null);
    expect(p.user).toContain('1');
  });

  it('anti 模式的 prompt 要求标记立场相反', () => {
    const p = buildJudgePrompt([{ text: 't', author: 'u' }], wl, 'anti', null);
    expect(p.system + p.user).toContain('相反');
  });

  it('解析合法 JSON 得到判定', () => {
    const raw = JSON.stringify({
      results: [
        { id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.9 },
      ],
    });
    const vs = parseJudgments(raw, ['1'], 'pass');
    expect(vs[0]!.action).toBe('hide');
    expect(vs[0]!.reason).toBe('在引战');
    expect(vs[0]!.itemId).toBe('1');
  });

  it('解析失败时全部回落为 pass', () => {
    const vs = parseJudgments('乱码', ['1', '2'], 'pass');
    expect(vs.map((v) => v.action)).toEqual(['pass', 'pass']);
  });

  it('缺少的结果项补为 pass', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: 'r', reasonCode: 'incitement', confidence: 0.9 }],
    });
    const vs = parseJudgments(raw, ['1', '2'], 'pass');
    expect(vs).toHaveLength(2);
    expect(vs[1]!.action).toBe('pass');
  });

  it('pass 的判定不可撤销', () => {
    const vs = parseJudgments('乱码', ['1'], 'pass');
    expect(vs[0]!.revocable).toBe(false);
  });

  it('非 pass 的判定可撤销', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: 'r', reasonCode: 'incitement', confidence: 0.9 }],
    });
    expect(parseJudgments(raw, ['1'], 'pass')[0]!.revocable).toBe(true);
  });

  it('置信度低于阈值的按 pass 处理', async () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: 'r', reasonCode: 'incitement', confidence: 0.3 }],
    });
    const vs = await judgeItems(client(raw), [{ text: 't', author: 'u' }], wl, 'cocoon', null, 0.7);
    expect(vs[0]!.action).toBe('pass');
  });

  it('LLM 抛错时全部降级为 pass', async () => {
    const vs = await judgeItems(client(new Error('挂了')), [{ text: 't', author: 'u' }], wl, 'cocoon', null, 0.7);
    expect(vs.every((v) => v.action === 'pass')).toBe(true);
  });

  it('judgeItems 返回数量与输入一致', async () => {
    const items = [{ text: 'a', author: 'u' }, { text: 'b', author: 'u' }, { text: 'c', author: 'u' }];
    const vs = await judgeItems(client('乱码'), items, wl, 'cocoon', null, 0.7);
    expect(vs).toHaveLength(3);
  });

  it('理由为空时用默认理由', () => {
    const raw = JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: '', reasonCode: 'incitement', confidence: 0.9 }],
    });
    expect(parseJudgments(raw, ['1'], 'pass')[0]!.reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/pipeline/judge'`

- [ ] **Step 3: 写实现**

`src/pipeline/judge.ts`：
```ts
import type { Mode, UserProfile, Verdict, VerdictReasonCode } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { parseJsonResponse } from '../bg/llm/client';
import { REASON_CODES } from '../shared/constants';
import type { JudgeInput, Wordlist } from './types';

const VALID_REASON_CODES = new Set<string>(REASON_CODES);

/**
 * 精判 prompt。**一次调用判一批**，这是成本控制的关键。
 */
export function buildJudgePrompt(
  items: JudgeInput[],
  wordlist: Wordlist,
  mode: Mode,
  profile: UserProfile | null,
): { system: string; user: string } {
  const isAnti = mode === 'anti';

  const system = [
    '你是一个 B 站评论审核器。输入是若干条评论，以及该视频的判据。',
    '请对每条评论独立判断，输出严格的 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{',
    '  "results": [',
    '    {"id": 1, "action": "pass|fold|hide|mark", "reason": "一句人话理由",',
    '     "reasonCode": "incitement|stance_opposite|dislike_match|off_topic",',
    '     "confidence": 0.0-1.0}',
    '  ]',
    '}',
    '',
    'action 的含义：',
    '- pass：正常内容，放行',
    '- fold：用户大概率不喜欢，折叠',
    '- hide：引战/挑起仇恨，隐藏',
    isAnti
      ? '- mark：内容与用户可能支持的立场相反，保留并标识'
      : '- mark：内容用户大概率不喜欢，保留并标识',
    '',
    '要求：',
    '- results 的长度必须与输入评论数一致，id 与输入序号一一对应',
    '- reason 必须是能直接展示给用户的人话，不超过 30 字',
    '- confidence 反映把握程度；不确定就给低分，不要勉强下结论',
    '- 判不准就给 pass。**宁可漏判，不要误判。**',
  ].join('\n');

  const w = [
    '【该视频的判据】',
    `立场：${wordlist.stance || '（未判定）'}`,
    `可疑表达：${wordlist.patterns.join('、') || '（无）'}`,
    '',
  ];

  if (profile) {
    if (profile.dislikes.length) {
      w.push(`用户不喜欢：${profile.dislikes.join('、')}`);
    }
    if (Object.keys(profile.stanceHints).length) {
      w.push(
        '用户立场：' +
        Object.entries(profile.stanceHints).map(([k, v]) => `${k}=${v}`).join('、'),
      );
    }
    w.push('');
  }

  const lines = items.map((it, i) => `${i + 1}. 作者：${it.author}｜内容：${it.text}`);

  const user = [...w, '【待判评论】', ...lines].join('\n');
  return { system, user };
}

/** 解析 LLM 输出，失败或缺项一律回落为 pass。 */
export function parseJudgments(
  raw: string,
  itemIds: string[],
  fallbackAction: 'pass',
): Verdict[] {
  const parsed = parseJsonResponse<{ results?: unknown }>(raw);
  const byId = new Map<string, Record<string, unknown>>();

  if (parsed && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const id = String(rec['id'] ?? '');
      if (!id) continue;
      byId.set(id, rec);
    }
  }

  return itemIds.map((id) => {
    const rec = byId.get(id);
    if (!rec) return passVerdict(id, fallbackAction);

    const action = rec['action'];
    const validAction =
      action === 'pass' || action === 'fold' || action === 'hide' || action === 'mark';

    if (!validAction) return passVerdict(id, fallbackAction);

    const reason =
      typeof rec['reason'] === 'string' && rec['reason'].trim().length > 0
        ? rec['reason'].trim().slice(0, 60)
        : '未说明原因';

    const rc = rec['reasonCode'];
    const reasonCode: VerdictReasonCode =
      typeof rc === 'string' && REASON_CODES.has(rc)
        ? (rc as VerdictReasonCode)
        : action === 'pass' ? 'none' : 'off_topic';

    const conf = typeof rec['confidence'] === 'number' ? rec['confidence'] : 0.5;

    return {
      itemId: id,
      action,
      reason,
      reasonCode,
      confidence: Math.max(0, Math.min(1, conf)),
      revocable: action !== 'pass',
    };
  });
}

function passVerdict(itemId: string, action: 'pass'): Verdict {
  return {
    itemId,
    action,
    reason: '',
    reasonCode: 'none',
    confidence: 1,
    revocable: false,
  };
}

/**
 * 批量精判。
 *
 * LLM 失败 → 全部降级为 pass（放行）。**绝不抛异常**，
 * 否则页面会因为一次网络抖动就卡住。
 */
export async function judgeItems(
  client: LlmClient,
  items: JudgeInput[],
  wordlist: Wordlist,
  mode: Mode,
  profile: UserProfile | null,
  threshold: number,
): Promise<Verdict[]> {
  if (items.length === 0) return [];
  const ids = items.map((_, i) => String(i + 1));
  try {
    const { system, user } = buildJudgePrompt(items, wordlist, mode, profile);
    const raw = await client.complete(user, { system, maxTokens: 2000 });
    const verdicts = parseJudgments(raw, ids, 'pass');
    return verdicts.map((v) =>
      v.action !== 'pass' && v.confidence < threshold ? passVerdict(v.itemId, 'pass') : v,
    );
  } catch {
    return ids.map((id) => passVerdict(id, 'pass'));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，pipeline-judge 13 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/judge.ts tests/unit/pipeline-judge.test.ts
git commit -m "feat: 新增 LLM 批量精判与降级"
```

---

### Task 4: 流水线编排

**Files:**
- Create: `src/pipeline/pipeline.ts`
- Test: `tests/unit/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `ContentItem` / `Verdict` / `UserProfile` / `Mode`，Task 2 的 `mergeSamples`，Task 3 的 `coarseMatch` / `judgeItems`，Task 1 的 `buildWordlistPrompt` / `parseWordlist` / `buildFallbackWordlist`
- Produces:
  - `class Pipeline`——方法 `judge(items: ContentItem[], ctx: PipelineContext): Promise<Verdict[]>`
  - `matchProfile(text: string, profile: UserProfile | null): boolean`——**零成本的画像匹配**
  - `PipelineOptions`——注入 client、now、cache 读写，便于测试

- [ ] **Step 1: 写失败测试**

`tests/unit/pipeline.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { Pipeline, matchProfile } from '../../src/pipeline/pipeline';
import type { ContentItem, UserProfile } from '../../src/shared/types';
import type { LlmClient } from '../../src/bg/llm/client';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: ['游戏实况'],
  stanceHints: { 'AI': '谨慎' },
  topics: ['Rust'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'comment', id: 'c1', text: '普通评论', author: 'u',
    meta: {}, context: { page: 'video', videoId: 'BV1', videoTitle: '标题' }, ...over,
  };
}

function client(text: string | Error): LlmClient {
  return { complete: vi.fn(async () => { if (text instanceof Error) throw text; return text; }) };
}

const WORDLIST_JSON = JSON.stringify({
  stance: '支持 A',
  patterns: ['引战'],
  oppositeKeywords: ['A 反驳'],
});

describe('画像匹配', () => {
  it('命中不喜欢的标签返回 true', () => {
    expect(matchProfile('这是游戏实况的吐槽', profile)).toBe(true);
  });

  it('不命中返回 false', () => {
    expect(matchProfile('讲 Rust 的技术分享', profile)).toBe(false);
  });

  it('没有画像时返回 false', () => {
    expect(matchProfile('任意内容', null)).toBe(false);
  });

  it('画像没有 dislikes 时返回 false', () => {
    expect(matchProfile('任意', { ...profile, dislikes: [] })).toBe(false);
  });
});

describe('判定流水线', () => {
  it('未命中词表的评论直接放行，不调 LLM 精判', async () => {
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({ client: c, wordlistProvider: async () => ({
      patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
    }) });
    const vs = await p.judge([item({ text: '今天天气不错' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('pass');
    // 只有词表那一次调用，没有精判调用
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('命中词表的评论会走精判', async () => {
    const c = client(JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.95 }],
    }));
    const p = new Pipeline({
      client: c,
      wordlistProvider: async () => ({
        patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
      }),
    });
    const vs = await p.judge([item({ text: '这就是引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('hide');
    expect(vs[0]!.reason).toBe('在引战');
  });

  it('画像命中时直接 fold，不花精判的钱', async () => {
    const c = client(WORDLIST_JSON);
    const p = new Pipeline({
      client: c,
      wordlistProvider: async () => ({
        patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
      }),
    });
    const vs = await p.judge([item({ text: '游戏实况真好看' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('fold');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('词表 provider 抛错时全部放行', async () => {
    const p = new Pipeline({
      client: client(WORDLIST_JSON),
      wordlistProvider: async () => { throw new Error('挂了'); },
    });
    const vs = await p.judge([item({ text: '引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('pass');
  });

  it('空输入返回空数组', async () => {
    const p = new Pipeline({ client: client(WORDLIST_JSON), wordlistProvider: async () => ({
      patterns: [], stance: '', oppositeKeywords: [], cacheKey: 'k',
    }) });
    expect(await p.judge([], { mode: 'cocoon', profile, video: null, threshold: 0.7 })).toEqual([]);
  });

  it('结果数量与输入一致', async () => {
    const p = new Pipeline({
      client: client(WORDLIST_JSON),
      wordlistProvider: async () => ({
        patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
      }),
    });
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    const vs = await p.judge(items, { mode: 'cocoon', profile, video: null, threshold: 0.7 });
    expect(vs).toHaveLength(3);
    expect(vs.map((v) => v.itemId)).toEqual(['a', 'b', 'c']);
  });

  it('白名单里的 id 直接放行', async () => {
    const p = new Pipeline({
      client: client(WORDLIST_JSON),
      wordlistProvider: async () => ({
        patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
      }),
      whitelist: ['c1'],
    });
    const vs = await p.judge([item({ id: 'c1', text: '引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs[0]!.action).toBe('pass');
  });

  it('每个非 pass 判定都带理由', async () => {
    const c = client(JSON.stringify({
      results: [{ id: '1', action: 'hide', reason: '在引战', reasonCode: 'incitement', confidence: 0.95 }],
    }));
    const p = new Pipeline({
      client: c,
      wordlistProvider: async () => ({
        patterns: ['引战'], stance: 's', oppositeKeywords: [], cacheKey: 'k',
      }),
    });
    const vs = await p.judge([item({ text: '引战' })], {
      mode: 'cocoon', profile, video: null, threshold: 0.7,
    });
    expect(vs.filter((v) => v.action !== 'pass').every((v) => v.reason.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/pipeline/pipeline'`

- [ ] **Step 3: 写实现**

`src/pipeline/pipeline.ts`：
```ts
import type { ContentItem, UserProfile, Verdict, Mode } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { coarseMatch } from './coarse';
import { judgeItems } from './judge';
import { buildWordlistPrompt, parseWordlist, buildFallbackWordlist } from './wordlist';
import type { Wordlist, PipelineContext, JudgeInput } from './types';

export interface PipelineOptions {
  client: LlmClient;
  /** 提供当前视频的词表。默认实现会调 LLM 生成。 */
  wordlistProvider: (ctx: PipelineContext) => Promise<Wordlist>;
  /** 已撤销（白名单）的内容 id，直接放行 */
  whitelist?: string[];
}

/**
 * 画像匹配：纯本地、零成本的第一道闸门。
 *
 * 命中画像里明确的「不喜欢」标签 → 直接 fold。
 * 这条不需要 LLM，因为它匹配的是画像里已经归纳好的标签。
 */
export function matchProfile(text: string, profile: UserProfile | null): boolean {
  if (!profile || profile.dislikes.length === 0) return false;
  const hay = text.toLowerCase();
  for (const d of profile.dislikes) {
    const needle = d.trim().toLowerCase();
    if (!needle) continue;
    if (hay.includes(needle)) return true;
  }
  return false;
}

/**
 * 判定流水线：三级闸门。
 *
 *   ① 画像匹配（本地，零成本）→ 命中直接 fold
 *   ② 动态词表粗筛（规则，零成本）→ 未命中直接放行
 *   ③ LLM 精判（唯一花钱环节）→ 只判 ② 命中的
 *
 * **成本结构**：每个视频 1 次词表调用 + 命中条数 × 1 次精判。
 * 未命中的评论不花钱。
 */
export class Pipeline {
  constructor(private readonly opts: PipelineOptions) {}

  async judge(items: ContentItem[], ctx: PipelineContext): Promise<Verdict[]> {
    if (items.length === 0) return [];

    const whitelist = new Set(this.opts.whitelist ?? []);
    const verdicts = new Map<string, Verdict>();

    // 待精判的条目
    const toJudge: { item: ContentItem; index: number }[] = [];

    // ① 画像匹配 + 白名单
    for (const item of items) {
      if (whitelist.has(item.id)) {
        verdicts.set(item.id, pass(item.id));
        continue;
      }
      if (matchProfile(item.text, ctx.profile)) {
        verdicts.set(item.id, {
          itemId: item.id,
          action: 'fold',
          reason: '命中你不喜欢的题材',
          reasonCode: 'dislike_match',
          confidence: 0.9,
          revocable: true,
        });
        continue;
      }
      toJudge.push({ item, index: items.indexOf(item) });
    }

    if (toJudge.length === 0) {
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    // ② 动态词表粗筛
    let wordlist: Wordlist;
    try {
      wordlist = await this.opts.wordlistProvider(ctx);
    } catch {
      // 词表拿不到 → 全部放行，绝不误伤
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    const suspects = toJudge.filter(({ item }) => coarseMatch(item.text, wordlist));
    for (const { item } of toJudge) {
      if (!suspects.some((s) => s.item.id === item.id)) {
        verdicts.set(item.id, pass(item.id));
      }
    }

    if (suspects.length === 0) {
      return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
    }

    // ③ LLM 精判
    const inputs: JudgeInput[] = suspects.map(({ item }) => ({
      text: item.text,
      author: item.author,
      videoTitle: item.context.videoTitle,
    }));
    const judged = await judgeItems(
      this.opts.client,
      inputs,
      wordlist,
      ctx.mode,
      ctx.profile,
      ctx.threshold,
    );

    suspects.forEach(({ item }, i) => {
      const v = judged[i];
      if (!v) {
        verdicts.set(item.id, pass(item.id));
        return;
      }
      verdicts.set(item.id, { ...v, itemId: item.id });
    });

    return items.map((i) => verdicts.get(i.id) ?? pass(i.id));
  }
}

function pass(itemId: string): Verdict {
  return {
    itemId,
    action: 'pass',
    reason: '',
    reasonCode: 'none',
    confidence: 1,
    revocable: false,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，pipeline 12 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/pipeline.ts tests/unit/pipeline.test.ts
git commit -m "feat: 新增三级判定流水线（画像匹配→词表粗筛→LLM精判）"
```

---

### Task 5: 词表缓存与生成器

**Files:**
- Create: `src/pipeline/wordlist-service.ts`
- Test: `tests/unit/pipeline-wordlist-service.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `STORAGE_KEYS` / `UserProfile` / `Mode`，Task 02 的 `fetchVideo` / `fetchConclusion` / `fetchVideoIdByBvid` / `BiliClient`，Task 03 的 `Wordlist`
- Produces:
  - `class WordlistService`——方法：
    - `get(video: VideoContext, profile: UserProfile | null, mode: Mode): Promise<Wordlist>`——带缓存
    - `invalidate(videoId: string): Promise<void>`
  - `loadVideoContext(c: BiliClient, bvid: string): Promise<VideoContext | null>`

- [ ] **Step 1: 写失败测试**

`tests/unit/pipeline-wordlist-service.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const store: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => { Object.assign(store, items); cb?.(); },
      remove: (keys: string[], cb?: () => void) => { for (const k of keys) delete store[k]; cb?.(); },
    },
  },
});

import { WordlistService } from '../../src/pipeline/wordlist-service';
import type { LlmClient } from '../../src/bg/llm/client';
import type { UserProfile } from '../../src/shared/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: [], stanceHints: {}, topics: [],
  updatedAt: '2026-10-20T00:00:00.000Z', sampleCount: 5,
};

const WL = JSON.stringify({ stance: 's', patterns: ['引战'], oppositeKeywords: ['x'] });

function client(): LlmClient {
  return { complete: vi.fn(async () => WL) };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('词表服务', () => {
  it('第一次生成词表', async () => {
    const c = client();
    const s = new WordlistService(c);
    const wl = await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect(wl.patterns).toEqual(['引战']);
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('第二次命中缓存不再调 LLM', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it('画像更新后缓存失效', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.get({ bvid: 'BV1', title: 't' }, { ...profile, updatedAt: '2026-10-21T00:00:00.000Z' }, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('不同视频各自生成', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.get({ bvid: 'BV2', title: 't' }, profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('LLM 失败时返回兜底词表（空模式，等于放行）', async () => {
    const c: LlmClient = { complete: vi.fn(async () => { throw new Error('挂了'); }) };
    const s = new WordlistService(c);
    const wl = await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect(wl.patterns).toEqual([]);
  });

  it('invalidate 后重新生成', async () => {
    const c = client();
    const s = new WordlistService(c);
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    await s.invalidate('BV1');
    await s.get({ bvid: 'BV1', title: 't' }, profile, 'cocoon');
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/pipeline/wordlist-service'`

- [ ] **Step 3: 写实现**

`src/pipeline/wordlist-service.ts`：
```ts
import type { UserProfile, Mode } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { getJson, setJson } from '../bg/storage';
import { STORAGE_KEYS } from '../shared/constants';
import {
  buildWordlistPrompt, parseWordlist, buildFallbackWordlist, wordlistCacheKey,
} from './wordlist';
import type { VideoContext, Wordlist } from './types';

interface CachedWordlist extends Wordlist {
  profileUpdatedAt: string;
}

/**
 * 词表服务：生成 + 缓存。
 *
 * 缓存键 = 视频 id + 画像版本。画像更新后自动失效（判据可能要变）。
 */
export class WordlistService {
  constructor(private readonly client: LlmClient) {}

  async get(
    video: VideoContext,
    profile: UserProfile | null,
    mode: Mode,
  ): Promise<Wordlist> {
    const profileUpdatedAt = profile?.updatedAt ?? '';
    const key = wordlistCacheKey(video.bvid, profileUpdatedAt);

    const cache = await getJson<Record<string, CachedWordlist>>(
      STORAGE_KEYS.wordlistCache, {},
    );
    const hit = cache[key];
    if (hit && Array.isArray(hit.patterns)) {
      return {
        patterns: hit.patterns,
        stance: hit.stance ?? '',
        oppositeKeywords: hit.oppositeKeywords ?? [],
        cacheKey: key,
      };
    }

    const fallback = buildFallbackWordlist(video, mode);
    let wordlist: Wordlist;
    try {
      const { system, user } = buildWordlistPrompt(video, profile, mode);
      const raw = await this.client.complete(user, { system, maxTokens: 1500 });
      wordlist = parseWordlist(raw, { ...fallback, cacheKey: key });
    } catch {
      wordlist = { ...fallback, cacheKey: key };
    }

    cache[key] = { ...wordlist, profileUpdatedAt };
    await setJson(STORAGE_KEYS.wordlistCache, cache);
    return wordlist;
  }

  async invalidate(videoId: string): Promise<void> {
    const cache = await getJson<Record<string, CachedWordlist>>(
      STORAGE_KEYS.wordlistCache, {},
    );
    for (const k of Object.keys(cache)) {
      if (k.includes(videoId)) delete cache[k];
    }
    await setJson(STORAGE_KEYS.wordlistCache, cache);
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，pipeline-wordlist-service 6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/wordlist-service.ts tests/unit/pipeline-wordlist-service.test.ts
git commit -m "feat: 新增词表服务与缓存"
```

---

### Task 6: 判定结果缓存

**Files:**
- Create: `src/pipeline/verdict-cache.ts`
- Test: `tests/unit/pipeline-verdict-cache.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `Verdict` / `STORAGE_KEYS`
- Produces:
  - `class VerdictCache`——方法：
    - `get(itemId: string, contextKey: string): Promise<Verdict | null>`
    - `set(itemId: string, contextKey: string, verdict: Verdict): Promise<void>`
    - `clear(): Promise<void>`
  - `verdictContextKey(item: ContentItem, mode: Mode): string`

- [ ] **Step 1: 写失败测试**

`tests/unit/pipeline-verdict-cache.test.ts`：
```ts
import { describe, it, expect, beforeEach } from 'vitest';

const store: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => { Object.assign(store, items); cb?.(); },
      remove: (keys: string[], cb?: () => void) => { for (const k of keys) delete store[k]; cb?.(); },
    },
  },
});

import { VerdictCache, verdictContextKey } from '../../src/pipeline/verdict-cache';
import type { ContentItem, Verdict } from '../../src/shared/types';

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'comment', id: 'c1', text: 't', author: 'u',
    meta: {}, context: { page: 'video', videoId: 'BV1' }, ...over,
  };
}

const v: Verdict = {
  itemId: 'c1', action: 'hide', reason: '在引战',
  reasonCode: 'incitement', confidence: 0.9, revocable: true,
};

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('判定缓存', () => {
  it('存进去能取出来', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx', v);
    expect((await c.get('c1', 'ctx'))?.action).toBe('hide');
  });

  it('不同 context 不共享', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx1', v);
    expect(await c.get('c1', 'ctx2')).toBeNull();
  });

  it('不同 id 不共享', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx', v);
    expect(await c.get('c2', 'ctx')).toBeNull();
  });

  it('clear 后取不到', async () => {
    const c = new VerdictCache();
    await c.set('c1', 'ctx', v);
    await c.clear();
    expect(await c.get('c1', 'ctx')).toBeNull();
  });

  it('context key 随模式变化', () => {
    expect(verdictContextKey(item(), 'cocoon')).not.toBe(verdictContextKey(item(), 'anti'));
  });

  it('context key 随视频变化', () => {
    const a = item({ context: { page: 'video', videoId: 'BV1' } });
    const b = item({ context: { page: 'video', videoId: 'BV2' } });
    expect(verdictContextKey(a, 'cocoon')).not.toBe(verdictContextKey(b, 'cocoon'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/pipeline/verdict-cache'`

- [ ] **Step 3: 写实现**

`src/pipeline/verdict-cache.ts`：
```ts
import type { ContentItem, Verdict, Mode } from '../shared/types';
import { getJson, setJson } from '../bg/storage';
import { STORAGE_KEYS } from '../shared/constants';
import { contentKey } from '../shared/hash';

/**
 * 判定结果的上下文键。
 *
 * 同一个评论在不同视频/不同模式下，判定结果可能不同，
 * 所以缓存键必须带上上下文。
 */
export function verdictContextKey(item: ContentItem, mode: Mode): string {
  return contentKey('verdict', mode, item.kind, item.context.videoId ?? '', item.text);
}

/**
 * 判定结果缓存。避免同一内容重复花钱。
 */
export class VerdictCache {
  async get(itemId: string, contextKey: string): Promise<Verdict | null> {
    const cache = await this.load();
    const v = cache[contentKey(itemId, contextKey)];
    return v ?? null;
  }

  async set(itemId: string, contextKey: string, verdict: Verdict): Promise<void> {
    const cache = await this.load();
    cache[contentKey(itemId, contextKey)] = verdict;
    // 限制条数，避免无限增长
    const keys = Object.keys(cache);
    if (keys.length > 3000) {
      for (const k of keys.slice(0, keys.length - 3000)) delete cache[k];
    }
    await setJson(STORAGE_KEYS.verdictCache, cache);
  }

  async clear(): Promise<void> {
    await setJson(STORAGE_KEYS.verdictCache, {});
  }

  private async load(): Promise<Record<string, Verdict>> {
    return getJson<Record<string, Verdict>>(STORAGE_KEYS.verdictCache, {});
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，pipeline-verdict-cache 6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/pipeline/verdict-cache.ts tests/unit/pipeline-verdict-cache.test.ts
git commit -m "feat: 新增判定结果缓存"
```

---

### Task 7: 端到端自检

**Files:**
- Modify: `docs/testing-checklist.md`
- Create: `src/bg/pipeline-service.ts`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: service worker 侧的判定服务，供 content script 调用

- [ ] **Step 1: 写 pipeline-service.ts**

`src/bg/pipeline-service.ts`：
```ts
import type { ContentItem, UserProfile, Mode, Verdict } from '../shared/types';
import type { LlmClient } from './llm/client';
import { Pipeline } from '../pipeline/pipeline';
import { WordlistService } from '../pipeline/wordlist-service';
import { VerdictCache, verdictContextKey } from '../pipeline/verdict-cache';
import { getProfile, getWhitelist } from './storage';
import type { VideoContext } from '../pipeline/types';

/**
 * service worker 侧的判定服务。
 * content script 只管抽 DOM 与执行动作，判定全在这里。
 */
export class PipelineService {
  private readonly wordlists: WordlistService;
  private readonly cache = new VerdictCache();

  constructor(private readonly client: LlmClient) {
    this.wordlists = new WordlistService(client);
  }

  async judge(
    items: ContentItem[],
    opts: { mode: Mode; video: VideoContext | null; threshold: number },
  ): Promise<Verdict[]> {
    const profile: UserProfile | null = await getProfile();
    const whitelist = await getWhitelist();

    const pipeline = new Pipeline({
      client: this.client,
      whitelist,
      wordlistProvider: async (ctx) => {
        if (!ctx.video) {
          return { patterns: [], stance: '', oppositeKeywords: [], cacheKey: 'none' };
        }
        return this.wordlists.get(ctx.video, ctx.profile, ctx.mode);
      },
    });

    const results = await pipeline.judge(items, {
      mode: opts.mode,
      profile,
      video: opts.video,
      threshold: opts.threshold,
    });

    // 写回缓存
    for (const v of results) {
      const item = items.find((i) => i.id === v.itemId);
      if (!item) continue;
      await this.cache.set(v.itemId, verdictContextKey(item, opts.mode), v);
    }

    return results;
  }
}
```

- [ ] **Step 2: 跑全量验证**

Run: `npm run typecheck && npm run test && npm run build`
Expected: 三条命令全部退出码 0

- [ ] **Step 3: 追加测试清单**

在 `docs/testing-checklist.md` 末尾追加：
```markdown
## 计划 04（判定流水线）

- [ ] 未命中词表的评论不产生 LLM 精判调用（看 network 面板）
- [ ] 命中词表的评论会被精判并给出理由
- [ ] 理由可展示、且能撤销
- [ ] LLM 不可用时全部放行（页面不被影响）
```

- [ ] **Step 4: 提交**

```bash
git add src/bg/pipeline-service.ts docs/testing-checklist.md
git commit -m "feat: 新增判定服务并补充测试清单"
```

---

## 完成标准

- [ ] `npm run typecheck` 退出码 0
- [ ] `npm run test` 全部通过
- [ ] `npm run build` 产出 `dist/`
- [ ] **未命中词表的评论不触发 LLM 精判**（有测试断言调用次数）
- [ ] LLM 失败时全部放行，页面不受影响
- [ ] 每个非 pass 判定都带人话理由
- [ ] 全部代码已提交
- [ ] 计划 05 可以直接开始
