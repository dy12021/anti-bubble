# 计划 05：适配器与动作层

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现三个页面适配器（搜索页/视频页/推荐流）、动作层（折叠/隐藏/标识/推荐卡片，含可解释与撤销）、以及反向推荐的召回与展示。

**Architecture:** 适配层每个页面一个模块，只负责从 DOM 抽出 `ContentItem`，**抽不动就返回空数组**（硬兜底）。动作层接收 `Verdict` 并操作 DOM，提供展开理由与一键撤销。反向推荐复用计划 04 的词表（`oppositeKeywords`）走两段式召回。

**Tech Stack:** TypeScript 5.5.2、Vitest 2.1.1、jsdom 25.0.1

**依赖:** 计划 01（类型）、计划 02（B 站 API）、计划 03（画像）、计划 04（判定流水线）。

---

## Global Constraints

- **适配器硬兜底**：抽不到内容必须返回空数组，**不得抛错、不得阻塞页面**。改版时表现为「这个页面不干预」，而不是「页面报错」。
- 适配器用 **DOM fixture 测试**固化结构假设——B 站改版时测试即报，而不是等用户报障。
- 动作层所有屏蔽**必须可展开看理由 + 一键撤销**；撤销写入白名单。
- 动作层**不得**修改 B 站原有 DOM 结构（只做折叠/隐藏/加标识），避免破坏站点功能。
- 三个页面的干预**各自独立开关**，可单独关闭。
- 反向推荐必须带「为什么这是相反观点」的人话说明。

---

## File Structure

```
src/
├── adapters/
│   ├── types.ts        # Adapter 接口
│   ├── search.ts
│   ├── video.ts
│   ├── feed.ts
│   └── index.ts        # 按页面类型分发
├── actions/
│   ├── fold.ts         # 折叠 + 展开理由 + 撤销
│   ├── mark.ts         # 标识
│   ├── recommend.ts    # 推荐卡片
│   └── index.ts
├── recommend/
│   ├── recall.ts       # 两段式召回
│   └── opposition.ts   # 立场判定
└── content/
    └── controller.ts   # 页面控制器：抽 → 判 → 执行
tests/
├── unit/
│   ├── adapter-search.test.ts
│   ├── adapter-video.test.ts
│   ├── adapter-feed.test.ts
│   ├── actions-fold.test.ts
│   └── recommend-recall.test.ts
└── fixtures/
    ├── search.html
    ├── video.html
    └── feed.html
```

---

### Task 1: 适配器接口与搜索页适配器

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/search.ts`
- Create: `tests/fixtures/search.html`
- Test: `tests/unit/adapter-search.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `ContentItem`
- Produces:
  - `interface Adapter`——`{ page: PageType; collect(root: ParentNode): ContentItem[] }`
  - `searchAdapter: Adapter`
  - `extractBvid(href: string): string | null`——从 B 站视频链接里取 bvid

- [ ] **Step 1: 写 fixture**

`tests/fixtures/search.html`：
```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>搜索</title></head>
  <body>
    <div class="bili-video-card">
      <a href="//www.bilibili.com/video/BV1xx411c7mD" class="bili-video-card__link--href">
        <div class="bili-video-card__info--tit"><h3 class="bili-video-card__info--tit">第一个视频标题</h3></div>
      </a>
      <div class="bili-video-card__info--author">UP主甲</div>
    </div>
    <div class="bili-video-card">
      <a href="//www.bilibili.com/video/BV1second" class="bili-video-card__link--href">
        <div class="bili-video-card__info--tit"><h3 class="bili-video-card__info--tit">第二个视频标题</h3></div>
      </a>
      <div class="bili-video-card__info--author">UP主乙</div>
    </div>
    <div class="not-a-card">干扰元素</div>
  </body>
</html>
```

- [ ] **Step 2: 写失败测试**

`tests/unit/adapter-search.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { searchAdapter, extractBvid } from '../../src/adapters/search';

const html = readFileSync(join(__dirname, '../fixtures/search.html'), 'utf8');

function dom(): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('extractBvid', () => {
  it('从绝对链接取 bvid', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });
  it('从协议相对链接取 bvid', () => {
    expect(extractBvid('//www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });
  it('带查询参数也能取', () => {
    expect(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=333')).toBe('BV1xx411c7mD');
  });
  it('非视频链接返回 null', () => {
    expect(extractBvid('https://www.bilibili.com/')).toBeNull();
  });
  it('空串返回 null', () => {
    expect(extractBvid('')).toBeNull();
  });
});

describe('搜索页适配器', () => {
  it('抽出两个视频卡片', () => {
    const items = searchAdapter.collect(dom());
    expect(items).toHaveLength(2);
  });

  it('抽出正确的标题', () => {
    const items = searchAdapter.collect(dom());
    expect(items[0]!.text).toContain('第一个视频标题');
  });

  it('抽出正确的 bvid', () => {
    const items = searchAdapter.collect(dom());
    expect(items[0]!.id).toBe('BV1xx411c7mD');
  });

  it('抽出作者', () => {
    const items = searchAdapter.collect(dom());
    expect(items[0]!.author).toBe('UP主甲');
  });

  it('item 的 kind 是 video', () => {
    expect(searchAdapter.collect(dom())[0]!.kind).toBe('video');
  });

  it('context.page 是 search', () => {
    expect(searchAdapter.collect(dom())[0]!.context.page).toBe('search');
  });

  it('空 DOM 返回空数组而不是抛错', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(searchAdapter.collect(empty)).toEqual([]);
  });

  it('结构改版抽不到时返回空数组（硬兜底）', () => {
    const changed = new DOMParser().parseFromString(
      '<html><body><div class="totally-different"></div></body></html>', 'text/html',
    );
    expect(searchAdapter.collect(changed)).toEqual([]);
  });
});
```

> **jsdom 需要在测试文件里启用 DOMParser**。把 `vitest.config.ts` 改成：
> ```ts
> export default defineConfig({
>   test: {
>     environment: 'jsdom',
>     include: ['tests/unit/**/*.test.ts'],
>   },
> });
> ```
> `environment: 'jsdom'` 全局生效，纯逻辑测试也不受影响（jsdom 提供了 Node 的全部 API）。

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/adapters/search'`

