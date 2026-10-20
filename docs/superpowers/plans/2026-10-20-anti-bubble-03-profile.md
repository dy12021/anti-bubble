# 计划 03：画像子系统

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现用户画像的构建、合并、增量更新与 LLM 归纳，让插件知道「这个人喜欢什么、不喜欢什么、站在哪一边」。

**Architecture:** 三段式——`collect.ts` 负责从 B 站拉取原始样本（冷启动），`merge.ts` 负责冷启动样本与增量样本的合并（时间衰减加权），`induce.ts` 负责调 LLM 把样本归纳成结构化画像。画像存 `chrome.storage.local`，全程不离开本机。

**Tech Stack:** TypeScript 5.5.2、Vitest 2.1.1

**依赖:** 计划 01（类型、存储、LLM 客户端）、计划 02（B 站 API 客户端）。

---

## Global Constraints

- 画像**只存本机** `chrome.storage.local`，不得使用 `storage.sync`，不得上传
- 冷启动拉取历史是**可关闭**的（设置项 `collectHistory`），关闭后只用增量
- 拉取历史要限速（复用 BiliClient 的节流），遇风控降级而非报错
- LLM 归纳的输入是**视频标题/分区/UP主**，不含播放行为以外的隐私
- 归纳失败必须降级为「规则画像」（按分区计数），不能让整个功能挂掉
- 画像合并必须**幂等**：同样的输入合并两次结果相同

---

## File Structure

```
src/
└── profile/
    ├── collect.ts     # 拉取原始样本
    ├── merge.ts       # 冷启动 + 增量合并（时间衰减）
    ├── induce.ts      # LLM 归纳
    └── rules.ts       # 规则降级画像（不依赖 LLM）
tests/unit/
├── profile-merge.test.ts
├── profile-rules.test.ts
└── profile-induce.test.ts
```

---

### Task 1: 样本合并与时间衰减

**Files:**
- Create: `src/profile/merge.ts`
- Test: `tests/unit/profile-merge.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `UserProfileInput`
- Produces:
  - `mergeSamples(samples: UserProfileInput[], now?: number): UserProfileInput[]`——冷启动与增量样本合并，去重、时间衰减
  - `sampleWeight(sample: UserProfileInput, now: number): number`——时间衰减权重
  - `HALF_LIFE_DAYS`——半衰期常量

- [ ] **Step 1: 写失败测试**

`tests/unit/profile-merge.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { mergeSamples, sampleWeight, HALF_LIFE_DAYS } from '../../src/profile/merge';
import type { UserProfileInput } from '../../src/shared/types';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function s(over: Partial<UserProfileInput> = {}): UserProfileInput {
  return {
    id: 'BV1', title: '标题', author: 'UP', category: '科技',
    collectedAt: new Date(NOW).toISOString(), origin: 'history', ...over,
  };
}

