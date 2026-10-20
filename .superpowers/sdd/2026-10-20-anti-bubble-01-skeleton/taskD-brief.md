# 批次 D：判定流水线（计划 04）

> 完整需求见 `docs/superpowers/plans/2026-10-20-anti-bubble-04-pipeline.md` 的 Task 1~7。
> 下面是给执行 agent 的补充说明与必须遵守的约束。

## 这个模块是整个项目的核心

判定的成本结构是**这个插件能不能用**的关键：

```
① 画像匹配（本地，零成本）      → 命中「不喜欢」标签直接 fold
② 动态词表粗筛（规则，零成本）  → 未命中直接放行，**绝不调 LLM**
③ LLM 精判（唯一花钱环节）      → 只判 ② 命中的
```

**成本红线**：未命中词表的内容**不得**调用 LLM。测试必须断言调用次数。

## 你的文件所有权（只准碰这些）

**创建：**
- `D:\coding\anti-bubble\src\pipeline\types.ts`
- `D:\coding\anti-bubble\src\pipeline\wordlist.ts`
- `D:\coding\anti-bubble\src\pipeline\coarse.ts`
- `D:\coding\anti-bubble\src\pipeline\judge.ts`
- `D:\coding\anti-bubble\src\pipeline\pipeline.ts`
- `D:\coding\anti-bubble\src\pipeline\wordlist-service.ts`
- `D:\coding\anti-bubble\src\pipeline\verdict-cache.ts`
- `D:\coding\anti-bubble\src\bg\pipeline-service.ts`
- `D:\coding\anti-bubble\tests\unit\pipeline-wordlist.test.ts`
- `D:\coding\anti-bubble\tests\unit\pipeline-coarse.test.ts`
- `D:\coding\anti-bubble\tests\unit\pipeline-judge.test.ts`
- `D:\coding\anti-bubble\tests\unit\pipeline.test.ts`
- `D:\coding\anti-bubble\tests\unit\pipeline-wordlist-service.test.ts`
- `D:\coding\anti-bubble\tests\unit\pipeline-verdict-cache.test.ts`

**不要碰**：`src/shared/*`、`src/bg/storage.ts`、`src/bg/llm/*`、`src/bili/*`、`src/profile/*`、
`src/adapters/*`、`src/actions/*`、`src/recommend/*`、`src/content/*`、`src/bg/router.ts`、`src/bg/index.ts`。

## 依赖的既有契约（直接 import，不要重新定义）

`src/shared/types.ts`：`ContentItem`、`Verdict`、`VerdictReasonCode`、`UserProfile`、`Mode`
`src/shared/constants.ts`：`STORAGE_KEYS`、**`REASON_CODES`**（judge.ts 要用它，不要自己再定义一份）
`src/shared/hash.ts`：`contentKey`
`src/bg/storage.ts`：`getJson`、`setJson`
`src/bg/llm/client.ts`：`LlmClient`、`parseJsonResponse`
`src/bili/client.ts`：`BiliClient`
`src/bili/api.ts`：`fetchVideo`、`fetchVideoIdByBvid`、`fetchConclusion`

**开工前先读这些文件确认实际签名。**

## 关键补充要求

### `src/pipeline/types.ts`
按计划定义 `VideoContext`、`Wordlist`、`JudgeInput`、`RawJudgeResult`、`PipelineContext`。
`Wordlist` 必须含 `patterns: string[]`、`stance: string`、`oppositeKeywords: string[]`、`cacheKey: string`。

### `wordlist.ts` — 最重要的一处设计
**一次 LLM 调用同时干三件事**（成本控制的关键，拆成三次调用每个视频要多花两倍钱）：
1. 抽取本视频立场 → `stance`
2. 产出判据词表 → `patterns`（用于粗筛召回）
3. 产出对立检索词 → `oppositeKeywords`（用于反向推荐）

`buildWordlistPrompt(video, profile, mode)` 的 mode 语义：
- `'cocoon'`：patterns 找「引战」+「用户大概率不喜欢的表达」
- `'anti'`：patterns 找「引战」+「与用户立场相反的表达」

`buildFallbackWordlist` 的 patterns 必须是**空数组**（空表 = 全部放行 = 不误伤）。

`parseWordlist(raw, fallback)` 要：过滤空模式、限制 60 条、oppositeKeywords 限制 8 条、解析失败回落到 fallback。

### `coarse.ts`
`coarseMatch(text, wordlist)`：小写子串包含匹配，零成本。空词表永远返回 false。

### `judge.ts`
- `buildJudgePrompt` 一次判一批（items 数组），prompt 里要带 item 序号，LLM 返回的 `id` 要能对齐
- `parseJudgments(raw, itemIds, fallbackAction)`：缺项/解析失败**一律补 pass**
- reason 为空时用默认理由（不能是空串）
- `judgeItems(...)` 里 LLM 抛错 → 全部降级为 pass（**绝不抛**）
- 置信度低于 threshold 的按 pass 处理
- pass 的 `revocable` 是 false，非 pass 是 true

### `pipeline.ts`
- `matchProfile(text, profile)`：纯本地，匹配画像 `dislikes` 里的标签（大小写不敏感子串）
- `Pipeline` 的 `judge(items, ctx)` 按 ①②③ 顺序执行
- 白名单里的 id 直接放行
- 词表 provider 抛错 → 全部放行
- 返回的 Verdict 数组**顺序和数量**必须与输入 items 一致

### `wordlist-service.ts`
- 缓存键 = 视频 id + 画像 `updatedAt`（画像更新后缓存自动失效）
- 存在 `STORAGE_KEYS.wordlistCache`（一个 `Record<cacheKey, Wordlist>`）
- LLM 失败 → 返回兜底词表（patterns 为空）

### `verdict-cache.ts`
- 缓存键含 mode、kind、videoId、text（同一评论在不同视频/模式下判定可能不同）
- 上限 3000 条，超出后丢弃最旧的

### `pipeline-service.ts`（service worker 侧）
- `class PipelineService`，`constructor(client: LlmClient)`
- `judge(items, opts: { mode, video, threshold })` → 取画像、取白名单、跑 Pipeline、写回缓存
- 词表 provider 在没有 video 时返回空词表（patterns 空 = 全部放行）

### 计划里漏了的一个函数（必须补）
计划 04 Task 5 的接口清单里声明了 `loadVideoContext(c: BiliClient, bvid: string): Promise<VideoContext | null>`，
但没给实现。**你要实现它**，放在 `src/pipeline/wordlist-service.ts`：
- 调 `fetchVideo(c, bvid)` 拿标题/简介
- 调 `fetchVideoIdByBvid(c, bvid)` 拿 aid/cid/upMid，再调 `fetchConclusion(c, bvid, cid, upMid)` 拿官方 AI 总结
- 任何一步失败都返回 null（不抛）
- 返回 `{ bvid, title, description?, summary? }`

## 硬性约束

- TypeScript 5.5，`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`（重导出用 `export type`）
- **不要 npm install 任何新包**
- 测试不得消耗 LLM 额度：用假 `LlmClient`
- 测试里 mock `chrome.storage.local`（callback 风格）
- **不要执行 git commit**（controller 统一提交）
- LLM 失败一律降级，绝不抛异常

## 完成后跑

```
npx vitest run tests/unit/pipeline-wordlist.test.ts tests/unit/pipeline-coarse.test.ts tests/unit/pipeline-judge.test.ts tests/unit/pipeline.test.ts tests/unit/pipeline-wordlist-service.test.ts tests/unit/pipeline-verdict-cache.test.ts
npx tsc --noEmit
```

两个都必须成功。
