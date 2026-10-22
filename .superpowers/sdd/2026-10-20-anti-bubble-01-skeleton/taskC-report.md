# 批次 C 报告：画像子系统（计划 03）

- 仓库：`<repo>`
- 分支：`feature/anti-bubble-v1`
- 执行时间：2026-10-20 13:15–13:25
- 未执行 `git commit`（按要求由 controller 统一提交）

---

## 1. 交付的文件

### 源码（5 个）

| 文件 | 内容 |
| --- | --- |
| `src/profile/merge.ts` | `HALF_LIFE_DAYS`、`sampleWeight`、`mergeSamples`（按 id 去重先到先留 + 按 `collectedAt` 倒序） |
| `src/profile/rules.ts` | `buildRuleProfile`（不依赖 LLM 的分区计数画像）、`TOPIC_KEYWORDS` |
| `src/profile/induce.ts` | `buildInductionPrompt`、`parseProfile`、`induceProfile`（LLM 失败降级为规则画像，不抛异常） |
| `src/profile/collect.ts` | `toSample`、`collectColdStart`、`collectIncremental` |
| `src/bg/profile-service.ts` | `class ProfileService`（`get`/`refresh`/`record`/`clear`）、`PROFILE_MAX_AGE_MS`、`WATCH_SAMPLE` |

### 测试（5 个）

`tests/unit/profile-merge.test.ts`、`profile-rules.test.ts`、`profile-induce.test.ts`、
`profile-collect.test.ts`、`profile-service.test.ts`

**未触碰**任何他人所有权范围内的文件（`src/shared/*`、`src/bg/storage.ts`、`src/bg/llm/*`、
`src/bili/*`、`src/bg/router.ts`、`src/bg/index.ts`、`src/content/*` 等）。

---

## 2. 验证结果

### 2.1 目标测试（要求命令）

```
cd <repo>
npx vitest run tests/unit/profile-merge.test.ts tests/unit/profile-rules.test.ts tests/unit/profile-induce.test.ts tests/unit/profile-collect.test.ts tests/unit/profile-service.test.ts
```

输出摘要：

```
 ✓ tests/unit/profile-merge.test.ts      (8 tests)  3ms
 ✓ tests/unit/profile-rules.test.ts      (7 tests)  3ms
 ✓ tests/unit/profile-collect.test.ts    (5 tests)  3ms
 ✓ tests/unit/profile-induce.test.ts     (11 tests) 5ms
 ✓ tests/unit/profile-service.test.ts    (9 tests)  4ms

 Test Files  5 passed (5)
      Tests  40 passed (40)
   Duration  336ms
```

**40/40 全绿。** 逐条用例：

