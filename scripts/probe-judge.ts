/**
 * 真模型探针：把判定 prompt 直接打到真实 LLM 上，看它怎么判。
 *
 * 为什么单独写这个脚本：判定链路中间隔着词表粗筛、缓存、DOM 注入，
 * 出问题时很难分清是「prompt 写错了」还是「别的环节搞错了」。
 * 这里绕过整条链路，直接问模型：**同样的输入，模型到底判成什么**。
 *
 * 用法：
 *   npx tsx scripts/probe-judge.ts            # 用当前 prompt 跑一遍
 *   CASE=joke npx tsx scripts/probe-judge.ts  # 只跑某一组用例
 *
 * Key 从 llm-quant/config.toml 读，**不打印明文**。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildJudgePrompt } from '../src/pipeline/judge';
import { buildWordlistPrompt } from '../src/pipeline/wordlist';
import { Pipeline } from '../src/pipeline/pipeline';
import { createLlmClient, parseJsonResponse } from '../src/bg/llm/client';
import type { LlmConfig } from '../src/shared/types';
import type { Wordlist } from '../src/pipeline/types';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const CFG = process.env.LLM_CONFIG ?? join(REPO, '..', 'llm-quant', 'config.toml');

function readLlmConfig(): LlmConfig {
  const raw = readFileSync(CFG, 'utf8');
  const llmSection: string[] = [];
  let inLlm = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { inLlm = /^\s*\[llm\]/.test(line); continue; }
    if (inLlm) llmSection.push(line);
  }
  const pick = (key: string): string => {
    for (const line of llmSection) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["'](.*)["']`));
      if (m) return m[1]!;
    }
    return '';
  };
  const apiKey = pick('api_key');
  const baseUrl = pick('base_url');
  const model = pick('model');
  if (!apiKey || !baseUrl || !model) throw new Error('config.toml 里读不到 llm 配置');
  return {
    provider: 'openai',
    baseUrl,
    apiKey,
    model,
    timeoutMs: 240000,
    maxTokens: Number(pick('max_completion_tokens') || 8192),
    reasoningEffort: (process.env.EFFORT ?? 'low') as 'low' | 'medium' | 'high',
  };
}

/** 画像：用户支持 AI、看不惯键政。用来给「立场相反」一个基准。 */
const profile = {
  interests: [{ tag: 'AI', weight: 0.9 }],
  dislikes: ['引战'],
  stanceHints: { AI: '支持' },
  topics: ['AI', '编程'],
  updatedAt: new Date().toISOString(),
  sampleCount: 50,
};

const wordlist: Wordlist = {
  patterns: ['推销', '阴谋', '取代', '网崩'],
  stance: '讨论 AI 编程工具的实际影响',
  oppositeKeywords: ['AI 替代人类'],
  cacheKey: 'probe',
};

interface Case {
  name: string;
  text: string;
  /** 可接受的判定动作 */
  ok: string[];
  /** 不接受的判定动作（显式列出，便于报告） */
  bad?: string[];
  /**
   * reason 里必须出现的词。
   *
   * 用来表达「看懂了调侃」这种**没法用 action 表达**的要求：
   * 调侃既可以 pass，也可以 mark（如果它确实在表达相反立场），
   * 但只要标了，理由就必须点明这是调侃。
   */
  reasonWords?: string[];
  /**
   * 全链路探针里是否断言这一条。
   *
   * 默认 false：全链路模式下，**能不能进精判由粗筛决定**，
   * 而粗筛的召回取决于那个视频的动态词表——词表没覆盖到的表达
   * 一律 pass。这是既有设计（判据就是召回闸门），不是本次改动的问题。
   * 所以全链路只断言「玩梗用例」，其余作为参考打印。
   */
  pipelineAssert?: boolean;
}

