import { STORAGE_KEYS } from '../shared/constants';
import type { Settings, SettingsPatch, UserProfile, LlmConfig } from '../shared/types';

/**
 * chrome.storage.local 的 Promise 包装。
 *
 * 只用 local 不用 sync：sync 会把数据同步到 Google 账号，
 * 与「画像只存在本机」的隐私承诺冲突。
 */

/** callback 风格的 chrome.storage API 包成 Promise。 */
function promisify<T>(fn: (cb: (v: T) => void) => void): Promise<T> {
  return new Promise((resolve) => fn(resolve));
}

/**
 * 读一个键。读不到（undefined）或存的是 null 时返回 fallback。
 * null 也必须回落——存 null 等于「没有有效值」，不能当配置用。
 */
export async function getJson<T>(key: string, fallback: T): Promise<T> {
  const res = await promisify<Record<string, unknown>>((cb) =>
    chrome.storage.local.get([key], cb),
  );
  const v = res[key];
  return v === undefined || v === null ? fallback : (v as T);
}

/** 写一个键。 */
export async function setJson(key: string, value: unknown): Promise<void> {
  await promisify<boolean>((cb) => chrome.storage.local.set({ [key]: value }, () => cb(true)));
}

/** 删一个键。 */
export async function removeKey(key: string): Promise<void> {
  await promisify<boolean>((cb) => chrome.storage.local.remove([key], () => cb(true)));
}

/**
 * 默认设置。
 *
 * 初始是「茧房模式」：只观察不干预，先让用户看到自己在被推荐什么。
 * enabledPages.unknown 默认关——认不出的页面不乱动。
 */
export function defaultSettings(): Settings {
  return {
    mode: 'cocoon',
    enabledPages: { search: true, video: true, feed: true, unknown: false },
    masterEnabled: true,
    collectHistory: true,
    confidenceThreshold: 0.7,
  };
}

/**
 * 读设置。存量可能只有部分字段（老版本、用户手改过），
 * 所以必须和默认值合并，而不是直接返回存量。
 */
export async function getSettings(): Promise<Settings> {
  const saved = await getJson<Partial<Settings>>(STORAGE_KEYS.settings, {});
  const base = defaultSettings();
  return {
    ...base,
    ...saved,
    // enabledPages 是浅合并：存了 {search:false} 不能把 video/feed 也丢了
    enabledPages: { ...base.enabledPages, ...(saved.enabledPages ?? {}) },
  };
}

/**
 * 存设置（补丁语义）。返回合并后的完整设置。
 *
 * 参数类型是 `SettingsPatch` 而不是 `Partial<Settings>`：
 * 后者会让 `enabledPages` 变成「要么不给、要么给全」，而我们要的是
 * 只关一个页面、其它页面不受影响（浅合并）。
 */
export async function saveSettings(patch: SettingsPatch): Promise<Settings> {
  const cur = await getSettings();
  const next: Settings = {
    ...cur,
    ...patch,
    enabledPages: { ...cur.enabledPages, ...(patch.enabledPages ?? {}) },
  };
  await setJson(STORAGE_KEYS.settings, next);
  return next;
}

/** 读画像。没有画像时返回 null（区别于「画像存在但为空」）。 */
export async function getProfile(): Promise<UserProfile | null> {
  return getJson<UserProfile | null>(STORAGE_KEYS.profile, null);
}

/** 存画像。 */
export async function saveProfile(p: UserProfile): Promise<void> {
  await setJson(STORAGE_KEYS.profile, p);
}

/**
 * 清画像。watchLog 一起清——它是画像的原料，
 * 留着会让「清空画像」后又被旧样本重新归纳出同样的结论。
 */
export async function clearProfile(): Promise<void> {
  await removeKey(STORAGE_KEYS.profile);
  await removeKey(STORAGE_KEYS.watchLog);
}

/** 读 LLM 配置（含 API Key）。调用方负责脱敏后再发给 popup。 */
export async function getLlmConfig(): Promise<LlmConfig | null> {
  return getJson<LlmConfig | null>(STORAGE_KEYS.llmConfig, null);
}

/** 存 LLM 配置。 */
export async function saveLlmConfig(c: LlmConfig): Promise<void> {
  await setJson(STORAGE_KEYS.llmConfig, c);
}

/** 读白名单（用户撤销过的条目 id）。 */
export async function getWhitelist(): Promise<string[]> {
  return getJson<string[]>(STORAGE_KEYS.whitelist, []);
}

/**
 * 记一条「最近一次失败」。
 *
 * **为什么要有这个**：判定链路里的失败全都被静默降级了
 * （LLM 挂了 → 空词表 → 全部放行），从用户视角看就是「插件没反应」。
 * 把原因记下来、在配置面板里显示出来，用户才知道该去改什么
 * （换模型？调大 token？换个 base_url？）。
 */
export async function setLastError(message: string): Promise<void> {
  try {
    await setJson(STORAGE_KEYS.lastError, {
      message,
      at: new Date().toISOString(),
    });
  } catch {
    // 记失败本身绝不能把流程搞崩（也别在没有 chrome 的环境里抛）
  }
}

/** 读最近一次失败。没有则返回 null。 */
export async function getLastError(): Promise<{ message: string; at: string } | null> {
  return getJson<{ message: string; at: string } | null>(STORAGE_KEYS.lastError, null);
}

/** 清掉最近一次失败（成功了就没什么好提示的了）。 */
export async function clearLastError(): Promise<void> {
  try {
    await removeKey(STORAGE_KEYS.lastError);
  } catch {
    // 同上：清失败提示不该把流程搞崩
  }
}

/** 加白名单，自动去重——撤销按钮可能被连点。 */
export async function addToWhitelist(id: string): Promise<void> {
  const cur = await getWhitelist();
  if (cur.includes(id)) return;
  await setJson(STORAGE_KEYS.whitelist, [...cur, id]);
}
