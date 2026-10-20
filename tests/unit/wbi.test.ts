import { describe, it, expect } from 'vitest';
import { mixinKey, signParams, encodeQuery, extractKey, md5, MIXIN_KEY_ENC_TAB } from '../../src/bili/wbi';

describe('WBI 签名', () => {
  it('mixin key 长度恒为 32', () => {
    const k = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    expect(k).toHaveLength(32);
  });

  it('mixin key 是确定性的', () => {
    const a = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    const b = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
    expect(a).toBe(b);
  });

  it('不同密钥产出不同 mixin key', () => {
    expect(mixinKey('aaa', 'bbb')).not.toBe(mixinKey('ccc', 'ddd'));
  });

  it('置换表长度是 64', () => {
    expect(MIXIN_KEY_ENC_TAB).toHaveLength(64);
  });

  it('extractKey 从 URL 里取出文件名', () => {
    expect(extractKey('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c',
    );
  });

  it('签名会加上 wts 与 w_rid', () => {
    const s = signParams({ keyword: 'test' }, mixinKey('a', 'b'));
    expect(s['wts']).toBeTruthy();
    expect(s['w_rid']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('签名对同样输入是稳定的（除 wts 外）', () => {
    const mk = mixinKey('a', 'b');
    const s1 = signParams({ keyword: 'test' }, mk);
    const s2 = signParams({ keyword: 'test' }, mk);
    expect(s1['w_rid']).toBe(s2['w_rid']);
  });

  it('参数不同则签名不同', () => {
    const mk = mixinKey('a', 'b');
    expect(signParams({ keyword: 'a' }, mk)['w_rid'])
      .not.toBe(signParams({ keyword: 'b' }, mk)['w_rid']);
  });

  it('剔除 !() 字符', () => {
    const mk = mixinKey('a', 'b');
    const s = signParams({ title: "a!b'c(d)e*f" }, mk);
    expect(s['title']).not.toContain('!');
    expect(s['title']).not.toContain('(');
    expect(s['title']).not.toContain('*');
  });

  it('encodeQuery 用 %20 而不是 +', () => {
    expect(encodeQuery({ keyword: 'a b' })).toContain('%20');
    expect(encodeQuery({ keyword: 'a b' })).not.toContain('+');
  });

  it('encodeQuery 正确转义中文', () => {
    expect(encodeQuery({ keyword: '测试' })).toBe('keyword=%E6%B5%8B%E8%AF%95');
  });
});

describe('MD5 实现', () => {
  it('空串', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
  it('abc', () => {
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });
  it('a', () => {
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
  });
  it('中文', () => {
    expect(md5('中文')).toHaveLength(32);
  });
  it('长字符串', () => {
    expect(md5('a'.repeat(1000))).toHaveLength(32);
  });

  /**
   * 回归防护：曾经的 bug 是手写位运算提字（`bytes[j] | (bytes[j+1] << 8) | ...`），
   * JS 的 `<<` 是有符号 32 位运算，0x80 << 24 溢出成负数。
   * 症状极其隐蔽：**只有全零输入正确**（空串能过），任何含非零字节的输入全错。
   * 所以必须有一个非零输入的向量盯着。
   */
  it('非零输入不与全零结果相同', () => {
    expect(md5('a')).not.toBe(md5('b'));
    expect(md5('a')).not.toBe(md5('aa'));
  });
});
