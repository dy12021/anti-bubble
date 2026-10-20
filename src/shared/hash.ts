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
