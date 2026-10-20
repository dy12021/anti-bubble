import type { Mode, UserProfile, Verdict, VerdictAction, VerdictReasonCode } from '../shared/types';
import type { LlmClient } from '../bg/llm/client';
import { parseJsonResponse } from '../bg/llm/client';
import { setLastError } from '../bg/storage';
import { REASON_CODES, MAX_BATCH_ITEMS } from '../shared/constants';
import type { JudgeInput, JudgeTarget, Wordlist } from './types';

/**
 * REASON_CODES 是只读元组，includes 的参数类型被收窄成字面量联合，
 * 这里派生一个 Set 出来做运行时校验（唯一的 code 来源仍是 constants.ts）。
 */
const VALID_REASON_CODES = new Set<string>(REASON_CODES);

/**
 * 精判 prompt。**一次调用判一批**，这是成本控制的关键。
 *
 * `target` 区分判的是「评论」还是「视频标题」——
 * 列表页抽到的是视频标题，让模型用评论的框架去理解标题，
 * 出来的理由会驴唇不对马嘴（「这条评论在引战」← 它根本不是评论）。
 */
export function buildJudgePrompt(
  items: JudgeInput[],
  wordlist: Wordlist,
  mode: Mode,
  profile: UserProfile | null,
  target: JudgeTarget = 'comment',
): { system: string; user: string } {
  const isAnti = mode === 'anti';
  const isTitle = target === 'title';

  const system = [
    isTitle
      ? '你是一个 B 站视频标题审核器。输入是若干条视频标题（来自搜索结果或推荐流），以及本页的判据。'
      : '你是一个 B 站评论审核器。输入是若干条评论，以及该视频的判据。',
    isTitle
      ? '请对每条视频标题独立判断：这个视频讲的内容是否引战，或与用户立场相反。'
      : '请对每条评论独立判断：这条评论是否引战，或与用户立场相反。',
    '请输出严格的 JSON，不要任何解释文字。',
    '',
    '输出格式：',
    '{',
    '  "results": [',
    '    {"id": 1, "action": "pass|fold|hide|mark", "reason": "一句人话理由",',
    '     "reasonCode": "incitement|stance_opposite|dislike_match|off_topic",',
    '     "confidence": 0.0-1.0}',
    '  ]',
    '}',
    '',
    'action 的含义：',
    '- pass：正常内容，放行',
    '- fold：用户大概率不喜欢，折叠',
    '- hide：引战/挑起仇恨，隐藏',
    isAnti
      ? '- mark：内容与用户可能支持的立场相反，保留并标识'
      : '- mark：内容用户大概率不喜欢，保留并标识',
    '',
    '要求：',
    '- results 的长度必须与输入条数一致，id 与输入序号一一对应',
    '- reason 必须是能直接展示给用户的人话，不超过 30 字',
    isTitle
      ? '- reason 要针对**标题表达的内容**，不要写「标题里有这个词」这种废话'
      : '- reason 要针对**评论说了什么**，不要写「评论里有这个词」这种废话',
    '- confidence 反映把握程度；不确定就给低分，不要勉强下结论',
    '- 判不准就给 pass。**宁可漏判，不要误判。**',
  ].join('\n');

  const w = [
    isTitle ? '【本页的判据】' : '【该视频的判据】',
    `立场：${wordlist.stance || '（未判定）'}`,
    `可疑表达：${wordlist.patterns.join('、') || '（无）'}`,
    '',
  ];

  // 评论要带上视频标题做语境：同一句话在不同视频下结论完全不同。
  // 之前这一段是空的，等于让模型在不知道视频讲什么的情况下判立场。
  if (!isTitle) {
    const videoTitle = items.find((it) => it.videoTitle)?.videoTitle;
    if (videoTitle) {
      w.unshift(`【该视频】标题：${videoTitle}`);
      w.splice(1, 0, '');
    }
  }

  if (profile) {
    if (profile.dislikes.length) {
      w.push(`用户不喜欢：${profile.dislikes.join('、')}`);
    }
    if (Object.keys(profile.stanceHints).length) {
      w.push(
        '用户立场：' +
          Object.entries(profile.stanceHints).map(([k, v]) => `${k}=${v}`).join('、'),
      );
    }
    w.push('');
  }

  const lines = items.map((it, i) =>
    isTitle
      ? `${i + 1}. UP主：${it.author}｜标题：${it.text}`
      : `${i + 1}. 作者：${it.author}｜内容：${it.text}`,
  );

  const user = [
    ...w,
    isTitle ? '【待判视频】' : '【待判评论】',
    ...lines,
  ].join('\n');
  return { system, user };
}

