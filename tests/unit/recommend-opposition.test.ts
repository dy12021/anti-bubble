import { describe, it, expect, vi } from 'vitest';
import { judgeOpposition, buildOppositionPrompt } from '../../src/recommend/opposition';
import type { LlmClient } from '../../src/bg/llm/client';
import type { SearchItem } from '../../src/bili/types';

function cand(bvid: string, title: string): SearchItem {
  return {
    bvid, title, author: 'UP', mid: 1, duration: '10:00',
    description: '', pubdate: 0, pic: '',
  };
}

const CANDIDATES = [
  cand('BV1aa411c7mD', 'AI 如何造福人类'),
  cand('BV1bb411c7mD', 'AI 会不会取代人类工作'),
  cand('BV1cc411c7mD', '全自动生产与资本积累'),
];

function client(text: string): LlmClient {
  return { complete: vi.fn(async () => text) };
}

describe('反向推荐的精排', () => {
  it('prompt 让模型按序号输出（抄序号比抄 bvid 稳）', () => {
    const p = buildOppositionPrompt({ title: '当前', stance: 'AI 很危险' }, CANDIDATES);
    expect(p.system).toContain('id 是候选列表里的**序号**');
    expect(p.user).toContain('1. [BV1aa411c7mD]');
  });

  it('按序号取候选', async () => {
    const c = client(JSON.stringify({
      results: [{ id: 2, reason: '它认为 AI 会取代人类工作' }],
    }));
    const out = await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES);
    expect(out).toHaveLength(1);
    expect(out[0]!.bvid).toBe('BV1bb411c7mD');
    expect(out[0]!.reason).toBe('它认为 AI 会取代人类工作');
  });

  it('按 bvid 取候选也认（老格式兼容）', async () => {
    const c = client(JSON.stringify({
      results: [{ bvid: 'BV1cc411c7mD', reason: 'r' }],
    }));
    const out = await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES);
    expect(out[0]!.bvid).toBe('BV1cc411c7mD');
  });

  it('bvid 大小写/空格不一致也能对上', async () => {
    const c = client(JSON.stringify({
      results: [{ bvid: ' bv1aa411c7md ', reason: 'r' }],
    }));
    const out = await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES);
    expect(out[0]!.bvid).toBe('BV1aa411c7mD');
  });

  it('序号是字符串也能认', async () => {
    const c = client(JSON.stringify({ results: [{ id: '3', reason: 'r' }] }));
    const out = await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES);
    expect(out[0]!.bvid).toBe('BV1cc411c7mD');
  });

  /**
   * 回归防护：早先只按 bvid 精确匹配，模型抄错一个字符就被静默丢掉，
   * 结果是「召回到 20 条却一条都没推」——看起来像功能坏了。
   */
  it('匹配不上的候选被忽略，且不影响其它结果', async () => {
    const c = client(JSON.stringify({
      results: [
        { id: 99, reason: '不存在的序号' },
        { bvid: 'BV1zzz', reason: '不存在的 bvid' },
        { id: 1, reason: '有效' },
      ],
    }));
    const out = await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES);
    expect(out).toHaveLength(1);
    expect(out[0]!.bvid).toBe('BV1aa411c7mD');
  });

  it('重复推同一个候选只保留一条', async () => {
    const c = client(JSON.stringify({
      results: [{ id: 1, reason: 'a' }, { bvid: 'BV1aa411c7mD', reason: 'b' }],
    }));
    const out = await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES);
    expect(out).toHaveLength(1);
  });

  it('最多推 5 条', async () => {
    const many = Array.from({ length: 12 }, (_, i) => cand('BV' + i, '标题' + i));
    const c = client(JSON.stringify({
      results: many.map((_, i) => ({ id: i + 1, reason: 'r' })),
    }));
    const out = await judgeOpposition(c, { title: 't', stance: 's' }, many);
    expect(out).toHaveLength(5);
  });

  it('输出不可解析时返回空数组', async () => {
    const c = client('乱码');
    expect(await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES)).toEqual([]);
  });

  it('LLM 抛错时返回空数组', async () => {
    const c: LlmClient = { complete: vi.fn(async () => { throw new Error('挂了'); }) };
    expect(await judgeOpposition(c, { title: 't', stance: 's' }, CANDIDATES)).toEqual([]);
  });

  it('没有候选时直接返回空', async () => {
    const c = client('{}');
    expect(await judgeOpposition(c, { title: 't', stance: 's' }, [])).toEqual([]);
  });
});
