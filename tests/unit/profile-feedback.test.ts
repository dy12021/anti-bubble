import { describe, it, expect } from 'vitest';
import {
  applyProfileFeedback, deriveInterestTag, describeProfileFeedback,
  applyProfileOverrides, recordProfileOverride, EMPTY_OVERRIDES,
} from '../../src/profile/feedback';
import type { UserProfile } from '../../src/shared/types';

const profile: UserProfile = {
  interests: [{ tag: '技术', weight: 0.8 }],
  dislikes: ['游戏实况', '引战'],
  stanceHints: { 'AI': '谨慎' },
  topics: ['Rust', '游戏实况'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 10,
};

const NOW = Date.parse('2026-10-25T12:00:00.000Z');

describe('派生兴趣标签', () => {
  it('去掉开头的方括号块（栏目名不是题材）', () => {
    expect(deriveInterestTag('【科普中国】AI 会不会取代人类')).toBe('AI 会不会取代人类');
  });

  it('按标点取片段', () => {
    expect(deriveInterestTag('芙蕾滤杯搭配草莓舒芙蕾')).toBe('芙蕾滤杯搭配草莓舒芙蕾');
  });

  it('通用词（合集/记录这类栏目标记）不当兴趣标签', () => {
    // 「合集」描述的是栏目的形式，不是题材——写进画像只会污染它
    expect(deriveInterestTag('【手打柠檬茶】合集｜速溶咖啡入门')).toBe('速溶咖啡入门');
    expect(deriveInterestTag('合集')).toBeNull();
  });

  it('通用句式（第X集/Vlog）跳过，换下一个片段', () => {
    expect(deriveInterestTag('Vlog58｜我的留学生活')).toBe('我的留学生活');
    expect(deriveInterestTag('第二集｜猫猫的一天')).toBe('猫猫的一天');
  });

  it('第一个片段是标题党钩子时也不收', () => {
    expect(deriveInterestTag('震惊！某国选手被曝黑幕')).toBe('某国选手被曝黑幕');
  });

  it('太长会截断', () => {
    const tag = deriveInterestTag('这是一个非常非常非常长的标题内容');
    expect(tag!.length).toBeLessThanOrEqual(20);
  });

  it('太短（1 个字）直接放弃，不往画像里塞垃圾', () => {
    expect(deriveInterestTag('啊')).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(deriveInterestTag('')).toBeNull();
  });
});

describe('画像反馈', () => {
  it('去掉命中的「不喜欢」标签，其它标签不动', () => {
    const next = applyProfileFeedback(
      profile,
      { matchedTag: '游戏实况', kind: 'video', text: 'Rust 异步编程实战' },
      NOW,
    );
    expect(next.dislikes).toEqual(['引战']);
    expect(next.topics).not.toContain('游戏实况');
  });

  it('把视频题材加进兴趣', () => {
    const next = applyProfileFeedback(
      profile,
      { matchedTag: '游戏实况', kind: 'video', text: 'Rust 异步编程实战' },
      NOW,
    );
    expect(next.interests.map((i) => i.tag)).toContain('Rust 异步编程实战');
  });

  it('评论不加兴趣（把一条评论当兴趣没意义）', () => {
    const next = applyProfileFeedback(
      profile,
      { matchedTag: '游戏实况', kind: 'comment', text: '这游戏真好玩' },
      NOW,
    );
    expect(next.interests.map((i) => i.tag)).toEqual(['技术']);
  });

  it('更新 updatedAt：判定缓存键带画像版本，不更新旧判定不会失效', () => {
    const next = applyProfileFeedback(profile, { matchedTag: '游戏实况' }, NOW);
    expect(next.updatedAt).toBe(new Date(NOW).toISOString());
    expect(next.updatedAt).not.toBe(profile.updatedAt);
  });

  it('不改原对象（纯函数）', () => {
    applyProfileFeedback(profile, { matchedTag: '游戏实况', kind: 'video', text: 'x' }, NOW);
    expect(profile.dislikes).toEqual(['游戏实况', '引战']);
  });

  it('标签大小写不同也算命中同一个标签', () => {
    const p: UserProfile = { ...profile, dislikes: ['GamePlay'] };
    const next = applyProfileFeedback(p, { matchedTag: 'gameplay' }, NOW);
    expect(next.dislikes).toEqual([]);
  });

  it('已有的兴趣标签只提权重，不重复添加', () => {
    const next = applyProfileFeedback(
      profile,
      { matchedTag: '游戏实况', kind: 'video', text: '技术' },
      NOW,
    );
    expect(next.interests.filter((i) => i.tag === '技术')).toHaveLength(1);
  });

  it('没有 matchedTag 时只加兴趣，不删标签', () => {
    const next = applyProfileFeedback(
      profile,
      { kind: 'video', text: '量子计算科普' },
      NOW,
    );
    expect(next.dislikes).toEqual(['游戏实况', '引战']);
    expect(next.interests.map((i) => i.tag)).toContain('量子计算科普');
  });
});

describe('画像反馈的描述', () => {
  it('说清楚会改什么', () => {
    const r = describeProfileFeedback(profile, {
      matchedTag: '游戏实况', kind: 'video', text: 'Rust 异步编程实战',
    });
    expect(r.removedTag).toBe('游戏实况');
    expect(r.addedInterest).toBe('Rust 异步编程实战');
  });

  it('标签本来就不在 dislikes 里时不报告删除', () => {
    const r = describeProfileFeedback(profile, { matchedTag: '不存在的标签' });
    expect(r.removedTag).toBeNull();
  });
});

/**
 * 手动纠正必须比自动归纳更持久。
 *
 * 画像每 24 小时会被 LLM 从观看样本重算一遍；
 * 用户在页面上点「我喜欢这类」是一次**显式纠正**，
 * 它不该 24 小时后被重新归纳抹掉。
 */
describe('手动纠正（覆盖自动归纳）', () => {
  it('记下被取消的「不喜欢」与新增的兴趣', () => {
    const o = recordProfileOverride(EMPTY_OVERRIDES, {
      matchedTag: '游戏实况', kind: 'video', text: 'Rust 异步编程实战',
    });
    expect(o.removedDislikes).toEqual(['游戏实况']);
    expect(o.addedInterests).toEqual(['Rust 异步编程实战']);
  });

  it('重复记不会重复写', () => {
    const once = recordProfileOverride(EMPTY_OVERRIDES, {
      matchedTag: '游戏实况', kind: 'video', text: 'Rust 异步编程实战',
    });
    const twice = recordProfileOverride(once, {
      matchedTag: '游戏实况', kind: 'video', text: 'Rust 异步编程实战',
    });
    expect(twice.removedDislikes).toHaveLength(1);
    expect(twice.addedInterests).toHaveLength(1);
  });

  it('评论不记进兴趣', () => {
    const o = recordProfileOverride(EMPTY_OVERRIDES, {
      matchedTag: '游戏实况', kind: 'comment', text: '这游戏真好玩',
    });
    expect(o.addedInterests).toEqual([]);
    expect(o.removedDislikes).toEqual(['游戏实况']);
  });

  it('叠加到归纳出来的画像上：把标签去掉、把兴趣加上', () => {
    // 模拟 LLM 重新归纳后又把「游戏实况」写回 dislikes
    const fresh: UserProfile = {
      interests: [{ tag: '技术', weight: 0.8 }],
      dislikes: ['游戏实况'],
      stanceHints: {},
      topics: ['游戏实况'],
      updatedAt: '2026-10-25T00:00:00.000Z',
      sampleCount: 20,
    };
    const merged = applyProfileOverrides(fresh, {
      removedDislikes: ['游戏实况'],
      addedInterests: ['Rust 异步编程实战'],
    });
    expect(merged.dislikes).toEqual([]);
    expect(merged.topics).toEqual([]);
    expect(merged.interests.map((i) => i.tag)).toContain('Rust 异步编程实战');
  });

  it('没有纠正时画像原样返回', () => {
    const p = { ...profile };
    expect(applyProfileOverrides(p, EMPTY_OVERRIDES)).toBe(p);
  });
});
