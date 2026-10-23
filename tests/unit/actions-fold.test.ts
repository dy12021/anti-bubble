// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { applyFold, injectStyles, CSS_PREFIX } from '../../src/actions/fold';
import type { Verdict } from '../../src/shared/types';

function fixture(): Document {
  return new DOMParser().parseFromString(
    `<html><body>
      <div class="reply-item" data-rpid="111"><div class="reply-content">引战内容</div></div>
    </body></html>`, 'text/html',
  );
}

/** 搜索页形态：视频卡片没有 data-rpid，只有链接里的 bvid。 */
function videoCardFixture(): Document {
  return new DOMParser().parseFromString(
    `<html><body>
      <div class="bili-video-card">
        <a href="//www.bilibili.com/video/BV1xx411c7mD" class="bili-video-card__link--href">
          <div class="bili-video-card__info--tit"><h3 class="bili-video-card__info--tit">第一个视频标题</h3></div>
        </a>
        <div class="bili-video-card__info--author">UP主甲</div>
      </div>
    </body></html>`, 'text/html',
  );
}

const verdict: Verdict = {
  itemId: '111', action: 'fold', reason: '在引战',
  reasonCode: 'incitement', confidence: 0.9, revocable: true,
};

describe('折叠动作', () => {
  /**
   * 折叠是**就地替换**：卡片留在原位，内容换成「理由 + 仍要显示」。
   *
   * 早先把卡片 `display:none` 掉、再把说明插到它旁边——
   * 说明就变成了网格里的另一个单元，整排卡片被挤歪。
   */
  it('折叠后原内容不可见', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const content = d.querySelector('.reply-content') as HTMLElement;
    expect(content.style.display).toBe('none');
  });

  it('折叠后说明行在原位（不是插在旁边当新单元）', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const el = d.querySelector('.reply-item') as HTMLElement;
    const notice = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`);
    expect(notice?.parentElement).toBe(el);
  });

  it('插入一条说明行', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`)).not.toBeNull();
  });

  it('说明行里有理由', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const notice = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`);
    expect(notice?.textContent).toContain('在引战');
  });

  it('找不到目标返回 null', () => {
    const d = fixture();
    expect(applyFold(d, '999', verdict, () => {})).toBeNull();
  });

  it('点「仍要显示」会调用撤销回调', () => {
    const d = fixture();
    const onRevoke = vi.fn();
    applyFold(d, '111', verdict, onRevoke);
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    expect(onRevoke).toHaveBeenCalledWith('111');
  });

  it('撤销后内容恢复可见', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    const content = d.querySelector('.reply-content') as HTMLElement;
    expect(content.style.display).not.toBe('none');
  });

  it('撤销后说明行被移除', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`)).toBeNull();
  });

  it('注入样式不会重复插入', () => {
    const d = fixture();
    injectStyles(d);
    injectStyles(d);
    expect(d.querySelectorAll(`[data-ab-prefix="${CSS_PREFIX}-styles"]`)).toHaveLength(1);
  });

  it('重复折叠同一条不会插两条说明行', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    applyFold(d, '111', verdict, () => {});
    expect(d.querySelectorAll(`[data-ab-prefix="${CSS_PREFIX}-notice"]`)).toHaveLength(1);
  });

  it('视频卡片也能被折叠（靠链接里的 bvid 反查）', () => {
    const d = videoCardFixture();
    const ok = applyFold(d, 'BV1xx411c7mD', { ...verdict, itemId: 'BV1xx411c7mD' }, () => {});
    expect(ok).not.toBeNull();
    const card = d.querySelector('.bili-video-card') as HTMLElement;
    // 卡片留在原位，内容收起来，说明就地显示
    expect(card.style.display).not.toBe('none');
    const link = card.querySelector('a') as HTMLElement;
    expect(link.style.display).toBe('none');
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`)?.textContent).toContain('在引战');
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`)?.parentElement).toBe(card);
  });

  it('视频卡片被折叠后也能撤销', () => {
    const d = videoCardFixture();
    const onRevoke = vi.fn();
    applyFold(d, 'BV1xx411c7mD', { ...verdict, itemId: 'BV1xx411c7mD' }, onRevoke);
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    expect(onRevoke).toHaveBeenCalledWith('BV1xx411c7mD');
    const link = d.querySelector('.bili-video-card a') as HTMLElement;
    expect(link.style.display).not.toBe('none');
  });

  it('非法 id 不会拼进选择器，直接返回 null', () => {
    const d = fixture();
    expect(applyFold(d, 'a"]b', verdict, () => {})).toBeNull();
  });

  it('root 传元素（而不是 document）也能工作', () => {
    const d = fixture();
    const body = d.body as HTMLElement;
    expect(applyFold(body, '111', verdict, () => {})).not.toBeNull();
    expect((d.querySelector('.reply-content') as HTMLElement).style.display).toBe('none');
  });
});

/**
 * 「我喜欢这类」：撤销屏蔽时顺手把画像改了。
 *
 * 画像里的「不喜欢」是归纳出来的，**会错**——
 * 用户点「仍要显示」就是在说「这条其实我想看」，
 * 不修正画像的话，同题材的内容下次还会被折叠。
 */
describe('折叠说明条上的「我喜欢这类」', () => {
  const profileVerdict: Verdict = {
    itemId: '111', action: 'fold', reason: '命中你不喜欢的「游戏实况」',
    reasonCode: 'dislike_match', confidence: 0.9, revocable: true,
    matchedTag: '游戏实况',
  };

  it('命中画像的折叠才出现这个按钮', () => {
    const d = fixture();
    applyFold(d, '111', profileVerdict, () => {}, () => {});
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-like"]`)).not.toBeNull();
  });

  it('LLM 判的折叠不出现这个按钮（没有标签可改）', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {}, () => {});
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-like"]`)).toBeNull();
  });

  it('没给回调时不出现这个按钮', () => {
    const d = fixture();
    applyFold(d, '111', profileVerdict, () => {});
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-like"]`)).toBeNull();
  });

  it('点了会调用更新画像的回调，并恢复内容', () => {
    const d = fixture();
    const onUpdateProfile = vi.fn();
    applyFold(d, '111', profileVerdict, () => {}, onUpdateProfile);
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-like"]`) as HTMLElement;
    btn.click();
    expect(onUpdateProfile).toHaveBeenCalledWith('111');
    const content = d.querySelector('.reply-content') as HTMLElement;
    expect(content.style.display).not.toBe('none');
  });

  it('点「仍要显示」不会顺带更新画像', () => {
    const d = fixture();
    const onUpdateProfile = vi.fn();
    applyFold(d, '111', profileVerdict, () => {}, onUpdateProfile);
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    expect(onUpdateProfile).not.toHaveBeenCalled();
  });
});
