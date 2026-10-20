# Task E 报告：适配器与动作层（计划 05）

- 计划：`docs/superpowers/plans/2026-10-20-anti-bubble-05-adapters.md`（Task 1~7 的代码部分）
- 简报：`.superpowers/sdd/2026-10-20-anti-bubble-01-skeleton/taskE-brief.md`
- 仓库：`D:\coding\anti-bubble`　分支：`feature/anti-bubble-v1`
- 执行时间：2026-10-20 13:19–13:30
- 状态：**DONE_WITH_CONCERNS**
  （本批 87 个用例全绿、仓库级 `tsc --noEmit` 退出码 0；
  顾虑集中在 3 处「与计划参考实现不同」的决定，以及 2 项需要 controller 接手的事，见第 5、6 节。）

**没有执行任何 git commit**（按要求留给 controller）。

---

## 1. 改了哪些文件

只创建了简报「你的文件所有权 → 创建」清单里的 13 个文件，**没有碰任何别人的文件**。

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `src/adapters/types.ts` | 新建 | `Adapter` 接口（`page` + `collect(root)`），硬兜底约定写进注释 |
| `src/adapters/search.ts` | 新建 | `extractBvid()` + `searchAdapter` |
| `src/adapters/video.ts` | 新建 | `extractBvidFromPageUrl()` + `videoAdapter`（旧版 `.reply-item[data-rpid]`） |
| `src/adapters/feed.ts` | 新建 | `feedAdapter`（复用 `.bili-video-card` 选择器） |
| `src/adapters/index.ts` | 新建 | `getAdapter(page)` 分发；`unknown → null` |
| `src/actions/fold.ts` | 新建 | `CSS_PREFIX`、`injectStyles()`、`resolveTarget()`、`applyFold()` |
| `src/actions/mark.ts` | 新建 | `applyMark()`（只加标识，不隐藏） |
| `src/actions/recommend.ts` | 新建 | `RecommendItem` + `renderRecommendations()`（独立区块 + 每条带「为什么」） |
| `src/actions/index.ts` | 新建 | 动作层 barrel |
| `src/recommend/recall.ts` | 新建 | `recallOpposite()`、`mineCommentOpposition()`，并转出 `judgeOpposition` |
| `src/recommend/opposition.ts` | 新建 | 阶段二立场精排：`buildOppositionPrompt()` + `judgeOpposition()` |
| `src/content/controller.ts` | 新建 | `PageController`、`ControllerDeps`、`detectPageType()` |
| `tests/fixtures/{search,video,feed}.html` | 新建 | 三份 DOM fixture（逐字取自计划） |
| `tests/unit/adapter-search.test.ts` | 新建 | 13 个用例 |
| `tests/unit/adapter-video.test.ts` | 新建 | 12 个用例 |
| `tests/unit/adapter-feed.test.ts` | 新建 | 9 个用例 |
| `tests/unit/actions-fold.test.ts` | 新建 | 13 个用例 |
| `tests/unit/actions-mark.test.ts` | 新建 | 12 个用例 |
| `tests/unit/recommend-recall.test.ts` | 新建 | 9 个用例 |
| `tests/unit/content-controller.test.ts` | 新建 | 19 个用例 |

### 导出签名（供下游对齐）

```ts
// src/adapters/types.ts
export interface Adapter { page: PageType; collect(root: ParentNode): ContentItem[]; }

// src/adapters/search.ts
export function extractBvid(href: string): string | null;
export const searchAdapter: Adapter;
// src/adapters/video.ts
export function extractBvidFromPageUrl(url: string): string | null;
export const videoAdapter: Adapter;
// src/adapters/feed.ts
export const feedAdapter: Adapter;
// src/adapters/index.ts
export function getAdapter(page: PageType): Adapter | null;

// src/actions/fold.ts
export const CSS_PREFIX = 'ab';
export function injectStyles(root: ParentNode): void;
export function resolveTarget(root: ParentNode, itemId: string): Element | null;
export function ownerDoc(root: ParentNode): Document;
export function applyFold(root: ParentNode, itemId: string, verdict: Verdict, onRevoke: (id: string) => void): boolean;
// src/actions/mark.ts
export function applyMark(root: ParentNode, itemId: string, verdict: Verdict): boolean;
// src/actions/recommend.ts
export interface RecommendItem { bvid: string; title: string; author: string; reason: string; url: string; }
export function renderRecommendations(root: ParentNode, anchor: Element, items: RecommendItem[]): boolean;

// src/recommend/recall.ts
export async function recallOpposite(c: BiliClient, keywords: string[], maxItems?: number): Promise<SearchItem[]>;
export async function mineCommentOpposition(c: BiliClient, oid: number, maxComments?: number): Promise<string[]>;
export { judgeOpposition, buildOppositionPrompt } from './opposition';
// src/recommend/opposition.ts
export async function judgeOpposition(client: LlmClient, current: { title: string; stance: string }, candidates: SearchItem[]): Promise<RecommendItem[]>;

// src/content/controller.ts
export interface ControllerDeps {
  url: string;
  send: (msg: unknown) => Promise<unknown>;
  settings?: Settings | null;
  video?: VideoContext | null;   // VideoContext 取自 src/pipeline/types.ts
  root?: ParentNode;
  onRevoke?: (id: string) => void;
}
export class PageController {
  items: ContentItem[];
  constructor(deps: ControllerDeps);
  start(): Promise<void>;
  stop(): void;
  showRecommendations(anchor: Element, items: RecommendItem[]): boolean;
}
export function detectPageType(url: string): PageType;
```

