# Task A 报告：存储层 + LLM 客户端契约层

- 计划：`docs/superpowers/plans/2026-10-20-anti-bubble-01-skeleton.md`（Task 5、Task 6）
- 仓库：`D:\coding\anti-bubble`　分支：`feature/anti-bubble-v1`
- 执行时间：2026-10-20 13:11–13:20
- 状态：**DONE_WITH_CONCERNS**（本批文件全绿；仓库级 `tsc --noEmit` 仍红，原因在其它批次，见「潜在问题」）

---

## 1. 改了哪些文件

只创建/修改了分配给我的 6 个文件，**没有碰 `src/shared/*`**，没有碰任何其它批次拥有的文件。

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `src/bg/storage.ts` | 新建 | `chrome.storage.local` 的 Promise 封装 + 设置/画像/LLM 配置/白名单读写 |
| `src/bg/llm/client.ts` | 新建 | `LlmClient` 接口、`buildChatMessages`、`parseJsonResponse`、`createLlmClient` |
| `src/bg/llm/openai.ts` | 新建 | OpenAI 兼容协议（DeepSeek / MiniMax / Kimi / Qwen 等） |
| `src/bg/llm/anthropic.ts` | 新建 | Anthropic 原生协议（Claude） |
| `tests/unit/storage.test.ts` | 新建 | 15 个用例，内存版 `chrome.storage.local` |
| `tests/unit/llm-client.test.ts` | 新建 | 13 个用例，`vi.spyOn(globalThis, 'fetch')` 全 mock |

### 签名核对（与规格逐字一致）

`src/bg/storage.ts`：

```ts
export async function getJson<T>(key: string, fallback: T): Promise<T>
export async function setJson(key: string, value: unknown): Promise<void>
export async function removeKey(key: string): Promise<void>
export function defaultSettings(): Settings
export async function getSettings(): Promise<Settings>
export async function saveSettings(patch: Partial<Settings>): Promise<Settings>
export async function getProfile(): Promise<UserProfile | null>
export async function saveProfile(p: UserProfile): Promise<void>
export async function clearProfile(): Promise<void>
export async function getLlmConfig(): Promise<LlmConfig | null>
export async function saveLlmConfig(c: LlmConfig): Promise<void>
export async function getWhitelist(): Promise<string[]>
export async function addToWhitelist(id: string): Promise<void>
```

`src/bg/llm/client.ts`：

```ts
export interface LlmClient {
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}
export interface ChatMessage { role: 'system' | 'user'; content: string; }
export function buildChatMessages(system: string | undefined, user: string): ChatMessage[]
export function parseJsonResponse<T>(raw: string): T | null
export function createLlmClient(config: LlmConfig): LlmClient
```

`src/bg/llm/openai.ts`：`export async function openAiComplete(config: LlmConfig, prompt: string, system?: string, maxTokens?: number): Promise<string>`
`src/bg/llm/anthropic.ts`：`export async function anthropicComplete(config: LlmConfig, prompt: string, system?: string, maxTokens?: number): Promise<string>`

**没有执行任何 git commit**（按要求留给 controller）。

---

## 2. 每条测试的通过情况

### `tests/unit/storage.test.ts` — 15 passed

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | 读不存在的键返回兜底值 | PASS |
| 2 | 存入的 null 也回落到兜底值 | PASS |
| 3 | 写入后能读回 | PASS |
| 4 | removeKey 删掉键 | PASS |
| 5 | 默认设置是信息茧房模式且三页面都开（`mode='cocoon'`、`masterEnabled=true`、search/video/feed 均 true） | PASS |
| 6 | 保存设置只改传入的字段（`saveSettings({mode:'anti'})` 后 `masterEnabled` 仍为 true） | PASS |
| 7 | enabledPages 是浅合并而不是整体替换（`{search:false}` 后 video/feed 仍为 true） | PASS |
| 8 | 读设置时把存量与默认值合并 | PASS |
| 9 | 画像可存可读 | PASS |
| 10 | 没有画像时返回 null | PASS |
| 11 | 清空画像后读回 null（`getProfile()` → null） | PASS |
| 12 | 清空画像同时清掉 watchLog | PASS |
| 13 | LLM 配置可存可读 | PASS |
| 14 | 白名单去重（`a,a,b` → `['a','b']`） | PASS |
| 15 | 白名单默认为空数组 | PASS |