- [ ] **Step 4: 写 types.ts**

`src/adapters/types.ts`：
```ts
import type { ContentItem, PageType } from '../shared/types';

/**
 * 页面适配器。
 *
 * **硬兜底约定**：collect() 抽不到内容时必须返回空数组，
 * 不得抛错、不得让页面报错。B 站改版时表现为「这个页面不干预」。
 */
export interface Adapter {
  page: PageType;
  collect(root: ParentNode): ContentItem[];
}
```

- [ ] **Step 5: 写 search.ts**

`src/adapters/search.ts`：
```ts
import type { ContentItem } from '../shared/types';
import type { Adapter } from './types';

/** 从各种形式的 B 站视频链接里取 bvid。取不到返回 null。 */
export function extractBvid(href: string): string | null {
  if (!href) return null;
  const m = href.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return m ? m[1]! : null;
}

/**
 * 搜索页适配器。
 *
 * B 站搜索结果的卡片结构（2026-10）：
 *   .bili-video-card  > a[href*="/video/"]  → 标题 .bili-video-card__info--tit
 *                                        →  作者 .bili-video-card__info--author
 * 结构变了就抽不到 → 返回空数组 → 该页不干预。不会报错。
 */
export const searchAdapter: Adapter = {
  page: 'search',
  collect(root: ParentNode): ContentItem[] {
    const out: ContentItem[] = [];
    const cards = root.querySelectorAll('.bili-video-card');
    for (const card of cards) {
      try {
        const link = card.querySelector<HTMLAnchorElement>('a[href*="/video/"]');
        if (!link) continue;
        const bvid = extractBvid(link.getAttribute('href') ?? '');
        if (!bvid) continue;

        const titleEl = card.querySelector('.bili-video-card__info--tit');
        const authorEl = card.querySelector('.bili-video-card__info--author');
        const title = (titleEl?.textContent ?? '').trim();
        if (!title) continue;

        out.push({
          kind: 'video',
          id: bvid,
          text: title,
          author: (authorEl?.textContent ?? '').trim(),
          meta: {},
          context: { page: 'search' },
        });
      } catch {
        // 单张卡片出错不影响其它卡片
        continue;
      }
    }
    return out;
  },
};
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，adapter-search 12 个测试全绿

- [ ] **Step 7: 提交**

```bash
git add src/adapters tests/fixtures/search.html tests/unit/adapter-search.test.ts vitest.config.ts
git commit -m "feat: 新增适配器接口与搜索页适配器"
```

---

### Task 2: 视频页适配器

**Files:**
- Create: `src/adapters/video.ts`
- Create: `tests/fixtures/video.html`
- Test: `tests/unit/adapter-video.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `ContentItem`
- Produces:
  - `videoAdapter: Adapter`
  - `extractBvidFromPageUrl(url: string): string | null`

- [ ] **Step 1: 写 fixture**

`tests/fixtures/video.html`：
```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>视频页</title></head>
  <body>
    <h1 class="video-title">这个视频在讲 Rust</h1>
    <div class="reply-item" data-rpid="111">
      <div class="user-name">用户甲</div>
      <div class="reply-content">这是一条普通评论</div>
    </div>
    <div class="reply-item" data-rpid="222">
      <div class="user-name">用户乙</div>
      <div class="reply-content">这就是引战，别看了</div>
    </div>
    <div class="reply-item">
      <div class="user-name">没有 rpid 的评论</div>
      <div class="reply-content">这条应当被跳过</div>
    </div>
  </body>
</html>
```

- [ ] **Step 2: 写失败测试**

`tests/unit/adapter-video.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { videoAdapter, extractBvidFromPageUrl } from '../../src/adapters/video';

const html = readFileSync(join(__dirname, '../fixtures/video.html'), 'utf8');
const dom = () => new DOMParser().parseFromString(html, 'text/html');

describe('extractBvidFromPageUrl', () => {
  it('取视频页 bvid', () => {
    expect(extractBvidFromPageUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBe('BV1xx411c7mD');
  });
  it('非视频页返回 null', () => {
    expect(extractBvidFromPageUrl('https://www.bilibili.com/')).toBeNull();
  });
  it('空串返回 null', () => {
    expect(extractBvidFromPageUrl('')).toBeNull();
  });
});

describe('视频页适配器', () => {
  it('抽出两条评论', () => {
    expect(videoAdapter.collect(dom())).toHaveLength(2);
  });

  it('跳过没有 rpid 的评论', () => {
    const ids = videoAdapter.collect(dom()).map((i) => i.id);
    expect(ids).not.toContain('');
    expect(ids).toHaveLength(2);
  });

  it('抽出正确的 rpid', () => {
    expect(videoAdapter.collect(dom())[0]!.id).toBe('111');
  });

  it('抽出评论正文', () => {
    expect(videoAdapter.collect(dom())[0]!.text).toBe('这是一条普通评论');
  });

  it('抽出评论作者', () => {
    expect(videoAdapter.collect(dom())[0]!.author).toBe('用户甲');
  });

  it('item 的 kind 是 comment', () => {
    expect(videoAdapter.collect(dom())[0]!.kind).toBe('comment');
  });

  it('context.page 是 video', () => {
    expect(videoAdapter.collect(dom())[0]!.context.page).toBe('video');
  });

  it('空 DOM 返回空数组', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(videoAdapter.collect(empty)).toEqual([]);
  });

  it('结构改版抽不到时返回空数组', () => {
    const changed = new DOMParser().parseFromString(
      '<html><body><div class="new-comment-design"></div></body></html>', 'text/html',
    );
    expect(videoAdapter.collect(changed)).toEqual([]);
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/adapters/video'`

- [ ] **Step 4: 写实现**

