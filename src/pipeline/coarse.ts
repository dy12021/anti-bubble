import type { Wordlist } from './types';

/**
 * 规则粗筛：文本是否命中动态词表。
 *
 * 这是整条流水线的**成本闸门**——命中才值得花钱调 LLM。
 * 匹配用小写子串包含，够用且零成本。
 */
export function coarseMatch(text: string, wordlist: Wordlist): boolean {
  if (!text) return false;
  const hay = text.toLowerCase();
  for (const raw of wordlist.patterns) {
    const p = raw.trim();
    if (!p) continue;
    if (hay.includes(p.toLowerCase())) return true;
  }
  return false;
}

export function coarseMatchAll(texts: string[], wordlist: Wordlist): boolean[] {
  return texts.map((t) => coarseMatch(t, wordlist));
}
