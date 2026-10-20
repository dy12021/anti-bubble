# （反）信息茧房

一个面向 B 站（bilibili）的 Chrome / Edge 扩展，用 LLM 分析你的个人喜好，
让你主动选择是**收紧**信息摄入（信息茧房模式），还是**打破**信息闭环（反信息茧房模式）。

- **信息茧房模式**：搜索结果自动屏蔽你大概率不喜欢的内容；视频评论去除引战/挑起仇恨的内容，以及你大概率不喜欢的评论。
- **反信息茧房模式**：搜索或打开一个表达观点的视频一段时间后，自动推荐表达**相反观点**的视频；评论屏蔽引战内容，但把与你可能支持的观点相反的内容**标识出来**（标记而非删除）。

与现有同类工具的区别：那些插件全是「规则/关键词式屏蔽」。本项目做的是
**让 LLM 读懂你的个人喜好**，并**主动把对立观点推到你面前**。

## 隐私

- **没有后端。** 本扩展不运行任何服务器，不做遥测，不收集统计。
- **你的画像只存在你的浏览器里**（`chrome.storage.local`），永不上传。
- **API Key 由你自己提供**，保存在本机 `chrome.storage.local`，只在你调用 LLM 时使用。
- **会读取的内容**：观看历史、收藏夹、关注列表（用于生成画像），
  以及你浏览页面上可见的视频标题、评论正文（用于判定）。
- **会离开你浏览器的数据**：发给你自己配置的 LLM 服务商的请求内容
  （评论正文、视频标题/简介）。选择哪个服务商，数据就流向哪里。
- 关闭采集历史：设置面板里关掉「拉取观看历史」，只用增量画像。

## 安装

```bash
npm install
npm run build
```

### Chrome

1. 打开 `chrome://extensions`
2. 开启右上角「开发者模式」
3. 点「加载已解压的扩展程序」→ 选 `dist/` 目录

### Edge

1. 打开 `edge://extensions`
2. 开启左侧「开发人员模式」
3. 点「加载解压缩的扩展」→ 选 `dist/` 目录

Edge 与 Chrome 同源（都是 Chromium），**扩展包完全相同**，两边都能跑。
如果你的 Edge 允许从 Chrome 应用商店安装扩展，也可以直接在 Edge 里搜扩展名安装。

## 配置

点扩展图标打开面板，填入：

- 服务商：OpenAI 兼容（DeepSeek / MiniMax / Kimi / Qwen 等）或 Anthropic
- Base URL、API Key、模型名
- 可选：最大输出 token（推理模型需要留够空间，见下）

填完点「测试连通性」。

### 用推理模型？注意 token 预算

带 thinking 的推理模型（如 `MiniMax-M3.1-Flash-Preview`）会**先思考再回答，
思考过程和最终答案共用 token 预算**。预算给小了，最终答案就是空的，
判定链路会静默失效（看起来像「插件没反应」）。

- 扩展默认 `maxTokens = 8192`。实测 M3.1 在 2000 时会时灵时不灵，8000 才稳定。
- 报错信息里如果出现「只返回了思考过程、没有最终答案」，就是预算不够，调大它。
- 推理模型每次调用要 8–60 秒，**强烈建议选非推理模型**（判定是分类任务，不需要深度思考）。
- 扩展的判定是**异步**的：LLM 判定完成前页面照常可用，判定完成后才折叠内容。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 存画像、缓存、你自己的 API Key |
| `alarms` | MV3 后台 30 秒即休眠，定时刷新画像必须用它 |
| `scripting` | 页面加载后按需注入内容脚本 |
| `https://*.bilibili.com/*` | 插件只在 B 站上工作，不需要全站权限 |

## 工作原理

判定走三级闸门，**只有第三级花钱**：

```
① 画像匹配（本地，零成本）      命中「不喜欢」标签 → 直接折叠
② 动态词表粗筛（规则，零成本）  未命中 → 放行，不调 LLM
③ LLM 精判（唯一花钱环节）      只判②命中的
```

词表不是固定关键词表——LLM 会先读完当前视频，产出一批「这个视频语境下值得细查的表达模式」
（引战、立场对立等），规则层拿它做零成本粗筛。词表按视频缓存。

每个视频的固定开销是 **1 次** LLM 调用（生成词表）+ 命中条数 × 1 次精判。

B 站请求全部在**页面上下文**发起，浏览器自动带登录 Cookie——
**你不需要手动导出任何凭据**。

### 三个页面的实现方式不一样

| 页面 | 怎么拿内容 | 为什么 |
| --- | --- | --- |
| 搜索页 | 直接读 DOM（`.bili-video-card`） | 卡片是普通 DOM |
| 首页推荐流 | 直接读 DOM（同上） | 同上 |
| **视频页评论区** | **调 B 站 API + 自己渲染** | 见下 |

视频页之所以特殊：B 站评论的 DOM 是
`#commentapp > <bili-comments>`（open shadow）`> <div>`（**closed shadow**），
评论在 closed shadow root 里——**连页面主世界的脚本都读不到**，content script 更读不到。
所以「抽 DOM + 在 DOM 上折叠」这条路走不通，只能改成 API 取、自己渲染。

自带评论区的代价：没有 B 站原生的楼中楼、点赞、表情等交互。
面板顶部有「显示 B 站原生评论」开关，可以随时切回去。

### 需要登录 B 站

B 站对未登录用户屏蔽评论（API 返回 -403），画像也需要登录态。
**插件的评论过滤和冷启动画像都需要你先登录 B 站。**
搜索页和推荐流的视频卡片过滤不受登录影响。


## 开发

```bash
npm run dev        # watch 构建
npm run test       # 单元测试
npm run typecheck  # 类型检查
```

### 真机验证

单测测不到「扩展有没有真的被注入到页面」这类接线问题，所以有真机验证脚本：

```bash
npm run build
node --experimental-strip-types scripts/verify-dist.ts   # 校验 dist 里 manifest 的每个路径都存在
.\scripts\launch-browser.ps1 -Browser chrome -Port 9333 # 或 -Browser edge
node --experimental-strip-types scripts/load-extension.ts
```

> Chrome 142+ 把 `--load-extension` 从代码里删了（`DisableLoadExtensionCommandLineSwitch`
> 整个特性被移除），命令行加载扩展已失效。唯一可行的自动化路径是 CDP 的
> `Extensions.loadUnpacked`，需要 `--enable-unsafe-extension-debugging`——上面的脚本已经处理。

## 状态

早期开发阶段。已实现：

- 三级判定流水线（画像匹配 → 动态词表粗筛 → LLM 精判）
- 搜索页 / 视频页 / 推荐流三个适配器
- 折叠、标识、反向推荐卡片，含「可展开看理由 + 一键撤销」
- 画像：观看历史/收藏夹冷启动 + 增量持续修正
- Chrome 与 Edge 双浏览器运行

尚未完成：配置面板 UI、商店发布（Chrome Web Store / Edge Add-ons）、
Shadow DOM 新版评论区适配。

## 发布到两个商店

扩展包相同，但**发布流程是两条独立的线**：

- **Chrome Web Store**：开发者账号 + 5 美元一次性注册费
- **Microsoft Edge Add-ons**：Partner Center 注册（免费），有**独立的扩展 ID**与独立审核流程
  - 本扩展不用任何依赖扩展 ID 的能力（无 OAuth、无 native messaging），所以 ID 差异不影响功能
  - 用 Edge Add-ons API 可自动化更新：`POST /v1/products/{id}/submissions/draft/package`

两边都要准备：隐私政策 URL、128×128 图标、截图、权限用途说明。

## License

MIT