`src/adapters/video.ts`：
```ts
import type { ContentItem } from '../shared/types';
import type { Adapter } from './types';

/** 从页面 URL 取 bvid。 */
export function extractBvidFromPageUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return m ? m[1]! : null;
}

/**
 * 视频页适配器：抽评论 + 视频标题。
 *
 * B 站评论节点（2026-10，两种形态都兼容）：
 *   旧版 .reply-item[data-rpid] > .user-name / .reply-content
 *   新版 Shadow DOM（.bili-comment-thread-renderer）——
 *     **Shadow DOM 里的内容 querySelector 抽不到**，
 *     所以这里只处理普通 DOM。新版由 content controller 另行处理，
 *     抽不到就返回空数组（该页不干预），不做兜底猜测。
 */
export const videoAdapter: Adapter = {
  page: 'video',
  collect(root: ParentNode): ContentItem[] {
    const out: ContentItem[] = [];

    const videoTitle =
      root.querySelector('.video-title')?.textContent?.trim() ?? '';
    const bvid = extractBvidFromPageUrl(
      typeof location !== 'undefined' ? location.href : '',
    );

    const nodes = root.querySelectorAll('.reply-item[data-rpid]');
    for (const node of nodes) {
      try {
        const rpid = node.getAttribute('data-rpid');
        if (!rpid) continue;
        const contentEl = node.querySelector('.reply-content');
        const text = (contentEl?.textContent ?? '').trim();
        if (!text) continue;
        const author = (
          node.querySelector('.user-name')?.textContent ?? ''
        ).trim();

        out.push({
          kind: 'comment',
          id: rpid,
          text,
          author,
          meta: {},
          context: {
            page: 'video',
            videoId: bvid ?? undefined,
            videoTitle: videoTitle || undefined,
          },
        });
      } catch {
        continue;
      }
    }

    return out;
  },
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，adapter-video 11 个测试全绿

- [ ] **Step 6: 提交**

```bash
git add src/adapters/video.ts tests/fixtures/video.html tests/unit/adapter-video.test.ts
git commit -m "feat: 新增视频页适配器"
```

---

### Task 3: 推荐流适配器与分发

**Files:**
- Create: `src/adapters/feed.ts`
- Create: `src/adapters/index.ts`
- Create: `tests/fixtures/feed.html`
- Test: `tests/unit/adapter-feed.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `PageType` / `ContentItem`，Task 2 的 `searchAdapter` / `videoAdapter`
- Produces:
  - `feedAdapter: Adapter`
  - `getAdapter(page: PageType): Adapter | null`

- [ ] **Step 1: 写 fixture**

`tests/fixtures/feed.html`：
```html
<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8" /><title>首页</title></head>
  <body>
    <div class="bili-video-card">
      <a href="//www.bilibili.com/video/BV1feed001" class="bili-video-card__link--href">
        <div class="bili-video-card__info--tit"><h3 class="bili-video-card__info--tit">推荐流视频一</h3></div>
      </a>
      <div class="bili-video-card__info--author">UP主丙</div>
    </div>
    <div class="bili-video-card">
      <a href="//www.bilibili.com/video/BV1feed002" class="bili-video-card__link--href">
        <div class="bili-video-card__info--tit"><h3 class="bili-video-card__info--tit">推荐流视频二</h3></div>
      </a>
      <div class="bili-video-card__info--author">UP主丁</div>
    </div>
  </body>
</html>
```

- [ ] **Step 2: 写失败测试**

`tests/unit/adapter-feed.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { feedAdapter } from '../../src/adapters/feed';
import { getAdapter } from '../../src/adapters';

const html = readFileSync(join(__dirname, '../fixtures/feed.html'), 'utf8');
const dom = () => new DOMParser().parseFromString(html, 'text/html');

describe('推荐流适配器', () => {
  it('抽出两个视频', () => {
    expect(feedAdapter.collect(dom())).toHaveLength(2);
  });
  it('抽出 bvid', () => {
    expect(feedAdapter.collect(dom())[0]!.id).toBe('BV1feed001');
  });
  it('抽出标题', () => {
    expect(feedAdapter.collect(dom())[0]!.text).toContain('推荐流视频一');
  });
  it('context.page 是 feed', () => {
    expect(feedAdapter.collect(dom())[0]!.context.page).toBe('feed');
  });
  it('空 DOM 返回空数组', () => {
    const empty = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(feedAdapter.collect(empty)).toEqual([]);
  });
});

describe('适配器分发', () => {
  it('search 返回搜索适配器', () => {
    expect(getAdapter('search')?.page).toBe('search');
  });
  it('video 返回视频适配器', () => {
    expect(getAdapter('video')?.page).toBe('video');
  });
  it('feed 返回推荐流适配器', () => {
    expect(getAdapter('feed')?.page).toBe('feed');
  });
  it('unknown 返回 null', () => {
    expect(getAdapter('unknown')).toBeNull();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/adapters/feed'`

- [ ] **Step 4: 写 feed.ts**

`src/adapters/feed.ts`：
```ts
import type { ContentItem } from '../shared/types';
import type { Adapter } from './types';
import { extractBvid } from './search';

/**
 * 推荐流适配器。
 *
 * 首页推荐与搜索结果的卡片结构一致（.bili-video-card），
 * 所以复用同一套选择器。
 */
export const feedAdapter: Adapter = {
  page: 'feed',
  collect(root: ParentNode): ContentItem[] {
    const out: ContentItem[] = [];
    const cards = root.querySelectorAll('.bili-video-card');
    for (const card of cards) {
      try {
        const link = card.querySelector<HTMLAnchorElement>('a[href*="/video/"]');
        if (!link) continue;
        const bvid = extractBvid(link.getAttribute('href') ?? '');
        if (!bvid) continue;
        const titleEl = card.querySelector('.bili-video-card__info--tit');
        const title = (titleEl?.textContent ?? '').trim();
        if (!title) continue;
        out.push({
          kind: 'video',
          id: bvid,
          text: title,
          author: (card.querySelector('.bili-video-card__info--author')?.textContent ?? '').trim(),
          meta: {},
          context: { page: 'feed' },
        });
      } catch {
        continue;
      }
    }
    return out;
  },
};
```

- [ ] **Step 5: 写 index.ts**

