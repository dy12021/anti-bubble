# （反）信息茧房浏览器插件 · 设计文档

- 日期：2026-10-20
- 状态：设计已确认（8 项决策已逐条与用户确认）
- 卡片：创意面板 #26「（反）信息茧房浏览器插件」

---

## 1. 要做什么

一个面向 B 站（bilibili）的浏览器插件，用 LLM 分析用户的个人喜好，并据此介入用户的观看与阅读体验。

插件提供两种**相反**的工作模式，用户随时切换：

### 1.1 信息茧房模式

主动**收紧**信息摄入，让用户看到的都是自己偏好的东西。

| 作用点 | 行为 |
| --- | --- |
| 搜索结果 | 自动屏蔽用户大概率不喜欢的内容（基于 LLM 对个人喜好的分析判定） |
| 视频评论 | 自动去除「引战、挑起仇恨」的内容，以及用户大概率不喜欢的评论 |

### 1.2 反信息茧房模式

主动**打破**信息闭环，把用户没接触过的对立观点推到面前。

| 作用点 | 行为 |
| --- | --- |
| 反向推荐 | 用户搜索后、或打开一个表达观点的视频一段时间后，自动推荐一些表达相反观点的视频 |
| 视频评论 | 同样自动屏蔽「引战、挑起仇恨」的内容，但把与用户可能支持的观点相反的内容**标识出来**（标记而非删除） |

### 1.3 两种模式的差异

评论处理上两者共享「去引战」这一条。差异在于：

- 信息茧房模式：额外**删除**用户不喜欢的评论
- 反信息茧房模式：改为**标识**立场相反的评论

---

## 2. 定位与约束

### 2.1 定位

**开源插件，发布到 GitHub / Chrome 商店，由每个用户自带 LLM API Key，不做后端托管。**

推论（全部是硬约束，贯穿设计）：

- 没有账号体系、没有计费、没有服务端
- 隐私数据（用户画像）**只存在用户本机**
- LLM 调用直连用户自己指定的服务商，请求从浏览器直接发出
- 兼容多家 API 是必须解决的工程问题
- 商店发布前置条件：公开仓库 + MIT 协议 + 隐私说明

### 2.2 为什么这个定位成立

调研了现存的同类项目（2026-10-20）：

