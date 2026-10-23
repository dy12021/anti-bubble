import type { VerdictReasonCode } from '../shared/types';

/**
 * 内置关键词库：「仅关键词」档的判据。
 *
 * ## 为什么要有它
 *
 * 动态词表（`wordlist.ts`）是 **LLM 按当前语境现场生成**的——
 * 这意味着「仅关键词」档如果还用它，就**不可能做到零 LLM 调用**：
 * 每个视频至少要一次词表生成，词表挂了整条链路就废。
 *
 * 所以「仅关键词」档用的是这份**内置静态词库**：
 * 零调用、零延迟、不需要配置 API Key，代价是判不准——
 * 它只知道「什么是骂人/煽动对立」，不知道「这个视频在讲什么」。
 *
 * ## 词库的取舍
 *
 * 只收**高置信度**的词：宁可漏判，不要误判。
 * 举两个被刻意排除的例子：
 * - 「垃圾」——B 站「垃圾分类」相关视频一大把，命中等于噪声；
 * - 「精美」——本意是「精致优美」，是中性词。
 *
 * 群体攻击标签（汉奸/精日/跪族…）保留：它们本身就是贬义标签，
 * 出现在内容里就是攻击群体的说法。
 */

/** 关键词库版本。改动词库时 +1，判定缓存键会带上它，旧判定自动失效。 */
export const KEYWORD_LIB_VERSION = 'v1';

export type KeywordCategory = 'insult' | 'label' | 'incitement';

/** 类别 → 人话标签。用在理由里，让用户知道命中的是哪一类。 */
const CATEGORY_LABEL: Record<KeywordCategory, string> = {
  insult: '辱骂用语',
  label: '群体攻击标签',
  incitement: '煽动对立表达',
};

/** 通用辱骂与人身攻击。 */
const INSULT_TERMS = [
  '傻逼', '傻b', '煞笔', '沙比',
  '智障', '脑残', '脑瘫', '弱智', '白痴',
  '蠢货', '蠢猪', '蠢比',
  '人渣', '狗东西', '狗屎', '废物点心',
  '滚蛋', '滚远点', '死一边去', '死全家', '妈卖批',
  '神经病', '不得好死', '有病吧',
  '贱人', '贱货', '绿茶婊', '泼妇',
  '畜生', '疯狗', '狗奴才', '走狗', '狗屁',
];

/** 攻击特定群体的贬义标签。 */
const LABEL_TERMS = [
  '汉奸', '精日', '跪族', '洋奴', '牧奴', '圣母', '白左',
];

/**
 * 煽动对立的句式模板。
 *
 * 用正则而不是枚举具体词：具体词（具体哪个民族/地区）不写死，
 * 只抓「把一群人一锅端」的**句式**——既覆盖到了，也不必在代码里写具体群体的脏话。
 */
const INCITEMENT_PATTERNS: RegExp[] = [
  // 「滚出中国/地球」
  /滚出(?:中国|地球|国内)/,
  /滚(?:回|出)(?:你们?的)?(?:老家|地球|中国)/,
  // 「XX都该死」「XX该滚」
  /(?:他们|她们|你们|这些人|那些人|某群人|这帮人)(?:都|全都|统统)(?:该死|该滚|滚出去|都得死)/,
  // 「一个都不是人」「都不配活」
  /(?:一个|全都|统统|都)(?:都)?不(?:是|配)(?:人|东西)/,
  /不(?:配|值得|屑于)(?:活|做人|存在|活着)/,
  // 「消灭他们」「杀光」
  /(?:消灭|杀光|杀绝|灭绝)(?:他们|她们|这些人|那些人|这帮人|所有人)/,
];

export interface KeywordRule {
  /** 匹配用的串（已小写）。正则规则的 needle 为空串。 */
  needle: string;
  /** 正则规则的模式（子串规则为 undefined）。 */
  pattern?: RegExp;
  category: KeywordCategory;
  reasonCode: VerdictReasonCode;
}

/** 一条命中的规则 + 实际命中的片段。 */
export interface KeywordHit {
  category: KeywordCategory;
  /** 实际命中的文本（给用户看「命中了什么」） */
  matched: string;
  reason: string;
  reasonCode: VerdictReasonCode;
}

function buildRules(): KeywordRule[] {
  const rules: KeywordRule[] = [];
  for (const t of INSULT_TERMS) {
    rules.push({ needle: t.toLowerCase(), category: 'insult', reasonCode: 'incitement' });
  }
  for (const t of LABEL_TERMS) {
    rules.push({ needle: t.toLowerCase(), category: 'label', reasonCode: 'incitement' });
  }
  for (const p of INCITEMENT_PATTERNS) {
    rules.push({ needle: '', pattern: p, category: 'incitement', reasonCode: 'incitement' });
  }
  return rules;
}

const RULES: KeywordRule[] = buildRules();

/**
 * 文本是否命中内置关键词库。
 *
 * 匹配用小写子串包含（和动态词表的粗筛一个路子）。
 * 返回第一条命中的规则，**没有命中返回 null**。
 */
export function matchBuiltinKeyword(text: string): KeywordHit | null {
  if (!text) return null;
  const hay = text.toLowerCase();

  for (const rule of RULES) {
    if (rule.pattern) {
      const m = rule.pattern.exec(hay);
      if (m) {
        return {
          category: rule.category,
          matched: m[0],
          reason: `命中${CATEGORY_LABEL[rule.category]}「${m[0]}」`,
          reasonCode: rule.reasonCode,
        };
      }
      continue;
    }
    if (rule.needle && hay.includes(rule.needle)) {
      return {
        category: rule.category,
        matched: rule.needle,
        reason: `命中${CATEGORY_LABEL[rule.category]}「${rule.needle}」`,
        reasonCode: rule.reasonCode,
      };
    }
  }
  return null;
}

/** 词库条目数。给测试与诊断用。 */
export function keywordRuleCount(): number {
  return RULES.length;
}