| 文件 | 通过数 | 用例 |
| --- | --- | --- |
| profile-merge | 8/8 | 同 id 只留一条、保留先出现的、不同 id 都保留、合并幂等、新样本权重更大、权重单调递减、半衰期≈0.5、权重 ∈ [0,1] |
| profile-rules | 7/7 | 分区计数成标签、权重归一化 0-1、最高权重=出现最多分区、空样本不抛错、sampleCount、updatedAt ISO、无空标签 |
| profile-induce | 11/11 | prompt 含标题/分区、有 system 段、超量截断、解析合法 JSON、解析 ```json 包裹、解析失败回落、补齐缺失字段、LLM 成功、LLM 抛错降级、LLM 垃圾降级 |
| profile-collect | 5/5 | toSample 转换、缺分区用空串、冷启动拉历史转样本、includeHistory=false 不发历史请求、拉取失败返回空数组 |
| profile-service | 9/9 | get 返回 null、refresh 后能取到画像、未过期不重调 LLM、force 强制归纳、观看不足阈值不记样本、超过阈值记样本、样本数增加、clear 后消失、24 小时常量 |

> 计划文档写的用例数与实际代码块不符：induce 实际 11 条（计划写 13）、service 实际 9 条（计划写 8）。以计划里的**代码块**为准，实际断言全部照抄。

### 2.2 全量单测（回归）

```
npx vitest run
```
→ **11 个文件 / 123 个测试全绿**（含 wbi、bili-client、bili-api、storage、llm-client、page-bridge 等他人模块，无回归）。

### 2.3 类型检查

**全项目** `npx tsc --noEmit` 当前退出码 **2**，错误**全部在他人所有权文件里**（并发推进中，错误集合会随各方落地而变化；最后一次检查时为）：

```
src/bg/router.ts(12,33):      TS2307: Cannot find module './pipeline/wordlist-service'  ← 批次 D 未落地
src/bg/storage.ts(76,43):     TS2304: Cannot find name 'SettingsPatch'                  ← 批次 A（storage.ts）
src/content/index.ts(4,32):   TS2307: Cannot find module './controller'                 ← 批次 E 未落地
src/content/index.ts(105,16): TS7006: Parameter 'id' implicitly has an 'any' type      ← 批次 E
```

> 期间 `src/bg/router.ts` 的 `MSG.GET_WHITELIST` 报错已被 controller 修掉，
> 批次 D 的 `src/bg/pipeline-service.ts` 已落地。**批次 C 自己的文件从未出现在错误列表里。**

**我这批文件自身 0 错误**。用仓库同样的严格开关只编译我这 10 个文件（+ 其传递依赖）验证：

```
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution bundler \
  --lib ES2022,DOM,DOM.Iterable --types chrome --strict --noUncheckedIndexedAccess \
  --noImplicitOverride --verbatimModuleSyntax --isolatedModules --resolveJsonModule \
  --skipLibCheck src/profile/*.ts src/bg/profile-service.ts tests/unit/profile-*.test.ts
```
→ **退出码 0**。

结论：全项目 tsc 转绿只差 D/E/F 三方的文件落地，与批次 C 无关。等他们落地后重跑即可（controller 收尾时统一跑）。

---

## 3. 与计划/简报的偏差（含原因）

计划内部存在**两处自相矛盾**：计划的「实现代码块」与它自己的「测试代码块」互相打脸。处理原则：**测试断言逐字保留**（那是验收标准），实现侧做最小修正。

### 3.1 `src/profile/induce.ts`：删掉 `if (samples.length === 0) return fallback;`

- 计划实现里有这一行（空样本直接返回规则画像，不问 LLM）。
- 但计划自己的 `profile-service.test.ts` 要求：**存储里一条样本都没有时**，
  - `'refresh 后能取到画像'` 期望 `interests.length > 0`；
  - `'force 会强制重新归纳'` 期望 LLM 调用次数增加。
  两者都要求 refresh **必须真的问一次 LLM**。空样本短路会让这两条直接失败
  （interests 为空、调用次数不增）。
- 处理：删掉短路，**空样本也问 LLM**；提示词里本来就有「不要编造样本里没有的偏好」，
  模型在无样本时给空画像是预期行为；LLM 挂了仍然降级为规则画像（不抛异常）。
- 另一种做法是把这两条测试改掉——但那等于把验收标准改松，不做。

### 3.2 `src/profile/induce.ts`：`stanceHints` 的类型谓词修正

计划的写法 `Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(...))`
在 `strict` 下推导出 `{ [k: string]: unknown }`，**赋给 `Record<string, string>` 会报 TS2322**，
即计划原样抄下来 `tsc` 不过。改为在 filter 上加类型谓词：

```ts
.filter((e): e is [string, string] => typeof e[1] === 'string')
```

行为不变（只保留字符串值、最多 8 项），类型正确。

### 3.3 `src/bg/profile-service.ts`：`refresh(client?, opts?)`

- 计划的签名是 `refresh(client: LlmClient, opts)`（client 必填），
  但计划自己的测试写的是 `svc.refresh(c)` 与 `svc.refresh(c, {force:true})`，
  简报也要求「传了 client 就用传的，没传就用构造时的」。
- 处理：`refresh(client?: LlmClient, opts: { force?: boolean } = {})`，内部 `client ?? this.client`。
  计划里 router 片段的 `svc.refresh(createLlmClient(cfg), { force: true })` 依然成立。

### 3.4 `src/bg/profile-service.ts`：`record` 在已有画像时同步 `sampleCount`

- 简报要求「`record` 在画像还不存在时，用 `buildRuleProfile` 写一份规则画像」。
- 但计划自己的测试 `'记录后画像样本数增加'` 期望两次 record 后 `sampleCount >= 2`；
  计划的实现只在「画像不存在」时写规则画像，第二次 record 时画像已存在 → `sampleCount` 停在 1 → 测试失败。
- 处理：画像不存在 → 写规则画像（照简报）；画像已存在 → **只同步 `sampleCount`**，
  不覆盖 `interests`/`dislikes`/`stanceHints`（那是 LLM 归纳的成果，用分区计数顶掉等于把归纳扔了）。
- 同时**故意不动 `updatedAt`**：它决定「画像是否过期」。每次观看都刷新它，
  画像就永远不过期，非 force 的 refresh 路径将永远不跑。

### 3.5 `src/bg/profile-service.ts`：静态 import + 去掉未用 import

- 计划的 `record` 里用 `await import('../profile/rules')` 动态引入 → 改成静态 import（无循环依赖，Vite 打包更干净）。
- 计划 import 了 `contentKey`（`src/shared/hash`）和 `collectColdStart` 但**从未使用** → 删掉
  （`tsc` 不开 `noUnusedLocals` 所以不报错，但留着是死引用）。`collectColdStart` 的去留见第 4 节。

### 3.6 `src/profile/rules.ts`：补上 `TOPIC_KEYWORDS`

- 计划的 Interfaces 明确声明本模块产出 `TOPIC_KEYWORDS: Record<string, string[]>`（分区名→题材标签映射），
  但实现代码块里没有 → 按接口契约补上。
- **不用于** `buildRuleProfile`：规则画像的标签必须保持分区原名
  （计划测试 `'最高权重的兴趣是出现最多的分区'` 期望 tag === '游戏'），已在注释里写明原因。

### 3.7 `tests/unit/profile-collect.test.ts`：mock 补一份 nav 响应

- 计划的 mock 只按 URL 子串匹配 `/x/v2/history/cursor`，nav 请求落到默认分支 `{data: null}`。
- 但 `fetchHistory` 走 `getPaged` → `getSigned`，**WBI 签名必须先从 `/x/web-interface/nav` 拿 mixin key**；
  拿不到 → `getSigned` 直接返回 null → 历史请求根本发不出去 → 计划的断言
  `samples.length > 0` / `samples[0].id === 'BV1'` 必然失败。
- 处理：mock 里加一条 `/x/web-interface/nav` 固定 `wbi_img` 响应（真实环境由 B 站下发、24h 轮换）。
  **计划的断言、输入数据、magic value 一字未改**，只补了签名所必需的前置响应。
- 另两处行为已实测确认：`includeHistory:false` 时全程不发 `/x/v2/history/cursor`；
  拉取失败时 `collectColdStart` 返回 `[]`（BiliClient 内部重试 3 次后返回 null，api 层转空数组）。

---

## 4. 发现的问题 / 需要 controller 知道的接缝

1. **冷启动采集没有接进 `ProfileService`（重要）**
   计划的 Task 5 接口清单写着「Consumes: `collectColdStart`」，但计划自己的实现代码块也**没有**调用它——
   `refresh` 只消费 `STORAGE_KEYS.watchLog`。简报给的构造签名是 `(client: LlmClient, now)`，
   **没有放 BiliClient 的位置**，所以我按现状实现（`refresh` 读 watchLog）。
   接缝建议：拿到 BiliClient 的一侧（content/controller 或 bg）先
   `const cold = await collectColdStart(bili); await setJson(STORAGE_KEYS.watchLog, cold)`，
   再 `svc.refresh(client, { force: true })` —— 画像就能吃到冷启动样本。
   当前 `src/bg/router.ts` 的 `REFRESH_PROFILE` 分支**没有**这一步，
   所以首次画像只会来自本次会话记录下来的观看。
   （我没有改 router.ts，它属于 controller；若希望 ProfileService 内部直接冷启动，
   需要给 `ProfileService` 加一个可注入的采集函数，属于接口变更，请 controller 决定。）

2. **`record` 生成的规则画像会挡住 24 小时内的非 force 刷新**
   `record` 首次写画像时 `updatedAt = now`，于是「未过期 → 直接返回现有画像」的规则
   会让此后 24 小时内的自动 refresh 都不问 LLM。
   用户手动点「重新归纳」走的是 `refresh(client, { force: true })`（router 已这样写），不受影响。

3. **画像的 `updatedAt` 与 `sampleCount` 语义不同**：`updatedAt` = 画像内容最后更新时间（决定过期），
   `sampleCount` = 累计样本数（会随每次 record 增长）。两者在 record 时是分开维护的。

4. **计划文档的用例数记账有误**：induce 11 条（计划写 13）、service 9 条（计划写 8）。

---

## 5. 约束遵守情况

| 约束 | 落实 |
| --- | --- |
| 画像只存 `chrome.storage.local`，禁用 `storage.sync` | ✅ 全部经 `src/bg/storage.ts`（仅 local）。`grep` 全项目无 `storage.sync` 调用 |
| LLM 失败降级为规则画像、绝不抛异常 | ✅ `induceProfile` 的 try/catch → `buildRuleProfile`；`parseProfile` 解析失败回 fallback |
| 测试不消耗 LLM 额度 | ✅ 全部用假 `LlmClient`（`complete` 返回预设字符串 / 直接 throw） |
| 测试 mock `chrome.storage.local`（callback 风格） | ✅ 沿用 `tests/unit/storage.test.ts` 的写法 |
| 不 npm install 新包 | ✅ 零新增依赖 |
| 不执行 git commit | ✅ 只写文件 + 跑测试 |
| 只碰自己所有权内的文件 | ✅ 见第 1 节 |
| `strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax` | ✅ 本批文件 scoped tsc 退出码 0（重导出/类型导入用 `import type`） |

---

## 6. 复现命令

```bash
cd <repo>
npx vitest run tests/unit/profile-merge.test.ts tests/unit/profile-rules.test.ts tests/unit/profile-induce.test.ts tests/unit/profile-collect.test.ts tests/unit/profile-service.test.ts
npx vitest run            # 全量 123/123
npx tsc --noEmit          # 全项目（当前卡在批次 D/E/F 的文件，批次 C 自身干净）
```
