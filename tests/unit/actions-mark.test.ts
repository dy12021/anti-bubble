// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { applyMark } from '../../src/actions/mark';
import { renderRecommendations, resolveRecommendationAnchor, renderNoOpposition } from '../../src/actions/recommend';
import type { Verdict } from '../../src/shared/types';

function fixture(): Document {
  return new DOMParser().parseFromString(
    `<html><body>
      <div class="reply-item" data-rpid="111"><div class="reply-content">立场相反的评论</div></div>
      <div id="anchor"></div>
    </body></html>`, 'text/html',
  );
}

/** 搜索页形态：视频卡片没有 data-rpid。 */
function videoCardFixture(): Document {
  return new DOMParser().parseFromString(
    `<html><body>
      <div class="bili-video-card">
        <a href="//www.bilibili.com/video/BV1xx411c7mD" class="bili-video-card__link--href">
          <div class="bili-video-card__info--tit"><h3 class="bili-video-card__info--tit">视频标题</h3></div>
        </a>
      </div>
    </body></html>`, 'text/html',
  );
}

const v: Verdict = {
  itemId: '111', action: 'mark', reason: '与你的立场相反',
  reasonCode: 'stance_opposite', confidence: 0.8, revocable: false,
};

describe('标识动作', () => {
  it('给内容加标识', () => {
    const d = fixture();
    expect(applyMark(d, '111', v)).toBe(true);
    expect(d.querySelector('[data-ab-prefix="ab-mark"]')).not.toBeNull();
  });

  it('标识里含理由', () => {
    const d = fixture();
    applyMark(d, '111', v);
    expect(d.querySelector('[data-ab-prefix="ab-mark"]')?.textContent).toContain('与你的立场相反');
  });

  it('不隐藏内容（标识不等于删除）', () => {
    const d = fixture();
    applyMark(d, '111', v);
    const el = d.querySelector('.reply-item') as HTMLElement;
    expect(el.style.display).not.toBe('none');
  });

  it('找不到目标返回 false', () => {
    expect(applyMark(fixture(), '999', v)).toBe(false);
  });

  it('重复标识不会插两个', () => {
    const d = fixture();
    applyMark(d, '111', v);
    applyMark(d, '111', v);
    expect(d.querySelectorAll('[data-ab-prefix="ab-mark"]')).toHaveLength(1);
  });

  it('不同内容各自都能被标识', () => {
    const d = new DOMParser().parseFromString(
      `<html><body>
        <div class="reply-item" data-rpid="111"><div class="reply-content">甲</div></div>
        <div class="reply-item" data-rpid="222"><div class="reply-content">乙</div></div>
      </body></html>`, 'text/html',
    );
    expect(applyMark(d, '111', v)).toBe(true);
    expect(applyMark(d, '222', { ...v, itemId: '222' })).toBe(true);
    expect(d.querySelectorAll('[data-ab-prefix="ab-mark"]')).toHaveLength(2);
  });

  it('视频卡片的标识挂在标题上', () => {
    const d = videoCardFixture();
    expect(applyMark(d, 'BV1xx411c7mD', { ...v, itemId: 'BV1xx411c7mD' })).toBe(true);
    const mark = d.querySelector('[data-ab-prefix="ab-mark"]');
    expect(mark).not.toBeNull();
    expect(mark?.parentElement?.className).toContain('bili-video-card__info--tit');
  });

  /**
   * 铁律：折叠、隐藏、标识**都要可撤销**。
   * 立场判断是模型的判断，判错了用户得能自己摘掉这个标签。
   */
  it('点标识能撤销（去掉标签 + 回调写白名单）', () => {
    const d = fixture();
    const onRevoke = vi.fn();
    applyMark(d, '111', v, onRevoke);
    const mark = d.querySelector('[data-ab-prefix="ab-mark"]') as HTMLElement;
    expect(mark).not.toBeNull();

    mark.click();
    expect(d.querySelector('[data-ab-prefix="ab-mark"]')).toBeNull();
    expect(onRevoke).toHaveBeenCalledWith('111');
  });

  it('撤销不隐藏内容（标识本来就没隐藏）', () => {
    const d = fixture();
    applyMark(d, '111', v, () => {});
    (d.querySelector('[data-ab-prefix="ab-mark"]') as HTMLElement).click();
    const el = d.querySelector('.reply-item') as HTMLElement;
    expect(el.style.display).not.toBe('none');
  });

  it('标识可聚焦并支持键盘撤销', () => {
    const d = fixture();
    const onRevoke = vi.fn();
    applyMark(d, '111', v, onRevoke);
    const mark = d.querySelector('[data-ab-prefix="ab-mark"]') as HTMLElement;
    expect(mark.getAttribute('tabindex')).toBe('0');
    expect(mark.getAttribute('role')).toBe('button');
    mark.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onRevoke).toHaveBeenCalledWith('111');
  });

  it('没给撤销回调时点标识也不会炸', () => {
    const d = fixture();
    applyMark(d, '111', v);
    const mark = d.querySelector('[data-ab-prefix="ab-mark"]') as HTMLElement;
    expect(() => mark.click()).not.toThrow();
    expect(d.querySelector('[data-ab-prefix="ab-mark"]')).toBeNull();
  });
});

