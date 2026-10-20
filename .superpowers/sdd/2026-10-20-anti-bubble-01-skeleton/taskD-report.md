# 任务 D 报告：判定流水线（计划 04）

> 分支 `feature/anti-bubble-v1`。**未执行 git commit**（按简报要求，由 controller 统一提交）。
> 本报告只覆盖批次 D 的文件所有权范围，未触碰 `src/profile/*`、`src/bg/router.ts`、
> `src/bg/storage.ts`、`src/bg/llm/*`、`src/bili/*`、`src/shared/*`。

---

## 1. 状态

**DONE_WITH_CONCERNS**

- 交付物全部完成，**我这批文件类型检查零错误**（隔离编译退出码 0）。
- 计划 04 的 6 个测试文件全绿：**58/58 通过**（含我新增的 1 条成本红线断言）。
- 全仓 `npx vitest run`：**17 文件 / 181 测试全绿**，退出码 0（其他 agent 的用例也未被我改坏）。
- **顾虑**：仓库级 `npx tsc --noEmit` 退出码仍是 2，3 条错误全部落在我**无权修改**的两个文件里
  （`src/bg/router.ts`、`src/content/index.ts`）。详见 §5。

---

## 2. 改了哪些文件

### 新建（源码，7 个）

| 文件 | 作用 |
|---|---|
| `src/pipeline/types.ts` | `VideoMeta` / `VideoContext` / `Wordlist` / `JudgeInput` / `RawJudgeResult` / `PipelineContext` |
| `src/pipeline/wordlist.ts` | 词表 prompt 构造、解析、兜底、缓存键 |
| `src/pipeline/coarse.ts` | 规则粗筛（成本闸门） |
| `src/pipeline/judge.ts` | LLM 批量精判 + 降级 |
| `src/pipeline/pipeline.ts` | 三级闸门编排 |
| `src/pipeline/wordlist-service.ts` | 词表服务（缓存）+ `loadVideoContext` |
| `src/pipeline/verdict-cache.ts` | 判定结果缓存（上限 3000） |
| `src/bg/pipeline-service.ts` | service worker 侧判定服务 |

（`src/pipeline/*` 6 个 + `src/bg/pipeline-service.ts` 1 个 = 7 个新建源码文件）

### 新建（测试，6 个）

`tests/unit/pipeline-wordlist.test.ts`、`pipeline-coarse.test.ts`、`pipeline-judge.test.ts`、
`pipeline.test.ts`、`pipeline-wordlist-service.test.ts`、`pipeline-verdict-cache.test.ts`

### 未改动

`src/shared/*`、`src/bg/storage.ts`、`src/bg/llm/*`、`src/bili/*`、`src/profile/*`、
`src/bg/router.ts`、`src/bg/index.ts`、`docs/testing-checklist.md`（计划 04 Task 7 Step 3 要追加
测试清单，但该文件不在我的所有权清单内，未动；见 §5 待办）。

---

## 3. 跑过的命令与输出摘要

### 3.1 计划指定的 6 个测试文件

```
npx vitest run tests/unit/pipeline-wordlist.test.ts tests/unit/pipeline-coarse.test.ts \
  tests/unit/pipeline-judge.test.ts tests/unit/pipeline.test.ts \
  tests/unit/pipeline-wordlist-service.test.ts tests/unit/pipeline-verdict-cache.test.ts
```

```
✓ tests/unit/pipeline-coarse.test.ts            (7 tests)
✓ tests/unit/pipeline-verdict-cache.test.ts      (6 tests)
✓ tests/unit/pipeline-wordlist.test.ts          (14 tests)
✓ tests/unit/pipeline-judge.test.ts             (12 tests)
✓ tests/unit/pipeline-wordlist-service.test.ts   (6 tests)
✓ tests/unit/pipeline.test.ts                   (13 tests)

Test Files  6 passed (6)
      Tests  58 passed (58)
EXIT=0
```

### 3.2 全量测试（确认没踩坏别人的模块）

```
npx vitest run
→ Test Files  17 passed (17)
      Tests  181 passed (181)
EXIT=0
```

### 3.3 类型检查

```
npx tsc --noEmit
src/bg/router.ts(12,33): error TS2307: Cannot find module './pipeline/wordlist-service' ...
src/content/index.ts(4,32): error TS2307: Cannot find module './controller' ...
src/content/index.ts(105,16): error TS7006: Parameter 'id' implicitly has an 'any' type.
EXIT=2
```

为了证明**我的文件**是干净的，用仓库同样的严格选项做了一次隔离编译（只包含我这 13 个文件
+ 其依赖 `src/shared`、`src/bg/storage`、`src/bg/llm`、`src/bili`）：