### `tests/unit/llm-client.test.ts` — 13 passed

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | OpenAI 协议打到正确端点并带 Key（URL 含 `/chat/completions`，headers 含 `Authorization: 'Bearer sk-test'`，返回 `choices[0].message.content`） | PASS |
| 2 | OpenAI 请求体带 model 与 messages，且不含 Key（另断言 `init.signal` 是 `AbortSignal`，验证超时确实用上了） | PASS |
| 3 | Anthropic 协议用 x-api-key 头（URL 含 `/v1/messages`，headers 含 `'x-api-key': 'ak-test'`） | PASS |
| 4 | Anthropic 只拼接 `type==='text'` 的内容（`a` + 忽略 thinking + `b` → `ab`） | PASS |
| 5 | HTTP 错误抛出可读信息且不含 Key（500 → 报 /500/，`rejects.not.toThrow(/sk-secret/)`） | PASS |
| 6 | 响应体回显 Key 时也被遮掉（401，body 内含 `sk-secret`） | PASS |
| 7 | 网络异常被包装（`Error('network down')` → `LLM 请求失败：network down`） | PASS |
| 8 | parseJsonResponse 能剥掉 markdown 包裹（` ```json {"a":1} ``` `） | PASS |
| 9 | parseJsonResponse 能从废话里抠出 JSON（`好的，结果如下：{"a":1} 希望有用`） | PASS |
| 10 | parseJsonResponse 遇到非 JSON 返回 null（`完全不是 JSON`） | PASS |
| 11 | 正常 JSON 原样解析 | PASS |
| 12 | buildChatMessages 有 system 时产出两条消息 | PASS |
| 13 | buildChatMessages system 为 undefined 时只产出 user 一条 | PASS |

**合计：本批 28 个用例全绿（storage 15 + llm-client 13）。测试全部走 mock，零真实 LLM 调用、零额度消耗。**

---

## 3. 跑的命令与输出摘要

```
cd D:\coding\anti-bubble
npx vitest run tests/unit/storage.test.ts tests/unit/llm-client.test.ts
```
```
 ✓ tests/unit/storage.test.ts    (15 tests) 3ms
 ✓ tests/unit/llm-client.test.ts (13 tests) 7ms
 Test Files  2 passed (2)
      Tests  27 passed (27)
EXIT=0
```

```
cd D:\coding\anti-bubble
npx vitest run          # 全量
```
```
 ✓ tests/unit/wbi.test.ts       (17 tests) 4ms
 ✓ tests/unit/storage.test.ts    (15 tests) 3ms
 ✓ tests/unit/llm-client.test.ts (13 tests) 7ms
 Test Files  3 passed (3)
      Tests  44 passed (44)
VITEST_EXIT=0
```

```
cd D:\coding\anti-bubble
npx tsc --noEmit
```
- **本批 6 个文件：干净。** 因仓库里其它批次文件处于半成品状态（见第 5 节），仓库级 `tsc --noEmit` 当前退出码 2，错误全部落在 `src/bg/router.ts`（controller 拥有）和缺失的其它批次模块上，**没有一条来自我拥有的文件**。
- 为给出确定结论，我用与 `tsconfig.json` 完全一致的编译选项、只针对本批 6 个文件跑了一次隔离类型检查：

```
npx tsc --noEmit --strict --noUncheckedIndexedAccess --noImplicitOverride \
  --verbatimModuleSyntax --isolatedModules --skipLibCheck \
  --target ES2022 --module ESNext --moduleResolution bundler \
  --lib ES2022,DOM,DOM.Iterable --types chrome,vite/client \
  src/bg/storage.ts src/bg/llm/client.ts src/bg/llm/openai.ts src/bg/llm/anthropic.ts \
  tests/unit/storage.test.ts tests/unit/llm-client.test.ts
→ SCOPED_TSC_EXIT=0
```

---

## 4. 与规格不同的决定，以及原因

### 4.1 `parseJsonResponse` 额外支持数组（超出计划 01 的参考实现）

计划的参考实现只从 `{`…`}` 抠对象。我在候选列表里加了一条 `[`…`]` 的数组候选（排在对象候选之后、整段解析之前）。

