/**
 * 测不同 reasoning_effort 下，列表词表调用要多久。
 * 词表是「抽取 + 生成短语」这种简单活，深度思考纯属浪费时间和钱。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildListWordlistPrompt } from '../src/pipeline/wordlist';
import { createLlmClient } from '../src/bg/llm/client';
import type { LlmConfig } from '../src/shared/types';

// 仓库根目录：从脚本自身位置推算，换机器/换盘符都不用改代码。
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
// LLM 配置来源：默认读同级目录下的 llm-quant/config.toml，可用环境变量覆盖。
const CONFIG_TOML = process.env.LLM_CONFIG ?? join(REPO, '..', 'llm-quant', 'config.toml');

function readLlmConfig(): LlmConfig {
  const raw = readFileSync(CONFIG_TOML, 'utf8');
  const lines: string[] = [];
  let inLlm = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { inLlm = /^\s*\[llm\]/.test(line); continue; }
    if (inLlm) lines.push(line);
  }
  const pick = (key: string): string => {
    for (const line of lines) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*["'](.*)["']`));
      if (m) return m[1]!;
    }
    return '';
  };
  return {
    provider: 'openai',
    baseUrl: pick('base_url'),
    apiKey: pick('api_key'),
    model: pick('model'),
    timeoutMs: 240000,
    maxTokens: Number(pick('max_completion_tokens') || 8192),
  };
}

const list = {
  id: 'list:probe-eff',
  title: '搜索：华为 手机',
  samples: [
    '2026年华为手机红黑榜选购指南！哪些物有所值可以选？哪些性价比偏低不推荐？#华为手机 #手机推荐',
    '小折叠，阔视界｜华为PuraX一年半后，越用越香',
    '你买华为必须要接受的四大缺点',
    '华为手机正常能用几年？内行人说出实情，和大家预想的完全不一样',
    '华为手机纷纷涨价！所有买手机的蹲好明晚8点！',
    '华为又被制裁了？供应链现状分析',
  ],
};

async function run(effort: 'low' | 'medium' | 'high' | undefined): Promise<void> {
  const cfg = readLlmConfig();
  if (effort) cfg.reasoningEffort = effort;
  const client = createLlmClient(cfg);
  const { system, user } = buildListWordlistPrompt(list, null, 'cocoon');
  const t0 = Date.now();
  try {
    const out = await client.complete(user, { system });
    console.log(`effort=${effort ?? '(未设)'}  ${Date.now() - t0}ms  长度=${out.length}`);
    console.log('   ' + out.replace(/\s+/g, ' ').slice(0, 220));
  } catch (e) {
    console.log(`effort=${effort ?? '(未设)'}  失败 ${Date.now() - t0}ms：${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(): Promise<void> {
  await run('low');
  await run(undefined);
}

main().catch((e) => {
  console.error('ERROR: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