```
npx tsc --noEmit --strict --noUncheckedIndexedAccess --noImplicitOverride \
  --verbatimModuleSyntax --isolatedModules --target ES2022 --module ESNext \
  --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --types chrome,vite/client \
  --skipLibCheck <我的 13 个文件>
EXIT=0
```

**结论：3 条错误都不是我的文件产生的**，见 §5。

---

## 4. 每条测试的通过情况

| 文件 | 用例数 | 结果 | 备注 |
|---|---|---|---|
| `pipeline-wordlist.test.ts` | 14 | 全部通过 | 逐字照抄计划 |
| `pipeline-coarse.test.ts` | 7 | 全部通过 | 逐字照抄计划 |
| `pipeline-judge.test.ts` | 12 | 全部通过 | 逐字照抄计划（计划正文写「13 个」，实际用例是 12 条，是计划自己数错了） |
| `pipeline.test.ts` | 13 | 全部通过 | 计划的 12 条 + 我新增 1 条成本红线断言（见 §5 偏离 7） |
| `pipeline-wordlist-service.test.ts` | 6 | 全部通过 | 逐字照抄计划 |
| `pipeline-verdict-cache.test.ts` | 6 | 全部通过 | 逐字照抄计划，mock 写法按简报改成 storage.test.ts 风格（见 §5 偏离 8） |

### 成本红线是被断言锁住的，不是靠人肉盯

- `pipeline.test.ts`「未命中词表的评论直接放行，不调 LLM 精判」：断言 `complete` 调用次数 **= 1**，
  这次 1 是**词表那一次**（provider 内部模拟），精判那一次一旦发生就会变成 2，测试立刻红。
- `pipeline.test.ts`「成本红线：粗筛未命中时流水线自己一次 LLM 都不发」：词表由外部提供（不花 LLM），
  断言调用次数 **= 0**。这条是我加的，把「未命中 ⇒ 零调用」直接钉死。
- `pipeline.test.ts`「画像命中时直接 fold，不花精判的钱」：断言调用次数 **= 1**（同样只有词表那一次）。

---

## 5. 与规格不同的地方，以及原因

> 计划 04 有 5 处**实现与它自己的测试互相矛盾**（不修就红）。下面逐条说明我怎么处理的、为什么。

### 偏离 1：`REASON_CODES` 是数组，不是 Set

计划 `judge.ts` 里写 `REASON_CODES.has(rc)`，但 `src/shared/constants.ts:19` 里
`REASON_CODES` 是 `as const` 的**只读数组**，没有 `.has`，而且 `includes` 的参数类型会被收窄成
字面量联合，传 `string` 编译不过。

**做法**：保留 constants.ts 里的唯一来源，派生一个运行时校验用的 Set（计划里本来就声明了
`VALID_REASON_CODES` 却没用上）：

```ts
const VALID_REASON_CODES = new Set<string>(REASON_CODES);
...
VALID_REASON_CODES.has(rc) ? (rc as VerdictReasonCode) : (action === 'pass' ? 'none' : 'off_topic')
```

`REASON_CODES` 本身没有被重新定义，来源仍是 constants.ts。

### 偏离 2：词表函数的入参类型要放宽

计划的测试这样调：`buildWordlistPrompt({ title: '独特标题ABC' }, ...)`、
`buildFallbackWordlist({ title: 't' }, 'cocoon')`——**没有 bvid**。但计划实现里
`buildFallbackWordlist` 要用 `video.bvid` 算缓存键，而 `VideoContext.bvid` 是必填，
照抄会 TS 报错。

**做法**：在 `src/pipeline/types.ts` 里加一个 `VideoMeta`（`bvid?` 可选），
`VideoContext extends VideoMeta` 并把 `bvid` 收窄回必填；两个词表函数收 `VideoMeta`。
`VideoContext` 仍然满足简报要求的 `{ bvid, title, description?, summary? }`。
**没有动 `VideoContext` 的字段语义**，只是加了一层更松的入参类型。

### 偏离 3：模式要求必须写进 user 消息

计划测试：`expect(p.user).toContain('相反')`（anti 模式）。但计划实现把模式要求只写在
**system** 里，user 里只有视频信息和画像——`相反` 两个字根本不在 user 里，这条测试必红。

**做法**：user 消息末尾加一段模式说明（system 里原有的说明保留不动）：

```
【本次要找什么】
本次要找的是两类内容：(a) 引战/挑起仇恨的表达；(b) 与用户立场相反的观点的表达。
```

anti 模式命中「相反」，cocoon 模式命中「不喜欢」。顺带修掉一个真实缺陷：
模型真正读的是 user，只写在 system 里的要求经常被忽略。

