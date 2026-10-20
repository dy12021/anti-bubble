# SDD ledger — plan: docs/superpowers/plans/2026-10-20-anti-bubble-01-skeleton.md

仓库：D:\coding\anti-bubble
分支：feature/anti-bubble-v1（基点 127bcf5）
开始时间：2026-10-20

## 执行方式（与 skill 默认的偏离，刻意为之）

用户明确要求「最佳完成度 + 并发子代理」。skill 默认「Never dispatch multiple
implementation subagents in parallel (conflicts)」，本次改为**按文件所有权严格切分后并发**：

- **子 agent 只写文件、只跑测试，不执行 git commit**。并发提交会抢 index.lock，
  且一个 agent 的 `git add -A` 会把别人的半成品带进 commit。
  所有 commit 由 controller（主会话）集中执行。
- 每个 agent 拥有**互不重叠**的文件集合，见下方「文件所有权」。
- 审查（reviewer）同样并发执行，但每个 reviewer 只看自己那批的 diff。

## 文件所有权（并发安全的依据）

| 批次 | Agent | 独占文件 |
| --- | --- | --- |
| A | contracts | `src/shared/*`、`src/bg/storage.ts`、`src/bg/llm/*`、`src/content/page.ts` |
| B | bili | `src/bili/*`、`src/content/page-bridge.ts`、`src/content/page-fetch.js`、`manifest.json`、`vite.config.ts` |
| C | profile | `src/profile/*`、`src/bg/profile-service.ts` |
| D | pipeline | `src/pipeline/*`、`src/bg/pipeline-service.ts` |
| E | adapters | `src/adapters/*`、`src/actions/*`、`src/recommend/*`、`src/content/controller.ts` |
| F | controller(我) | `src/bg/router.ts`、`src/bg/index.ts`、`src/content/index.ts`、`README.md`、`docs/testing-checklist.md`、`vitest.config.ts` |

**测试文件**按同名前缀归属：`tests/unit/<模块>-*.test.ts` 归对应 agent。
`tests/fixtures/*` 归 adapters agent。

## Global Constraints（对所有 agent 生效）

- 无后端、无遥测；画像/缓存/Key 只存 `chrome.storage.local`，**禁用** `storage.sync`
- API Key 不得进入代码或日志
- 不要求用户导出凭据：B 站请求在页面上下文发起，浏览器自动带 SESSDATA
- 适配器硬兜底：抽不到内容返回空数组，不得抛错、不得阻塞页面
- 每个非 `pass` 判定必须带人话 `reason` + 机器可读 `reasonCode`
- 每个 fold/hide/mark 必须可撤销，撤销写入白名单
- 不用 eval / new Function / 远程代码（MV3 合规）
- 不用 chrome.webRequest 阻塞模式
- 构建产物可读（`minify: false`）
- 测试不消耗 LLM 额度（用假 client）
- 提交粒度：每个 Task 一次提交，commit message 用中文

## 已知坑（规划期实测，照做即可，别重踩）

1. MD5 手写位运算有符号溢出 → 用 `DataView.getUint32(offset, true)`
2. CRXJS 把 `public/` 摊到 dist 根 → manifest 图标路径写 `icon-16.png`
3. `getPaged` 需要两个泛型 `<P, I>`
4. `verbatimModuleSyntax` → 重导出类型用 `export type`
5. PowerShell 读 UTF-8 显乱码是 cp936 显示层问题，文件无恙
6. 独立 TS 脚本用 `node --experimental-strip-types script.ts`（必须 .ts）
7. 删除文件用 `mavis-trash`，不要 `Remove-Item`

## 进度

（由 controller 逐条追加）

- Task A (契约层+存储+LLM客户端): complete (commits 2896f23..e8c0905, review by controller)
  - 验证：44 项单测全绿，tsc 干净
  - agent 报告 taskA-report.md。提出 3 个真问题，controller 全部修掉：
    ① MSG.GET_WHITELIST 契约层漏了 → 已补
    ② Partial<Settings> 不允许部分 enabledPages（TS2739）→ 新增 SettingsPatch 类型，测试去掉类型断言
    ③ agent 的 Key 脱敏增强（redact）→ 采纳
  - agent 额外发现并修正了 controller 的一个设计错误：service worker 自己发不了 B 站请求
    （拿不到 SESSDATA），视频上下文必须由 content script 取好随 payload 传入。
- Task B (页面请求桥+B站端点测试): complete (commit e8c0905)
  - 验证：page-bridge 14 + bili-client 13 + bili-api 11 = 38 项全绿
  - agent 做了一件计划里没有的正确处理：用 vite `output.entryFileNames` 把 page-fetch.js
    强制落到 `content/page-fetch.js`，与 manifest 的 web_accessible_resources 路径对齐。
    否则它会被输出成 assets/page-fetch-*.js，注入时 404。已实测 dist 路径正确。
- Task C (画像子系统): complete (commit ffc05e6, 40 项全绿)
  - agent 报告 taskC-report.md。发现两处计划自相矛盾并按测试意图修正（induce 的空样本早退、
    record 的 sampleCount 同步），另修了 stanceHints 的 strict 类型谓词问题。
  - **agent 标出真缺口：冷启动采集没接进 ProfileService**（refresh 只消费 watchLog，
    从不调 collectColdStart）。controller 补上：content script 在页面上下文采集
    历史/收藏夹 → SYNC_PROFILE_SAMPLES → 后台 addSamples 落库 → refresh 归纳。
    新增 tests/unit/profile-coldstart.test.ts（6 项）锁住这条链路。
- Task D (判定流水线): complete (commit 14f2e72, 58 项全绿)
  - agent 报告 taskD-report.md。发现计划 04 有 5 处「实现与自己的测试互相矛盾」，
    按测试意图修正（REASON_CODES 是数组不是 Set、词表入参放宽 bvid、anti 模式说明
    要写进 user、invalidate 用哈希键删不掉、Pipeline 词表来源与取词表时机），
    计划里的函数名/导出名/测试名/断言/魔法值全部保留。
  - **agent 标出两个真缺口**，controller 已修：
    ① 判定缓存只写不读 → PipelineService 先查缓存，只判未命中的（tests/unit/pipeline-cache.test.ts）
    ② 精判不分批 → 按 MAX_BATCH_ITEMS=20 切块，一批失败只降级那一批
  - 另修 controller 自己的 import 路径笔误（./pipeline/ → ../pipeline/）