`src/content/index.ts`（controller 的文件，未改）的调用方式**已验证兼容**：
`new PageController({ url, send, settings, video, onRevoke })` 全部命中上面这个 `ControllerDeps`，
`await ctrl.start()` 正常返回。

---

## 2. 每条测试通过情况

命令：

```
cd D:\coding\anti-bubble
npx vitest run tests/unit/adapter-search.test.ts tests/unit/adapter-video.test.ts \
  tests/unit/adapter-feed.test.ts tests/unit/actions-fold.test.ts tests/unit/actions-mark.test.ts \
  tests/unit/recommend-recall.test.ts tests/unit/content-controller.test.ts
```

结果：**7 files / 87 tests 全绿**（`Test Files 7 passed (7)`、`Tests 87 passed (87)`）。

### 2.1 `tests/unit/adapter-search.test.ts` — 13 passed

| # | 用例 | 来源 | 结果 |
| --- | --- | --- | --- |
| 1 | 从绝对链接取 bvid | 计划 | PASS |
| 2 | 从协议相对链接取 bvid | 计划 | PASS |
| 3 | 带查询参数也能取 | 计划 | PASS |
| 4 | 非视频链接返回 null | 计划 | PASS |
| 5 | 空串返回 null | 计划 | PASS |
| 6 | 抽出两个视频卡片 | 计划 | PASS |
| 7 | 抽出正确的标题 | 计划 | PASS |
| 8 | 抽出正确的 bvid | 计划 | PASS |
| 9 | 抽出作者 | 计划 | PASS |
| 10 | item 的 kind 是 video | 计划 | PASS |
| 11 | context.page 是 search | 计划 | PASS |
| 12 | 空 DOM 返回空数组而不是抛错 | 计划 | PASS |
| 13 | 结构改版抽不到时返回空数组（硬兜底） | 计划 | PASS |

### 2.2 `tests/unit/adapter-video.test.ts` — 12 passed

计划 11 条全 PASS（取视频页 bvid / 非视频页 null / 空串 null / 抽出两条评论 / 跳过没有 rpid 的评论 /
抽出正确的 rpid / 抽出评论正文 / 抽出评论作者 / kind 是 comment / context.page 是 video /
空 DOM 返回空数组 / 结构改版抽不到时返回空数组）。
计划原文写「11 个测试」，实际是 **12** 条（计划正文自己列了 12 条），以正文为准。

### 2.3 `tests/unit/adapter-feed.test.ts` — 9 passed

计划 9 条全 PASS（抽出两个视频 / bvid / 标题 / context.page 是 feed / 空 DOM 返回空数组 /
getAdapter 四个分支）。

### 2.4 `tests/unit/actions-fold.test.ts` — 13 passed

| # | 用例 | 来源 | 结果 |
| --- | --- | --- | --- |
| 1 | 折叠后内容不可见 | 计划 | PASS |
| 2 | 插入一条说明行 | 计划 | PASS |
| 3 | 说明行里有理由 | 计划 | PASS |
| 4 | 找不到目标返回 false | 计划 | PASS |
| 5 | 点「仍要显示」会调用撤销回调 | 计划 | PASS |
| 6 | 撤销后内容恢复可见 | 计划 | PASS |
| 7 | 撤销后说明行被移除 | 补充 | PASS |
| 8 | 注入样式不会重复插入 | 计划 | PASS |
| 9 | 重复折叠同一条不会插两条说明行 | 补充 | PASS |
| 10 | 视频卡片也能被折叠（靠链接里的 bvid 反查） | 补充 | PASS |
| 11 | 视频卡片被折叠后也能撤销 | 补充 | PASS |
| 12 | 非法 id 不会拼进选择器，直接返回 false | 补充 | PASS |
| 13 | root 传元素（而不是 document）也能工作 | 补充 | PASS |