`src/adapters/index.ts`：
```ts
import type { PageType } from '../shared/types';
import type { Adapter } from './types';
import { searchAdapter } from './search';
import { videoAdapter } from './video';
import { feedAdapter } from './feed';

export type { Adapter } from './types';
export { searchAdapter, extractBvid } from './search';
export { videoAdapter, extractBvidFromPageUrl } from './video';
export { feedAdapter } from './feed';

/** 按页面类型取适配器。unknown 返回 null（该页不干预）。 */
export function getAdapter(page: PageType): Adapter | null {
  switch (page) {
    case 'search': return searchAdapter;
    case 'video': return videoAdapter;
    case 'feed': return feedAdapter;
    default: return null;
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，adapter-feed 9 个测试全绿

- [ ] **Step 7: 提交**

```bash
git add src/adapters tests/fixtures/feed.html tests/unit/adapter-feed.test.ts
git commit -m "feat: 新增推荐流适配器与页面分发"
```

---

### Task 4: 折叠动作与可解释撤销

**Files:**
- Create: `src/actions/fold.ts`
- Test: `tests/unit/actions-fold.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `Verdict`
- Produces:
  - `applyFold(root: ParentNode, itemId: string, verdict: Verdict, onRevoke: (id: string) => void): boolean`
  - `CSS_PREFIX`——注入样式的 id 前缀
  - `injectStyles(root: ParentNode): void`

- [ ] **Step 1: 写失败测试**

`tests/unit/actions-fold.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { applyFold, injectStyles, CSS_PREFIX } from '../../src/actions/fold';
import type { Verdict } from '../../src/shared/types';

function fixture(): Document {
  return new DOMParser().parseFromString(
    `<html><body>
      <div class="reply-item" data-rpid="111"><div class="reply-content">引战内容</div></div>
    </body></html>`, 'text/html',
  );
}

const verdict: Verdict = {
  itemId: '111', action: 'fold', reason: '在引战',
  reasonCode: 'incitement', confidence: 0.9, revocable: true,
};

describe('折叠动作', () => {
  it('折叠后内容不可见', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const el = d.querySelector('.reply-item') as HTMLElement;
    expect(el.style.display).toBe('none');
  });

  it('插入一条说明行', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`)).not.toBeNull();
  });

  it('说明行里有理由', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const notice = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`);
    expect(notice?.textContent).toContain('在引战');
  });

  it('找不到目标返回 false', () => {
    const d = fixture();
    expect(applyFold(d, '999', verdict, () => {})).toBe(false);
  });

  it('点「仍要显示」会调用撤销回调', () => {
    const d = fixture();
    const onRevoke = vi.fn();
    applyFold(d, '111', verdict, onRevoke);
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    expect(onRevoke).toHaveBeenCalledWith('111');
  });

  it('撤销后内容恢复可见', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    const el = d.querySelector('.reply-item') as HTMLElement;
    expect(el.style.display).not.toBe('none');
  });

  it('注入样式不会重复插入', () => {
    const d = fixture();
    injectStyles(d);
    injectStyles(d);
    expect(d.querySelectorAll(`[data-ab-prefix="${CSS_PREFIX}-styles"]`)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/actions/fold'`

- [ ] **Step 3: 写实现**

`src/actions/fold.ts`：
```ts
import type { Verdict } from '../shared/types';

/** 注入样式的标识前缀。用它做属性选择器，避免与站点自身样式冲突。 */
export const CSS_PREFIX = 'ab';

const STYLE_ID = `${CSS_PREFIX}-styles`;

/** 注入一次样式。重复调用不会重复插入。 */
export function injectStyles(root: ParentNode): void {
  if (root.querySelector(`[data-ab-prefix="${STYLE_ID}"]`)) return;
  const style = (root as Document).createElement('style');
  style.setAttribute('data-ab-prefix', STYLE_ID);
  style.textContent = `
.${CSS_PREFIX}-notice {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 10px; margin: 2px 0;
  font-size: 12px; line-height: 1.6;
  color: #61666d;
  background: rgba(0,0,0,.04);
  border-left: 2px solid #fb7299;
  border-radius: 2px;
}
.${CSS_PREFIX}-notice-reason { flex: 1; }
.${CSS_PREFIX}-revoke {
  cursor: pointer; border: 0; background: transparent;
  color: #fb7299; font-size: 12px; padding: 0 2px;
}
.${CSS_PREFIX}-revoke:hover { text-decoration: underline; }
.${CSS_PREFIX}-mark {
  display: inline-block; margin-left: 6px;
  padding: 0 5px; font-size: 11px; line-height: 1.6;
  color: #fff; background: #fb7299; border-radius: 3px;
}
.${CSS_PREFIX}-recommend {
  margin: 12px 0; padding: 12px;
  border: 1px dashed #fb7299; border-radius: 6px;
  background: rgba(251,114,153,.05);
}
.${CSS_PREFIX}-recommend-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.${CSS_PREFIX}-recommend-item { display: flex; gap: 6px; margin: 6px 0; font-size: 13px; }
.${CSS_PREFIX}-recommend-reason { color: #61666d; font-size: 12px; }
`;
  const host = (root as Document).head ?? (root as Document).documentElement;
  host?.appendChild(style);
}

/**
 * 折叠一条内容，并插入「理由 + 仍要显示」。
 *
 * 点「仍要显示」→ 恢复可见 + 调用 onRevoke（上层写白名单）。
 */
export function applyFold(
  root: ParentNode,
  itemId: string,
  verdict: Verdict,
  onRevoke: (id: string) => void,
): boolean {
  const doc = (root as Document);
  const target = doc.querySelector(`[data-rpid="${itemId}"]`);
  if (!target) return false;

  injectStyles(doc);

  const el = target as HTMLElement;
  el.style.display = 'none';

  // 已经插过说明就不重复
  if (doc.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"][data-item-id="${itemId}"]`)) {
    return true;
  }

  const notice = doc.createElement('div');
  notice.className = `${CSS_PREFIX}-notice`;
  notice.setAttribute('data-ab-prefix', `${CSS_PREFIX}-notice`);
  notice.setAttribute('data-item-id', itemId);

  const reason = doc.createElement('span');
  reason.className = `${CSS_PREFIX}-notice-reason`;
  reason.textContent = `已屏蔽（${verdict.reason || '未说明原因'}）`;

  const btn = doc.createElement('button');
  btn.className = `${CSS_PREFIX}-revoke`;
  btn.setAttribute('data-ab-prefix', `${CSS_PREFIX}-revoke`);
  btn.textContent = '仍要显示';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.style.display = '';
    notice.remove();
    onRevoke(itemId);
  });

  notice.appendChild(reason);
  notice.appendChild(btn);
  el.parentNode?.insertBefore(notice, el);
  return true;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，actions-fold 7 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/actions/fold.ts tests/unit/actions-fold.test.ts
