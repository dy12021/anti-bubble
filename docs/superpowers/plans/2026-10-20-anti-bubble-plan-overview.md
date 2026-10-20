# （反）信息茧房插件 · 实施计划总览

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个开源 Chrome 扩展（MV3），用 LLM 分析用户 B 站个人喜好，在「信息茧房 / 反信息茧房」两种模式下介入搜索结果、视频评论与推荐流。

**Architecture:** 三层解耦——适配层（从页面 DOM 抽候选内容）、判定层（画像匹配→动态词表粗筛→LLM 精判，三页面复用）、动作层（折叠/隐藏/标识/推荐，全部可展开看理由并撤销）。无后端，用户自带 LLM API Key，画像与缓存只存 `chrome.storage.local`。

**Tech Stack:** TypeScript 5.x、Vite 5、@crxjs/vite-plugin、Manifest V3、Vitest、@types/chrome、chrome-types

**设计文档：** `docs/superpowers/specs/2026-10-20-anti-bubble-design.md`

---

## 为什么拆成 4 个计划

设计覆盖 4 个相对独立的子系统。硬塞进一个计划会导致计划过长、无法逐段验证。拆分标准是**每个计划结束时都有一个能独立跑起来、能独立测试的东西**。

| 计划 | 名称 | 交付物 | 依赖 |
| --- | --- | --- | --- |
| 01 | `skeleton` | 可加载的 MV3 扩展骨架 + 消息通道 + 存储层 | 无 |
| 02 | `bili-api` | B 站 API 客户端（WBI 签名、限速、缓存） | 01 |
| 03 | `profile` | 画像子系统（冷启动直拉 + 增量合并 + LLM 归纳） | 01, 02 |
| 04 | `pipeline` | 判定流水线（动态词表 + 粗筛 + 精判） | 01, 03 |
| 05 | `adapters` | 三个页面适配器 + 动作层 + 反向推荐 | 04 |

> 实际共 5 个计划（编号 01–05）。计划 05 内部再按适配器拆分任务。

**执行顺序严格串行**：01 → 02 → 03 → 04 → 05。每个计划的最后一个任务都是「端到端可运行」的自检。

---

## ⚠️ 规划期实测发现的问题（照抄计划前必读）

这几个坑是**写计划时真的写错了**，已修正到各计划里，但值得单独列出：

1. **MD5 手写位运算会静默出错**（计划 02 Task 1）
   JS 的 `<<` 是有符号 32 位运算，`0x80 << 24` 溢出成负数。
   症状：**只有全零输入（空串）能过**，`'abc'` 全错——只测空串会以为是对的。
   修法：用 `DataView.getUint32(offset, true)` 读小端。
   **任何自实现的哈希/编码，测试向量必须含非零字节。**

2. **CRXJS 的图标路径**（计划 01 Task 1）
   `public/` 的内容会被摊到 `dist/` 根，但 manifest 里的路径**不会**跟着改。
   写 `public/icon-16.png` 构建不报错、运行时 Chrome 找不到图标。
   正确写法：`icon-16.png`。

3. **`getPaged` 需要两个泛型**（计划 02 Task 2）
   写成 `getPaged<T>(..., pick: (data: T) => T[])` 会让 `pick` 的返回类型与页面对象类型冲突，
   TS 直接报错。正确：`getPaged<P, I>(..., pick: (data: P) => I[])`——
   P 是页面对象（`{ list, page }`），I 是条目类型。

4. **`verbatimModuleSyntax` 下重导出类型要用 `export type`**（计划 02 Task 2）
   `export { BiliEnvelope } from './types'` 会报 TS1205。

5. **PowerShell 读 UTF-8 文件会显示乱码**（Windows）
   `Get-Content -Raw` 不加 `-Encoding UTF8` 会按 cp936 解码，**看起来乱码但文件本身是好的**。
   确认真实编码用 `[System.IO.File]::ReadAllBytes()` + `[System.Text.Encoding]::UTF8.GetString()`。
   写入代码文件时用 `.NET` 的 `WriteAllText(path, text, UTF8Encoding($false))`（无 BOM）。

6. **独立脚本跑 TS** 用 `node --experimental-strip-types script.ts`（**必须 .ts 后缀**）。
   `npx vite-node` 会加载 `vite.config.ts` 导致 CRXJS 插件在非 build 模式崩溃。

7. **删除文件走 `mavis-trash`**，不要用 `Remove-Item`（安全策略会拦永久删除）。

---

## Global Constraints

以下约束适用于**所有**计划，任何任务都隐含包含本节：

- **无后端**：不得引入任何自建服务端、账号系统、遥测上报。LLM 调用由浏览器直连用户指定的服务商。
- **隐私**：用户画像、缓存、API Key 一律只存 `chrome.storage.local`，**不得**使用 `chrome.storage.sync`（同步会离开本机），**不得**上传任何数据。
- **API Key 不得进入代码或日志**：Key 只存 `chrome.storage.local`，任何 `console.log` / 错误消息不得包含 Key 原文。
- **不要求用户导出凭据**：B 站请求一律在页面上下文发起，浏览器自动带 `SESSDATA`。
- **适配器硬兜底**：适配器抽不到内容时**必须静默放弃**（返回空数组），不得抛错、不得阻塞页面渲染。
- **判定可解释**：每一个非 `pass` 的判定结果必须带人话 `reason` 与机器可读 `reasonCode`。
- **可撤销**：每个 `fold` / `hide` / `mark` 动作必须支持撤销，并写入本地白名单使其不再被判定。
- **不写 `eval` / `new Function` / 远程代码**：MV3 商店合规硬要求。
- **不用 `chrome.webRequest` 阻塞模式**：需要改请求时用 `chrome.declarativeNetRequest`。
- **构建产物可读**：`build.minify` 保持可读（商店审核会看代码可读性，混淆会被拒）。
- **提交粒度**：每个 Task 结束提交一次，commit message 用中文描述做了什么。
- **测试不消耗 LLM 额度**：所有涉及 LLM 的测试用假实现（fixture），真实调用只在手动验证步骤做。

---

## 技术栈版本（锁定）

```
typescript@5.5.2
vite@5.4.1
@crxjs/vite-plugin@latest
@types/chrome@0.0.266
vitest@2.1.1
jsdom@25.0.1
```

**不要**参考网上「2026 MV3 新增 14 个必填字段」之类的说法——那是 AI 生成营销文里的虚构内容。MV3 真实必填字段就是 `manifest_version` / `name` / `version` 三项。

---

## 计划索引

| 计划 | 文件 | 状态 |
| --- | --- | --- |
| 01 扩展骨架 | `docs/superpowers/plans/2026-10-20-anti-bubble-01-skeleton.md` | 待执行 |
| 02 B 站 API 客户端 | `docs/superpowers/plans/2026-10-20-anti-bubble-02-bili-api.md` | 待执行 |
| 03 画像子系统 | `docs/superpowers/plans/2026-10-20-anti-bubble-03-profile.md` | 待执行 |
| 04 判定流水线 | `docs/superpowers/plans/2026-10-20-anti-bubble-04-pipeline.md` | 待执行 |
| 05 适配器与动作层 | `docs/superpowers/plans/2026-10-20-anti-bubble-05-adapters.md` | 待执行 |
