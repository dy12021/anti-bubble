import { isRequest, type MsgResponse } from '../shared/messages';
import { handleMessage } from './router';

/**
 * service worker 入口。
 * 只做一件事：把 chrome.runtime.onMessage 接到路由。
 * MV3 的 service worker 会被 Chrome 随时挂起，所以不能有常驻状态。
 */

chrome.runtime.onMessage.addListener(
  (msg: unknown, _sender, sendResponse: (r: MsgResponse) => void) => {
    if (!isRequest(msg)) {
      sendResponse({ id: '', ok: false, error: '消息格式非法' });
      return false;
    }
    const type = msg.type;
    console.info(`[anti-bubble] 收到消息 ${type}`);
    handleMessage(msg)
      .then((r) => {
        console.info(`[anti-bubble] ${type} -> ok=${r.ok}${r.error ? ' err=' + r.error : ''}`);
        sendResponse(r);
      })
      .catch((e: unknown) => {
        const err = e instanceof Error ? e.message : String(e);
        console.error(`[anti-bubble] ${type} 异常：${err}`);
        sendResponse({ id: msg.id, ok: false, error: err });
      });
    return true; // 保持消息通道开放，等异步结果
  },
);