git commit -m "feat: 新增折叠动作与可解释撤销"
```

---

### Task 5: 标识动作与推荐卡片

**Files:**
- Create: `src/actions/mark.ts`
- Create: `src/actions/recommend.ts`
- Test: `tests/unit/actions-mark.test.ts`

**Interfaces:**
- Consumes: Task 01 的 `Verdict`
- Produces:
  - `applyMark(root: ParentNode, itemId: string, verdict: Verdict): boolean`——给内容加一个标识标签
  - `renderRecommendations(root: ParentNode, anchor: Element, items: RecommendItem[]): boolean`
  - `interface RecommendItem`——`{ bvid, title, author, reason, url }`

- [ ] **Step 1: 写失败测试**

`tests/unit/actions-mark.test.ts`：
```ts
import { describe, it, expect } from 'vitest';
import { applyMark } from '../../src/actions/mark';
import { renderRecommendations } from '../../src/actions/recommend';
import type { Verdict } from '../../src/shared/types';

function fixture(): Document {
  return new DOMParser().parseFromString(
    `<html><body>
      <div class="reply-item" data-rpid="111"><div class="reply-content">立场相反的评论</div></div>
      <div id="anchor"></div>
    </body></html>`, 'text/html',
  );
}

const v: Verdict = {
  itemId: '111', action: 'mark', reason: '与你的立场相反',
  reasonCode: 'stance_opposite', confidence: 0.8, revocable: false,
};

describe('标识动作', () => {
  it('给内容加标识', () => {
    const d = fixture();
    expect(applyMark(d, '111', v)).toBe(true);
    expect(d.querySelector('[data-ab-prefix="ab-mark"]')).not.toBeNull();
  });

  it('标识里含理由', () => {
    const d = fixture();
    applyMark(d, '111', v);
    expect(d.querySelector('[data-ab-prefix="ab-mark"]')?.textContent).toContain('与你的立场相反');
  });

  it('不隐藏内容（标识不等于删除）', () => {
    const d = fixture();
    applyMark(d, '111', v);
    const el = d.querySelector('.reply-item') as HTMLElement;
    expect(el.style.display).not.toBe('none');
  });

  it('找不到目标返回 false', () => {
    expect(applyMark(fixture(), '999', v)).toBe(false);
  });

  it('重复标识不会插两个', () => {
    const d = fixture();
    applyMark(d, '111', v);
    applyMark(d, '111', v);
    expect(d.querySelectorAll('[data-ab-prefix="ab-mark"]')).toHaveLength(1);
  });
});

