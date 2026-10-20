# 计划 01：扩展骨架与核心契约

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立可加载的 MV3 扩展骨架，定义全项目共享的类型契约、消息协议、存储层与 LLM 客户端抽象，让后续 4 个计划可以直接往上长。

**Architecture:** Vite + CRXJS 构建；`src/shared/` 放所有跨上下文共享的类型与纯函数（无 chrome API 依赖，可在 Node 里单测）；`src/bg/` 是 service worker（后台：LLM 调用、缓存、定时任务）；`src/content/` 是 content script（页面 DOM 操作）；`src/popup/` 是配置面板。

**Tech Stack:** TypeScript 5.5.2、Vite 5.4.1、@crxjs/vite-plugin、Vitest 2.1.1、chrome-types

**依赖:** 无。这是起点。

---

## Global Constraints

- 无后端、无遥测；画像/缓存/Key 只存 `chrome.storage.local`
- API Key 不得进入代码或日志
- 不用 `eval` / `new Function` / 远程代码
- 构建产物保持可读（`minify: false`）
- 每个 Task 结束提交一次，commit message 用中文
- 测试不消耗 LLM 额度

---

## File Structure

```
anti-bubble/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── manifest.json
├── vitest.config.ts
├── src/
│   ├── shared/                # 纯逻辑，无 chrome API 依赖，Node 可测
│   │   ├── types.ts           # ContentItem / Verdict / UserProfile 等核心类型
│   │   ├── messages.ts        # 跨上下文消息协议
│   │   ├── constants.ts       # storage key、页面类型、动作枚举
│   │   └── hash.ts            # 缓存键哈希（内容寻址）
│   ├── bg/
│   │   ├── index.ts           # service worker 入口
│   │   ├── llm/
│   │   │   ├── client.ts      # LLM 客户端抽象（接口 + 工厂）
│   │   │   ├── openai.ts      # OpenAI 兼容协议实现
│   │   │   └── anthropic.ts   # Anthropic 协议实现
│   │   └── storage.ts         # chrome.storage.local 封装
│   ├── content/
│   │   ├── index.ts           # content script 入口
│   │   └── page.ts            # 页面类型识别
│   └── popup/
│       ├── index.html
│       ├── main.ts
│       └── style.css
└── tests/
    └── unit/
```

**为什么 `src/shared/` 独立**：`shared/` 里不许出现 `chrome.*` 调用。这样它能被 Vitest 在 Node 里直接跑，也能在 service worker / content script / popup 三个上下文里安全 import（MV3 三者的执行环境不同，共享代码必须无副作用）。

---

## Task 1: 工程脚手架与构建管线

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `manifest.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`（已存在，确认含 `node_modules/`、`dist/`）

**Interfaces:**
- Consumes: 无
- Produces: `npm run build` 产出 `dist/`；`npm run test` 运行 Vitest；`npm run dev` 启动 watch 构建

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "anti-bubble",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "（反）信息茧房：B 站信息摄入干预插件",
  "license": "MIT",
  "scripts": {
    "dev": "vite build --watch --mode development",
    "build": "vite build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.21",
    "@types/chrome": "0.0.266",
    "jsdom": "25.0.1",
    "typescript": "5.5.2",
    "vite": "5.4.1",
    "vitest": "2.1.1"
  }
}
```

- [ ] **Step 2: 安装依赖**

Run: `npm install`
Expected: 无 ERROR，`node_modules/` 生成，`package-lock.json` 创建

- [ ] **Step 3: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vite/client"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src", "tests", "vite.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: 写 manifest.json**

放在项目根目录（CRXJS 从根读取）：

```json
{
  "manifest_version": 3,
  "name": "（反）信息茧房",
  "version": "0.1.0",
  "description": "用 LLM 分析你的 B 站偏好，主动收紧或主动打破你的信息茧房。",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "alarms", "scripting"],
  "host_permissions": ["https://*.bilibili.com/*"],
  "background": {
    "service_worker": "src/bg/index.ts",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/index.html"
  },
  "icons": {
    "16": "icon-16.png",
    "48": "icon-48.png",
    "128": "icon-128.png"
  }
}
```

> **实测修正（2026-10-20）**：图标路径**不能**写成 `public/icon-16.png`。
> CRXJS 会把 `public/` 的内容摊到 `dist/` 根目录，但 manifest 里的路径**不会**跟着改，
> 写 `public/...` 会导致 Chrome 找不到图标（构建不报错，运行时才炸）。
> 正确写法是 `icon-16.png`（相对 dist 根）。
> 验证命令见 Task 1 Step 9。

**权限说明（写进 README，商店审核要填）**：
- `storage`：存画像、缓存、用户自己的 LLM API Key
- `alarms`：MV3 service worker 30 秒即休眠，定时刷新画像必须用它
- `scripting`：页面加载后按需注入内容脚本
- `host_permissions`：`https://*.bilibili.com/*`——插件只在 B 站上工作，不需要全站权限

- [ ] **Step 5: 写 vite.config.ts**

```ts
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        popup: 'src/popup/index.html',
        background: 'src/bg/index.ts',
        content: 'src/content/index.ts',
      },
    },
  },
});
```

- [ ] **Step 6: 写 vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
  },
});
```

- [ ] **Step 7: 建占位入口文件，让构建能跑通**

`src/bg/index.ts`：
```ts
console.info('[anti-bubble] service worker started');
```

`src/content/index.ts`：
```ts
console.info('[anti-bubble] content script loaded');
```

`src/popup/index.html`：
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>（反）信息茧房</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main id="app">（反）信息茧房</main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/popup/main.ts`：
```ts
const app = document.getElementById('app');
if (app) app.textContent = '（反）信息茧房';
```

`src/popup/style.css`：
```css
body { font-family: system-ui, sans-serif; margin: 0; padding: 12px; width: 320px; }
```

- [ ] **Step 8: 建占位图标**

用 Python 生成三个尺寸的纯色 PNG（无需设计资源）：