describe('样本合并', () => {
  it('相同 id 只保留一条', () => {
    const out = mergeSamples([s(), s({ title: '另一个标题' })], NOW);
    expect(out).toHaveLength(1);
  });

  it('保留先出现的（冷启动优先）', () => {
    const out = mergeSamples([s({ title: '先' }), s({ title: '后' })], NOW);
    expect(out[0]!.title).toBe('先');
  });

  it('不同 id 都保留', () => {
    expect(mergeSamples([s({ id: 'A' }), s({ id: 'B' })], NOW)).toHaveLength(2);
  });

  it('合并是幂等的', () => {
    const a = mergeSamples([s({ id: 'A' }), s({ id: 'B' })], NOW);
    expect(mergeSamples(a, NOW)).toEqual(a);
  });

  it('新样本权重不小于旧样本', () => {
    const old = s({ collectedAt: new Date(NOW - 60 * 86400000).toISOString() });
    const fresh = s({ collectedAt: new Date(NOW).toISOString() });
    expect(sampleWeight(fresh, NOW)).toBeGreaterThan(sampleWeight(old, NOW));
  });

  it('权重随时间单调递减', () => {
    const w1 = sampleWeight(s({ collectedAt: new Date(NOW - 86400000).toISOString() }), NOW);
    const w2 = sampleWeight(s({ collectedAt: new Date(NOW - 10 * 86400000).toISOString() }), NOW);
    expect(w1).toBeGreaterThan(w2);
  });

  it('半衰期处权重约为 0.5', () => {
    const half = s({ collectedAt: new Date(NOW - HALF_LIFE_DAYS * 86400000).toISOString() });
    expect(sampleWeight(half, NOW)).toBeCloseTo(0.5, 2);
  });

  it('权重范围在 0 到 1 之间', () => {
    const veryOld = s({ collectedAt: new Date(NOW - 3650 * 86400000).toISOString() });
    const w = sampleWeight(veryOld, NOW);
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/profile/merge'`

- [ ] **Step 3: 写实现**

`src/profile/merge.ts`：
```ts
import type { UserProfileInput } from '../shared/types';

/** 半衰期（天）。90 天的行为仍有一半权重。 */
export const HALF_LIFE_DAYS = 90;

/**
 * 时间衰减权重。
 *
 * 为什么需要衰减：三个月前的观看记录不能和昨天的等权——
 * 人的口味会变，昨天的行为更能代表当下。
 *
 * 权重公式：w = 0.5 ^ (ageDays / HALF_LIFE_DAYS)
 */
export function sampleWeight(sample: UserProfileInput, now: number): number {
  const t = Date.parse(sample.collectedAt);
  if (Number.isNaN(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86400000);
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/**
 * 合并冷启动样本与增量样本。
 *
 * 规则：
 * 1. 按 id 去重，**先出现的保留**（冷启动样本排在前面，因为它们更权威）；
 * 2. 幂等：合并已合并的结果不变。
 */
export function mergeSamples(
  samples: UserProfileInput[],
  now: number = Date.now(),
): UserProfileInput[] {
  const seen = new Set<string>();
  const out: UserProfileInput[] = [];
  for (const s of samples) {
    if (!s?.id) continue;
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  // 按采集时间倒序，让新的排在前面（后续归纳时可取前 N 条）
  out.sort((a, b) => {
    const ta = Date.parse(a.collectedAt);
    const tb = Date.parse(b.collectedAt);
    const va = Number.isNaN(ta) ? 0 : ta;
    const vb = Number.isNaN(tb) ? 0 : tb;
    return vb - va;
  });
  void now;
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，profile-merge 8 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/profile/merge.ts tests/unit/profile-merge.test.ts
git commit -m "feat: 新增画像样本合并与时间衰减"
```

---

### Task 2: 规则降级画像

**Files:**
- Create: `src/profile/rules.ts`
- Test: `tests/unit/profile-rules.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `UserProfileInput` / `UserProfile`，Task 1 的 `sampleWeight`
- Produces:
  - `buildRuleProfile(samples: UserProfileInput[], now?: number): UserProfile`——**不依赖 LLM**的画像，用于 LLM 失败时降级
  - `TOPIC_KEYWORDS: Record<string, string[]>`——分区名到题材标签的映射

- [ ] **Step 1: 写失败测试**

`tests/unit/profile-rules.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { buildRuleProfile } from '../../src/profile/rules';
import type { UserProfileInput } from '../../src/shared/types';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function s(over: Partial<UserProfileInput> = {}): UserProfileInput {
  return {
    id: 'BV1', title: 'Rust 异步编程', author: 'UP', category: '技术',
    collectedAt: new Date(NOW).toISOString(), origin: 'history', ...over,
  };
}

describe('规则画像', () => {
  it('统计分区出现次数作为兴趣标签', () => {
    const p = buildRuleProfile([s({ id: 'A' }), s({ id: 'B' }), s({ id: 'C' })], NOW);
    const tags = p.interests.map((i) => i.tag);
    expect(tags).toContain('技术');
  });

  it('兴趣权重归一化到 0-1', () => {
    const p = buildRuleProfile([s({ id: 'A' }), s({ id: 'B' })], NOW);
    for (const i of p.interests) {
      expect(i.weight).toBeGreaterThan(0);
      expect(i.weight).toBeLessThanOrEqual(1);
    }
  });

  it('最高权重的兴趣是出现最多的分区', () => {
    const p = buildRuleProfile([
      s({ id: 'A', category: '技术' }),
      s({ id: 'B', category: '游戏' }),
      s({ id: 'C', category: '游戏' }),
    ], NOW);
    expect(p.interests[0]!.tag).toBe('游戏');
  });

  it('没有样本时返回空画像而不是抛错', () => {
    const p = buildRuleProfile([], NOW);
    expect(p.interests).toEqual([]);
    expect(p.sampleCount).toBe(0);
  });

  it('sampleCount 记录样本数', () => {
    const p = buildRuleProfile([s({ id: 'A' }), s({ id: 'B' })], NOW);
    expect(p.sampleCount).toBe(2);
  });

  it('updatedAt 是 ISO 字符串', () => {
    const p = buildRuleProfile([s()], NOW);
    expect(new Date(p.updatedAt).toISOString()).toBe(new Date(NOW).toISOString());
  });

  it('不产生空标签项', () => {
    const p = buildRuleProfile([s({ category: '' })], NOW);
    expect(p.interests.every((i) => i.tag.length > 0)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/profile/rules'`

- [ ] **Step 3: 写实现**

`src/profile/rules.ts`：
```ts
import type { UserProfileInput, UserProfile } from '../shared/types';
import { sampleWeight } from './merge';

/**
 * 规则画像：不依赖 LLM 的降级实现。
 *
 * 存在的意义：LLM 归纳可能失败（没配 Key、被限流、网络不通），
 * 此时插件不能整个瘫掉——至少还能按分区做粗粒度的偏好判断。
 */
export function buildRuleProfile(
  samples: UserProfileInput[],
  now: number = Date.now(),
): UserProfile {
  const scores = new Map<string, number>();
  const total = new Map<string, number>();

  for (const s of samples) {
    const cat = (s.category ?? '').trim();
    if (!cat) continue;
    const w = sampleWeight(s, now);
    scores.set(cat, (scores.get(cat) ?? 0) + w);
    total.set(cat, (total.get(cat) ?? 0) + 1);
  }

  const max = Math.max(0, ...scores.values());
  const interests = [...scores.entries()]
    .map(([tag, score]) => ({ tag, weight: max > 0 ? score / max : 0 }))
    .sort((a, b) => b.weight - a.weight);

  return {
    interests,
    dislikes: [],
    stanceHints: {},
    topics: interests.slice(0, 10).map((i) => i.tag),
    updatedAt: new Date(now).toISOString(),
    sampleCount: samples.length,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，profile-rules 7 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/profile/rules.ts tests/unit/profile-rules.test.ts
git commit -m "feat: 新增不依赖 LLM 的规则降级画像"
```

---

### Task 3: LLM 归纳

**Files:**
- Create: `src/profile/induce.ts`
- Test: `tests/unit/profile-induce.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `UserProfile` / `LlmConfig` / `UserProfileInput`，Task 2 的 `buildRuleProfile`
- Produces:
  - `buildInductionPrompt(samples: UserProfileInput[], maxSamples?: number): { system: string; user: string }`
  - `induceProfile(client: LlmClient, samples: UserProfileInput[], now?: number): Promise<UserProfile>`——**LLM 失败自动降级为规则画像**
  - `parseProfile(raw: string, fallback: UserProfile): UserProfile`

- [ ] **Step 1: 写失败测试**

`tests/unit/profile-induce.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { buildInductionPrompt, induceProfile, parseProfile } from '../../src/profile/induce';
import { buildRuleProfile } from '../../src/profile/rules';
import type { UserProfileInput } from '../../src/shared/types';
import type { LlmClient } from '../../src/bg/llm/client';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function s(over: Partial<UserProfileInput> = {}): UserProfileInput {
  return {
    id: 'BV1', title: 'Rust 异步编程', author: 'UP', category: '技术',
    collectedAt: new Date(NOW).toISOString(), origin: 'history', ...over,
  };
}

function fakeClient(text: string | Error): LlmClient {
  return {
    complete: vi.fn(async () => {
      if (text instanceof Error) throw text;
      return text;
    }),
  };
}

describe('画像归纳', () => {
  it('prompt 里包含视频标题', () => {
    const p = buildInductionPrompt([s({ title: '独特标题XYZ' })]);
    expect(p.user).toContain('独特标题XYZ');
  });

  it('prompt 里包含分区', () => {
    const p = buildInductionPrompt([s({ category: '游戏区' })]);
    expect(p.user).toContain('游戏区');
  });

  it('prompt 有 system 段', () => {
    const p = buildInductionPrompt([s()]);
    expect(p.system.length).toBeGreaterThan(0);
  });

  it('样本过多时截断', () => {
    const many = Array.from({ length: 500 }, (_, i) => s({ id: 'BV' + i }));
    const p = buildInductionPrompt(many, 50);
    expect(p.user.split('\n').length).toBeLessThanOrEqual(60);
  });

  it('解析合法 JSON 得到画像', () => {
    const fallback = buildRuleProfile([s()], NOW);
    const raw = JSON.stringify({
      interests: [{ tag: '技术', weight: 0.9 }],
      dislikes: ['游戏'],
      stanceHints: { 'AI': '谨慎乐观' },
      topics: ['Rust'],
    });
    const p = parseProfile(raw, fallback);
    expect(p.interests[0]!.tag).toBe('技术');
    expect(p.dislikes).toEqual(['游戏']);
  });

  it('解析带 markdown 包裹的 JSON', () => {
    const fallback = buildRuleProfile([s()], NOW);
    const raw = '```json\n{"interests":[{"tag":"X","weight":0.5}],"dislikes":[],"stanceHints":{},"topics":[]}\n```';
    expect(parseProfile(raw, fallback).interests[0]!.tag).toBe('X');
  });

  it('解析失败时回落到规则画像', () => {
    const fallback = buildRuleProfile([s()], NOW);
    expect(parseProfile('完全不是 JSON', fallback)).toEqual(fallback);
  });

  it('解析时补齐缺失字段', () => {
    const fallback = buildRuleProfile([s()], NOW);
    const p = parseProfile('{"interests":[]}', fallback);
    expect(p.dislikes).toEqual([]);
    expect(p.stanceHints).toEqual({});
    expect(Array.isArray(p.topics)).toBe(true);
  });

  it('LLM 成功时返回归纳结果', async () => {
    const client = fakeClient(JSON.stringify({
      interests: [{ tag: '技术', weight: 0.8 }],
      dislikes: [], stanceHints: {}, topics: ['Rust'],
    }));
    const p = await induceProfile(client, [s()], NOW);
    expect(p.interests[0]!.tag).toBe('技术');
  });

  it('LLM 抛错时降级为规则画像而不是抛出', async () => {
    const client = fakeClient(new Error('LLM 挂了'));
    const p = await induceProfile(client, [s()], NOW);
    expect(p.interests.length).toBeGreaterThan(0);
    expect(p.sampleCount).toBe(1);
  });

  it('LLM 返回垃圾时降级为规则画像', async () => {
    const client = fakeClient('我不知道你在说什么');
    const p = await induceProfile(client, [s()], NOW);
    expect(p.interests.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/profile/induce'`

- [ ] **Step 3: 写实现**

`src/profile/induce.ts`：
```ts
import type { UserProfile, UserProfileInput } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { parseJsonResponse } from '../bg/llm/client';
import { buildRuleProfile } from './rules';

/**
 * 让 LLM 从观看/收藏样本里归纳用户画像。
 *
 * 设计要点：
 * 1. **必须能降级**。LLM 没配 Key / 被限流 / 网络不通时，
 *    插件要退回到规则画像，不能整个瘫掉。
 * 2. **输入只含视频元信息**（标题/分区/UP主），不含浏览行为之外的隐私。
 */

const MAX_SAMPLES = 200;

export function buildInductionPrompt(
  samples: UserProfileInput[],
  maxSamples: number = MAX_SAMPLES,
): { system: string; user: string } {
  const system = [
    '你是一个用户画像归纳器。输入是用户近期在 B 站观看/收藏的视频摘要。',
    '请归纳这个用户的偏好，输出严格的 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{',
    '  "interests": [{"tag": "题材标签", "weight": 0.0-1.0}],',
    '  "dislikes": ["用户明确不喜欢的题材"],',
    '  "stanceHints": {"话题": "用户在该话题上的倾向，如 谨慎/支持/反对/中立"},',
    '  "topics": ["用户关注的话题"]',
    '}',
    '',
    '要求：',
    '- interests 按权重从高到低，最多 12 项',
    '- dislikes 只写有明确证据的，最多 8 项',
    '- stanceHints 最多 8 项，只在样本有明确立场时写',
    '- 不要编造样本里没有的偏好',
  ].join('\n');

  const lines = samples.slice(0, maxSamples).map((s) => {
    const parts = [`标题：${s.title}`];
    if (s.category) parts.push(`分区：${s.category}`);
    if (s.author) parts.push(`UP主：${s.author}`);
    return `- ${parts.join('｜')}`;
  });

  const user = [
    `以下是用户最近观看的 ${Math.min(samples.length, maxSamples)} 个视频：`,
    '',
    ...lines,
  ].join('\n');

  return { system, user };
}

/** 解析 LLM 输出，失败时回落到规则画像。 */
export function parseProfile(raw: string, fallback: UserProfile): UserProfile {
  const parsed = parseJsonResponse<Partial<UserProfile>>(raw);
  if (!parsed || typeof parsed !== 'object') return fallback;

  const interests = Array.isArray(parsed.interests)
    ? parsed.interests
        .filter(
          (i): i is { tag: string; weight: number } =>
            !!i && typeof i.tag === 'string' && i.tag.length > 0 &&
            typeof i.weight === 'number',
        )
        .map((i) => ({ tag: i.tag, weight: Math.max(0, Math.min(1, i.weight)) }))
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 12)
    : fallback.interests;

  const dislikes = Array.isArray(parsed.dislikes)
    ? parsed.dislikes.filter((d): d is string => typeof d === 'string' && d.length > 0).slice(0, 8)
    : fallback.dislikes;

  const stanceHints =
    parsed.stanceHints && typeof parsed.stanceHints === 'object' && !Array.isArray(parsed.stanceHints)
      ? Object.fromEntries(
          Object.entries(parsed.stanceHints as Record<string, unknown>)
            .filter(([, v]) => typeof v === 'string')
            .slice(0, 8),
        )
      : fallback.stanceHints;

  const topics = Array.isArray(parsed.topics)
    ? parsed.topics.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 12)
    : fallback.topics;

  return {
    interests,
    dislikes,
    stanceHints,
    topics,
    updatedAt: fallback.updatedAt,
    sampleCount: fallback.sampleCount,
  };
}

/**
 * 归纳画像。LLM 失败时降级为规则画像，**不抛异常**。
 */
export async function induceProfile(
  client: LlmClient,
  samples: UserProfileInput[],
  now: number = Date.now(),
): Promise<UserProfile> {
  const fallback = buildRuleProfile(samples, now);
  if (samples.length === 0) return fallback;

  const { system, user } = buildInductionPrompt(samples);
  try {
    const raw = await client.complete(user, { system, maxTokens: 2000 });
    return parseProfile(raw, fallback);
  } catch {
    // 降级：规则画像
    return fallback;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，profile-induce 13 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/profile/induce.ts tests/unit/profile-induce.test.ts
git commit -m "feat: 新增 LLM 画像归纳与失败降级"
```

---

### Task 4: 样本采集

**Files:**
- Create: `src/profile/collect.ts`
- Test: `tests/unit/profile-collect.test.ts`

**Interfaces:**
- Consumes: Task 02 的 `fetchHistory` / `fetchFavorites` / `fetchFavoriteItems` / `fetchFollowing` / `BiliClient`，Task 1 的 `mergeSamples`
- Produces:
  - `collectColdStart(c: BiliClient, opts?: { includeHistory?: boolean }): Promise<UserProfileInput[]>`
  - `collectIncremental(c: BiliClient, item: ContentItem, watchSeconds: number): Promise<UserProfileInput>`
  - `toSample(item: ContentItem, watchSeconds: number, origin: UserProfileInput['origin']): UserProfileInput`

- [ ] **Step 1: 写失败测试**

`tests/unit/profile-collect.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { collectColdStart, toSample } from '../../src/profile/collect';
import { BiliClient } from '../../src/bili/client';
import type { ContentItem } from '../../src/shared/types';

function clientWith(responses: Record<string, unknown>) {
  return new BiliClient({
    getJson: async (url: string) => {
      for (const [k, v] of Object.entries(responses)) {
        if (url.includes(k)) return v;
      }
      return { code: 0, message: '0', data: null };
    },
    now: () => 1_700_000_000_000,
    sleep: async () => {},
  });
}

describe('样本采集', () => {
  it('toSample 把内容单元转成样本', () => {
    const item: ContentItem = {
      kind: 'video', id: 'BV1', text: '标题', author: 'UP',
      meta: { category: '技术' },
      context: { page: 'feed' },
    };
    const s = toSample(item, 120, 'history');
    expect(s.id).toBe('BV1');
    expect(s.category).toBe('技术');
    expect(s.watchSeconds).toBe(120);
    expect(s.origin).toBe('history');
  });

  it('toSample 缺分区时用空串而不是 undefined', () => {
    const item: ContentItem = {
      kind: 'video', id: 'BV1', text: 't', author: 'a', meta: {}, context: { page: 'feed' },
    };
    expect(toSample(item, 10, 'history').category).toBe('');
  });

  it('冷启动拉取历史并转成样本', async () => {
    const c = clientWith({
      '/x/v2/history/cursor': {
        code: 0, message: '0',
        data: {
          list: [{
            history: {
              bvid: 'BV1', title: '历史视频', author_name: 'UP',
              mid: 1, duration: 100, viewed_at: 1_700_000_000, tname: '技术',
            },
          }],
          page: { has_more: false },
        },
      },
    });
    const samples = await collectColdStart(c);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0]!.id).toBe('BV1');
    expect(samples[0]!.origin).toBe('history');
  });

  it('关闭 includeHistory 时不拉历史', async () => {
    const seen: string[] = [];
    const c = new BiliClient({
      getJson: async (url: string) => {
        seen.push(url);
        return { code: 0, message: '0', data: { list: [], page: { has_more: false } } };
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    await collectColdStart(c, { includeHistory: false });
    expect(seen.some((u) => u.includes('/x/v2/history/cursor'))).toBe(false);
  });

  it('拉取失败时返回空数组而不是抛错', async () => {
    const c = new BiliClient({
      getJson: async () => { throw new Error('net'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await collectColdStart(c)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/profile/collect'`

- [ ] **Step 3: 写实现**

`src/profile/collect.ts`：
```ts
import type { BiliClient } from '../bili/client';
import { fetchHistory, fetchFavorites, fetchFavoriteItems } from '../bili/api';
import type { ContentItem, UserProfileInput } from '../shared/types';

/** 把内容单元转成画像样本。 */
export function toSample(
  item: ContentItem,
  watchSeconds: number,
  origin: UserProfileInput['origin'],
): UserProfileInput {
  const cat = item.meta['category'];
  return {
    id: item.id,
    title: item.text,
    author: item.author,
    category: typeof cat === 'string' ? cat : '',
    watchSeconds,
    collectedAt: new Date().toISOString(),
    origin,
  };
}

/**
 * 冷启动采样：观看历史 + 收藏夹。
 *
 * 失败一律降级为空数组——拉不到数据不该让插件不可用。
 */
export async function collectColdStart(
  c: BiliClient,
  opts: { includeHistory?: boolean } = {},
): Promise<UserProfileInput[]> {
  const includeHistory = opts.includeHistory !== false;
  const samples: UserProfileInput[] = [];

  if (includeHistory) {
    const history = await fetchHistory(c);
    for (const h of history) {
      const info = h.history;
      if (!info?.bvid) continue;
      samples.push({
        id: info.bvid,
        title: info.title ?? '',
        author: info.author_name ?? '',
        category: info.tname ?? '',
        collectedAt: new Date((info.viewed_at ?? Date.now() / 1000) * 1000).toISOString(),
        origin: 'history',
      });
    }
  }

  const folders = await fetchFavorites(c);
  for (const f of folders.slice(0, 10)) {
    const items = await fetchFavoriteItems(c, f.id);
    for (const m of items) {
      if (!m.bvid) continue;
      samples.push({
        id: m.bvid,
        title: m.title ?? '',
        author: m.upper?.name ?? '',
        category: '',
        collectedAt: m.ctime ? new Date(m.ctime * 1000).toISOString() : new Date().toISOString(),
        origin: 'favorite',
      });
    }
  }

  return samples;
}

/** 增量样本：用户刚看过的视频。 */
export function collectIncremental(
  _c: BiliClient,
  item: ContentItem,
  watchSeconds: number,
): UserProfileInput {
  return toSample(item, watchSeconds, 'history');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，profile-collect 5 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/profile/collect.ts tests/unit/profile-collect.test.ts
git commit -m "feat: 新增画像样本采集（冷启动与增量）"
```

---

### Task 5: 画像服务与路由接入

**Files:**
- Create: `src/bg/profile-service.ts`
- Modify: `src/bg/router.ts`
- Test: `tests/unit/profile-service.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `getProfile` / `saveProfile` / `getSettings` / `STORAGE_KEYS`，Task 03 的 `induceProfile`，Task 04 的 `collectColdStart` / `mergeSamples`
- Produces:
  - `class ProfileService`——方法：
    - `get(): Promise<UserProfile | null>`
    - `refresh(client: LlmClient, opts?: { force?: boolean }): Promise<UserProfile>`
    - `record(item: ContentItem, watchSeconds: number): Promise<void>`
    - `clear(): Promise<void>`
  - `PROFILE_MAX_AGE_MS`——画像最大有效期（24 小时）
  - `WATCH_SAMPLE`——累积观看多少秒才记一条样本（30 秒，过滤误点）

- [ ] **Step 1: 写失败测试**

`tests/unit/profile-service.test.ts`：
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

import { ProfileService, PROFILE_MAX_AGE_MS, WATCH_SAMPLE } from '../../src/bg/profile-service';
import type { ContentItem } from '../../src/shared/types';
import type { LlmClient } from '../../src/bg/llm/client';

const NOW = Date.parse('2026-10-20T00:00:00Z');

function item(over: Partial<ContentItem> = {}): ContentItem {
  return {
    kind: 'video', id: 'BV1', text: '标题', author: 'UP',
    meta: { category: '技术' }, context: { page: 'feed' }, ...over,
  };
}

function client(): LlmClient {
  return {
    complete: vi.fn(async () => JSON.stringify({
      interests: [{ tag: '技术', weight: 0.8 }], dislikes: [],
      stanceHints: {}, topics: ['x'],
    })),
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('画像服务', () => {
  it('没有画像时 get 返回 null', async () => {
    const s = new ProfileService(client(), () => NOW);
    expect(await s.get()).toBeNull();
  });

  it('refresh 后能取到画像', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.refresh(client());
    expect((await s.get())?.interests.length).toBeGreaterThan(0);
  });

  it('未过期时 refresh 不重新调用 LLM', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    await s.refresh(c);
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    await s.refresh(c);
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('force 会强制重新归纳', async () => {
    const c = client();
    const s = new ProfileService(c, () => NOW);
    await s.refresh(c);
    const before = (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    await s.refresh(c, { force: true });
    expect((c.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });

  it('观看不足阈值不记样本', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.record(item(), WATCH_SAMPLE - 1);
    expect(await s.get()).toBeNull();
  });

  it('观看超过阈值记样本', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.record(item(), WATCH_SAMPLE + 1);
    expect(await s.get()).not.toBeNull();
  });

  it('记录后画像样本数增加', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.record(item({ id: 'BV1' }), 100);
    await s.record(item({ id: 'BV2' }), 100);
    expect((await s.get())?.sampleCount).toBeGreaterThanOrEqual(2);
  });

  it('clear 后画像消失', async () => {
    const s = new ProfileService(client(), () => NOW);
    await s.refresh(client());
    await s.clear();
    expect(await s.get()).toBeNull();
  });

  it('过期常量为 24 小时', () => {
    expect(PROFILE_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/bg/profile-service'`

- [ ] **Step 3: 写实现**

`src/bg/profile-service.ts`：
```ts
import type { UserProfile, UserProfileInput, ContentItem } from '../shared/types';
import type { LlmClient } from './llm/client';
import { getProfile, saveProfile, clearProfile, getJson, setJson } from './storage';
import { STORAGE_KEYS } from '../shared/constants';
import { induceProfile } from '../profile/induce';
import { mergeSamples } from '../profile/merge';
import { collectColdStart, toSample } from '../profile/collect';
import { contentKey } from '../shared/hash';

/** 画像最长有效期：24 小时后自动重新归纳。 */
export const PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 累计观看多少秒才记一条样本。过滤误点即退。 */
export const WATCH_SAMPLE = 30;

/**
 * 画像服务。
 *
 * 负责三件事：
 * 1. 提供当前画像
 * 2. 定期/按需重新归纳（冷启动拉数据 + LLM 归纳）
 * 3. 记录增量观看
 */
export class ProfileService {
  constructor(
    private readonly client: LlmClient,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async get(): Promise<UserProfile | null> {
    return getProfile();
  }

  /** 归纳画像。force=true 时忽略缓存强制重算。 */
  async refresh(
    client: LlmClient,
    opts: { force?: boolean } = {},
  ): Promise<UserProfile> {
    const existing = await getProfile();
    if (existing && !opts.force) {
      const age = this.now() - Date.parse(existing.updatedAt);
      if (Number.isFinite(age) && age < PROFILE_MAX_AGE_MS) {
        return existing;
      }
    }

    const samples = await this.getSamples();
    const profile = await induceProfile(client, samples, this.now());
    await saveProfile(profile);
    return profile;
  }

  /** 记录一次观看。不足阈值则忽略。 */
  async record(item: ContentItem, watchSeconds: number): Promise<void> {
    if (watchSeconds < WATCH_SAMPLE) return;

    const samples = await this.getSamples();
    const sample = toSample(item, watchSeconds, 'history');
    const merged = mergeSamples([sample, ...samples], this.now());

    // 只保留最近 1000 条，避免无限增长
    await setJson(STORAGE_KEYS.watchLog, merged.slice(0, 1000));

    // 立刻用规则画像更新一次（不等 LLM），
    // 让「刚看完就刷新」的即时行为也能反映到画像里
    const current = await getProfile();
    if (!current) {
      const { buildRuleProfile } = await import('../profile/rules');
      await saveProfile(buildRuleProfile(merged, this.now()));
    }
  }

  async clear(): Promise<void> {
    await clearProfile();
  }

  /** 冷启动样本 + 增量样本合并。 */
  private async getSamples(): Promise<UserProfileInput[]> {
    const incremental = await getJson<UserProfileInput[]>(STORAGE_KEYS.watchLog, []);
    return mergeSamples(incremental, this.now());
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，profile-service 8 个测试全绿

- [ ] **Step 5: 接入路由**

修改 `src/bg/router.ts`，在 switch 里加：

```ts
      case MSG.GET_PROFILE:
        return { id, ok: true, data: await getProfile() };
```
（已有，保留）

并新增 `MSG.REFRESH_PROFILE`：
```ts
      case MSG.REFRESH_PROFILE: {
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM，无法归纳画像' };
        const svc = new ProfileService(createLlmClient(cfg));
        const profile = await svc.refresh(createLlmClient(cfg), { force: true });
        return { id, ok: true, data: profile };
      }
```

同时在 `src/shared/messages.ts` 的 `MSG` 里加 `REFRESH_PROFILE: 'REFRESH_PROFILE'`。

- [ ] **Step 6: 跑测试与构建**

Run: `npm run test && npm run typecheck && npm run build`
Expected: 全部退出码 0

- [ ] **Step 7: 提交**

```bash
git add src/bg src/profile src/shared/messages.ts tests/unit/profile-service.test.ts
git commit -m "feat: 新增画像服务并接入消息路由"
```

---

## 完成标准

- [ ] `npm run typecheck` 退出码 0
- [ ] `npm run test` 全部通过
- [ ] `npm run build` 产出 `dist/`
- [ ] LLM 不可用时降级为规则画像且不抛异常
- [ ] 画像只存在 `chrome.storage.local`
- [ ] 全部代码已提交
- [ ] 计划 04 可以直接开始
