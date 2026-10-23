import { describe, it, expect } from 'vitest';
import { matchBuiltinKeyword, keywordRuleCount } from '../../src/pipeline/keyword';

describe('内置关键词库', () => {
  it('词库不是空的', () => {
    expect(keywordRuleCount()).toBeGreaterThan(20);
  });

  it('命中辱骂用语', () => {
    const hit = matchBuiltinKeyword('你真是傻逼吧');
    expect(hit).not.toBeNull();
    expect(hit!.category).toBe('insult');
    expect(hit!.reasonCode).toBe('incitement');
    // 理由要能直接展示给用户
    expect(hit!.reason).toContain('命中');
  });

  it('命中群体攻击标签', () => {
    const hit = matchBuiltinKeyword('他就是个汉奸');
    expect(hit).not.toBeNull();
    expect(hit!.category).toBe('label');
  });

  it('命中煽动对立的句式', () => {
    const hit = matchBuiltinKeyword('这些人全都该死');
    expect(hit).not.toBeNull();
    expect(hit!.category).toBe('incitement');
  });

  it('大写英文也能命中（匹配是忽略大小写的）', () => {
    expect(matchBuiltinKeyword('你真是傻B')).not.toBeNull();
  });

  it('普通内容不命中', () => {
    expect(matchBuiltinKeyword('今天天气不错，讲讲 Rust 挺好')).toBeNull();
  });

  it('「垃圾分类」这种高频中性词不命中', () => {
    // 词库只收高置信度的词：命中等于噪声的词一律不收。
    expect(matchBuiltinKeyword('垃圾分类的新规来了')).toBeNull();
  });

  it('「精美」这种中性词不命中', () => {
    expect(matchBuiltinKeyword('画面精美到可以当壁纸')).toBeNull();
  });

  it('空文本不命中', () => {
    expect(matchBuiltinKeyword('')).toBeNull();
  });
});
