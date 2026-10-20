# 批次 E：适配器与动作层（计划 05）

> 完整需求见 `docs/superpowers/plans/2026-10-20-anti-bubble-05-adapters.md` 的 Task 1~8。
> 下面是给执行 agent 的补充说明与必须遵守的约束。

## 这是用户看得见的部分，也是 B 站改版风险最集中的地方

两个铁律：
1. **适配器硬兜底**：抽不到内容必须返回空数组，**不得抛错、不得阻塞页面**。
   B 站改版时的表现应该是「这个页面不干预」，而不是「页面报错」。
2. **动作层可解释可撤销**：每个 fold/hide/mark 都要能展开看理由 + 一键撤销。

## 你的文件所有权（只准碰这些）

**创建：**
- `D:\coding\anti-bubble\src\adapters\types.ts`
- `D:\coding\anti-bubble\src\adapters\search.ts`
- `D:\coding\anti-bubble\src\adapters\video.ts`
- `D:\coding\anti-bubble\src\adapters\feed.ts`
- `D:\coding\anti-bubble\src\adapters\index.ts`
- `D:\coding\anti-bubble\src\actions\fold.ts`
- `D:\coding\anti-bubble\src\actions\mark.ts`
- `D:\coding\anti-bubble\src\actions\recommend.ts`
- `D:\coding\anti-bubble\src\actions\index.ts`
- `D:\coding\anti-bubble\src\recommend\recall.ts`
- `D:\coding\anti-bubble\src\recommend\opposition.ts`
- `D:\coding\anti-bubble\src\content\controller.ts`
- `D:\coding\anti-bubble\tests\fixtures\search.html`
- `D:\coding\anti-bubble\tests\fixtures\video.html`
- `D:\coding\anti-bubble\tests\fixtures\feed.html`
- `D:\coding\anti-bubble\tests\unit\adapter-search.test.ts`
- `D:\coding\anti-bubble\tests\unit\adapter-video.test.ts`
- `D:\coding\anti-bubble\tests\unit\adapter-feed.test.ts`
- `D:\coding\anti-bubble\tests\unit\actions-fold.test.ts`
- `D:\coding\anti-bubble\tests\unit\actions-mark.test.ts`
- `D:\coding\anti-bubble\tests\unit\recommend-recall.test.ts`
- `D:\coding\anti-bubble\tests\unit\content-controller.test.ts`

**不要碰**：`src/shared/*`、`src/bg/*`、`src/bili/*`、`src/profile/*`、`src/pipeline/*`、
`src/content/index.ts`、`src/content/page-bridge.ts`、`src/content/page-fetch.js`、
`manifest.json`、`vite.config.ts` —— 那些是别的 agent 的地盘。

## 依赖的既有契约（直接 import，不要重新定义）

`src/shared/types.ts`：`ContentItem`、`ItemContext`、`Verdict`、`PageType`、`Settings`、`Mode`
`src/shared/messages.ts`：`MSG`（消息类型常量，含 `JUDGE_ITEMS`、`GET_SETTINGS`、`REVOKE`）
`src/bg/llm/client.ts`：`LlmClient`、`parseJsonResponse`
`src/bili/client.ts`：`BiliClient`
`src/bili/api.ts`：`searchVideos`、`fetchComments`
`src/bili/types.ts`：`SearchItem`、`CommentItem`

**开工前先读这些文件确认实际签名。**

## 关键补充要求

### vitest 环境
计划里说要把 `vitest.config.ts` 改成 `environment: 'jsdom'`。
**但 `vitest.config.ts` 不在你的所有权范围**（由 controller 改）。
你在测试里需要 DOM 时，用文件顶部的 `// @vitest-environment jsdom` 注释**逐文件声明**，
这样不依赖全局配置，也就不会和别人的改动冲突。
（`jsdom` 已经在 devDependencies 里了。）

### 适配器选择器（B 站 2026-10 的实际结构）
搜索页与推荐流卡片：
```
.bili-video-card  > a[href*="/video/"]
  标题  .bili-video-card__info--tit
  作者  .bili-video-card__info--author
```
视频页评论（旧版 DOM）：
```
.reply-item[data-rpid]
  作者  .user-name
  正文  .reply-content
```
新版评论区是 Shadow DOM，`querySelector` 抽不到 —— **不要试图兜底猜测**，
抽不到就返回空数组（该页不干预）。这一点在代码注释里写清楚。

### 动作层
- `applyFold` 折叠后插入一条说明行：「已屏蔽（<理由>）」+「仍要显示」按钮
- 点「仍要显示」→ 恢复可见 + 移除说明行 + 调用 `onRevoke(itemId)`
- `applyMark` 只**加标识不隐藏**（反信息茧房模式的立场相反评论是标记，不是删除）
- 样式用 `CSS_PREFIX = 'ab'`，通过 `data-ab-prefix` 属性选择，避免与站点样式冲突
- `injectStyles` 重复调用不能重复插入（用 `data-ab-prefix="ab-styles"` 标记）
- **不要修改 B 站原有 DOM 结构**，只做折叠/隐藏/加标识

### 推荐卡片
- 反向推荐必须是**独立区块**（`.ab-recommend`），不混入 B 站原生推荐流
- 每条推荐**必须带「为什么」**（人话说明它表达了相反观点），否则用户会以为是系统抽风

### 反向推荐召回（两段式）
- 阶段一 `recallOpposite`：用 `oppositeKeywords` 调 `searchVideos`，合并去重
- 阶段二 `judgeOpposition`：LLM 判断候选是否**真的**表达相反观点，判不出来就丢弃
- 补充信号 `mineCommentOpposition`：从评论区挖高赞反对评论

### 页面控制器
- `class PageController`，`constructor(deps: ControllerDeps)`
- `ControllerDeps`：`{ url, send, settings?, root?, onRevoke? }`
- `start()` 流程：读 settings → 没配置/总开关关 → return；识别页面 → 页面开关关 → return；
  取适配器 → 抽内容 → 抽不到 → return；请求判定 → 执行动作
- **任何一步失败都静默降级**，绝不让 B 站页面报错
- `stop()` 可中断
- 通过 `deps.send` 发 `MSG.JUDGE_ITEMS` 消息拿 verdicts

## 硬性约束

- TypeScript 5.5，`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`（重导出用 `export type`）
- **不要 npm install 任何新包**
- 测试不得发真实网络请求（全部 mock）
- **不要执行 git commit**（controller 统一提交）
- 适配器抽不到内容时静默返回空数组

## 完成后跑

```
npx vitest run tests/unit/adapter-search.test.ts tests/unit/adapter-video.test.ts tests/unit/adapter-feed.test.ts tests/unit/actions-fold.test.ts tests/unit/actions-mark.test.ts tests/unit/recommend-recall.test.ts tests/unit/content-controller.test.ts
npx tsc --noEmit
```

两个都必须成功。
