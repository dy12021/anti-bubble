import { MSG } from '../shared/messages';
import type { Settings, UserProfile } from '../shared/types';

/* ------------------------------------------------------------------ *
 * 面板逻辑
 *
 * 与 service worker 的所有交互都走 chrome.runtime.sendMessage，
 * 面板自己不碰 storage——这样只有一处读写真相。
 * ------------------------------------------------------------------ */

let reqSeq = 0;

async function call<T = unknown>(
  type: string,
  payload?: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const id = `popup-${++reqSeq}`;
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, id, payload }, (resp: unknown) => {
        void chrome.runtime.lastError;
        const r = resp as { ok?: boolean; data?: T; error?: string } | undefined;
        if (!r) {
          resolve({ ok: false, error: '后台无响应（service worker 可能已休眠，试试重开面板）' });
          return;
        }
        resolve({ ok: r.ok === true, data: r.data, error: r.error });
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`缺少元素 #${id}`);
  return n as T;
}

function setStatus(node: HTMLElement, text: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  node.textContent = text;
  node.className = `status status-${kind}`;
}

function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* --------------------------- 模式切换 --------------------------- */

function bindMode(): void {
  const btns = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.seg-btn'),
  );
  for (const b of btns) {
    b.addEventListener('click', () => {
      const mode = b.dataset['mode'] as Settings['mode'];
      void call(MSG.SET_SETTINGS, { settings: { mode } }).then((r) => {
        if (r.ok) paintMode(mode);
      });
    });
  }
}

function paintMode(mode: Settings['mode']): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('.seg-btn')) {
    const on = b.dataset['mode'] === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

/* --------------------------- 设置读写 --------------------------- */

async function loadSettings(): Promise<void> {
  const r = await call<Settings>(MSG.GET_SETTINGS);
  if (!r.ok || !r.data) return;
  const s = r.data;

  paintMode(s.mode);
  el<HTMLInputElement>('masterEnabled').checked = s.masterEnabled;
  el<HTMLInputElement>('collectHistory').checked = s.collectHistory;
  for (const input of Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-page]'),
  )) {
    const key = input.dataset['page'] as keyof Settings['enabledPages'];
    input.checked = s.enabledPages[key] !== false;
  }
}

function bindSettings(): void {
  const save = (patch: Partial<Settings>) => {
    void call(MSG.SET_SETTINGS, { settings: patch });
  };

  el<HTMLInputElement>('masterEnabled').addEventListener('change', (e) => {
    save({ masterEnabled: (e.target as HTMLInputElement).checked });
  });
  el<HTMLInputElement>('collectHistory').addEventListener('change', (e) => {
    save({ collectHistory: (e.target as HTMLInputElement).checked });
  });
  for (const input of Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-page]'),
  )) {
    input.addEventListener('change', () => {
      const enabledPages: Record<string, boolean> = {};
      for (const i of Array.from(
        document.querySelectorAll<HTMLInputElement>('input[data-page]'),
      )) {
        enabledPages[i.dataset['page']!] = i.checked;
      }
      save({ enabledPages: enabledPages as Settings['enabledPages'] });
    });
  }
}

/* --------------------------- LLM 配置 --------------------------- */

interface LlmConfigView {
  provider: 'openai' | 'anthropic';
  baseUrl: string;
  model: string;
  timeoutMs: number;
  hasKey: boolean;
  maxTokens?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
}

async function loadLlmConfig(): Promise<void> {
  const r = await call<LlmConfigView | null>(MSG.GET_LLM_CONFIG);
  const c = r.data;
  if (!c) {
    el('keyState').textContent = '尚未配置。填好后点「保存配置」。';
    return;
  }
  el<HTMLSelectElement>('provider').value = c.provider;
  el<HTMLInputElement>('baseUrl').value = c.baseUrl;
  el<HTMLInputElement>('model').value = c.model;
  el<HTMLInputElement>('maxTokens').value = String(c.maxTokens ?? 8192);
  el<HTMLSelectElement>('reasoningEffort').value = c.reasoningEffort ?? 'low';
  el('keyState').textContent = c.hasKey
    ? '已保存 Key（不显示明文）。留空表示沿用。'
    : '尚未保存 Key。';
}

/**
 * 最近一次失败。
 *
 * 判定链路的失败全都被静默降级了（LLM 挂了 → 空词表 → 全部放行），
 * 从用户视角就是「插件没反应」。这里把原因摊开，用户才知道该改什么。
 */
async function loadLastError(): Promise<void> {
  const r = await call<{ message: string; at: string } | null>(MSG.GET_LAST_ERROR);
  const block = el('errorBlock');
  const box = el('errorBox');
  const e = r.data;
  if (!e || !e.message) {
    block.hidden = true;
    box.textContent = '';
    return;
  }
  block.hidden = false;
  box.textContent = `${e.message}（${fmtTime(e.at)}）`;
}