const cases: Case[] = [
  {
    name: '用户实况①：狗头 + 反问式调侃',
    text: 'OPENAi发现漏洞，然后大家用codex修，这何尝不是一种大推销[doge]',
    // 调侃不该被折叠；标不标都行，但标了必须看出是调侃
    ok: ['pass', 'mark'],
    bad: ['fold', 'hide'],
    reasonWords: ['调侃', '反讽', '讽刺', '戏谑', '玩笑'],
    pipelineAssert: true,
  },
  {
    name: '用户实况②：游戏/动漫玩梗串烧',
    text: '谁到底要走2077世界线，但网崩溃，为了阻止流窜ai只能建立黑塔(晋级而立)',
    ok: ['pass'],
    bad: ['mark', 'fold', 'hide'],
    pipelineAssert: true,
  },
  {
    name: '对照①：真诚的立场相反主张',
    text: 'AI 编程工具迟早把人类工程师全部替代掉，现在这些工具本质上就是裁员工具',
    ok: ['mark'],
  },
  {
    name: '对照②：真正的引战（攻击群体）',
    text: '某群体的人就别出来恶心人了，滚回你们老家去',
    ok: ['fold', 'hide'],
  },
  {
    name: '对照③：纯玩梗/日常梗',
    text: '今日份的忧郁.jpg 到家了',
    ok: ['pass'],
  },
  {
    name: '对照④：狗头但说的是正经事',
    text: '刚看到大模型把整个项目重构了，效率确实离谱[doge]',
    ok: ['pass'],
  },
];

/**
 * 两种语境。
 *
 * - `clean`：词表干净（判据是正经的引战词），评论不在判据里。
 * - `real`：**还原用户截图里的真实情况**——那个视频的评论区里有大量玩梗评论，
 *   词表是从评论区样本里学判据的，于是玩梗的字面词（黑塔/晋级而立/网崩）
 *   进了判据；粗筛把这条玩梗评论送进精判，模型看到「可疑表达：黑塔、晋级而立」
 *   就顺着这个框硬找解读。
 */
const scenarios: Record<string, { wordlist: Wordlist; videoTitle: string }> = {
  clean: {
    wordlist: {
      patterns: ['推销', '阴谋', '取代', '网崩'],
      stance: '讨论 AI 编程工具的实际影响',
      oppositeKeywords: ['AI 替代人类'],
      cacheKey: 'probe',
    },
    videoTitle: 'AI 编程工具的实际影响',
  },
  real: {
    wordlist: {
      patterns: ['黑塔', '晋级而立', '流窜', '网崩', '世界线', '大推销'],
      stance: '讨论 AI 发展失控，以及赛博朋克 2077 式的崩坏世界线',
      oppositeKeywords: ['AI 失控 阴谋'],
      cacheKey: 'probe',
    },
    videoTitle: '当 AI 接管一切：赛博朋克 2077 的世界线还能回得去吗',
  },
};

