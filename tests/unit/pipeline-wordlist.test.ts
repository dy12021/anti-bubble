import { describe, it, expect } from 'vitest';
import {
  buildWordlistPrompt, parseWordlist, buildFallbackWordlist, wordlistCacheKey,
  buildListWordlistPrompt, buildSubjectPrompt,
} from '../../src/pipeline/wordlist';
import { videoSubject } from '../../src/pipeline/subject';
import type { UserProfile } from '../../src/shared/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.9 }],
  dislikes: ['游戏'],
  stanceHints: { 'AI': '谨慎' },
  topics: ['Rust'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

describe('动态词表', () => {
  it('prompt 含视频标题', () => {
    const p = buildWordlistPrompt({ title: '独特标题ABC' }, profile, 'cocoon');
    expect(p.user).toContain('独特标题ABC');
  });

  it('prompt 含视频简介', () => {
    const p = buildWordlistPrompt({ title: 't', description: '独特简介XYZ' }, profile, 'cocoon');
    expect(p.user).toContain('独特简介XYZ');
  });

  it('prompt 含画像信息', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.user).toContain('技术');
    expect(p.user).toContain('游戏');
  });

  /**
   * 回归防护：视频页的判据必须是**评论里会原样出现的字面表达**。
   *
   * 没有评论样本时，模型会产出「刷屏」「接龙」这类*行为描述*，
   * 评论里不会原样出现 → 粗筛永远打不中 → 评论看着判过其实没判。
   */
  it('给了评论样本时，prompt 里带样本', () => {
    const p = buildWordlistPrompt(
      { title: 't', samples: ['这视频也太下头了吧', '主播是认真的吗'] },
      profile,
      'cocoon',
    );
    expect(p.user).toContain('【评论区样本】');
    expect(p.user).toContain('这视频也太下头了吧');
    expect(p.user).toContain('主播是认真的吗');
  });

  it('没给评论样本时不加样本段', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.user).not.toContain('【评论区样本】');
  });

  it('明说判据要是字面表达、不要写行为描述', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.system).toContain('必须是评论里会原样出现的字面表达');
    expect(p.system).toContain('不要写行为的描述');
  });

  it('cocoon 模式要求找不喜欢的内容', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'cocoon');
    expect(p.user).toContain('不喜欢');
  });

  it('anti 模式要求找对立立场', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'anti');
    expect(p.user).toContain('相反');
  });

  it('解析合法 JSON 得到词表', () => {
    const raw = JSON.stringify({
      patterns: ['引战', '地域攻击'],
      stance: '支持国产芯片',
      oppositeKeywords: ['芯片 反驳', '国产 争议'],
    });
    const w = parseWordlist(raw, buildFallbackWordlist(videoSubject({ bvid: 'BV1', title: 't' })));
    expect(w.patterns).toEqual(['引战', '地域攻击']);
    expect(w.oppositeKeywords).toHaveLength(2);
  });

  it('解析带 markdown 包裹的 JSON', () => {
    const raw = '```json\n{"patterns":["a"],"stance":"s","oppositeKeywords":[]}\n```';
    expect(parseWordlist(raw, buildFallbackWordlist(videoSubject({ bvid: 'BV1', title: 't' }))).patterns).toEqual(['a']);
  });

  it('解析失败回落到兜底词表', () => {
    const fb = buildFallbackWordlist(videoSubject({ bvid: 'BV1', title: 't' }));
    expect(parseWordlist('乱码', fb)).toEqual(fb);
  });

  it('兜底词表 patterns 为空（等于全部放行）', () => {
    const fb = buildFallbackWordlist(videoSubject({ bvid: 'BV1', title: 't' }));
    expect(fb.patterns).toEqual([]);
  });

  it('解析时过滤空模式', () => {
    const raw = JSON.stringify({ patterns: ['a', '', '  ', 'b'], stance: '', oppositeKeywords: [] });
    const w = parseWordlist(raw, buildFallbackWordlist(videoSubject({ bvid: 'BV1', title: 't' })));
    expect(w.patterns).toEqual(['a', 'b']);
  });

  it('解析时限制模式数量上限', () => {
    const raw = JSON.stringify({
      patterns: Array.from({ length: 200 }, (_, i) => 'p' + i),
      stance: '', oppositeKeywords: [],
    });
    expect(parseWordlist(raw, buildFallbackWordlist(videoSubject({ bvid: 'BV1', title: 't' }))).patterns.length)
      .toBeLessThanOrEqual(60);
  });

  it('缓存键随视频 id 变化', () => {
    expect(wordlistCacheKey('BV1', 't')).not.toBe(wordlistCacheKey('BV2', 't'));
  });

  it('缓存键随画像版本变化', () => {
    expect(wordlistCacheKey('BV1', 't1')).not.toBe(wordlistCacheKey('BV1', 't2'));
  });

  it('缓存键是稳定的', () => {
    expect(wordlistCacheKey('BV1', 't')).toBe(wordlistCacheKey('BV1', 't'));
  });
});