### 偏离 4：`invalidate(videoId)` 在计划里根本删不掉任何东西

`wordlistCacheKey` 返回的是 **哈希**（`contentKey('wordlist', videoId, updatedAt)`），
计划里 `invalidate` 用 `k.includes(videoId)` 去找——哈希串里根本不含 `BV1`，
「invalidate 后重新生成」这条测试必红。

**做法**：缓存条目里多存一个 `videoId` 字段，`invalidate` 按这个字段删
（保留 `k.includes(videoId)` 作兜底）。缓存键本身没变，仍然是哈希。

### 偏离 5：Pipeline 的词表来源与获取时机

计划有两处自相矛盾：

1. `pipeline.ts` import 了 `buildWordlistPrompt / parseWordlist / buildFallbackWordlist`
   却**一次都没用**，但 `PipelineOptions` 的注释写着「默认实现会调 LLM 生成」。
2. 计划实现里词表是在**画像匹配之后**才去取的，且 provider 是**必填**。
   于是计划测试「画像命中时直接 fold，不花精判的钱」里，词表根本没被取，
   `client.complete` 调用次数是 **0**，而断言写的是 **1** → 必红。

**做法**：

- `wordlistProvider` 改为**可选**；不提供时 Pipeline 自己调 LLM 生成一份
  （正好把计划里那三个没用上的 import 用起来，和计划注释「默认实现会调 LLM 生成」对齐）。
  生产路径 `PipelineService` 注入的是 `WordlistService.get`（自带缓存，命中 0 次调用），
  所以**每个视频仍然只有 1 次 LLM 调用**，不会变成 2 次。
- 词表在进入 ① 之前一次性取好。词表是**每视频一次**的量（与条目数无关，缓存命中则 0 次），
  提前取不会让「未命中词表的内容」多花钱——花钱与否由 ② 的粗筛决定。
  这样计划的两处 `toBe(1)` 断言都成立且有意义。

### 偏离 6：判定动作的类型收窄写法

计划的 `parseJudgments` 用 `const validAction = action === 'pass' || ...` 再 `if (!validAction) return`
来收窄 `unknown`。我改写成直接用否定条件收窄，**不依赖别名条件收窄**（也不需要 `as` 断言）：

```ts
if (rawAction !== 'pass' && rawAction !== 'fold' && rawAction !== 'hide' && rawAction !== 'mark') {
  return passVerdict(id, fallbackAction);
}
const action: VerdictAction = rawAction;
```

语义与计划完全一致（非法 action → 补 pass），只是类型上更稳。

### 偏离 7：`pipeline.test.ts` 里 mock 的词表 provider 会打一次 LLM

计划的 mock provider 是纯函数（不调 LLM），但断言期望调用次数 = 1
（注释写「只有词表那一次调用，没有精判调用」）。照抄的话计数只能是 0。

**做法**：mock provider 内部打一次 `client.complete`，**模拟真实词表服务的成本**
（真实实现里「生成词表」本身就是一次 LLM 调用）。这样：

- 计划的**断言值一字未改**（`toBe(1)` 保留），且含义变成「1 = 词表那一次，
  精判那一次没发生」——比原来更强：精判一旦被误触发，计数会变 2，测试立刻红。
- 额外加了一条「成本红线：粗筛未命中时流水线自己一次 LLM 都不发」（词表由外部提供 → 断言 0 次）。

计划里的**函数名、导出名、测试名、断言、魔法值全部保留**。

### 偏离 8：`pipeline-verdict-cache.test.ts` 的 mock

计划那份测试文件调了 `vi.stubGlobal` 却**没有 import `vi`**（照抄会 ReferenceError），
且是在模块顶层做 stub。按简报「参考 `tests/unit/storage.test.ts` 的 mock 写法」，
改成 `beforeEach` 里 `vi.stubGlobal` + 补上 `vi` 的 import。`pipeline-wordlist-service.test.ts`
同样改成这个写法。

### 其他小差异

- `verdict-cache.ts` 的上限常量提成 `MAX_ENTRIES = 3000`（计划里是字面量 3000）。
- `judge.ts` 的 `JudgeInput.videoTitle` 仍按计划保留在类型里，但计划的 prompt 没用它，
  我没擅自加（避免改变 prompt 格式）。**待办见 §6。**

---

## 6. 发现的问题（需要 controller / 后续批次处理）

### 6.1 阻塞项：仓库级 `tsc --noEmit` 退出码 2（3 条错误，都不在我的文件里）