### 2.5 `tests/unit/actions-mark.test.ts` — 12 passed

计划 9 条全 PASS（给内容加标识 / 标识里含理由 / 不隐藏内容 / 找不到目标返回 false /
重复标识不会插两个 / 渲染出推荐条目 / 推荐里带「为什么」/ 空数组不渲染 / 链接指向对应 bvid）。
补充 3 条：不同内容各自都能被标识 / 视频卡片的标识挂在标题上 / 是独立区块不塞进原生推荐流里。全部 PASS。

### 2.6 `tests/unit/recommend-recall.test.ts` — 9 passed

计划 6 条全 PASS（多个关键词的结果合并去重 / 搜索失败返回空数组 / LLM 判不出的候选被剔除 /
LLM 判定为相反观点的候选被保留且带理由 / LLM 抛错时返回空数组 / 评论区挖掘失败返回空数组）。
补充 3 条：判定出的推荐带 bvid 与可点链接 / LLM 说了候选里没有的 bvid 就丢弃 /
挖到高赞评论作为检索入口。全部 PASS。

### 2.7 `tests/unit/content-controller.test.ts` — 19 passed

| # | 用例 | 来源 | 结果 |
| --- | --- | --- | --- |
| 1 | 未知页面不启动任何适配器 | 计划 | PASS |
| 2 | 总开关关闭时不判定 | 计划 | PASS |
| 3 | 页面级开关关闭时不判定该页 | 计划 | PASS |
| 4 | masterEnabled 为 false 时不判定 | 补充 | PASS |
| 5 | 抽不到内容时不发判定请求 | 补充 | PASS |
| 6 | 判定请求带上 items / mode / video | 补充（简报要求） | PASS |
| 7 | 没有视频上下文时 video 传 null | 补充（简报要求） | PASS |
| 8 | fold 判定会折叠对应内容 | 补充 | PASS |
| 9 | mark 判定只加标识不隐藏 | 补充 | PASS |
| 10 | 撤销会回调用 onRevoke | 补充 | PASS |
| 11 | 后台抛错时静默降级，不影响页面 | 补充（铁律 1） | PASS |
| 12 | stop() 之后不再执行动作 | 补充 | PASS |
| 13 | 反向推荐渲染成独立区块且每条带理由 | 补充 | PASS |
| 14~19 | 页面类型识别 6 条 | 计划 01 Task 8 | PASS |

**测试全部走 mock，零真实网络请求、零 LLM 调用、零额度消耗。**
（`BiliClient` 的 `getJson` 全是内存假实现；`LlmClient` 全是 `{ complete: vi.fn(...) }`。）

---

## 3. 跑的命令与输出摘要

### 3.1 本批指定测试

```
> npx vitest run tests/unit/adapter-search.test.ts tests/unit/adapter-video.test.ts \
    tests/unit/adapter-feed.test.ts tests/unit/actions-fold.test.ts tests/unit/actions-mark.test.ts \
    tests/unit/recommend-recall.test.ts tests/unit/content-controller.test.ts

 ✓ tests/unit/recommend-recall.test.ts  (9 tests) 6ms
 ✓ tests/unit/adapter-feed.test.ts     (9 tests) 20ms
 ✓ tests/unit/adapter-search.test.ts   (13 tests) 20ms
 ✓ tests/unit/adapter-video.test.ts     (12 tests) 23ms
 ✓ tests/unit/actions-fold.test.ts      (13 tests) 29ms
 ✓ tests/unit/actions-mark.test.ts      (12 tests) 29ms
 ✓ tests/unit/content-controller.test.ts (19 tests) 30ms

 Test Files  7 passed (7)
      Tests  87 passed (87)
```

### 3.2 全量回归（确认没踩别人的文件）

```
> npx vitest run

 Test Files  26 passed (26)
      Tests  280 passed (280)
```

### 3.3 构建（额外自检，非要求项）

```
> npx vite build

✓ 42 modules transformed.
✓ built in 162ms
BUILD_EXIT=0
```

`dist/` 已在 `.gitignore` 里，不污染工作区。

---

## 4. `tsc --noEmit` 的实际输出