/**
 * 列表页的词表 prompt。
 *
 * 关键差异：判据要出现在**视频标题**里。
 * 照搬视频页那套（「可能出现在评论里」）会让模型产出
 * 「楼主」「UP主说」这种标题里根本不存在的模式 → 粗筛永不命中 →
 * 列表页又变成全部放行。
 */
describe('列表页词表', () => {
  const list = {
    id: 'list:abc',
    title: '搜索：华为',
    samples: ['华为被制裁了吗', '国产芯片终于突破'],
  };

  it('prompt 含页面主题', () => {
    const p = buildListWordlistPrompt(list, profile, 'cocoon');
    expect(p.user).toContain('搜索：华为');
  });

  it('prompt 含抽样标题', () => {
    const p = buildListWordlistPrompt(list, profile, 'cocoon');
    expect(p.user).toContain('华为被制裁了吗');
    expect(p.user).toContain('国产芯片终于突破');
  });

  it('明说判据要出现在标题里，不是评论里', () => {
    const p = buildListWordlistPrompt(list, profile, 'cocoon');
    expect(p.system).toContain('视频标题');
    expect(p.system).toContain('会出现在视频标题里');
  });

  it('提醒不要把主题词/话题标签当判据（否则等于全部命中）', () => {
    const p = buildListWordlistPrompt(list, profile, 'cocoon');
    expect(p.system).toContain('不要用主题词本身');
    expect(p.system).toContain('不要用话题标签');
  });

  it('要求判据带立场或情绪，不要用纯功能词', () => {
    const p = buildListWordlistPrompt(list, profile, 'cocoon');
    expect(p.system).toContain('必须带立场或情绪');
    expect(p.system).toContain('不要用纯功能词');
  });

  it('anti 模式同样要求找对立立场', () => {
    const p = buildListWordlistPrompt(list, profile, 'anti');
    expect(p.user).toContain('相反');
  });

  /**
   * 回归防护：对立检索词必须**带立场**。
   *
   * 只给主题词（「人工智能」「AI 应用」）的话，搜回来的是同主题内容，
   * 不一定相反 —— 精排筛下来往往一条都没有，反向推荐就永远出不来东西。
   */
  it('要求对立检索词带立场、不许只给主题词', () => {
    const p = buildListWordlistPrompt(list, profile, 'anti');
    expect(p.system).toContain('词本身必须**带立场**');
    expect(p.system).toContain('不要只给主题词或品类词');
  });

  it('视频页的对立检索词也要求带立场', () => {
    const p = buildWordlistPrompt({ title: 't' }, profile, 'anti');
    expect(p.system).toContain('词本身必须**带立场**');
    expect(p.system).toContain('不要只给主题词或品类词');
  });

  it('buildSubjectPrompt 按语境类型分发', () => {
    const videoPrompt = buildSubjectPrompt(
      videoSubject({ bvid: 'BV1', title: '独特视频标题QQQ' }),
      profile,
      'cocoon',
    );
    expect(videoPrompt.user).toContain('独特视频标题QQQ');

    const listPrompt = buildSubjectPrompt(
      { kind: 'list', list },
      profile,
      'cocoon',
    );
    expect(listPrompt.user).toContain('搜索：华为');
    expect(listPrompt.user).not.toContain('【视频】');
  });
});