```powershell
$ErrorActionPreference='Stop'
New-Item -ItemType Directory -Force -Path 'D:\coding\anti-bubble\public' | Out-Null
@'
import struct, zlib, os
def png(path, size, rgba=(31,111,235,255)):
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    raw = b"".join(b"\x00" + bytes(rgba) * size for _ in range(size))
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)
base = r"D:\coding\anti-bubble\public"
for s in (16, 48, 128):
    png(os.path.join(base, "icon-%d.png" % s), s)
print("icons written")
'@ | Set-Content -Path "$env:TEMP\gen_icons.py" -Encoding UTF8
& 'C:\ProgramData\anaconda3\python.exe' "$env:TEMP\gen_icons.py"
```

Expected: 输出 `icons written`，`public/` 下出现三个 PNG

- [ ] **Step 9: 跑构建验证**

Run: `npm run build`
Expected: 退出码 0，`dist/` 目录生成且含 `manifest.json`

若 CRXJS 版本与 Vite 5 不兼容导致构建失败，改为 `npm i -D @crxjs/vite-plugin@1.0.14`（该版本与 Vite 5 兼容）后重试。

- [ ] **Step 10: 校验 manifest 里每个路径都真实存在**

构建成功**不等于**产物可用——CRXJS 不会校验 manifest 里的资源路径。必须逐个核对：

```powershell
Set-Location 'D:\coding\anti-bubble'
$m = Get-Content 'dist\manifest.json' -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($k in $m.icons.PSObject.Properties) {
  Write-Host ("icon " + $k.Name + " -> " + $k.Value + " exists=" + (Test-Path (Join-Path 'dist' $k.Value)))
}
Write-Host ("service_worker exists=" + (Test-Path (Join-Path 'dist' $m.background.service_worker)))
Write-Host ("popup exists=" + (Test-Path (Join-Path 'dist' $m.action.default_popup)))
```

Expected: 全部 `exists=True`

> **Windows 编码坑**：`Get-Content -Raw` 不加 `-Encoding UTF8` 会按 cp936 解码，
> 看起来是乱码——那是**显示层**的问题，文件本身仍是合法 UTF-8。
> 要确认文件真实编码，用 `[System.IO.File]::ReadAllBytes($p)` +
> `[System.Text.Encoding]::UTF8.GetString($bytes)`。
> manifest.json 必须是无 BOM 的 UTF-8（Chrome 要求）。

- [ ] **Step 11: 提交**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts manifest.json vitest.config.ts src public
git commit -m "chore: 搭建 MV3 扩展脚手架与构建管线"
```

---

## Task 2: 核心类型契约

**Files:**
- Create: `src/shared/types.ts`
- Create: `src/shared/constants.ts`
- Test: `tests/unit/types.test.ts`

**Interfaces:**
- Consumes: Task 1 的构建管线
- Produces: 后续所有计划依赖的类型定义——
  - `PageType` = `'search' | 'video' | 'feed' | 'unknown'`
  - `ItemKind` = `'video' | 'comment'`
  - `ContentItem`（适配层产出，判定层消费）
  - `Verdict`（判定层产出，动作层执行）
  - `VerdictAction` = `'fold' | 'hide' | 'mark' | 'recommend' | 'pass'`
  - `UserProfile`、`UserProfileInput`
  - `Mode` = `'cocoon' | 'anti'`
  - `ItemContext`、`VerdictReasonCode`

- [ ] **Step 1: 写失败测试**

`tests/unit/types.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { VERDICT_ACTIONS, MODES, PAGE_TYPES } from '../../src/shared/constants';