```
> npx tsc --noEmit
TSC_EXIT=0
```

**没有任何输出，退出码 0。**

简报说「tsc 可能因为别的 agent 的文件没写完而报错」——实测**别的批次都已经交付完了**
（`src/pipeline/*`、`src/bg/profile-service.ts`、`src/bg/pipeline-service.ts` 都已存在），
所以仓库级类型检查是干净的，不需要动用「不用管」的豁免。

中途出现过一次只属于我的文件的类型错误，已修掉（见第 5.4 节）：
```
tests/unit/adapter-feed.test.ts(3,30): error TS2307: Cannot find module 'node:fs'
tests/unit/adapter-feed.test.ts(4,22): error TS2307: Cannot find module 'node:path'
tests/unit/adapter-feed.test.ts(8,32): error TS2304: Cannot find name '__dirname'
（search / video 三个测试文件同样 3 条）
tests/unit/content-controller.test.ts(111,17): error TS2352: Conversion of type 'undefined' to ...
tests/unit/content-controller.test.ts(111,37): error TS2493: Tuple type '[]' of length '0' has no element at index '0'
tests/unit/content-controller.test.ts(130,17): error TS2352: ...
tests/unit/content-controller.test.ts(130,37): error TS2493: ...
```

---

## 5. 与规格不同的决定，以及原因

计划里的代码块是「逐字要求」，以下 4 处是**有意偏离**，全部保持计划规定的
导出名、属性名（`data-ab-prefix`）、测试断言与魔法值不变，且都有测试覆盖。

### 5.1 `detectPageType` 放在 `src/content/controller.ts`，没有新建 `src/content/page.ts`

- **计划怎么写的**：计划 05 的 controller 写 `import { detectPageType } from './page'`，
  但计划 05 自己的 File Structure 里只列了 `src/content/controller.ts`，**从没说要创建 `page.ts`**。
  `src/content/page.ts` 是计划 01 Task 8 的产物。
- **实际情况**：按 `.superpowers/sdd/2026-10-20-anti-bubble-01-skeleton/progress.md` 的文件所有权表，
  `src/content/page.ts` 归 **batch A（contracts）**；batch A 的报告（`taskA-report.md`）明确写了
  它只交付了计划 01 的 Task 5、Task 6，**Task 8（`page.ts`）没交**。
  当前仓库里 `src/content/page.ts` 不存在。
- **为什么这么定**：简报明令「不要碰你的文件所有权之外的东西」，`page.ts` 不在我的清单里。
  为了不越界写别人的文件、也不留下 import 指向空气，我把计划 01 Task 8 的
  `detectPageType` **逐字**搬进 `src/content/controller.ts` 并导出。
  它是纯函数、无副作用，搬动不改变任何行为。
- **给 controller 的交接**：如果之后补上 `src/content/page.ts`（或决定把这段逻辑挪过去），
  只需要把 `src/content/controller.ts` 里的 `import { detectPageType } from './page'` 加回来、
  删掉本文件里的本地定义即可。**建议 controller 尽早定这件事**，否则仓库里会有两份实现。

### 5.2 动作层能命中「视频卡片」，不只是 `[data-rpid]`

- **计划怎么写的**：`applyFold` / `applyMark` 只用 `doc.querySelector('[data-rpid="${itemId}"]')` 找目标。
- **为什么必须改**：评论有 `data-rpid`，**视频卡片没有**——搜索页/推荐流抽出来的 `ContentItem.id`
  是 bvid。照计划原样实现，三个页面类型里有**两个（search / feed）永远折叠不了**，
  「搜索页：命中的结果被折叠」这条验收项直接不成立。
- **怎么改的**：新增 `resolveTarget(root, itemId)`：
  1. 先按 `[data-rpid="id"]` 找（评论路径，与计划完全一致）；
  2. 找不到再遍历 `a[href*="/video/"]`，用 `extractBvid(href) === itemId` 精确比对，
     命中就取 `link.closest('.bili-video-card')`。
  用链接里的 bvid 反查，**不需要往站点 DOM 上加任何属性**（不动站点原有结构）。
- **对计划断言的影响**：零。计划 7 条 fold 断言 + 5 条 mark 断言的 DOM 结构、属性名、
  期望值全部一字未改，全绿。另外补了 4 条用例覆盖视频卡片路径。
- **附带加固**：`resolveTarget` 用 `SAFE_ITEM_ID = /^[A-Za-z0-9_-]+$/` 挡了一道，
  免得将来有人把 LLM 返回的任意字符串拼进 CSS 选择器。