function bindLlmConfig(): void {
  el('saveLlm').addEventListener('click', () => {
    void (async () => {
      const status = el('llmStatus');
      setStatus(status, '保存中…');
      const r = await call(MSG.SET_LLM_CONFIG, {
        config: {
          provider: el<HTMLSelectElement>('provider').value as 'openai' | 'anthropic',
          baseUrl: el<HTMLInputElement>('baseUrl').value.trim(),
          model: el<HTMLInputElement>('model').value.trim(),
          apiKey: el<HTMLInputElement>('apiKey').value.trim(),
          maxTokens: Number(el<HTMLInputElement>('maxTokens').value) || undefined,
          // 空串 = 不设置（服务商不认这个字段时用）
          reasoningEffort:
            (el<HTMLSelectElement>('reasoningEffort').value || undefined) as
              | 'low'
              | 'medium'
              | 'high'
              | undefined,
          timeoutMs: 120000,
        },
      });
      if (!r.ok) {
        setStatus(status, r.error ?? '保存失败', 'err');
        return;
      }
      el<HTMLInputElement>('apiKey').value = '';
      setStatus(status, '已保存 ✓', 'ok');
      await loadLlmConfig();
    })();
  });

  el('testLlm').addEventListener('click', () => {
    void (async () => {
      const status = el('llmStatus');
      setStatus(status, '测试中…推理模型可能要几十秒');
      const r = await call<{ output: string }>(MSG.TEST_LLM);
      if (!r.ok) {
        setStatus(status, r.error ?? '测试失败', 'err');
        return;
      }
      setStatus(status, `连通正常：${(r.data?.output ?? '').slice(0, 40)}`, 'ok');
    })();
  });
}

/* --------------------------- 画像 --------------------------- */

function renderProfile(p: UserProfile | null): void {
  const box = el('profileBox');
  if (!p) {
    box.innerHTML =
      '<div class="empty">还没有画像。' +
      '打开几个 B 站视频后点「重新归纳画像」，' +
      '或勾选上面的「拉取观看历史做冷启动画像」。</div>';
    return;
  }
  const interests = p.interests.length
    ? p.interests
        .map(
          (i) =>
            `<span class="tag">${escapeHtml(i.tag)}<i>${Math.round(i.weight * 100)}</i></span>`,
        )
        .join('')
    : '<span class="empty">暂无兴趣标签</span>';
  const dislikes = p.dislikes.length
    ? p.dislikes.map((d) => `<span class="tag tag-dislike">${escapeHtml(d)}</span>`).join('')
    : '';
  const stances = Object.entries(p.stanceHints)
    .map(([k, v]) => `<span class="tag">${escapeHtml(k)}：${escapeHtml(v)}</span>`)
    .join('');

  box.innerHTML = `
    <div class="meta">样本 ${p.sampleCount} 条 · 更新于 ${fmtTime(p.updatedAt)}</div>
    <div class="tags">${interests}</div>
    ${dislikes ? `<div class="tags-label">不喜欢</div><div class="tags">${dislikes}</div>` : ''}
    ${stances ? `<div class="tags-label">立场倾向</div><div class="tags">${stances}</div>` : ''}
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

async function loadProfile(): Promise<void> {
  const r = await call<UserProfile | null>(MSG.GET_PROFILE);
  renderProfile(r.ok ? (r.data ?? null) : null);
}

function bindProfile(): void {
  el('refreshProfile').addEventListener('click', () => {
    void (async () => {
      const status = el('profileStatus');
      setStatus(status, '归纳中…推理模型可能要几十秒');
      const r = await call<UserProfile>(MSG.REFRESH_PROFILE);
      if (!r.ok) {
        setStatus(status, r.error ?? '归纳失败', 'err');
        return;
      }
      setStatus(status, '已更新 ✓', 'ok');
      await loadProfile();
    })();
  });

  el('clearProfile').addEventListener('click', () => {
    void (async () => {
      const status = el('profileStatus');
      const r = await call(MSG.CLEAR_PROFILE);
      if (!r.ok) {
        setStatus(status, r.error ?? '清空失败', 'err');
        return;
      }
      setStatus(status, '已清空 ✓', 'ok');
      await loadProfile();
    })();
  });
}

/* --------------------------- 屏蔽记录 --------------------------- */

interface BlockedEntry {
  itemId: string;
  action: string;
  reason: string;
  reasonCode: string;
  at: string;
  excerpt: string;
}

async function loadBlocked(): Promise<void> {
  const r = await call<BlockedEntry[]>(MSG.GET_BLOCKED_LOG);
  const list = r.ok ? (r.data ?? []) : [];
  el('blockedCount').textContent = list.length ? String(list.length) : '';
  const box = el('blockedBox');
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有屏蔽记录</div>';
    return;
  }
  const actionName: Record<string, string> = {
    fold: '折叠', hide: '隐藏', mark: '标识', recommend: '推荐', pass: '放行',
  };
  box.innerHTML = list
    .slice(0, 30)
    .map(
      (e) => `
      <div class="log-item">
        <div class="log-head">
          <span class="badge badge-${escapeHtml(e.action)}">${actionName[e.action] ?? e.action}</span>
          <span class="log-reason">${escapeHtml(e.reason)}</span>
          <span class="log-time">${fmtTime(e.at)}</span>
        </div>
        <div class="log-excerpt">${escapeHtml(e.excerpt)}</div>
      </div>`,
    )
    .join('');
}

function bindClearAll(): void {
  el('clearAll').addEventListener('click', (e) => {
    e.preventDefault();
    if (!confirm('清除本机保存的全部数据（画像、缓存、白名单、屏蔽记录）？LLM 配置会保留。')) return;
    void (async () => {
      await call(MSG.CLEAR_PROFILE);
      await call(MSG.CLEAR_BLOCKED_LOG);
      await loadProfile();
      await loadBlocked();
    })();
  });
}

/* --------------------------- 启动 --------------------------- */

async function main(): Promise<void> {
  bindMode();
  bindSettings();
  bindLlmConfig();
  bindProfile();
  bindClearAll();

  await Promise.all([
    loadSettings(), loadLlmConfig(), loadProfile(), loadBlocked(), loadLastError(),
  ]);
}

void main();