| 项目 | 形态 | 能力 |
| --- | --- | --- |
| [jev-bili-filter](https://github.com/littlewindy123/jev-bili-filter) | Chrome 扩展，MIT | LLM 判评论/弹幕降噪，但**规则是预设的**（剧透/反串黑/广告/基本盘），无个人画像 |
| [bilibili_blocked](https://greasyfork.org/id/scripts/584385-bilibili-blocked) | 油猴脚本 | 按标签/标题/UP主/分区/关键词屏蔽 |
| [BiliField](https://github.com/moayuisuda/BiliField) | MV3 扩展，React+Vite | 改写 fetch 过滤推荐流与评论 |
| [bilibili-cleaner](https://github.com/nonomal/bilibili-cleaner) | 油猴脚本，300+ 开关 | 页面净化 + 视频/评论/动态过滤 |
| [anti-bili-ad](https://github.com/0ldm0s/anti-bili-ad) | MV3 扩展 | 屏蔽首页不可屏蔽的推荐位 |

**结论：全部是「规则/关键词式屏蔽」。没有一家做「LLM 读懂个人喜好」这一层，也没有一家做「主动推荐相反观点」。**

本项目的差异点正是这两件事，定位上必须避开「再做一个关键词过滤器」。

### 2.3 关键外部约束（已验证）

**B 站 API**

| 用途 | 接口 | 限制 |
| --- | --- | --- |
| 观看历史 | `/x/v2/history/cursor` | 需登录态；**仅最近 ~1000 条 / 3 个月** |
| 收藏夹 | `/x/v3/fav/resource/list` | 需登录态；`ps` 上限 40 |
| 收藏夹列表 | `/x/v3/fav/folder/created/list-all` | 需登录态 |
| 视频详情 | `/x/web-interface/view` | 无需签名 |
| 官方 AI 总结 | `/x/web-interface/view/conclusion/get` | 需 WBI 签名；视频没生成过就返回空 |
| 搜索 | `/x/web-interface/wbi/search/type` | 需 WBI 签名 |
| 评论 | `/x/v2/reply/wbi/main` | 需 WBI 签名；分页用 `next` 游标不是页号 |

- **WBI 签名**：URL 含 `/wbi/` 的接口都要 `w_rid` + `wts`。密钥从 `/x/web-interface/nav` 的 `wbi_img` 取，**24 小时内有效，每次请求都重新拉会被限频**——必须缓存。
- 签名细节坑：空格必须编码成 `%20` 而非 `+`，否则触发 CORS 错误。
- **风控**：`-352` 风险控制、412。连续请求 5–8 次/分钟就可能被拦。需限速 + 退避。
- 搜索「冷启动」：空 session 第一次搜会 412，先访问首页拿 `buvid3`。
- 评论 `mode=3` 拿主楼，`mode=2` 拿回复。

**登录态**：`SESSDATA` + `DedeUserID`。插件在 `bilibili.com` 页面上下文里发请求，浏览器自动带 Cookie，**用户不需要导出任何凭据**。

**Chrome 扩展（MV3）**

- Service worker 约 30 秒空闲即挂起 → 不能用 `setTimeout`/`setInterval`，定时任务要用 `chrome.alarms`
- 无持久化 service worker（官方明确不打算支持）
- Service worker 无 DOM → 需要 DOM 就用 offscreen document
- 跨域请求需 `host_permissions`
- `chrome.storage.local` 10 MB；`sync` 100 KB
- Content script 与 service worker 通信：`chrome.runtime.sendMessage` + `return true` 保持通道

---

## 3. 架构

### 3.1 三层解耦

```
┌─────────────────────────────────────────────────────────┐
│ ① 适配层 Adapter                                          │
│   SearchAdapter / FeedAdapter  —— 从 DOM 抽视频卡片       │
│   VideoAdapter                 —— 从 DOM 抽评论（**已废弃**）│
│   职责：从页面 DOM 抽出「候选内容单元」                    │
│   约束：抽不动 → 硬兜底，本页面不做任何干预，不报错不阻塞   │
└──────────────────────┬──────────────────────────────────┘
                       │ 统一数据结构 ContentItem
                       ▼
┌─────────────────────────────────────────────────────────┐
│ ② 判定层 Pipeline                                         │
│   一套流水线，三个页面复用                                  │
│   画像匹配 → 动态词表粗筛 → LLM 精判 → 动作                │
└──────────────────────┬──────────────────────────────────┘
                       │ 判定结果 Verdict
                       ▼
┌─────────────────────────────────────────────────────────┐
│ ③ 动作层 Action                                           │
│   折叠 / 隐藏 / 标识 / 推荐卡片                            │
│   所有动作均可展开查看理由 + 一键撤销                      │
└─────────────────────────────────────────────────────────┘
```

**为什么必须解耦**：首版一次做齐三个页面（决策 #6）。若判定逻辑在三个页面各写一遍，B 站改版要改三处，且改版风险会同时爆在三处。解耦后，改版只影响适配层。

#### 视频页的架构变更（2026-10-20 真机验证后）

**原设计**：视频页用 `VideoAdapter` 从 DOM 抽 `.reply-item[data-rpid]`，再在 DOM 上折叠。

**实测结论**：这条路在今天的 B 站**走不通**。真实 DOM 结构是

```
#commentapp > <bili-comments>                  ← open shadow root（可访问）
               └─ <div> 的 closed shadow root  ← 评论在这里
```

**closed shadow root 连页面主世界的脚本都进不去**，content script 更进不去。
实测 `.reply-item` / `.bili-comment-thread-renderer` / `.bpx-comment` 在深层搜索下
全部为 0，评论区只剩一个转圈的 spinner。

**改法**：视频页的评论走 **B 站 API + 自渲染评论区**（`src/content/comment-panel.ts`）。
搜索页/推荐流不受影响（普通 DOM，实测 42 张卡片可抽）。

代价：没有 B 站原生的楼中楼、点赞、表情。补偿：面板顶部有「显示 B 站原生评论」开关。

> **教训**：DOM 选择器失效是**只有真机能发现**的问题——
> 单元测试用 fixture 验证选择器，而 fixture 是我们自己写的，
> 它天然符合我们的假设。**必须在真实页面上验证选择器还有效。**

### 3.2 核心数据结构

```ts
// 适配层产出，判定层消费
interface ContentItem {
  kind: 'video' | 'comment';
  id: string;              // bvid / rpid
  text: string;            // 标题+简介 / 评论正文
  author: string;          // UP主昵称
  meta: Record<string, unknown>;  // 分区、时长、播放量、点赞数等
  context: PageContext;    // 所在页面、当前视频、用户画像 id
}

// 判定层产出，动作层执行
interface Verdict {
  itemId: string;
  action: 'fold' | 'hide' | 'mark' | 'recommend' | 'pass';
  reason: string;          // 人话理由，展开时显示
  reasonCode: string;      // 机器可读，用于统计与撤销
  confidence: number;      // 0-1
  revocable: boolean;
}
```

### 3.3 判定流水线

```
ContentItem
   │
   ├─→ [画像匹配] 本地，零 LLM 调用
   │     画像里有明确的「不喜欢」标签 → 直接 fold
   │
   ├─→ [动态词表粗筛] 规则层，零 LLM 调用
   │     当前视频的判据词表命中 → 进入精判
   │     未命中 → pass（放行）
   │
   └─→ [LLM 精判] 唯一花钱的环节
         只对命中项调用，返回 Verdict
```

**成本结构**：每个视频 **1 次** LLM 调用生成动态词表 + 命中条数 × 1 次精判。未命中的评论**不花钱**。

**与反向推荐的 LLM 调用关系**：动态词表的生成和反向推荐里的「抽取立场」是**同一次调用**，合并成一个 prompt——LLM 一次性输出「本视频立场 + 判据词表 + 对立搜索词」。这样每个视频的固定开销是 1 次调用，不是 2 次。

### 3.4 触发时机

反向推荐的触发点有两个，两处都支持：

| 触发 | 行为 |
| --- | --- |
| **搜索页** | 用户提交一次搜索后，对该次搜索结果中的高曝光视频做立场判定，命中「表达观点」的才进入反向推荐 |
| **视频页** | 用户打开视频并**累计观看超过阈值**（默认 60 秒，可配）后触发，避免误触发在误点即退的视频上 |

两个触发点共用同一套「立场抽取 + 词表 + 搜索 + 精排」流水线。

---

## 4. 画像子系统

### 4.1 数据来源：混合方案

**冷启动（首次运行）**

登录态直拉，浏览器自动带 `SESSDATA`，用户无需导出凭据：

- 观看历史 `/x/v2/history/cursor` → 最近 ~1000 条 / 3 个月
- 收藏夹 `/x/v3/fav/resource/list`（先取 `list-all` 拿 fid）
- 关注列表

**增量（持续运行）**

插件运行期间记录用户看过的视频：标题 / UP 主 / 分区 / 时长。本地累积，持续修正画像。

**合并**：冷启动样本给初始权重，增量样本按时间衰减加权（近期行为更能代表当下喜好）。

### 4.2 画像内容

由 LLM 从上述数据归纳，产出结构化画像：

```ts
interface UserProfile {
  interests: { tag: string; weight: number }[];   // 题材/分区偏好
  dislikes: string[];                              // 明确不喜欢的标签
  stanceHints: Record<string, string>;             // 立场倾向（话题 → 倾向）
  topics: string[];                                // 关注的话题
  updatedAt: string;
}
```

### 4.3 隐私（开源发布的硬要求）

- 画像**只存 `chrome.storage.local`**，不上传任何服务器
- README 必须写清：收集什么（观看历史/收藏/关注）、存在哪、如何清除（一键清空）
- **LLM 请求会把内容发往用户自选的服务商**——这一点必须在首次配置时明示，用户确认后才启用
- 提供「不收集历史，仅用增量」的选项

---

## 5. 动态词表（解决「规则判不了立场」的核心机制）

### 5.1 问题

决策 #4 选定「规则粗筛 → LLM 精判」两级。矛盾：静态关键词表能识别「骂人」「地域攻击」，但**识别不了「这条评论在反驳用户的立场」**——纯规则粗筛会让反信息茧房模式在评论层面失效。

### 5.2 解法

把 LLM 从「逐条判定」上移到「一次性生成判据」：

1. LLM 读当前视频的标题 / 简介 / 官方 AI 总结，以及用户画像
2. 输出该视频的**动态判据词表**：哪些表达模式可能构成「引战」或「立场对立」
3. 规则层拿这张表做粗筛（字面/正则匹配）
4. 命中的才逐条调 LLM 精判；未命中直接放行

### 5.3 特性

- 每个视频**只多 1 次** LLM 调用
- 词表贴合当前话题，漏召明显低于固定词表
- 词表**按视频缓存**（`storage.local`），同一视频重复进入不重复生成
- 词表有盲区 → 保留逐条精判作为兜底（命中才精判，不命中不查）

### 5.4 漏召的实际后果（重要取舍）

**词表未命中的评论一律放行，不做 LLM 精判。** 这意味着：

- 一条真正的立场相反评论，如果没被词表覆盖，**不会被标识**（漏召）
- 这是**有意的取舍**，不是缺陷：全量精判会把成本推高一个量级（热门视频几百次调用）
- 漏召的方向是「漏标」而非「错标」——不会把正常评论误判为相反观点，代价只是少标了几条
- 缓解手段：词表由 LLM 针对当前视频生成，覆盖面远大于固定词表；用户发现某类立场没被标出时，可手动把该表述加进本地自定义词表

### 5.5 流水线三者缺一不可

```
动态词表（LLM 生成） → 规则粗筛（零成本） → 逐条精判（LLM）
```

注意三者的分工：词表负责**召回**（把可能相关的挑出来），规则负责**过滤**（零成本剔除明显无关），精判负责**定性**（下最终结论）。缺任何一环，判定质量或成本都会崩。

### 5.6 推理模型的 token 预算（2026-10-20 实测补充）

带 thinking 的推理模型（实测 `MiniMax-M3.1-Flash`）会**先思考再回答，思考过程和最终答案共用 token 预算**。

- 预算给小了 → 最终 `content` 是**空串** → JSON 解析失败 → **判定链路静默失效**
  （看起来像「插件没反应」，实际上一次判定都没发生）
- `reasoning_effort: "none"` **关不掉**：M3.1 强制 adaptive thinking，传 none 会被 400 拒绝
  （`requires adaptive thinking; reasoning effort none is not allowed`）
- 实测同一请求 `max_tokens=2000` 时而返回正常、时而返回空串——adaptive thinking 长度会波动

**对策**：
1. 默认 `maxTokens = 8192`（实测稳定）
2. 客户端在 `content` 为空但有 `reasoning_content` 时，抛出**可操作的**错误
   （「只返回了思考过程、没有最终答案——token 预算不够」），而不是让上层静默降级
3. `LlmConfig` 增加可选的 `reasoningEffort` 与 `useMaxCompletionTokens`
   —— 只有确定服务商支持时才发这两个字段
4. 判定是**异步**的：LLM 判定完成前页面照常可用

---

## 6. 反向推荐

### 6.1 前置门槛

并非所有视频都有立场。先判定「这个视频是否在表达观点」，无立场的视频不触发推荐。

### 6.2 召回（两段式为主）

```
当前视频（标题/简介/官方AI总结）
   │
   ├─→ LLM 抽取立场 + 生成 3-5 个对立视角搜索词
   │      ↓
   │   B 站搜索 /x/web-interface/wbi/search/type
   │      ↓
   │   候选视频
   │
   └─→ 补充信号：评论区挖高赞反对意见 → 提取关键词 → 额外检索
          ↓
       合并去重
          ↓
       LLM 批量判定立场（阶段二：精排）
          ↓
       保留确实表达相反观点的
```

### 6.3 展示

以独立区块出现在视频页（不混入 B 站原生推荐流），每条推荐**必须带一句「为什么这是相反观点」**——否则用户会以为是系统抽风。

---

## 7. 判定策略与动作

### 7.1 动作语义

| 动作 | 含义 | 用在哪 |
| --- | --- | --- |
| `fold` | 折叠成一行摘要，点击可展开 | 信息茧房模式：不喜欢的内容 |
| `hide` | 完全移除 | 信息茧房模式：引战/仇恨评论 |
| `mark` | 保留并加标识 | 反信息茧房模式：立场相反的评论 |
| `recommend` | 插入推荐卡片 | 反信息茧房模式：相反观点视频 |
| `pass` | 放行 | 未命中任何规则 |

### 7.2 可解释 + 可撤销（硬要求）

LLM 判定是概率性的，误伤必然发生。没有可解释与可撤销，用户一旦遇到误伤就会关掉插件。

- 每条被折叠/隐藏的内容 → 显示一行「已屏蔽（理由）」，点击展开看完整理由
- 展开后提供「仍要显示」→ 立即撤销，并写入本地白名单，后续不再判定
- 面板（popup）提供屏蔽记录列表：看今天屏蔽了多少、各自理由是什么
- 全局总开关，一键恢复所有屏蔽

### 7.3 页面级独立开关

搜索页 / 视频页 / 推荐流三个干预点各自可单独关闭。首版一次做齐三个页面，改版风险集中，必须给用户逃生口。

---

## 8. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| **B 站改版** | 适配层失效 | 三层解耦，改版只改适配层；每适配器硬兜底（抽不动=不干预）；DOM fixture 测试固化结构假设，改版时测试即报 |
| **LLM 误伤** | 用户失去信任 | 可解释 + 一键撤销 + 全局开关 + 本地白名单（§7.2） |
| **调用成本失控** | 用户钱包遭殃 | 三级筛选（画像→词表→LLM），非命中不调用；每视频词表缓存；结果按内容哈希缓存 |
| **B 站风控 -352/412** | 拉不到历史/评论 | 限速 + 指数退避；WBI 密钥缓存 24h 不重复拉；失败降级而非报错 |
| **商店审核** | 无法发布 | 公开仓库 + MIT + 隐私说明（披露收集范围与 LLM 请求去向） |
| **API 不兼容** | 用户配了 Key 调不通 | 抽象 LLM 客户端层；至少支持 OpenAI 兼容（DeepSeek/MiniMax/Kimi）+ Anthropic 两种协议；配置页有连通性自测 |

---

## 9. 技术栈

- **扩展形态**：Chrome Manifest V3
- **构建**：Vite + TypeScript（输出 `dist/`，可直接「加载已解压的扩展程序」）
- **运行时**：Service worker（后台任务、缓存、调度）+ Content script（DOM 适配）+ Popup（配置与面板）
- **存储**：`chrome.storage.local`（画像、缓存、配置、Key）
- **LLM**：自建客户端层，OpenAI 兼容 + Anthropic 两套协议
- **测试**：Vitest（纯逻辑单测）；Playwright（适配器 DOM 回归，用 fixture 不消耗用户额度）
- **协议**：MIT

---

## 10. 目录结构

```
src/
  shared/            # 跨上下文唯一真相源（无 chrome.* 依赖，可单测）
    types.ts  constants.ts  hash.ts  messages.ts
  bili/              # B 站 API 客户端
    wbi.ts           # WBI 签名 + 同步 MD5
    client.ts        # 限速 / 退避 / 错误降级
    api.ts           # 各端点封装
    types.ts
  profile/           # 画像子系统
    merge.ts  rules.ts  induce.ts  collect.ts
  pipeline/          # ② 判定层，三页面复用
    types.ts         # VideoContext / Wordlist / JudgeInput
    wordlist.ts  coarse.ts  judge.ts  pipeline.ts
    wordlist-service.ts  verdict-cache.ts
  adapters/          # ① 适配层：搜索页 / 推荐流（视频页已改走 API）
    types.ts  search.ts  feed.ts  index.ts
  actions/           # ③ 动作层
    fold.ts  mark.ts  recommend.ts  index.ts
  recommend/         # 反向推荐召回与立场判定
    recall.ts  opposition.ts
  content/           # content script
    index.ts         # 入口
    controller.ts    # 抽 → 判 → 执行
    comment-panel.ts # 自有评论区（视频页）
    page-bridge.ts   # 页面上下文请求桥
    page-fetch.js    # 注入页面上下文的 fetch 代理
    page.ts          # 页面类型识别
  bg/                # service worker
    index.ts  router.ts  storage.ts
    profile-service.ts  pipeline-service.ts
    llm/             # client.ts  openai.ts  anthropic.ts
  popup/             # 配置面板
    index.html  main.ts  style.css
scripts/             # 真机验证与诊断脚本（CDP 驱动）
tests/
  unit/  fixtures/
```

---

## 10.1 真机验证发现的问题（2026-10-20）

以下问题**单元测试全部通过**、只有真实浏览器才暴露。已全部修复。
| # | 问题 | 症状 | 根因 |
| --- | --- | --- | --- |
| 1 | **manifest 没声明 content_scripts** | 扩展加载了但什么都不干 | 计划里漏了，`CRXJS` 不会自动补 |
| 2 | **未登录时取不到 WBI 密钥** | 所有需签名的接口全废 | `nav` 未登录时返回 `code=-101`，但响应里**照样带 `wbi_img`**；`get()` 因为 `code!==0` 把整个 `data` 丢了 |
| 3 | **页面桥自回声** | 所有 B 站请求都返回 null | `window.postMessage` 会把消息派发回同一 window，content script 自己的**请求**也被自己的监听器收到；监听器只用 `__ab`+`id` 过滤，请求消息恰好也带这两个字段 → **每次请求立刻 resolve 成 null** |
| 4 | **视频页 DOM 读不到评论** | 视频页一条评论都抽不到 | 评论在 **closed shadow root** 里，页面脚本都读不到 |
| 5 | **推理模型 token 预算不足** | 判定链路静默失效 | 思考过程与答案共用预算，预算小了 `content` 是空串 |
| 6 | **判定缓存只写不读** | 同一评论判两次，白花一次钱 | `PipelineService` 写了缓存但没查 |
| 7 | **精判不分批** | 命中过多时一次发太多 | 没按 `MAX_BATCH_ITEMS=20` 切块 |
| 8 | **冷启动采集没接进画像** | 首次运行没有画像 | `refresh` 只消费 `watchLog`，从不调 `collectColdStart` |
| 9 | **`applyFold` 只认 `[data-rpid]`** | 搜索页/推荐流折叠完全不生效 | 那些页面的 id 是 bvid 不是 rpid |
| 10 | **`applyMark` 判重查全页** | 页面上有一个标识后，后面全拿不到 | 判重范围错了 |
| 11 | **评论判定请求没带 video** | 评论全部原样放行 | 后台拿不到视频上下文 → 空词表 → 粗筛永不命中 |
| 12 | **多个 BiliClient 实例各限各的** | 视频页面板时有时无（Chrome 能出、Edge 出不来） | 限流状态是**实例级**的，各处各自 new 一个 → 请求互相不避让 → 撞 -352 风控 → 重试退避 → 拿不到数据。**限流器存在的前提是全局只有一个** |

### 真机验证脚本（都在 `scripts/`）

| 脚本 | 用途 |
| --- | --- |
| `launch-browser.ps1` | 启动带 CDP 的 Chrome/Edge 独立实例 |
| `load-extension.ts` | 用 CDP `Extensions.loadUnpacked` 装扩展 |
| `verify-dist.ts` | **构建产物闸门**：manifest 引用的每个路径都必须在 dist 里存在 |
| `capture-extension-log.ts` | 连上→刷新→抓扩展自己的控制台 |
| `e2e-judge.ts` | 端到端：真实页面 + 真实 LLM → 评论被折叠/标识 |
| `shot-popup.ts` | 打开并截图配置面板 |
| `probe-*.ts` | 各类定点诊断（DOM 结构、窗口、API 参数组合） |
| `close-small-windows.ts` | 清理 PWA 小窗 |

### 真机验证的注意事项（都是踩过的）

1. **content script 只在页面加载时注入**。`Page.navigate` 到**当前同一个 URL**
   会被当作同文档导航，不重新加载 → content script 不注入。相同 URL 必须用
   `Page.reload({ignoreCache:true})`。
2. **`Runtime.enable` 不回放历史控制台消息**。要抓页面加载期的日志，
   必须「先连上 → enable → 再导航/reload → 再收集」。
3. **MV3 service worker 懒加载**，30 秒空闲即休眠。找不到 SW target 时，
   刷新一次页面（content script 发消息）就能唤醒。
4. **两个浏览器实例要分开端口**（9333 / 9334），否则脚本会互相抢页面导航。
5. **限流必须是全局的**：见问题 #12，多实例 = 没限流。


> **Chrome 142+ 删除了 `DisableLoadExtensionCommandLineSwitch` 特性**，
> `--load-extension` 在稳定版彻底失效。唯一可行的自动化路径是 CDP 的
> `Extensions.loadUnpacked`，需要 `--enable-unsafe-extension-debugging`。

---

## 11. 已确认的决策清单

| # | 议题 | 决策 |
| --- | --- | --- |
| 1 | 定位 | 开源插件 + 用户自带 Key，无后端 |
| 2 | 画像数据源 | 混合：直拉冷启动 + 插件内增量 |
| 3 | 反向推荐召回 | 两段式为主 + 评论区挖掘补充 |
| 4 | 评论判定 | 两级：规则粗筛 → LLM 精判 |
| 5 | 粗筛层 | LLM 动态词表（非固定词表） |
| 6 | 首版范围 | 两套模式 + 全页面一次做齐 |
| 7 | 代码结构 | 三层解耦：适配层 / 判定层 / 动作层 |
| 8 | 可解释性 | 每条屏蔽可展开看理由 + 一键撤销 |

---

## 12. 未决问题

以下不阻塞首版，但需要提前有答案：

1. **B 站分区的判定粒度**——「用户不喜欢」是按分区粗判（如「讨厌游戏区」），还是按具体话题细判（需 LLM 介入）？
2. **推荐视频的插入位置**——独立区块还是挂到 B 站原生推荐流尾部？
3. **立场标注的呈现**——图标 + 文字标签，还是加颜色区分？
4. **画像刷新触发**——每次启动、每天一次，还是手动？