/** 解析 LLM 输出，失败或缺项一律回落为 pass。 */
export function parseJudgments(
  raw: string,
  itemIds: string[],
  fallbackAction: 'pass',
): Verdict[] {
  const parsed = parseJsonResponse<{ results?: unknown }>(raw);
  const byId = new Map<string, Record<string, unknown>>();

  if (parsed && Array.isArray(parsed.results)) {
    for (const r of parsed.results) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const id = String(rec['id'] ?? '');
      if (!id) continue;
      byId.set(id, rec);
    }
  }

  return itemIds.map((id) => {
    const rec = byId.get(id);
    if (!rec) return passVerdict(id, fallbackAction);

    const rawAction = rec['action'];
    if (
      rawAction !== 'pass' &&
      rawAction !== 'fold' &&
      rawAction !== 'hide' &&
      rawAction !== 'mark'
    ) {
      return passVerdict(id, fallbackAction);
    }
    const action: VerdictAction = rawAction;

    const reason =
      typeof rec['reason'] === 'string' && rec['reason'].trim().length > 0
        ? rec['reason'].trim().slice(0, 60)
        : '未说明原因';

    const rc = rec['reasonCode'];
    // action=pass 时 reasonCode 必须是 none。
    // 实测模型会在放行时也填一个「看起来像理由」的码（比如给一条支持性评论
    // 填 stance_opposite），那会污染屏蔽统计里的按码分布——放行的条目
    // 本来就不该出现在任何原因分类里。
    const reasonCode: VerdictReasonCode =
      action === 'pass'
        ? 'none'
        : typeof rc === 'string' && VALID_REASON_CODES.has(rc)
          ? (rc as VerdictReasonCode)
          : 'off_topic';

    const conf = typeof rec['confidence'] === 'number' ? rec['confidence'] : 0.5;

    return {
      itemId: id,
      action,
      reason,
      reasonCode,
      confidence: Math.max(0, Math.min(1, conf)),
      revocable: action !== 'pass',
    };
  });
}

function passVerdict(itemId: string, action: 'pass'): Verdict {
  return {
    itemId,
    action,
    reason: '',
    reasonCode: 'none',
    confidence: 1,
    revocable: false,
  };
}

/**
 * 批量精判。
 *
 * **按 MAX_BATCH_ITEMS 分批**：一次调用塞几十上百条，模型质量会掉，
 * 而且单次响应体容易超长被截断。分批后每批独立判定，
 * 一批失败只影响那一批（降级为 pass），不会连累其它。
 *
 * LLM 失败 → 全部降级为 pass（放行）。**绝不抛异常**，
 * 否则页面会因为一次网络抖动就卡住。
 */
export async function judgeItems(
  client: LlmClient,
  items: JudgeInput[],
  wordlist: Wordlist,
  mode: Mode,
  profile: UserProfile | null,
  threshold: number,
  target: JudgeTarget = 'comment',
): Promise<Verdict[]> {
  if (items.length === 0) return [];

  const out: Verdict[] = [];
  for (let start = 0; start < items.length; start += MAX_BATCH_ITEMS) {
    const chunk = items.slice(start, start + MAX_BATCH_ITEMS);
    const ids = chunk.map((_, i) => String(start + i + 1));
    try {
      const { system, user } = buildJudgePrompt(chunk, wordlist, mode, profile, target);
      const raw = await client.complete(user, { system });
      const verdicts = parseJudgments(raw, ids, 'pass');
      out.push(
        ...verdicts.map((v) =>
          v.action !== 'pass' && v.confidence < threshold ? passVerdict(v.itemId, 'pass') : v,
        ),
      );
    } catch (e) {
      // 这一批降级为 pass，不影响其它批。
      // 但要记下原因——用户看到的是「什么都没发生」，得让他知道发生了什么。
      const reason = e instanceof Error ? e.message : String(e);
      console.error(`[anti-bubble] LLM 精判失败：${reason}`);
      await setLastError(`LLM 精判失败：${reason}`);
      out.push(...ids.map((id) => passVerdict(id, 'pass')));
    }
  }
  return out;
}
