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
  it('折叠后内容不可见', () => {
    const d = fixture();
    applyFold(d, '111', verdict, () => {});
    const el = d.querySelector('.reply-item') as HTMLElement;
    expect(el.style.display).toBe('none');
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

  it('找不到目标返回 false', () => {
    const d = fixture();
    expect(applyFold(d, '999', verdict, () => {})).toBe(false);
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
    const el = d.querySelector('.reply-item') as HTMLElement;
    expect(el.style.display).not.toBe('none');
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
    expect(ok).toBe(true);
    const card = d.querySelector('.bili-video-card') as HTMLElement;
    expect(card.style.display).toBe('none');
    expect(d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-notice"]`)?.textContent).toContain('在引战');
  });

  it('视频卡片被折叠后也能撤销', () => {
    const d = videoCardFixture();
    const onRevoke = vi.fn();
    applyFold(d, 'BV1xx411c7mD', { ...verdict, itemId: 'BV1xx411c7mD' }, onRevoke);
    const btn = d.querySelector(`[data-ab-prefix="${CSS_PREFIX}-revoke"]`) as HTMLElement;
    btn.click();
    expect(onRevoke).toHaveBeenCalledWith('BV1xx411c7mD');
    expect((d.querySelector('.bili-video-card') as HTMLElement).style.display).not.toBe('none');
  });

  it('非法 id 不会拼进选择器，直接返回 false', () => {
    const d = fixture();
    expect(applyFold(d, 'a"]b', verdict, () => {})).toBe(false);
  });

  it('root 传元素（而不是 document）也能工作', () => {
    const d = fixture();
    const body = d.body as HTMLElement;
    expect(applyFold(body, '111', verdict, () => {})).toBe(true);
    expect((d.querySelector('.reply-item') as HTMLElement).style.display).toBe('none');
  });
});