async function main(): Promise<void> {
  const cfg = readLlmConfig();
  console.log('模型:', cfg.model, '（Key 不打印）');
  const client = createLlmClient(cfg);

  // ── 词表探针：玩梗的字面词会不会进判据 ──
  // 这是根因那一半：判据来自评论区样本，样本里全是玩梗，
  // 词表就会把「黑塔」「晋级而立」当判据 → 粗筛把这些玩梗评论送进精判。
  if (process.env.WORDLIST === '1') {
    const video = {
      title: '当 AI 接管一切：赛博朋克 2077 的世界线还能回得去吗',
      description: '聊聊 AI 泛滥之后世界会变成什么样。',
      samples: [
        '谁到底要走2077世界线，但网崩溃，为了阻止流窜ai只能建立黑塔(晋级而立)',
        'OPENAi发现漏洞，然后大家用codex修，这何尝不是一种大推销[doge]',
        '笑死，隔壁2077的AI都比我玩得强[doge]',
        '楼主这波预测有点东西，2077世界线真的回不去了',
        '黑塔一出，AI直接被关小黑屋了（晋级而立）',
      ],
    };
    const { system, user } = buildWordlistPrompt(video, profile, 'anti');
    const raw = await client.complete(user, { system, maxTokens: 4000 });
    const parsed = parseJsonResponse<{ patterns?: string[]; stance?: string }>(raw);
    if (!parsed) {
      console.log('--- 词表原始输出（前 1200 字）---');
      console.log(raw.slice(0, 1200));
      process.exitCode = 1;
      return;
    }
    const patterns = parsed.patterns ?? [];
    console.log('\n=== 生成的判据 ===');
    console.log(patterns.join('、'));
    console.log('立场：', parsed.stance ?? '');
    // 玩梗/虚构设定的专有名词与表情标记不该进判据
    const memeWords = ['黑塔', '晋级而立', '流窜', 'doge', '笑死', '世界线', '网崩'];
    const leaked = patterns.filter((p) => memeWords.some((w) => p.includes(w)));
    console.log(
      leaked.length
        ? `\nFAIL 判据里混进了玩梗/虚构设定的词：${leaked.join('、')}`
        : '\nPASS 判据里没有玩梗/虚构设定的词',
    );
    if (leaked.length) process.exitCode = 1;
    return;
  }

  const only = process.env.CASE;
  const picked = only ? cases.filter((c) => c.name.includes(only)) : cases;
  const which = process.env.SCENARIO ? [process.env.SCENARIO] : Object.keys(scenarios);
  let totalFail = 0;

  // ── 全链路探针：真模型生成词表 → 粗筛 → 精判 ──
  // 单看精判不够：粗筛决定哪些评论能进精判，
  // 词表把玩梗的字面词当判据时，模型会被「可疑表达：黑塔」这个框带着跑偏。
  if (process.env.PIPELINE === '1') {
    const video = {
      title: '当 AI 接管一切：赛博朋克 2077 的世界线还能回得去吗',
      description: '聊聊 AI 泛滥之后世界会变成什么样。',
      samples: [
        '谁到底要走2077世界线，但网崩溃，为了阻止流窜ai只能建立黑塔(晋级而立)',
        'OPENAi发现漏洞，然后大家用codex修，这何尝不是一种大推销[doge]',
        '笑死，隔壁2077的AI都比我玩得强[doge]',
        '楼主这波预测有点东西，2077世界线真的回不去了',
        '黑塔一出，AI直接被关小黑屋了（晋级而立）',
      ],
    };
    const wl = buildWordlistPrompt(video, profile, 'anti');
    const wlRaw = await client.complete(wl.user, { system: wl.system, maxTokens: 4000 });
    const wlParsed = parseJsonResponse<{ patterns?: string[]; stance?: string; oppositeKeywords?: string[] }>(wlRaw);
    const patterns = wlParsed?.patterns ?? [];
    console.log('\n=== 真模型生成的判据 ===');
    console.log(patterns.join('、') || '(空)');
    console.log('立场：', wlParsed?.stance ?? '');

    const wordlist: Wordlist = {
      patterns,
      stance: wlParsed?.stance ?? '',
      oppositeKeywords: wlParsed?.oppositeKeywords ?? [],
      cacheKey: 'probe',
    };
    const pipeline = new Pipeline({ client });
    const items = picked.map((c, i) => ({
      kind: 'comment' as const,
      id: String(i + 1),
      text: c.text,
      author: 'u',
      meta: {},
      context: { page: 'video' as const, videoId: 'BV1', videoTitle: video.title },
    }));
    const verdicts = await pipeline.judge(items, {
      mode: 'anti',
      profile,
      subject: { kind: 'video', video: { ...video, bvid: 'BV1' } },
      threshold: 0.7,
    });

    console.log('\n=== 全链路判定 ===');
    let pass = 0;
    let asserted = 0;
    picked.forEach((c, i) => {
      const v = verdicts[i]!;
      const reason = v.reason ?? '';
      const isAssert = c.pipelineAssert === true;
      const problems: string[] = [];
      if (isAssert) {
        if (!c.ok.includes(v.action)) problems.push(`动作 ${v.action} 不在可接受集合 [${c.ok.join('/')}]`);
        if (c.bad?.includes(v.action)) problems.push(`动作 ${v.action} 属于明确不该出现的动作`);
        if (v.action !== 'pass' && c.reasonWords?.length) {
          if (!c.reasonWords.some((w) => reason.includes(w))) {
            problems.push(`理由没体现「看懂了」（应含：${c.reasonWords.join('/')}）`);
          }
        }
      }
      const ok = problems.length === 0;
      if (isAssert) {
        asserted++;
        if (ok) pass++;
        else totalFail++;
      }
      console.log(
        `${ok ? 'PASS' : 'FAIL'} [${v.action}] ${c.name}` +
        `${isAssert ? '' : '  （参考：能不能进精判由粗筛决定，不作断言）'}\n` +
        `      理由：${reason || '(无)'}\n` +
        `      码：${v.reasonCode}  置信度：${v.confidence}` +
        (problems.length ? `\n      ✗ ${problems.join('；')}` : ''),
      );
    });
    console.log(`\n断言 ${asserted} 条，符合期望 ${pass} 条`);
    if (totalFail > 0) process.exitCode = 1;
    return;
  }

  for (const sc of which) {
    const { wordlist, videoTitle } = scenarios[sc]!;
    console.log(`\n========== 语境：${sc} ==========`);
    console.log(`立场：${wordlist.stance}`);
    console.log(`判据：${wordlist.patterns.join('、')}\n`);

    const { system, user } = buildJudgePrompt(
      picked.map((c) => ({ text: c.text, author: 'u', videoTitle })),
      wordlist,
      (process.env.MODE as 'cocoon' | 'anti') ?? 'anti',
      profile,
      'comment',
    );

    const raw = await client.complete(user, { system, maxTokens: cfg.maxTokens ?? 8192 });
    const parsed = parseJsonResponse<{
      results?: { id: string | number; action: string; reason: string; reasonCode: string; confidence: number }[];
    }>(raw);
    if (!parsed) {
      console.log('--- 模型原始输出（前 1200 字）---');
      console.log(raw.slice(0, 1200));
      totalFail += picked.length;
      continue;
    }

    let pass = 0;
    picked.forEach((c, i) => {
      // 模型的 id 可能是数字也可能是字符串，两边都归一化再比
      const r = parsed.results?.find((x) => String(x.id) === String(i + 1));
      const action = r?.action ?? '(缺)';
      const reason = r?.reason ?? '';

      const problems: string[] = [];
      if (!c.ok.includes(action)) problems.push(`动作 ${action} 不在可接受集合 [${c.ok.join('/')}]`);
      if (c.bad?.includes(action)) problems.push(`动作 ${action} 属于明确不该出现的动作`);
      // 「看懂了调侃」这种要求只能从 reason 上体现
      if (action !== 'pass' && c.reasonWords?.length) {
        const hit = c.reasonWords.find((w) => reason.includes(w));
        if (!hit) {
          problems.push(`理由没体现「看懂了」（应含：${c.reasonWords.join('/')}）`);
        }
      }
      const ok = problems.length === 0;
      if (ok) pass++;
      else totalFail++;
      console.log(
        `${ok ? 'PASS' : 'FAIL'} [${action}] ${c.name}\n` +
        `      理由：${reason || '(无)'}\n` +
        `      码：${r?.reasonCode ?? '-'}  置信度：${r?.confidence ?? '-'}` +
        (problems.length ? `\n      ✗ ${problems.join('；')}` : ''),
      );
    });
    console.log(`\n共 ${picked.length} 条，符合期望 ${pass} 条`);
  }

  if (totalFail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