describe('推荐卡片', () => {
  it('渲染出推荐条目', () => {
    const d = fixture();
    const ok = renderRecommendations(d, d.querySelector('#anchor')!, [
      { bvid: 'BV1', title: '相反观点视频', author: 'UP', reason: '它主张相反的观点', url: 'https://b23.tv/BV1' },
    ]);
    expect(ok).toBe(true);
    expect(d.querySelectorAll('[data-ab-prefix="ab-recommend-item"]')).toHaveLength(1);
  });

  it('推荐里带「为什么」', () => {
    const d = fixture();
    renderRecommendations(d, d.querySelector('#anchor')!, [
      { bvid: 'BV1', title: 't', author: 'UP', reason: '它主张相反的观点', url: 'u' },
    ]);
    expect(d.body?.textContent).toContain('它主张相反的观点');
  });

  it('空数组不渲染', () => {
    const d = fixture();
    expect(renderRecommendations(d, d.querySelector('#anchor')!, [])).toBe(false);
    expect(d.querySelector('[data-ab-prefix="ab-recommend"]')).toBeNull();
  });

  it('链接指向对应 bvid', () => {
    const d = fixture();
    renderRecommendations(d, d.querySelector('#anchor')!, [
      { bvid: 'BV1xx', title: 't', author: 'UP', reason: 'r', url: 'https://www.bilibili.com/video/BV1xx' },
    ]);
    const a = d.querySelector('[data-ab-prefix="ab-recommend-item"] a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toContain('BV1xx');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/actions/mark'`

- [ ] **Step 3: 写 mark.ts**

`src/actions/mark.ts`：
```ts
import type { Verdict } from '../shared/types';
import { CSS_PREFIX, injectStyles } from './fold';

/**
 * 给内容加一个标识标签（不隐藏内容）。
 *
 * 反信息茧房模式用：把「与用户立场相反」的评论标出来，
 * 但**保留**它——用户自己决定看不看。
 */
export function applyMark(root: ParentNode, itemId: string, verdict: Verdict): boolean {
  const doc = (root as Document);
  const target = doc.querySelector(`[data-rpid="${itemId}"]`);
  if (!target) return false;

  injectStyles(doc);

  // 已标识过就不重复
  if (doc.querySelector(`[data-ab-prefix="${CSS_PREFIX}-mark"]`)) return true;

  const mark = doc.createElement('span');
  mark.className = `${CSS_PREFIX}-mark`;
  mark.setAttribute('data-ab-prefix', `${CSS_PREFIX}-mark`);
  mark.textContent = verdict.reason || '立场相反';

  const content = target.querySelector('.reply-content') ?? target;
  content.appendChild(mark);
  return true;
}
```

- [ ] **Step 4: 写 recommend.ts**

`src/actions/recommend.ts`：
```ts
import { CSS_PREFIX, injectStyles } from './fold';

export interface RecommendItem {
  bvid: string;
  title: string;
  author: string;
  /** 为什么这是相反观点——必须是人话，否则用户会以为是系统抽风 */
  reason: string;
  url: string;
}

/**
 * 渲染反向推荐区块。
 *
 * 插在 anchor 之后，作为**独立区块**，不混入 B 站原生推荐流——
 * 混进去用户会以为是站点自己的推荐。
 */
export function renderRecommendations(
  root: ParentNode,
  anchor: Element,
  items: RecommendItem[],
): boolean {
  if (!items.length) return false;
  const doc = (root as Document);
  injectStyles(doc);

  const box = doc.createElement('div');
  box.className = `${CSS_PREFIX}-recommend`;
  box.setAttribute('data-ab-prefix', `${CSS_PREFIX}-recommend`);

  const title = doc.createElement('div');
  title.className = `${CSS_PREFIX}-recommend-title`;
  title.textContent = '相反的观点';
  box.appendChild(title);

  for (const it of items) {
    const row = doc.createElement('div');
    row.className = `${CSS_PREFIX}-recommend-item`;
    row.setAttribute('data-ab-prefix', `${CSS_PREFIX}-recommend-item`);

    const a = doc.createElement('a');
    a.href = it.url || `https://www.bilibili.com/video/${it.bvid}`;
    a.target = '_blank';
    a.rel = 'noreferrer noopener';
    a.textContent = it.title;

    const reason = doc.createElement('span');
    reason.className = `${CSS_PREFIX}-recommend-reason`;
    reason.textContent = `（${it.reason}）`;

    row.appendChild(a);
    row.appendChild(reason);
    box.appendChild(row);
  }

  anchor.parentNode?.insertBefore(box, anchor.nextSibling);
  return true;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，actions-mark 9 个测试全绿

- [ ] **Step 6: 提交**

```bash
git add src/actions/mark.ts src/actions/recommend.ts tests/unit/actions-mark.test.ts
git commit -m "feat: 新增标识动作与反向推荐卡片渲染"
```

---

### Task 6: 反向推荐召回

**Files:**
- Create: `src/recommend/recall.ts`
- Create: `src/recommend/opposition.ts`
- Test: `tests/unit/recommend-recall.test.ts`

**Interfaces:**
- Consumes: Task 02 的 `searchVideos` / `BiliClient`，Task 01 的 `LLMClient` / `UserProfile`
- Produces:
  - `recallOpposite(c: BiliClient, keywords: string[], maxItems?: number): Promise<SearchItem[]>`
  - `judgeOpposition(client: LlmClient, current: { title: string; stance: string }, candidates: SearchItem[]): Promise<RecommendItem[]>`
  - `mineCommentOpposition(c: BiliClient, oid: number): Promise<string[]>`——从评论区挖反对意见的关键词

- [ ] **Step 1: 写失败测试**

`tests/unit/recommend-recall.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { recallOpposite, judgeOpposition, mineCommentOpposition } from '../../src/recommend/recall';
import { BiliClient } from '../../src/bili/client';
import type { LlmClient } from '../../src/bg/llm/client';

describe('反向推荐召回', () => {
  it('多个关键词的结果合并去重', async () => {
    const c = new BiliClient({
      getJson: async (url: string) => ({
        code: 0, message: '0',
        data: { result: [
          { bvid: 'BV1', title: 'A', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' },
          ...(url.includes('kw2') ? [{ bvid: 'BV2', title: 'B', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' }] : []),
        ] },
      }),
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    const r = await recallOpposite(c, ['kw1', 'kw2']);
    const ids = r.map((x) => x.bvid);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('搜索失败返回空数组', async () => {
    const c = new BiliClient({
      getJson: async () => { throw new Error('net'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await recallOpposite(c, ['kw'])).toEqual([]);
  });

  it('LLM 判不出的候选被剔除', async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => JSON.stringify({ results: [] })),
    };
    const r = await judgeOpposition(
      client,
      { title: 't', stance: '支持 A' },
      [{ bvid: 'BV1', title: 'x', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' }],
    );
    expect(r).toHaveLength(0);
  });

  it('LLM 判定为相反观点的候选被保留且带理由', async () => {
    const client: LlmClient = {
      complete: vi.fn(async () => JSON.stringify({
        results: [{ bvid: 'BV1', reason: '它主张相反观点' }],
      })),
    };
    const r = await judgeOpposition(
      client,
      { title: 't', stance: '支持 A' },
      [{ bvid: 'BV1', title: 'x', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' }],
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.reason).toBe('它主张相反观点');
  });

  it('LLM 抛错时返回空数组', async () => {
    const client: LlmClient = { complete: vi.fn(async () => { throw new Error('x'); }) };
    const r = await judgeOpposition(
      client,
      { title: 't', stance: 's' },
      [{ bvid: 'BV1', title: 'x', author: 'u', description: '', pubdate: 0, pic: '', mid: 1, duration: '' }],
    );
    expect(r).toEqual([]);
  });

  it('评论区挖掘失败返回空数组', async () => {
    const c = new BiliClient({
      getJson: async () => { throw new Error('net'); },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });
    expect(await mineCommentOpposition(c, 123)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/recommend/recall'`

- [ ] **Step 3: 写实现**

`src/recommend/recall.ts`：
```ts
import type { BiliClient } from '../bili/client';
import { searchVideos, fetchComments } from '../bili/api';
import type { SearchItem, CommentItem } from '../bili/types';
import type { LlmClient } from '../bg/llm/client';
import { parseJsonResponse } from '../bg/llm/client';
import type { RecommendItem } from '../actions/recommend';

/**
 * 阶段一（召回）：用对立关键词搜索 B 站，合并去重。
 */
export async function recallOpposite(
  c: BiliClient,
  keywords: string[],
  maxItems: number = 20,
): Promise<SearchItem[]> {
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  for (const kw of keywords.slice(0, 8)) {
    if (!kw.trim()) continue;
    const items = await searchVideos(c, kw);
    for (const it of items) {
      if (!it?.bvid || seen.has(it.bvid)) continue;
      seen.add(it.bvid);
      out.push(it);
      if (out.length >= maxItems) return out;
    }
  }
  return out;
}

/**
 * 阶段二（精排）：让 LLM 判断候选是否真的表达相反观点。
 *
 * 判不出来就丢弃——宁可少推，不要推错。
 */
export async function judgeOpposition(
  client: LlmClient,
  current: { title: string; stance: string },
  candidates: SearchItem[],
): Promise<RecommendItem[]> {
  if (candidates.length === 0) return [];

  const system = [
    '你是一个立场比对器。输入是当前视频和一个候选视频列表。',
    '请挑出**确实表达相反观点**的候选，输出严格 JSON。',
    '',
    '输出格式：',
    '{ "results": [{"bvid": "BVxxx", "reason": "一句话说明它为什么是相反观点"}] }',
    '',
    '要求：',
    '- 只输出确实立场相反的；只是不同话题、补充信息、不同立场的都**不要**输出',
    '- reason 必须是能直接展示给用户的人话，不超过 30 字',
    '- 最多输出 5 条',
  ].join('\n');

  const user = [
    `当前视频：${current.title}`,
    `当前视频立场：${current.stance || '（未判定）'}`,
    '',
    '候选视频：',
    ...candidates.map((c2, i) => `${i + 1}. [${c2.bvid}] ${c2.title}｜${c2.author}`),
  ].join('\n');

  try {
    const raw = await client.complete(user, { system, maxTokens: 1000 });
    const parsed = parseJsonResponse<{ results?: { bvid?: string; reason?: string }[] }>(raw);
    const list = parsed?.results ?? [];
    const out: RecommendItem[] = [];
    for (const r of list) {
      const bvid = typeof r.bvid === 'string' ? r.bvid : '';
      if (!bvid) continue;
      const cand = candidates.find((c2) => c2.bvid === bvid);
      if (!cand) continue;
      const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : '表达了相反的观点';
      out.push({
        bvid,
        title: cand.title,
        author: cand.author,
        reason,
        url: `https://www.bilibili.com/video/${bvid}`,
      });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 补充信号：从当前视频的评论区挖反对意见，提取关键词作为额外检索入口。
 *
 * 做法：取点赞数较高且带反对意味的评论，用 LLM 提取其中的检索词。
 * 拿不到就返回空数组（这是补充信号，不该影响主流程）。
 */
export async function mineCommentOpposition(
  c: BiliClient,
  oid: number,
  maxComments: number = 30,
): Promise<string[]> {
  const comments = await fetchComments(c, oid, 3);
  if (comments.length === 0) return [];

  const top = comments
    .filter((x) => typeof x.like === 'number')
    .sort((a, b) => (b.like ?? 0) - (a.like ?? 0))
    .slice(0, maxComments);

  const texts = top
    .map((x) => x.content?.message ?? '')
    .filter((t) => t.length > 0);
  if (texts.length === 0) return [];

  // 关键词提取交给调用方的 LLM（这里只做数据准备与轻量过滤）
  return texts
    .filter((t) => t.length >= 6 && t.length <= 60)
    .slice(0, 10);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，recommend-recall 6 个测试全绿

- [ ] **Step 5: 提交**

```bash
git add src/recommend tests/unit/recommend-recall.test.ts
git commit -m "feat: 新增反向推荐召回与立场精排"
```

---

### Task 7: 页面控制器

**Files:**
- Create: `src/content/controller.ts`
- Modify: `src/content/index.ts`
- Test: `tests/unit/content-controller.test.ts`

**Interfaces:**
- Consumes: Task 05 的适配器与动作层，Task 04 的判定流水线（通过 service worker 消息）
- Produces:
  - `class PageController`——方法：
    - `start(): Promise<void>`——识别页面 → 抽内容 → 请求判定 → 执行动作
    - `stop(): void`
  - `requestJudgments(items: ContentItem[]): Promise<Verdict[]>`——通过 `chrome.runtime.sendMessage` 调 service worker

- [ ] **Step 1: 写失败测试**

`tests/unit/content-controller.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';

vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn(async (msg: unknown) => {
      if ((msg as { type?: string })?.type === 'JUDGE_ITEMS') {
        return { id: 'x', ok: true, data: { verdicts: [] } };
      }
      return { id: 'x', ok: true, data: null };
    }),
  },
});

import { PageController } from '../../src/content/controller';
import type { ContentItem } from '../../src/shared/types';

describe('页面控制器', () => {
  it('未知页面不启动任何适配器', async () => {
    const c = new PageController({ url: 'https://www.bilibili.com/read/cv1', send: async () => ({ ok: true, data: null }) });
    await c.start();
    expect(c.items).toHaveLength(0);
  });

  it('总开关关闭时不判定', async () => {
    const send = vi.fn(async () => ({ ok: true, data: null }));
    const c = new PageController({ url: 'https://search.bilibili.com/all?keyword=x', send });
    await c.start();
    expect(send).not.toHaveBeenCalled();
  });

  it('页面级开关关闭时不判定该页', async () => {
    const send = vi.fn(async () => ({ ok: true, data: null }));
    const c = new PageController({
      url: 'https://search.bilibili.com/all?keyword=x',
      send,
      settings: { mode: 'cocoon', enabledPages: { search: false, video: true, feed: true, unknown: false }, masterEnabled: true, collectHistory: true, confidenceThreshold: 0.7 },
    });
    await c.start();
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test`
Expected: FAIL，`Cannot find module '../../src/content/controller'`

- [ ] **Step 3: 写实现**

`src/content/controller.ts`：
```ts
import type { ContentItem, Verdict, Settings } from '../shared/types';
import { detectPageType } from './page';
import { getAdapter } from '../adapters';
import { applyFold } from '../actions/fold';
import { applyMark } from '../actions/mark';
import { MSG } from '../shared/messages';

export interface ControllerDeps {
  url: string;
  send: (msg: unknown) => Promise<unknown>;
  settings?: Settings | null;
  root?: ParentNode;
  onRevoke?: (id: string) => void;
}

/**
 * 页面控制器：抽 → 判 → 执行。
 *
 * **任何一步失败都静默降级**，绝不让 B 站页面报错或卡住。
 */
export class PageController {
  items: ContentItem[] = [];
  private stopped = false;

  constructor(private readonly deps: ControllerDeps) {}

  async start(): Promise<void> {
    const settings = this.deps.settings;
    // 没配置就什么都不做
    if (!settings || !settings.masterEnabled) return;

    const page = detectPageType(this.deps.url);
    if (!settings.enabledPages[page]) return;

    const adapter = getAdapter(page);
    if (!adapter) return;

    const root = this.deps.root ?? document;
    try {
      this.items = adapter.collect(root);
    } catch {
      this.items = [];
      return;
    }
    if (this.items.length === 0) return;

    const verdicts = await this.requestJudgments(this.items, settings);
    if (this.stopped) return;
    this.apply(verdicts);
  }

  stop(): void {
    this.stopped = true;
  }

  private async requestJudgments(
    items: ContentItem[],
    settings: Settings,
  ): Promise<Verdict[]> {
    try {
      const resp = (await this.deps.send({
        type: MSG.JUDGE_ITEMS,
        id: `ab-${Date.now().toString(36)}`,
        payload: { items, mode: settings.mode },
      })) as { ok?: boolean; data?: { verdicts?: Verdict[] } };
      if (!resp?.ok) return [];
      return resp.data?.verdicts ?? [];
    } catch {
      return [];
    }
  }

  private apply(verdicts: Verdict[]): void {
    const root = this.deps.root ?? document;
    for (const v of verdicts) {
      try {
        if (v.action === 'fold') {
          applyFold(root, v.itemId, v, (id) => this.deps.onRevoke?.(id));
        } else if (v.action === 'mark') {
          applyMark(root, v.itemId, v);
        }
      } catch {
        // 单条失败不影响其它
        continue;
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm run test`
Expected: PASS，content-controller 3 个测试全绿

- [ ] **Step 5: 改 content script 入口**

`src/content/index.ts`：
```ts
import { createPageBridge } from './page-bridge';
import { BiliClient } from '../bili/client';
import { fetchNav } from '../bili/api';
import { PageController } from './controller';
import { MSG } from '../shared/messages';

function injectPageFetch(): void {
  try {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('content/page-fetch.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch {
    // 注入失败不影响页面
  }
}

injectPageFetch();

const getJson = createPageBridge({
  addEventListener: (t, h) => window.addEventListener(t, h as EventListener),
  removeEventListener: (t, h) => window.removeEventListener(t, h as EventListener),
  postMessage: (m) => window.postMessage(m, window.location.origin),
});

/** 向 service worker 发消息。 */
function send(msg: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp: unknown) => {
        void chrome.runtime.lastError;
        resolve(resp);
      });
    } catch {
      resolve(null);
    }
  });
}

async function main(): Promise<void> {
  const settingsResp = (await send({ type: MSG.GET_SETTINGS, id: 'init' })) as {
    ok?: boolean; data?: { mode: string; enabledPages: Record<string, boolean>; masterEnabled: boolean; confidenceThreshold: number; collectHistory: boolean } | null;
  };

  const ctrl = new PageController({
    url: location.href,
    send,
    settings: settingsResp?.data ?? null,
    onRevoke: (id) => {
      void send({ type: MSG.REVOKE, id: 'revoke', payload: { itemId: id } });
    },
  });

  await ctrl.start();

  // 调试用：验证登录态
  const bili = new BiliClient({ getJson });
  void fetchNav(bili).then((nav) => {
    if (nav) console.info('[anti-bubble] nav ok, login=', nav.isLogin, 'uname=', nav.uname);
    else console.warn('[anti-bubble] nav 获取失败（可能未登录或被风控）');
  });
}

void main();
```

- [ ] **Step 6: 跑测试与构建**

Run: `npm run test && npm run typecheck && npm run build`
Expected: 全部退出码 0

- [ ] **Step 7: 提交**

```bash
git add src/content tests/unit/content-controller.test.ts
git commit -m "feat: 新增页面控制器并接入 content script"
```

---

### Task 8: 端到端自检与 README 完善

**Files:**
- Modify: `README.md`
- Modify: `docs/testing-checklist.md`

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可用的扩展 + 完整文档

- [ ] **Step 1: 完善 README**

在 `README.md` 的「状态」一节替换为：

```markdown
## 状态

早期开发阶段。已实现：

- 三级判定流水线（画像匹配 → 动态词表粗筛 → LLM 精判）
- 搜索页 / 视频页 / 推荐流三个适配器
- 折叠、标识、反向推荐卡片，含「可展开看理由 + 一键撤销」
- 画像：观看历史/收藏夹冷启动 + 增量持续修正

尚未完成：配置面板、商店发布、Shadow DOM 新版评论区适配。
```

- [ ] **Step 2: 追加测试清单**

```markdown
## 计划 05（适配器与动作层）

- [ ] 搜索页：命中的结果被折叠，点「仍要显示」能恢复
- [ ] 视频页：引战评论被隐藏
- [ ] 推荐流：命中的视频被折叠
- [ ] 反信息茧房模式：立场相反的评论带标识，且**没有被删除**
- [ ] 反向推荐区块出现在视频页，且每条都带「为什么」
- [ ] 三个页面的开关能各自独立关闭
- [ ] B 站改版模拟：把卡片 class 改掉后，插件不报错、只是不干预
```

- [ ] **Step 3: 人工验证**

1. `npm run build`
2. 加载 `dist/`
3. 搜索页：搜一个关键词，命中项应被折叠
4. 点「仍要显示」→ 应恢复
5. 视频页：切到反信息茧房模式，立场相反的评论应带标识
6. 三个页面的开关分别关掉，验证独立生效

**任一步失败不要提交**，先修。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/testing-checklist.md
git commit -m "docs: 完善 README 与端到端验证清单"
```

---

## 完成标准

- [ ] `npm run typecheck` 退出码 0
- [ ] `npm run test` 全部通过
- [ ] `npm run build` 产出 `dist/`
- [ ] 三个适配器抽不到内容时静默降级
- [ ] 每个屏蔽都能展开看理由并撤销
- [ ] 三个页面开关独立生效
- [ ] 全部代码已提交，git status 干净