describe('推荐卡片', () => {
  it('渲染出推荐条目', () => {
    const d = fixture();
    const ok = renderRecommendations(d, d.querySelector('#anchor')!, [
      { bvid: 'BV1', title: '相反观点视频', author: 'UP', reason: '它主张相反的观点', url: 'https://b23.tv/BV1' },
    ]);
    expect(ok).toBe(true);
    expect(d.querySelectorAll('[data-ab-prefix="ab-recommend-item"]')).toHaveLength(1);
  });

  it('推荐里带「为什么」', () => {
    const d = fixture();
    renderRecommendations(d, d.querySelector('#anchor')!, [
      { bvid: 'BV1', title: 't', author: 'UP', reason: '它主张相反的观点', url: 'u' },
    ]);
    expect(d.body?.textContent).toContain('它主张相反的观点');
  });

  it('空数组不渲染', () => {
    const d = fixture();
    expect(renderRecommendations(d, d.querySelector('#anchor')!, [])).toBe(false);
    expect(d.querySelector('[data-ab-prefix="ab-recommend"]')).toBeNull();
  });

  it('链接指向对应 bvid', () => {
    const d = fixture();
    renderRecommendations(d, d.querySelector('#anchor')!, [
      { bvid: 'BV1xx', title: 't', author: 'UP', reason: 'r', url: 'https://www.bilibili.com/video/BV1xx' },
    ]);
    const a = d.querySelector('[data-ab-prefix="ab-recommend-item"] a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toContain('BV1xx');
  });

  it('是独立区块，不塞进原生推荐流里', () => {
    const d = fixture();
    renderRecommendations(d, d.querySelector('#anchor')!, [
      { bvid: 'BV1', title: 't', author: 'UP', reason: 'r', url: 'u' },
    ]);
    const box = d.querySelector('[data-ab-prefix="ab-recommend"]');
    expect(box?.className).toContain('ab-recommend');
    // 区块是 anchor 的兄弟节点，不是 anchor 的子节点
    expect(box?.parentElement).toBe(d.querySelector('#anchor')?.parentElement);
  });
});

/**
 * 反向推荐区块的插入位置。
 *
 * 回归防护：B 站视频页标题 h1 的父级 `.video-info-title-inner` 是 **flex 行**。
 * 早先版本把区块插成标题的兄弟节点 → 它成了第三个 flex item，
 * 被挤到右边、压在播放器上面，还把原布局挤歪。
 * 正确做法是插在**整个信息区下面**，成为整宽独立区块。
 */
describe('反向推荐区块的插入位置', () => {
  function videoPageDom(): Document {
    return new DOMParser().parseFromString(
      `<html><body>
        <div class="left-column">
          <div id="viewbox_report" class="video-info-container">
            <div class="video-info-title">
              <div class="video-info-title-inner">
                <h1 class="video-title">视频标题</h1>
                <div class="video-info-tags">标签</div>
              </div>
            </div>
            <div class="video-desc-container">简介</div>
          </div>
        </div>
      </body></html>`, 'text/html',
    );
  }

  it('优先挂在视频信息区（#viewbox_report）上', () => {
    const d = videoPageDom();
    expect(resolveRecommendationAnchor(d)?.id).toBe('viewbox_report');
  });

  it('不挂在标题的 flex 父级上', () => {
    const d = videoPageDom();
    const anchor = resolveRecommendationAnchor(d);
    expect(anchor?.className).not.toContain('video-info-title-inner');
  });

  it('没有信息区时退回标题容器', () => {
    const d = new DOMParser().parseFromString(
      `<html><body>
        <div class="video-info-title"><h1 class="video-title">t</h1></div>
      </body></html>`, 'text/html',
    );
    expect(resolveRecommendationAnchor(d)?.className).toContain('video-info-title');
  });

  it('什么都没有时返回 null', () => {
    const d = new DOMParser().parseFromString('<html><body></body></html>', 'text/html');
    expect(resolveRecommendationAnchor(d)).toBeNull();
  });

  it('用这个锚点渲染，区块落在信息区之后', () => {
    const d = videoPageDom();
    const anchor = resolveRecommendationAnchor(d)!;
    renderRecommendations(d, anchor, [
      { bvid: 'BV1', title: '相反观点视频', author: 'UP', reason: '它主张相反的观点', url: 'u' },
    ]);
    const box = d.querySelector('[data-ab-prefix="ab-recommend"]');
    expect(box?.parentElement).toBe(d.querySelector('.left-column'));
    // 不在 flex 行里
    expect(box?.parentElement?.className).not.toContain('video-info-title-inner');
  });

  it('没找到相反观点时给一句说明（别让用户以为插件坏了）', () => {
    const d = videoPageDom();
    const anchor = resolveRecommendationAnchor(d)!;
    renderNoOpposition(d, anchor);
    const note = d.querySelector('[data-ab-prefix="ab-recommend-empty"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain('没找到');
    expect(note?.parentElement).toBe(d.querySelector('.left-column'));
  });
});
