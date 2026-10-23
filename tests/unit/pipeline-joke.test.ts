import { describe, it, expect } from 'vitest';
import { buildJudgePrompt } from '../../src/pipeline/judge';
import { buildWordlistPrompt, buildListWordlistPrompt } from '../../src/pipeline/wordlist';
import type { UserProfile } from '../../src/shared/types';
import type { Wordlist } from '../../src/pipeline/types';

const profile: UserProfile = {
  interests: [{ tag: 'AI', weight: 0.9 }],
  dislikes: ['引战'],
  stanceHints: { AI: '支持' },
  topics: ['AI'],
  updatedAt: '2026-10-20T00:00:00.000Z',
  sampleCount: 50,
};

const wl: Wordlist = {
  patterns: ['黑塔', '晋级而立', '大推销'], stance: '讨论 AI 泛滥', oppositeKeywords: [], cacheKey: 'k',
};

function judgeSystem(target: 'comment' | 'title' = 'comment'): string {
  const p = buildJudgePrompt(
    [{ text: '这何尝不是一种大推销[doge]', author: 'u', videoTitle: 'AI 泛滥' }],
    wl,
    'anti',
    profile,
    target,
  );
  return p.system;
}

/**
 * 回归防护：**调侃不是主张**。
 *
 * 用户实测（真机截图）：评论区里两条调侃被当成正经主张评价，
 * 一条被标成「用日网阴谋和黑塔讽刺AI发展失控」——
 * 模型给游戏梗编了个现实解释（黑塔是游戏角色，不是「日网阴谋」）。
 */
describe('调侃 / 玩梗的判读规则', () => {
  it('判定 prompt 里明确教模型识别调侃', () => {
    const s = judgeSystem();
    expect(s).toContain('调侃、玩梗、反讽');
    expect(s).toContain('[doge]');
    expect(s).toContain('反问式的调侃');
  });

  it('教模型不要给梗编现实解释（用户实测的「日网阴谋」错法）', () => {
    const s = judgeSystem();
    expect(s).toContain('不要给它们编一个现实解释');
  });

  it('纯玩梗默认放行，不当引战也不当立场主张', () => {
    const s = judgeSystem();
    expect(s).toContain('纯玩梗、纯自嘲、纯戏谑 → **pass**');
  });

  it('调侃里夹带辱骂/攻击群体的仍然按引战处理', () => {
    const s = judgeSystem();
    expect(s).toContain('夹带辱骂');
  });

  it('要标立场相反时，理由必须点明是调侃并写出言外之意', () => {
    const s = judgeSystem();
    expect(s).toContain('reason 必须以「调侃：」开头');
    expect(s).toContain('言外之意');
  });

  it('要求先判断是不是调侃，再进正误分析', () => {
    expect(judgeSystem()).toContain('先判断这是不是调侃/玩梗');
    expect(judgeSystem('title')).toContain('先判断这是不是调侃/玩梗');
  });
});

/**
 * 词表侧：**玩梗的字面词不该进判据**。
 *
 * 判据是粗筛的召回闸门。判据里塞满「黑塔」「晋级而立」这类梗词，
 * 后果有两个：玩梗评论一批批被送去精判（白花钱），
 * 以及模型看到「可疑表达：黑塔」会顺着这个框硬找解读，把玩梗当成真的主张。
 */
describe('词表不收玩梗词', () => {
  it('视频页词表 prompt 有这条规则', () => {
    const p = buildWordlistPrompt(
      {
        title: '当 AI 接管一切：赛博朋克 2077 的世界线还能回得去吗',
        description: '聊聊 AI 泛滥之后世界会变成什么样。',
        samples: ['谁到底要走2077世界线，但网崩溃，为了阻止流窜ai只能建立黑塔(晋级而立)'],
      },
      profile,
      'anti',
    );
    expect(p.system).toContain('不要把玩梗写进判据');
    expect(p.system).toContain('角色名');
    expect(p.system).toContain('[doge]');
  });

  it('列表页词表 prompt 也有这条规则', () => {
    const p = buildListWordlistPrompt(
      { id: 'list:x', title: '搜索：AI', samples: ['AI 泛滥成这样了吗'] },
      profile,
      'anti',
    );
    expect(p.system).toContain('不要把玩梗写进判据');
  });

  it('视频页词表还多一条：不要用标题里已经出现的词', () => {
    const p = buildWordlistPrompt({ title: '赛博朋克 2077 世界线', samples: ['a'] }, profile, 'anti');
    expect(p.system).toContain('不要用标题或主题里出现过的词');
  });
});