- 原因：规格只要求「能抠 JSON」，数组也是 JSON；纯增量能力，不会改变对象解析的行为顺序，也不会让「抠不出来」的情况返回非 null。
- 风险：无。对象候选优先，行为与计划完全一致。

### 4.2 错误信息增加 Key 脱敏（超出计划 01 的参考实现）

`openai.ts` / `anthropic.ts` 各加了一个私有 `redact(text, apiKey)`：把响应体里出现的 apiKey 原文替换成 `***`。

- 原因：规格写的是「错误信息里**绝对**不能出现 API Key」，而 HTTP 错误按要求要回传响应体前 200 字符。响应体是外部内容，代理/网关/某些 SDK 会把 Key 原样回显（OpenAI 自己是打码的，但不能依赖对方）。脱敏是兜底，不改变「状态码 + 响应体前 200 字」的结构。
- 代价：`redact` 在两个文件里各存一份（`src/bg/llm/` 下不能新增共享文件），有轻微重复。已在两处注释里互相指认。

### 4.3 `saveSettings({enabledPages:{search:false}})` 的类型毛刺

规格同时要求两件事：(a) 签名一字不改为 `saveSettings(patch: Partial<Settings>)`；(b) 要能只传部分页面开关并浅合并。

`Partial<Settings>` 只放宽**顶层**，`enabledPages` 的类型仍是完整的 `Record<PageType, boolean>`，所以 `saveSettings({ enabledPages: { search: false } })` 在 TS 层是类型错误（TS2739）。

- 决定：**签名保持 `Partial<Settings>` 不动**（契约层优先，规格明写「一个字都别改」）；运行时照样浅合并；测试里用一次显式断言绕过类型层：
  ```ts
  const patch = { enabledPages: { search: false } } as Partial<Settings>;
  ```
- 断言是必要的：如果测试改成传全量 `{...defaultSettings().enabledPages, search:false}`，那么「浅合并」和「整体替换」的结果完全一样，这条用例就测不出差别了。
- 备选方案（未采用）：把参数类型放宽成 `Partial<Omit<Settings,'enabledPages'>> & { enabledPages?: Partial<Settings['enabledPages']> }`。可读性更好，但违反「签名一字不改」，且会让 reviewer/其它 agent 对不上规格。**若 controller 认为可改 shared 侧的类型，这是更干净的修法。**

### 4.4 `LlmClient` 接口严格只保留 `complete`，没有加 `getJson`

见第 5 节第 1 条。

### 4.5 测试用例数比计划多（storage 15 个 vs 计划 6 个，llm 13 个 vs 计划 8 个）

多出来的都是规格点名要求但计划里没有的：null 回落、`enabledPages` 浅合并、`clearProfile` 同时清 watchLog、Anthropic 只取 text 段、响应体回显 Key 的脱敏、`AbortSignal` 超时断言等。没有为了凑数而写的空断言。

### 4.6 实现风格

沿用了仓库既有风格（中文注释解释「为什么」而不是「是什么」、单引号、2 空格缩进、LF 行尾）。所有新文件的行尾是 LF，与仓库既有文件一致（`core.autocrlf=true`，Git 会在提交时转 CRLF）。

---

## 5. 潜在问题（需要 controller 或其它 owner 处理，我不能自行修改）

### 1) `src/bg/router.ts` 与本批 `LlmClient` 契约不符 —— controller（batch F）自己修

`router.ts:145`：

```ts
const video = await loadVideoContext(client.getJson ? client : client, p.bvid);
```

- `client.getJson` 在 `LlmClient` 上不存在 → TS2339。
- 而且 `client.getJson ? client : client` 两个分支完全一样，是个语义上的空操作。
- `loadVideoContext` 的真实定义在 `src/content/index.ts:52`，签名是 `loadVideoContext(bvid: string)`（**一个参数**），router 这里传了两个参数。

**我没有给 `LlmClient` 加 `getJson` 方法**，理由是硬证据：计划 03/04/05 里所有下游 agent 的假客户端都是 `{ complete: vi.fn(async () => ...) }` 这种字面量对象，只要 `LlmClient` 多一个**必需**成员，这些 mock 全部编译不过。加成员会直接破坏下游批次；正确做法是 controller 在 router 里改成 `loadVideoContext(p.bvid)` 或传对参数。