describe('常量表', () => {
  it('动作枚举包含设计文档定义的 5 个', () => {
    expect([...VERDICT_ACTIONS].sort()).toEqual(
      ['fold', 'hide', 'mark', 'pass', 'recommend'],
    );
  });

  it('模式只有信息茧房与反信息茧房两种', () => {
    expect([...MODES].sort()).toEqual(['anti', 'cocoon']);
  });

  it('页面类型覆盖三个目标页面', () => {
    expect([...PAGE_TYPES].sort()).toEqual(['feed', 'search', 'unknown', 'video']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，报 `Cannot find module '../../src/shared/constants'`

- [ ] **Step 3: 写 constants.ts**

`src/shared/constants.ts`：
```ts
/** 扩展内所有存储键的单一来源。改这里等于改 storage 布局。 */
export const STORAGE_KEYS = {
  profile: 'profile',
  llmConfig: 'llmConfig',
  wordlistCache: 'wordlistCache',
  verdictCache: 'verdictCache',
  whitelist: 'whitelist',
  watchLog: 'watchLog',
  settings: 'settings',
  blockedLog: 'blockedLog',
} as const;

export const VERDICT_ACTIONS = ['pass', 'fold', 'hide', 'mark', 'recommend'] as const;
export const MODES = ['cocoon', 'anti'] as const;
export const PAGE_TYPES = ['search', 'video', 'feed', 'unknown'] as const;

export const REASON_CODES = [
  'dislike_match',      // 命中用户画像里的「不喜欢」
  'incitement',         // 引战 / 挑起仇恨
  'stance_opposite',    // 与用户可能支持的立场相反
  'off_topic',          // 与画像明显无关
  'recommendation',     // 反向推荐：确实是相反观点
  'none',               // 放行
] as const;

/** 单次 LLM 请求允许的最大评论条数。批量判定时用，超过就分批。 */
export const MAX_BATCH_ITEMS = 20;

/** 反向推荐的触发阈值：视频页累计观看秒数。 */
export const ANTI_TRIGGER_WATCH_SECONDS = 60;

/** B 站风控阈值：连续请求间隔（毫秒）。5-8 次/分钟即会被拦。 */
export const BILI_REQUEST_INTERVAL_MS = 1200;
```

- [ ] **Step 4: 写 types.ts**

`src/shared/types.ts`：
```ts
import type {
  VERDICT_ACTIONS, MODES, PAGE_TYPES, REASON_CODES,
} from './constants';

export type PageType = (typeof PAGE_TYPES)[number];
export type ItemKind = 'video' | 'comment';
export type VerdictAction = (typeof VERDICT_ACTIONS)[number];
export type Mode = (typeof MODES)[number];
export type VerdictReasonCode = (typeof REASON_CODES)[number];

/** 内容所处的上下文。判定需要它来理解「这条评论在回应什么」。 */
export interface ItemContext {
  page: PageType;
  /** 视频页/评论所属的视频 id；搜索页与推荐流为 undefined */
  videoId?: string;
  /** 视频标题或简介摘要，作为立场判定的语境 */
  videoTitle?: string;
  /** 父评论 id，楼中楼用 */
  parentId?: string;
}

/**
 * 适配层产出、判定层消费的统一内容单元。
 * 适配器抽不到内容时返回空数组，绝不抛错。
 */
export interface ContentItem {
  kind: ItemKind;
  /** video → bvid；comment → rpid */
  id: string;
  /** 视频标题+简介片段，或评论正文 */
  text: string;
  /** UP主昵称 / 评论者昵称 */
  author: string;
  /** 分区、时长、播放量、点赞数等。语义随 kind 而定。 */
  meta: Record<string, unknown>;
  context: ItemContext;
}

/** 判定层产出、动作层执行的结果。 */
export interface Verdict {
  itemId: string;
  action: VerdictAction;
  /** 展示给用户的人话理由。每个非 pass 判定都必须有。 */
  reason: string;
  reasonCode: VerdictReasonCode;
  /** 0-1。低于阈值按 pass 处理。 */
  confidence: number;
  /** 是否可撤销。pass 不可撤销。 */
  revocable: boolean;
}

/** 画像的输入样本：一条观看/收藏记录。 */
export interface UserProfileInput {
  /** bvid */
  id: string;
  title: string;
  author: string;
  /** 分区名或 id */
  category: string;
  /** 观看时长（秒）；收藏夹样本没有，填 undefined */
  watchSeconds?: number;
  /** 样本采集时间 ISO 字符串，用于时间衰减 */
  collectedAt: string;
  /** 来源：history / favorite / follow / live */
  origin: 'history' | 'favorite' | 'follow' | 'live';
}

/** LLM 归纳出的用户画像。 */
export interface UserProfile {
  interests: { tag: string; weight: number }[];
  dislikes: string[];
  stanceHints: Record<string, string>;
  topics: string[];
  updatedAt: string;
  /** 样本总数，供 UI 展示 */
  sampleCount: number;
}

/** LLM 配置。用户自带 Key。 */
export interface LlmConfig {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 单次请求超时（毫秒） */
  timeoutMs: number;
}

/** 全局设置。 */
export interface Settings {
  mode: Mode;
  /** 每个页面类型可独立开关 */
  enabledPages: Record<PageType, boolean>;
  /** 总开关 */
  masterEnabled: boolean;
  /** 是否拉取观看历史做冷启动 */
  collectHistory: boolean;
  /** 判定置信度阈值，低于此值按 pass 处理 */
  confidenceThreshold: number;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，3 个测试全绿

- [ ] **Step 6: 跑类型检查**

Run: `npm run typecheck`
Expected: 退出码 0，无输出

- [ ] **Step 7: 提交**

```bash
git add src/shared tests/unit/types.test.ts
git commit -m "feat: 定义核心类型契约与常量表"
```

---

## Task 3: 内容寻址哈希

**Files:**
- Create: `src/shared/hash.ts`
- Test: `tests/unit/hash.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `contentKey(...parts: unknown[]): string`——把任意输入压成稳定短键，供词表缓存与判定缓存使用。要求：
  - 相同输入 → 相同输出（进程内与跨进程都要稳定）
  - 不同输入 → 不同输出的概率极高
  - 不泄露原文（输出是十六进制摘要，不是明文）

- [ ] **Step 1: 写失败测试**

`tests/unit/hash.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { contentKey } from '../../src/shared/hash';

describe('contentKey', () => {
  it('相同输入产生相同键', () => {
    expect(contentKey('abc', 1)).toBe(contentKey('abc', 1));
  });

  it('不同输入产生不同键', () => {
    expect(contentKey('abc', 1)).not.toBe(contentKey('abc', 2));
  });

  it('参数顺序影响结果', () => {
    expect(contentKey('a', 'b')).not.toBe(contentKey('b', 'a'));
  });

  it('键是固定长度的十六进制', () => {
    expect(contentKey('x')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('不泄露明文', () => {
    const secret = '我的私人观看记录';
    expect(contentKey(secret)).not.toContain(secret);
  });

  it('对对象按稳定顺序序列化', () => {
    expect(contentKey({ a: 1, b: 2 })).toBe(contentKey({ b: 2, a: 1 }));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/shared/hash'`

- [ ] **Step 3: 写实现**

`src/shared/hash.ts`：
```ts
/**
 * 内容寻址哈希：把任意输入压成 16 位十六进制短键。
 *
 * 为什么不用 crypto.subtle：content script 与 popup 都要调用它，
 * 而 Web Crypto 的 digest 是异步的，会把调用方全拖成 async。
 * 这里的 FNV-1a 变体不用于安全场景，只用于缓存寻址。
 */

/** 稳定序列化：对象按 key 排序，数组保序。 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    if (Array.isArray(value)) {
      return '[' + value.map(stableStringify).join(',') + ']';
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** FNV-1a 64 位变体，用两个 32 位字拼出 16 位十六进制。 */
export function contentKey(...parts: unknown[]): string {
  const s = parts.map(stableStringify).join('\u0001');
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 ^ c) >>> 0;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    h2 = ((h2 << 13) | (h2 >>> 19)) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/shared/hash.ts tests/unit/hash.test.ts
git commit -m "feat: 新增内容寻址哈希用于缓存键"
```

---

## Task 4: 消息协议

**Files:**
- Create: `src/shared/messages.ts`
- Test: `tests/unit/messages.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `ContentItem`、`Verdict`、`PageType`、`Mode`
- Produces:
  - `MsgRequest` / `MsgResponse` 联合类型
  - `createRequestId(): string`
  - `isRequest(msg: unknown): msg is MsgRequest`——运行时校验，用于挡掉畸形消息
  - 消息类型常量 `MSG`

- [ ] **Step 1: 写失败测试**

`tests/unit/messages.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { isRequest, createRequestId, MSG } from '../../src/shared/messages';

describe('消息协议', () => {
  it('识别合法请求', () => {
    expect(isRequest({ type: MSG.JUDGE_ITEMS, id: 'r1', payload: { items: [], mode: 'cocoon' } })).toBe(true);
  });

  it('拒绝缺 type 的消息', () => {
    expect(isRequest({ id: 'r1' })).toBe(false);
  });

  it('拒绝缺 id 的消息', () => {
    expect(isRequest({ type: MSG.JUDGE_ITEMS, payload: { items: [], mode: 'cocoon' } })).toBe(false);
  });

  it('拒绝未知 type', () => {
    expect(isRequest({ type: 'NOT_A_REAL_TYPE', id: 'r1' })).toBe(false);
  });

  it('拒绝 null 与非对象', () => {
    expect(isRequest(null)).toBe(false);
    expect(isRequest('str')).toBe(false);
    expect(isRequest(42)).toBe(false);
  });

  it('请求 id 互不相同', () => {
    expect(createRequestId()).not.toBe(createRequestId());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/shared/messages'`

- [ ] **Step 3: 写实现**

`src/shared/messages.ts`：
```ts
import type { ContentItem, Verdict, PageType, Mode, UserProfile } from './types';

export const MSG = {
  /** content → bg：请求判定一批内容 */
  JUDGE_ITEMS: 'JUDGE_ITEMS',
  /** content → bg：请求当前页面的动态词表 */
  GET_WORDLIST: 'GET_WORDLIST',
  /** content → bg：请求画像 */
  GET_PROFILE: 'GET_PROFILE',
  /** content → bg：记录用户看过的视频（增量画像） */
  RECORD_WATCH: 'RECORD_WATCH',
  /** content → bg：撤销某个判定 */
  REVOKE: 'REVOKE',
  /** popup → bg：取设置 */
  GET_SETTINGS: 'GET_SETTINGS',
  /** popup → bg：存设置 */
  SET_SETTINGS: 'SET_SETTINGS',
  /** popup → bg：取 LLM 配置（Key 需脱敏） */
  GET_LLM_CONFIG: 'GET_LLM_CONFIG',
  /** popup → bg：存 LLM 配置 */
  SET_LLM_CONFIG: 'SET_LLM_CONFIG',
  /** popup → bg：连通性自测 */
  TEST_LLM: 'TEST_LLM',
  /** popup → bg：取屏蔽记录 */
  GET_BLOCKED_LOG: 'GET_BLOCKED_LOG',
  /** popup → bg：清空画像 */
  CLEAR_PROFILE: 'CLEAR_PROFILE',
  /** bg → content：执行动作 */
  APPLY_VERDICT: 'APPLY_VERDICT',
  /** bg → content：推送反向推荐结果 */
  PUSH_RECOMMENDATIONS: 'PUSH_RECOMMENDATIONS',
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

export interface JudgeItemsPayload {
  items: ContentItem[];
  mode: Mode;
}

export interface RecordWatchPayload {
  item: ContentItem;
  watchSeconds: number;
}

export interface RevokePayload {
  itemId: string;
}

export interface SetSettingsPayload {
  settings: Partial<import('./types').Settings>;
}

export interface SetLlmConfigPayload {
  config: import('./types').LlmConfig;
}

export interface TestLlmPayload {
  config?: import('./types').LlmConfig;
}

export interface MsgRequest {
  type: MsgType;
  id: string;
  payload?: unknown;
}

export interface MsgResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

const REQUEST_TYPES = new Set<string>(Object.values(MSG));

/** 运行时校验。service worker 收到的消息不可信，必须挡。 */
export function isRequest(msg: unknown): msg is MsgRequest {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (typeof m.type !== 'string' || !REQUEST_TYPES.has(m.type)) return false;
  if (typeof m.id !== 'string' || m.id.length === 0) return false;
  return true;
}

let counter = 0;
export function createRequestId(): string {
  counter = (counter + 1) % 0xffffff;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** 判定结果的载荷（bg → content）。 */
export interface ApplyVerdictPayload {
  verdicts: Verdict[];
}

/** 反向推荐结果的载荷（bg → content）。 */
export interface PushRecommendationsPayload {
  videoId: string;
  items: {
    bvid: string;
    title: string;
    author: string;
    /** 为什么推荐这个——必须是人话，说明它表达了相反观点 */
    reason: string;
    url: string;
  }[];
}

export type { ContentItem, Verdict, PageType, Mode, UserProfile };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/shared/messages.ts tests/unit/messages.test.ts
git commit -m "feat: 定义跨上下文消息协议与运行时校验"
```

---

## Task 5: 存储层

**Files:**
- Create: `src/bg/storage.ts`
- Test: `tests/unit/storage.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `STORAGE_KEYS`、`UserProfile`、`Settings`、`LlmConfig`
- Produces:
  - `getJson<T>(key: string, fallback: T): Promise<T>`
  - `setJson(key: string, value: unknown): Promise<void>`
  - `removeKey(key: string): Promise<void>`
  - `getSettings(): Promise<Settings>`
  - `saveSettings(patch: Partial<Settings>): Promise<Settings>`
  - `getProfile(): Promise<UserProfile | null>`
  - `saveProfile(p: UserProfile): Promise<void>`
  - `clearProfile(): Promise<void>`
  - `getLlmConfig(): Promise<LlmConfig | null>`
  - `saveLlmConfig(c: LlmConfig): Promise<void>`
  - `getWhitelist(): Promise<string[]>`
  - `addToWhitelist(id: string): Promise<void>`
  - `defaultSettings(): Settings`

**注意**：这些函数只能在 service worker / popup 上下文用（依赖 `chrome.storage`）。测试用 mock。

- [ ] **Step 1: 写失败测试**

`tests/unit/storage.test.ts`：
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const store: Record<string, unknown> = {};

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => {
        Object.assign(store, items);
        cb?.();
      },
      remove: (keys: string[], cb?: () => void) => {
        for (const k of keys) delete store[k];
        cb?.();
      },
    },
  },
});

import {
  getJson, setJson, getSettings, saveSettings, defaultSettings,
  getWhitelist, addToWhitelist, clearProfile,
} from '../../src/bg/storage';

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('存储层', () => {
  it('读不存在的键返回兜底值', async () => {
    expect(await getJson('missing', 'fallback')).toBe('fallback');
  });

  it('写入后能读回', async () => {
    await setJson('k', { a: 1 });
    expect(await getJson('k', null)).toEqual({ a: 1 });
  });

  it('默认设置是信息茧房模式且三页面都开', () => {
    const s = defaultSettings();
    expect(s.mode).toBe('cocoon');
    expect(s.masterEnabled).toBe(true);
    expect(s.enabledPages.search).toBe(true);
    expect(s.enabledPages.video).toBe(true);
    expect(s.enabledPages.feed).toBe(true);
  });

  it('保存设置只改传入的字段', async () => {
    await setJson('settings', defaultSettings());
    const next = await saveSettings({ mode: 'anti' });
    expect(next.mode).toBe('anti');
    expect(next.masterEnabled).toBe(true);
  });

  it('白名单去重', async () => {
    await addToWhitelist('a');
    await addToWhitelist('a');
    await addToWhitelist('b');
    expect((await getWhitelist()).sort()).toEqual(['a', 'b']);
  });

  it('清空画像后读回 null', async () => {
    await setJson('profile', { interests: [] });
    await clearProfile();
    expect(await getJson('profile', null)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/bg/storage'`

- [ ] **Step 3: 写实现**

`src/bg/storage.ts`：
```ts
import { STORAGE_KEYS } from '../shared/constants';
import type { Settings, UserProfile, LlmConfig } from '../shared/types';

/**
 * chrome.storage.local 的 Promise 包装。
 *
 * 只用 local 不用 sync：sync 会把数据同步到 Google 账号，
 * 与「画像只存在本机」的隐私承诺冲突。
 */

function promisify<T>(fn: (cb: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve) => fn(resolve));
}

export async function getJson<T>(key: string, fallback: T): Promise<T> {
  const res = await promisify<Record<string, unknown>>((cb) =>
    chrome.storage.local.get([key], cb),
  );
  const v = res[key];
  return v === undefined || v === null ? fallback : (v as T);
}

export async function setJson(key: string, value: unknown): Promise<void> {
  await promisify<boolean>((cb) => chrome.storage.local.set({ [key]: value }, () => cb(true)));
}

export async function removeKey(key: string): Promise<void> {
  await promisify<boolean>((cb) => chrome.storage.local.remove([key], () => cb(true)));
}

export function defaultSettings(): Settings {
  return {
    mode: 'cocoon',
    enabledPages: { search: true, video: true, feed: true, unknown: false },
    masterEnabled: true,
    collectHistory: true,
    confidenceThreshold: 0.7,
  };
}

export async function getSettings(): Promise<Settings> {
  const saved = await getJson<Partial<Settings>>(STORAGE_KEYS.settings, {});
  const base = defaultSettings();
  return {
    ...base,
    ...saved,
    enabledPages: { ...base.enabledPages, ...(saved.enabledPages ?? {}) },
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = {
    ...cur,
    ...patch,
    enabledPages: { ...cur.enabledPages, ...(patch.enabledPages ?? {}) },
  };
  await setJson(STORAGE_KEYS.settings, next);
  return next;
}

export async function getProfile(): Promise<UserProfile | null> {
  return getJson<UserProfile | null>(STORAGE_KEYS.profile, null);
}

export async function saveProfile(p: UserProfile): Promise<void> {
  await setJson(STORAGE_KEYS.profile, p);
}

export async function clearProfile(): Promise<void> {
  await removeKey(STORAGE_KEYS.profile);
  await removeKey(STORAGE_KEYS.watchLog);
}

export async function getLlmConfig(): Promise<LlmConfig | null> {
  return getJson<LlmConfig | null>(STORAGE_KEYS.llmConfig, null);
}

export async function saveLlmConfig(c: LlmConfig): Promise<void> {
  await setJson(STORAGE_KEYS.llmConfig, c);
}

export async function getWhitelist(): Promise<string[]> {
  return getJson<string[]>(STORAGE_KEYS.whitelist, []);
}

export async function addToWhitelist(id: string): Promise<void> {
  const cur = await getWhitelist();
  if (cur.includes(id)) return;
  await setJson(STORAGE_KEYS.whitelist, [...cur, id]);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/bg/storage.ts tests/unit/storage.test.ts
git commit -m "feat: 新增本地存储层与设置读写"
```

---

## Task 6: LLM 客户端抽象

**Files:**
- Create: `src/bg/llm/client.ts`
- Create: `src/bg/llm/openai.ts`
- Create: `src/bg/llm/anthropic.ts`
- Test: `tests/unit/llm-client.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LlmConfig`
- Produces:
  - `interface LlmClient { complete(prompt: string, opts?: { maxTokens?: number }): Promise<string> }`
  - `createLlmClient(config: LlmConfig): LlmClient`
  - `buildChatMessages(system: string, user: string): { role: string; content: string }[]`——两个协议共用的消息构造
  - `parseJsonResponse<T>(raw: string): T | null`——从 LLM 返回里抠 JSON，容忍 ```json 包裹与前后废话

- [ ] **Step 1: 写失败测试**

`tests/unit/llm-client.test.ts`：
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLlmClient, parseJsonResponse, buildChatMessages } from '../../src/bg/llm/client';

afterEach(() => vi.restoreAllMocks());

describe('LLM 客户端', () => {
  it('OpenAI 协议打到正确端点并带 Key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }), { status: 200 }),
    );
    const c = createLlmClient({
      provider: 'openai', baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test', model: 'm1', timeoutMs: 5000,
    });
    const out = await c.complete('hello');
    expect(out).toBe('hi');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/chat/completions');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' });
  });

  it('Anthropic 协议用 x-api-key 头', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ type: 'text', text: 'yo' }] }), { status: 200 }),
    );
    const c = createLlmClient({
      provider: 'anthropic', baseUrl: 'https://api.anthropic.com',
      apiKey: 'ak-test', model: 'm2', timeoutMs: 5000,
    });
    expect(await c.complete('hello')).toBe('yo');
    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'ak-test' });
  });

  it('HTTP 错误抛出可读信息且不含 Key', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('boom', { status: 500 }));
    const c = createLlmClient({
      provider: 'openai', baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-secret', model: 'm1', timeoutMs: 5000,
    });
    await expect(c.complete('x')).rejects.toThrow(/500/);
    await expect(c.complete('x')).rejects.not.toThrow(/sk-secret/);
  });

  it('网络异常被包装成错误', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const c = createLlmClient({
      provider: 'openai', baseUrl: 'https://api.example.com/v1',
      apiKey: 'k', model: 'm', timeoutMs: 1000,
    });
    await expect(c.complete('x')).rejects.toThrow(/network down/);
  });

  it('parseJsonResponse 能剥掉 markdown 包裹', () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('parseJsonResponse 能从废话里抠出 JSON', () => {
    expect(parseJsonResponse('好的，结果如下：{"a":1} 希望有用')).toEqual({ a: 1 });
  });

  it('parseJsonResponse 遇到非 JSON 返回 null', () => {
    expect(parseJsonResponse('完全不是 JSON')).toBeNull();
  });

  it('buildChatMessages 产出两条消息', () => {
    const m = buildChatMessages('sys', 'usr');
    expect(m).toHaveLength(2);
    expect(m[0]!.content).toBe('sys');
    expect(m[1]!.content).toBe('usr');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/bg/llm/client'`

- [ ] **Step 3: 写 client.ts**

`src/bg/llm/client.ts`：
```ts
import type { LlmConfig } from '../../shared/types';
import { openAiComplete } from './openai';
import { anthropicComplete } from './anthropic';

export interface LlmClient {
  /** 返回模型的纯文本输出。失败时抛 Error（消息里不得含 API Key）。 */
  complete(prompt: string, opts?: { system?: string; maxTokens?: number }): Promise<string>;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function buildChatMessages(system: string | undefined, user: string): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  if (system) msgs.push({ role: 'system', content: system });
  msgs.push({ role: 'user', content: user });
  return msgs;
}

/**
 * 从 LLM 输出里抠 JSON。
 * 真实模型经常在 JSON 前后加话或用 ```json 包裹，所以不能直接 JSON.parse。
 * 抠不出来返回 null——调用方负责降级，不要抛。
 */
export function parseJsonResponse<T>(raw: string): T | null {
  const text = raw.trim();
  const candidates: string[] = [];

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1].trim());

  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    candidates.push(text.slice(braceStart, braceEnd + 1));
  }
  candidates.push(text);

  for (const c of candidates) {
    try {
      return JSON.parse(c) as T;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

export function createLlmClient(config: LlmConfig): LlmClient {
  if (config.provider === 'anthropic') {
    return {
      complete: (prompt, opts) =>
        anthropicComplete(config, prompt, opts?.system, opts?.maxTokens),
    };
  }
  return {
    complete: (prompt, opts) =>
      openAiComplete(config, prompt, opts?.system, opts?.maxTokens),
  };
}
```

- [ ] **Step 4: 写 openai.ts**

`src/bg/llm/openai.ts`：
```ts
import type { LlmConfig } from '../../shared/types';
import { buildChatMessages, type ChatMessage } from './client';

/** OpenAI 兼容协议。DeepSeek / MiniMax / Kimi / Qwen 等都走这个。 */
export async function openAiComplete(
  config: LlmConfig,
  prompt: string,
  system?: string,
  maxTokens?: number,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const messages: ChatMessage[] = buildChatMessages(system, prompt);
  const body = {
    model: config.model,
    messages,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  };

  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    throw new Error(`LLM 请求失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    // 只回传状态码与响应体前 200 字，不含请求头（Key 在请求头里）
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`LLM 返回 HTTP ${res.status}：${detail}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('LLM 响应格式异常：缺少 choices[0].message.content');
  }
  return content;
}
```

- [ ] **Step 5: 写 anthropic.ts**

`src/bg/llm/anthropic.ts`：
```ts
import type { LlmConfig } from '../../shared/types';

/** Anthropic 原生协议（Claude）。 */
export async function anthropicComplete(
  config: LlmConfig,
  prompt: string,
  system?: string,
  maxTokens?: number,
): Promise<string> {
  const base = config.baseUrl.replace(/\/+$/, '');
  const body = {
    model: config.model,
    max_tokens: maxTokens ?? 2048,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: prompt }],
  };

  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    throw new Error(`LLM 请求失败：${e instanceof Error ? e.message : String(e)}`);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`LLM 返回 HTTP ${res.status}：${detail}`);
  }

  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = (data.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
  if (!text) throw new Error('LLM 响应格式异常：缺少 content[].text');
  return text;
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，8 个测试全绿

- [ ] **Step 7: 跑类型检查**

Run: `npm run typecheck`
Expected: 退出码 0

若报 `Response` 类型缺失，在 `tsconfig.json` 的 `lib` 里加 `"DOM.Iterable"`（已有）并确认 `types` 含 `chrome`；若仍缺，`vitest.config.ts` 里加 `environment: 'node'` 已有，改为在测试文件顶部加 `/// <reference types="node" />` 并安装 `@types/node@22`。

- [ ] **Step 8: 提交**

```bash
git add src/bg/llm tests/unit/llm-client.test.ts
git commit -m "feat: 新增 LLM 客户端抽象与 OpenAI/Anthropic 双协议实现"
```

---

## Task 7: service worker 消息路由

**Files:**
- Modify: `src/bg/index.ts`
- Test: `tests/unit/bg-router.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `MSG` / `isRequest` / `MsgRequest` / `MsgResponse`，Task 5 的存储函数，Task 6 的 `createLlmClient`
- Produces:
  - `handleMessage(req: MsgRequest): Promise<MsgResponse>`——**纯函数式路由**，不依赖 `chrome.runtime` 全局，可在 Node 里测
  - `src/bg/index.ts` 只负责把 `chrome.runtime.onMessage` 接到 `handleMessage` 上

- [ ] **Step 1: 写失败测试**

`tests/unit/bg-router.test.ts`：
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MSG } from '../../src/shared/messages';

const store: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: (keys: string[], cb: (r: Record<string, unknown>) => void) => {
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        cb(out);
      },
      set: (items: Record<string, unknown>, cb?: () => void) => { Object.assign(store, items); cb?.(); },
      remove: (keys: string[], cb?: () => void) => { for (const k of keys) delete store[k]; cb?.(); },
    },
  },
});

import { handleMessage } from '../../src/bg/router';

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
});

describe('service worker 路由', () => {
  it('GET_SETTINGS 返回默认设置', async () => {
    const r = await handleMessage({ type: MSG.GET_SETTINGS, id: '1' });
    expect(r.ok).toBe(true);
    expect((r.data as { mode: string }).mode).toBe('cocoon');
  });

  it('SET_SETTINGS 后 GET_SETTINGS 能读到', async () => {
    await handleMessage({ type: MSG.SET_SETTINGS, id: '1', payload: { settings: { mode: 'anti' } } });
    const r = await handleMessage({ type: MSG.GET_SETTINGS, id: '2' });
    expect((r.data as { mode: string }).mode).toBe('anti');
  });

  it('未知类型返回错误而不是抛异常', async () => {
    const r = await handleMessage({ type: 'BOGUS' as never, id: '1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('GET_LLM_CONFIG 不回传 API Key 明文', async () => {
    await handleMessage({
      type: MSG.SET_LLM_CONFIG, id: '1',
      payload: { config: { provider: 'openai', baseUrl: 'https://x/v1', apiKey: 'sk-secret', model: 'm', timeoutMs: 1000 } },
    });
    const r = await handleMessage({ type: MSG.GET_LLM_CONFIG, id: '2' });
    expect(JSON.stringify(r.data)).not.toContain('sk-secret');
  });

  it('REVOKE 把 id 加进白名单', async () => {
    const r = await handleMessage({ type: MSG.REVOKE, id: '1', payload: { itemId: 'x1' } });
    expect(r.ok).toBe(true);
    expect(store['whitelist']).toEqual(['x1']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/bg/router'`

- [ ] **Step 3: 写 router.ts**

`src/bg/router.ts`：
```ts
import { MSG, type MsgRequest, type MsgResponse } from '../shared/messages';
import {
  getSettings, saveSettings, getProfile, clearProfile,
  getLlmConfig, saveLlmConfig, getWhitelist, addToWhitelist,
} from './storage';
import { createLlmClient } from './llm/client';

/**
 * service worker 的消息路由。
 *
 * 抽成独立模块是为了能在 Node 里直接测——chrome.runtime.onMessage
 * 在测试环境里不存在，路由逻辑本身却完全不需要它。
 */
export async function handleMessage(req: MsgRequest): Promise<MsgResponse> {
  const id = req.id;
  try {
    switch (req.type) {
      case MSG.GET_SETTINGS:
        return { id, ok: true, data: await getSettings() };

      case MSG.SET_SETTINGS: {
        const patch = (req.payload as { settings?: Partial<import('../shared/types').Settings> })?.settings ?? {};
        return { id, ok: true, data: await saveSettings(patch) };
      }

      case MSG.GET_PROFILE:
        return { id, ok: true, data: await getProfile() };

      case MSG.CLEAR_PROFILE:
        await clearProfile();
        return { id, ok: true, data: null };

      case MSG.GET_LLM_CONFIG: {
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: true, data: null };
        // Key 脱敏：popup 只需知道「配没配」，不需知道明文
        return {
          id, ok: true,
          data: { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, timeoutMs: cfg.timeoutMs, hasKey: true },
        };
      }

      case MSG.SET_LLM_CONFIG: {
        const cfg = (req.payload as { config?: import('../shared/types').LlmConfig })?.config;
        if (!cfg) return { id, ok: false, error: '缺少 LLM 配置' };
        await saveLlmConfig(cfg);
        return { id, ok: true, data: { saved: true } };
      }

      case MSG.TEST_LLM: {
        const override = (req.payload as { config?: import('../shared/types').LlmConfig })?.config;
        const cfg = override ?? (await getLlmConfig());
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM' };
        const client = createLlmClient(cfg);
        const out = await client.complete('回复「ok」两个字即可。', { maxTokens: 16 });
        return { id, ok: true, data: { output: out } };
      }

      case MSG.GET_WHITELIST:
        return { id, ok: true, data: await getWhitelist() };

      case MSG.REVOKE: {
        const itemId = (req.payload as { itemId?: string })?.itemId;
        if (!itemId) return { id, ok: false, error: '缺少 itemId' };
        await addToWhitelist(itemId);
        return { id, ok: true, data: { revoked: itemId } };
      }

      case MSG.GET_BLOCKED_LOG:
        return { id, ok: true, data: [] };

      default:
        return { id, ok: false, error: `未知的消息类型：${String(req.type)}` };
    }
  } catch (e) {
    return { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 4: 改写 service worker 入口**

`src/bg/index.ts`：
```ts
import { isRequest, type MsgResponse } from '../shared/messages';
import { handleMessage } from './router';

/**
 * service worker 入口。
 * 只做一件事：把 chrome.runtime.onMessage 接到路由。
 * MV3 的 service worker 会被 Chrome 随时挂起，所以不能有常驻状态。
 */

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, sendResponse: (r: MsgResponse) => void) => {
    if (!isRequest(msg)) {
      sendResponse({ id: '', ok: false, error: '消息格式非法' });
      return false;
    }
    handleMessage(msg)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true; // 保持消息通道开放，等异步结果
  },
);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，5 个测试全绿

- [ ] **Step 6: 跑构建**

Run: `npm run build`
Expected: 退出码 0，`dist/manifest.json` 生成

- [ ] **Step 7: 提交**

```bash
git add src/bg tests/unit/bg-router.test.ts
git commit -m "feat: 新增 service worker 消息路由与设置/配置接口"
```

---

## Task 8: 页面类型识别

**Files:**
- Create: `src/content/page.ts`
- Test: `tests/unit/page.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `PageType`
- Produces: `detectPageType(url: string): PageType`
  - `https://search.bilibili.com/all?keyword=x` → `'search'`
  - `https://www.bilibili.com/video/BVxxxx` → `'video'`
  - `https://www.bilibili.com/`（首页推荐流）、`https://t.bilibili.com/` → `'feed'`
  - 其他 → `'unknown'`

- [ ] **Step 1: 写失败测试**

`tests/unit/page.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { detectPageType } from '../../src/content/page';

describe('页面类型识别', () => {
  it('搜索页', () => {
    expect(detectPageType('https://search.bilibili.com/all?keyword=test')).toBe('search');
    expect(detectPageType('https://search.bilibili.com/video?keyword=test')).toBe('search');
  });

  it('视频页', () => {
    expect(detectPageType('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('video');
    expect(detectPageType('https://www.bilibili.com/video/BV1xx411c7D/?spm_id_from=333.1')).toBe('video');
  });

  it('首页推荐流', () => {
    expect(detectPageType('https://www.bilibili.com/')).toBe('feed');
    expect(detectPageType('https://www.bilibili.com/?spm_id_from=333.1')).toBe('feed');
  });

  it('动态页算 feed', () => {
    expect(detectPageType('https://t.bilibili.com/')).toBe('feed');
  });

  it('其他页面为 unknown', () => {
    expect(detectPageType('https://www.bilibili.com/read/cv123')).toBe('unknown');
    expect(detectPageType('https://example.com/')).toBe('unknown');
  });

  it('非法 url 不抛异常', () => {
    expect(detectPageType('not a url')).toBe('unknown');
    expect(detectPageType('')).toBe('unknown');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/content/page'`

- [ ] **Step 3: 写实现**

`src/content/page.ts`：
```ts
import type { PageType } from '../shared/types';

/**
 * 识别当前页面属于哪一类干预点。
 * 识别不出来就返回 unknown——适配层据此放弃干预，绝不猜。
 */
export function detectPageType(url: string): PageType {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'unknown';
  }
  if (!u.hostname.endsWith('bilibili.com')) return 'unknown';

  const host = u.hostname;
  const path = u.pathname;

  if (host === 'search.bilibili.com') return 'search';
  if (path.startsWith('/video/')) return 'video';
  if (host === 't.bilibili.com') return 'feed';
  if (host === 'www.bilibili.com' || host === 'bilibili.com') {
    if (path === '/' || path === '') return 'feed';
  }
  return 'unknown';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/content/page.ts tests/unit/page.test.ts
git commit -m "feat: 新增 B 站页面类型识别"
```

---

## Task 9: 端到端自检与 README

**Files:**
- Create: `README.md`
- Create: `docs/testing-checklist.md`
- Modify: `src/popup/main.ts`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可加载的扩展 + 人工验证清单

- [ ] **Step 1: 写 README**

`README.md`（内容必须与实际实现一致）：

```markdown
# （反）信息茧房

一个面向 B 站（bilibili）的 Chrome 扩展，用 LLM 分析你的个人喜好，
让你主动选择是**收紧**信息摄入（信息茧房模式），还是**打破**信息闭环（反信息茧房模式）。

## 隐私

- **没有后端。** 本扩展不运行任何服务器，不做遥测，不收集统计。
- **你的画像只存在你的浏览器里**（`chrome.storage.local`），永不上传。
- **API Key 由你自己提供**，保存在本机 `chrome.storage.local`，只在你调用 LLM 时使用。
- **会读取的内容**：观看历史、收藏夹、关注列表（用于生成画像），
  以及你浏览页面上可见的视频标题、评论正文（用于判定）。
- **会离开你浏览器的数据**：发给你自己配置的 LLM 服务商的请求内容
  （评论正文、视频标题）。选择哪个服务商，数据就流向哪里。
- 关闭采集历史：设置面板里关掉「拉取观看历史」，只用增量画像。

## 安装

```bash
npm install
npm run build
```

然后打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选 `dist/` 目录。

## 配置

点扩展图标打开面板，填入：

- 服务商：OpenAI 兼容（DeepSeek / MiniMax / Kimi / Qwen 等）或 Anthropic
- Base URL、API Key、模型名

填完点「测试连通性」。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 存画像、缓存、你自己的 API Key |
| `alarms` | MV3 后台 30 秒即休眠，定时刷新画像必须用它 |
| `scripting` | 页面加载后按需注入内容脚本 |
| `https://*.bilibili.com/*` | 插件只在 B 站上工作 |

## 开发

```bash
npm run dev        # watch 构建
npm run test       # 单元测试
npm run typecheck  # 类型检查
```

## 状态

当前处于早期开发阶段，功能尚未完整。

## License

MIT
```

- [ ] **Step 2: 写测试清单**

`docs/testing-checklist.md`：

```markdown
# 人工验证清单

自动化测试覆盖不到的部分（真实 B 站页面、真实 LLM 调用），按此逐项人工验证。

## 计划 01（骨架）

- [ ] Chrome 能加载 `dist/`，无错误
- [ ] 打开 `chrome://extensions` → 「Service Worker」能点开看到控制台
- [ ] 点击扩展图标，popup 打开显示「（反）信息茧房」
- [ ] popup 打开时控制台无异常
- [ ] `chrome.storage.local` 中能看到 `settings` 键

## 后续计划

（随计划推进补充）
```

- [ ] **Step 3: popup 显示配置入口占位**

`src/popup/main.ts`：
```ts
async function main(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <h1>（反）信息茧房</h1>
    <p class="muted">配置面板开发中。</p>
  `;
}

void main();
```

- [ ] **Step 4: 全量验证**

Run: `npm run typecheck && npm run test && npm run build`
Expected: 三条命令全部退出码 0

- [ ] **Step 5: 人工验证（在 Chrome 里做）**

1. `npm run build`
2. 打开 `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `dist/`
3. 确认扩展卡片无错误徽标
4. 点击扩展图标 → popup 显示「（反）信息茧房」
5. 打开 `chrome://extensions` → 该扩展 → 「Service Worker」→ 控制台无报错
6. 打开任意 B 站页面 → 页面控制台无报错

**任一步失败就不要提交**，先修好。

- [ ] **Step 6: 提交**

```bash
git add README.md docs/testing-checklist.md src/popup/main.ts
git commit -m "docs: 新增 README、隐私说明与人工验证清单"
```

---

## 完成标准

- [ ] `npm run typecheck` 退出码 0
- [ ] `npm run test` 全部通过
- [ ] `npm run build` 产出 `dist/`
- [ ] Chrome 能加载扩展，popup 正常，service worker 无报错
- [ ] 全部代码已提交，git status 干净
- [ ] 计划 02 可以直接开始，无需回头改本计划的文件
