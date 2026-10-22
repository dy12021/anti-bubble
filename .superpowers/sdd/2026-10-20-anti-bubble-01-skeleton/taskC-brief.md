# 批次 C：画像子系统（计划 03）

> 完整需求见 `docs/superpowers/plans/2026-10-20-anti-bubble-03-profile.md` 的 Task 1~5。
> 下面是给执行 agent 的补充说明与必须遵守的约束。

## 你的文件所有权（只准碰这些）

**创建：**
- `<repo>\src\profile\merge.ts`
- `<repo>\src\profile\rules.ts`
- `<repo>\src\profile\induce.ts`
- `<repo>\src\profile\collect.ts`
- `<repo>\src\bg\profile-service.ts`
- `<repo>\tests\unit\profile-merge.test.ts`
- `<repo>\tests\unit\profile-rules.test.ts`
- `<repo>\tests\unit\profile-induce.test.ts`
- `<repo>\tests\unit\profile-collect.test.ts`
- `<repo>\tests\unit\profile-service.test.ts`

**不要碰**：`src/shared/*`、`src/bg/storage.ts`、`src/bg/llm/*`、`src/bili/*`、`src/pipeline/*`、
`src/adapters/*`、`src/actions/*`、`src/recommend/*`、`src/content/*`、`src/bg/router.ts`、`src/bg/index.ts`。

## 依赖的既有契约（直接 import，不要重新定义）

`src/shared/types.ts`：`UserProfileInput`、`UserProfile`、`Settings`、`LlmConfig`
`src/shared/constants.ts`：`STORAGE_KEYS`
`src/bg/storage.ts`：`getJson`、`setJson`、`removeKey`、`getProfile`、`saveProfile`、`clearProfile`
`src/bg/llm/client.ts`：`LlmClient`（`complete(prompt, opts?: {system?, maxTokens?})`）、`parseJsonResponse`
`src/bili/api.ts`：`fetchHistory`、`fetchFavorites`、`fetchFavoriteItems`、`fetchFollowing`
`src/bili/client.ts`：`BiliClient`
`src/bili/types.ts`：`HistoryItem`、`FavoriteFolder`、`FavoriteItem`

**开工前先把这些文件读一遍确认实际签名。**

## 关键补充要求

### Task 1（merge.ts）额外要求
- `mergeSamples` 的 `now` 参数目前签名里没用到（`void now`），这是**刻意的**——保留参数是为了将来做加权合并。不要删掉参数。
- 去重规则：**先出现的保留**（冷启动样本排在数组前面，因为它们更权威）
- 输出按 `collectedAt` 倒序（新的在前）

### Task 4（collect.ts）额外要求
- `collectColdStart` 的 `opts.includeHistory` 默认 `true`；显式传 `false` 时**不能**发任何 `/x/v2/history/cursor` 请求（有测试断言）
- 收藏夹只取前 10 个（`folders.slice(0, 10)`），每个收藏夹翻页上限 10 页
- 所有失败路径返回空数组，**不抛**

### Task 5（profile-service.ts）额外要求
- `ProfileService` 构造签名：`constructor(client: LlmClient, now: () => number = () => Date.now())`
- `refresh(client, opts?: {force?: boolean})` —— 传了 client 就用传的，没传就用构造时的
  （注意：计划里签名是 `refresh(client: LlmClient, opts)`，但测试里是 `svc.refresh(c)` 和 `svc.refresh(c, {force:true})`，实现要兼容）
- 未过期（< PROFILE_MAX_AGE_MS = 24h）且未 force 时直接返回现有画像，**不调 LLM**（有测试断言调用次数）
- `record(item, watchSeconds)`：watchSeconds < WATCH_SAMPLE(30) 时**直接 return，不记样本**（有测试断言）
- `record` 后要写 `STORAGE_KEYS.watchLog`，最多保留 1000 条
- `record` 在画像还不存在时，用 `buildRuleProfile` 写一份规则画像（让即时行为立刻反映）
- 记得 `src/shared/messages.ts` 里已经有 `REFRESH_PROFILE` 消息类型了，路由接线由 controller 负责，**你不用管**

## 硬性约束

- TypeScript 5.5，`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`
  （重导出类型用 `export type { X }`）
- **不要 npm install 任何新包**
- 测试不得消耗 LLM 额度：用假 `LlmClient`（`complete` 返回预设字符串或抛错）
- 测试里 mock `chrome.storage.local`（callback 风格）
- 画像只存 `chrome.storage.local`，**禁用** `chrome.storage.sync`
- **不要执行 git commit**（controller 统一提交）
- LLM 失败必须降级为规则画像，**不抛异常**

## 完成后跑

```
cd /d <repo>   # 或用绝对路径
npx vitest run tests/unit/profile-merge.test.ts tests/unit/profile-rules.test.ts tests/unit/profile-induce.test.ts tests/unit/profile-collect.test.ts tests/unit/profile-service.test.ts
npx tsc --noEmit
```

两个都必须成功（测试全绿 + tsc 退出码 0）。