### 5.3 `applyMark` 的「重复标识」判定改成**按条目**，不是全局

- **计划怎么写的**：`if (doc.querySelector('[data-ab-prefix="ab-mark"]')) return true;`——全局查。
  也就是说：只要页面上已经有**任意一个**标识，**后面所有内容都不会再被标识**。
- **为什么必须改**：视频页同时出现多条「立场相反」评论是常态（正是反信息茧房模式的主场景），
  原写法会让第二条及以后的相反评论静默地拿不到标识——功能等于只有 1/N 生效。
- **怎么改的**：mark 元素上带 `data-item-id="<itemId>"`，判重改为
  `[data-ab-prefix="ab-mark"][data-item-id="<id>"]`。
- **对计划断言的影响**：零。计划那条「重复标识不会插两个」照样通过（同一个 id 插两次仍是 1 个）。
  另外补了「不同内容各自都能被标识」一条用例。

### 5.4 测试里 fixture 的读法从 `readFileSync` 换成 Vite `?raw` 导入

- **计划怎么写的**：`readFileSync(join(__dirname, '../fixtures/search.html'), 'utf8')`。
- **为什么必须改**：仓库的 `tsconfig.json` 里 `"types": ["chrome", "vite/client"]`，
  **没有 `@types/node`**（实测 `node_modules/@types/node` 不存在），且简报禁止 npm install 新包。
  于是 `node:fs` / `node:path` / `__dirname` 三个符号在 tsc 下全是错误——
  这正是第 4 节列出的那批 TS2307 / TS2304。运行时没问题（vitest 跑在 node 上），
  但**类型层过不了**，而简报要求「你自己写的文件不能有类型错误」。
- **怎么改的**：`import html from '../fixtures/search.html?raw';`。
  `?raw` 是 Vite 一等公民，类型由 `vite/client` 提供（已在 tsconfig 的 `types` 里），
  vitest 的 transform 管线也支持。fixture 文件本身**一个字节没改**，
  「用 DOM fixture 固化结构假设」的意图完全保留，还顺带去掉了 fs 依赖。
- **对计划断言的影响**：零。13 + 12 + 9 条适配器断言的期望值全部一字未改。

### 5.5 两处小偏离（补齐简报要求，非计划参考实现）

1. **`hide` 动作也走 `applyFold`**。`VERDICT_ACTIONS` 含 `hide`，`src/pipeline/judge.ts` 的
   LLM prompt 明确把 `hide` 定义为「引战/挑起仇恨，隐藏」，但计划的 controller 只处理
   `fold` 和 `mark`——`hide` 会被静默丢弃。
   铁律 2 要求「每个 fold/hide/mark 都要能展开看理由 + 一键撤销」，
   所以 `hide` 与 `fold` 走同一条路径：藏起来 + 给理由 + 给「仍要显示」。
2. **`ControllerDeps` 增加 `video?`、`requestJudgments` 的 payload 增加 `video`**。
   这是**简报明文要求**（简报 > 计划）：
   `payload: { items, mode: settings.mode, video: this.deps.video ?? null }`。
   `VideoContext` 从 `src/pipeline/types.ts` import——该文件已存在，形状与简报给的
   `{ bvid, title, description?, summary? }` 完全一致（`VideoContext extends VideoMeta { bvid: string }`），
   且 `src/content/index.ts` 也是从同一个路径 import 的，两边对齐。
   计划里 `ControllerDeps` 没有 `video`、payload 也没有 `video`，按简报改。

### 5.6 顺手做的两处稳健性加固（不改行为）

- `ownerDoc(root)`：`root` 可能是 `document` 也可能是某个元素，
  元素上没有 `createElement`，统一走 `ownerDocument`。动作层因此能接受任意 `ParentNode`。
- `PageController.getRoot()`：`document` 不存在时返回 `null` 而不是让 `ReferenceError` 冒出去
  （controller 跑在 content script 里一定有 document，但测试/未来复用场景下更稳）。

---

## 6. 发现的问题 / 需要 controller 接手

### 6.1 【必须处理】`src/content/page.ts` 缺失，已在 controller 内临时实现

见 5.1。请 controller 决定：补 `src/content/page.ts`（batch A 所有权）并让 controller 改回 import，
或者正式接受 `detectPageType` 住在 `src/content/controller.ts`。**当前两份实现不要同时存在。**

### 6.2 【需要接线】反向推荐从 bg 到 content 的链路没通