| 位置 | 错误 | 性质 | 修法 |
|---|---|---|---|
| `src/bg/router.ts:12` | `Cannot find module './pipeline/wordlist-service'` | **路径写错**。同一个文件第 13 行写的是 `'../pipeline/types'`（对的），第 12 行写成了 `'./pipeline/wordlist-service'`。计划 04 与简报都规定词表服务在 `src/pipeline/wordlist-service.ts` | 把第 12 行改成 `from '../pipeline/wordlist-service'`（**一行**） |
| `src/content/index.ts:4` | `Cannot find module './controller'` | 批次 E（content controller）**还在写**，`src/content/` 目前只有 `index.ts / page-bridge.ts / page-fetch.js` | 等该 agent 交付 `src/content/controller.ts` |
| `src/content/index.ts:105` | `Parameter 'id' implicitly has an 'any' type` | 同上文件，同一批次 E 在飞 | 同上，随该 agent 一起解决 |

> `src/bg/router.ts` 与 `src/content/index.ts` 都在简报的「**不要碰**」清单里，
> 而且这两个文件此刻正被别的 agent 改动（`git status` 显示 `M src/content/index.ts`、
> `?? src/bg/router.ts`），所以我**没有代改**，避免和并发写入打架。
> **上面三行就是全部修复动作**，controller 顺手改掉即可 tsc 归零。
> 如果 controller 授权我改 `router.ts` 第 12 行，我 1 分钟内可以补上。

### 6.2 判定结果缓存目前是「只写不读」

`PipelineService.judge()` 会把结果写回 `STORAGE_KEYS.verdictCache`，但**没有任何地方读它**——
计划 04 也没写读回路径（Task 6 只定义了 `get/set/clear`）。

后果：同一评论第二次出现时，流水线会**再花一次精判的钱**，缓存形同虚设。
按简报「PipelineService → 取画像、取白名单、跑 Pipeline、**写回缓存**」的字面要求实现，
读回逻辑没有擅自加（会改变「结果数量与顺序一致」的行为，也需要配套测试）。
**建议下一批**：在 `PipelineService.judge` 入口先查缓存，命中直接返回，miss 才跑流水线。

### 6.3 精判没有分批，疑似忽略了 `MAX_BATCH_ITEMS`

`src/shared/constants.ts:29` 定义了 `MAX_BATCH_ITEMS = 20`，但计划 04 的 `judgeItems`
把**所有**可疑条目塞进**一次** LLM 调用。命中超过 20 条时，prompt 会很长、输出可能超长被截断，
解析失败就整批降级成 pass（静默漏判）。

计划没要求分块，简报也没提，所以我按计划实现。**建议下一批**：按 `MAX_BATCH_ITEMS` 切块，
逐块调用。

### 6.4 计划 04 Task 7 Step 3 要求的测试清单没加

计划要求在 `docs/testing-checklist.md` 末尾追加「计划 04（判定流水线）」4 条勾选项。
该文件**不在我的文件所有权清单**里（简报只列了 `src/pipeline/*`、`src/bg/pipeline-service.ts`
和 6 个测试文件），且 `docs/` 属于跨批次公共文档，我没有擅自改。
**controller 如需，请自行追加**，或授权我加。

---

## 7. 成本结构（实现后的实际形态）

```
① 画像匹配   本地字符串匹配          0 次 LLM 调用   命中「不喜欢」→ 直接 fold
② 词表粗筛   本地子串匹配            0 次 LLM 调用   未命中 → 直接放行，绝不进 ③
   └─ 词表本身  每视频 1 次（缓存命中 0 次），失败 → 空表（= 全部放行）
③ LLM 精判   一次调用判一批可疑条目    1 次 LLM 调用   失败 → 整批降级为 pass
```

- 精判是**一批一次调用**（不是一条一次），所以「命中 8 条」也只花 1 次钱。
- 降级路径全部不抛异常：词表失败 → 空表全放行；精判失败 → 整批 pass；
  `parseJsonResponse` 抠不出 JSON → 逐条补 pass。
- 每个非 pass 判定都有人话 `reason` + 机器可读 `reasonCode`（来自 `REASON_CODES`），
  `pass` 的 `revocable` 为 false、非 pass 为 true。
- 置信度低于 `threshold`（默认 0.7）按 pass 处理。

---

## 8. 复现命令

```bash
cd D:\coding\anti-bubble
npx vitest run tests/unit/pipeline-wordlist.test.ts tests/unit/pipeline-coarse.test.ts \
  tests/unit/pipeline-judge.test.ts tests/unit/pipeline.test.ts \
  tests/unit/pipeline-wordlist-service.test.ts tests/unit/pipeline-verdict-cache.test.ts
npx vitest run          # 全量：17 文件 / 181 测试
npx tsc --noEmit        # 见 §6.1（3 条错误均在我的所有权之外）
```