### 2) `MSG.GET_WHITELIST` 在 `src/shared/messages.ts` 里不存在 —— shared 所有者（batch A）修

`router.ts:113` 用了 `case MSG.GET_WHITELIST:`，但 `src/shared/messages.ts` 的 `MSG` 里没有这一项 → TS2339。

本批任务明确要求「绝对不要碰 `src/shared/*`」，所以我没动。请 shared 侧补上 `GET_WHITELIST: 'GET_WHITELIST'`（顺便确认 popup 侧是否需要 `REMOVE_FROM_WHITELIST` 之类的反向操作，目前只有加没有删）。

### 3) 仓库级 `tsc --noEmit` 目前不绿，但错误不归本批

当前错误：

```
src/bg/router.ts(10,32): Cannot find module './profile-service'        ← batch C 未交付
src/bg/router.ts(11,33): Cannot find module './pipeline-service'      ← batch D 未交付
src/bg/router.ts(12,51): Cannot find module '../pipeline/wordlist-service' ← batch D 未交付
src/bg/router.ts(112,16): Property 'GET_WHITELIST' does not exist      ← shared 侧缺
src/bg/router.ts(144,53): Property 'getJson' does not exist on 'LlmClient' ← 见第 1 条
src/bg/router.ts(180,22) / (181,19): implicit any                     ← 上面缺失模块导致的连锁
```

等 batch C/D 交付、shared 补 `GET_WHITELIST`、router 修 `getJson` 之后应能归零。本批 6 个文件隔离类型检查退出码 0。

### 4) `chrome.storage.local` 的 `runtime.lastError` 未处理

`getJson/setJson/removeKey` 没有检查 `chrome.runtime.lastError`。正常路径下 `get`/`set`/`remove` 不会因为业务原因失败，但配额超限 / 扩展被禁用等情况下回调里会带 `lastError`，当前实现会静默当成成功（`get` 拿到空对象 → 回落默认值，看起来像「设置丢了」）。属于可接受的简化，但**建议在 01 收尾时补一行检查**（记 `console.warn`，注意不要打印 Key）。

### 5) 本批没有重试与并发限流

`openAiComplete` / `anthropicComplete` 是一次性请求，没有重试、没有并发上限。下游判定流水线会批量调 LLM（计划 04 里 `MAX_BATCH_ITEMS = 20`），同一时刻并发打供应商接口容易触发 429。建议在 llm 层加一个简单的「同 provider 串行 + 指数退避」，但**这超出了本批的签名契约**（不能改 `complete` 的形状），留给 pipeline/llm 层决定。

### 6) 仓库在任务执行中途被 controller 提交过一次

执行过程中 controller 提交了 `2896f23 feat: 新增共享契约层、存储层与 LLM 客户端双协议实现`，把当时的工作区快照（含我前 5 个文件）收进去了。此后我又做了 3 处改动（Key 脱敏 + 2 条测试），**当前工作区相对 HEAD 的未提交差异（属于本批的）**：

```
src/bg/llm/openai.ts        | 11 ++++++++++-
src/bg/llm/anthropic.ts     | 11 ++++++++++-
tests/unit/llm-client.test.ts | 11 +++++++++++
```

（`git diff --stat` 里还有 `src/bg/index.ts`，那是 controller 自己的文件，不属于本批。）
请 controller 再提交一次收尾。另外 `src/bg/storage.ts` 与 `tests/unit/storage.test.ts` 已在 `2896f23` 里，无差异。

### 7) 无其它阻塞

`src/shared/types.ts` / `src/shared/constants.ts` 的类型我全部按现有定义 import，没有重复定义，也没有修改。

---

## 6. 交接给下游批次的一句话

- 存储层：`getSettings()` 永远返回完整 `Settings`（存量和默认值合并过），`saveSettings(patch)` 是补丁语义且 `enabledPages` 浅合并。**注意 `Partial<Settings>` 的类型毛刺**（见 4.3），要单独关某个页面开关时需要一次断言。
- LLM 层：所有下游模块统一用 `createLlmClient(config)` 拿到的 `LlmClient`，只有 `complete(prompt, { system, maxTokens })` 一个方法；解析统一走 `parseJsonResponse<T>(raw)`（抠不出返回 null，不抛，**调用方必须自己降级**）。假客户端写成 `{ complete: vi.fn(async () => '...') }` 即可。