- `src/shared/messages.ts` 里有 `MSG.PUSH_RECOMMENDATIONS`（bg → content），
  `src/bg/router.ts` 也会回 `PushRecommendationsPayload`。
- 但 `src/content/index.ts`（controller 的文件）**没有监听 PUSH_RECOMMENDATIONS**，
  也没有任何地方调用 `renderRecommendations`。
- 我能做的已经做完：`renderRecommendations()` 实现完毕并有测试，
  并在 `PageController` 上暴露了 `showRecommendations(anchor, items)` 作为接入口。
  **接线需要在 `src/content/index.ts` 里加一个 `chrome.runtime.onMessage` 监听**——
  那个文件不是我的，我没动。请 controller 接上，否则「反向推荐卡片」这一项在真实页面上不会出现。
- 顺带提醒：`src/bg/router.ts` 的 `PUSH_RECOMMENDATIONS` 分支目前**没有 case**（我读了整份 router，
  只有 `GET_WORDLIST` / `JUDGE_ITEMS` 等分支，没有 `PUSH_RECOMMENDATIONS`），
  也就是说这条消息现在会被路由到 `default: 未知的消息类型`。这条链路的**两端**都需要补。

### 6.3 【提醒，非阻塞】新版评论区是 Shadow DOM，抽不到就是抽不到

按简报要求，`videoAdapter` 只处理旧版 `.reply-item[data-rpid]`，
新版 Shadow DOM（`.bili-comment-thread-renderer`）`querySelector` 抽不到——
**没有做兜底猜测**，抽不到就返回空数组（该页不干预）。这一点写进了 `src/adapters/video.ts` 的注释。
计划 05 Task 8 的 README 也把「Shadow DOM 新版评论区适配」列为「尚未完成」。
后续要做的话，正路是 `element.shadowRoot` 遍历，或站点提供的内部 API。

### 6.4 【提醒】动作层只处理「已进入 DOM 的静态内容」

适配器是一次性抽当前 DOM。B 站是单页应用，搜索页翻页/推荐流滚动加载出来的卡片
**不会被二次处理**（`PageController.start()` 只跑一次）。
如果要做增量干预，需要在 controller 里挂 `MutationObserver`。
这超出了计划 05 的范围，我**没有实现**——记在这里供 controller 决定是否排后续任务。

### 6.5 【提醒】视频页的 bvid 来自全局 `location`

`videoAdapter` 按计划用 `location.href` 取 bvid 填进 `context.videoId`。
在 content script 里 `location` 就是页面地址，没问题；但**单测里 `location` 是 jsdom 的
`http://localhost:3000/`**，所以 `context.videoId` 在测试中是 `undefined`（计划也没有断言它）。
若将来要在适配器里断言 `videoId`，需要给 `Adapter.collect` 传入页面 URL，或者在 controller 里补。

### 6.6 【无阻塞】其它批次状态

- `src/pipeline/types.ts` 已有 `VideoContext`，形状与简报一致——**不需要**像简报预案那样本地定义同形状接口。
- `src/bg/router.ts` 的 `JUDGE_ITEMS` 分支读的正是 `p?.video`，与我发的 payload 对得上：
  `payload: { items, mode, video }` → `const video = p?.video ?? null;` → `svc.judge(items, { mode, video, threshold })`。链路是通的。
- 仓库级 `tsc --noEmit` 现在是 **0 错误**，比简报预期的好（别的批次都交付完了）。

---

## 7. 交接给 controller 的一句话

- 适配器层：三个页面各一个模块，**抽不到就返回空数组**（`catch` + 空数组双重保险），
  三个页面各自的 DOM 假设都被 fixture 测试钉住（B 站改版 → 测试先红，不会等到用户报障）。
- 动作层：每个 fold/mark 都带 `data-ab-prefix` 前缀与理由文案，
  fold 一定会插一条「已屏蔽（<理由>）+ 仍要显示」，点一下就恢复并回调 `onRevoke`（上层写白名单）。
  **动作层不碰站点原有 DOM 结构**——只做 `display:none`、插自己的兄弟节点、加自己的 span。
- 反向推荐：两段式（关键词召回 → LLM 立场精排），判不出来就丢弃；
  渲染成独立区块 `.ab-recommend`，每条强制带「为什么」（`RecommendItem.reason` 是必填字段）。
- **两件需要 controller 拍板的事**：`src/content/page.ts` 的归属与去重（6.1）、
  `PUSH_RECOMMENDATIONS` 两端接线（6.2）。
