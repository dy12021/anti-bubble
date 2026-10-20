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
    handleMessage(msg)
      .then(sendResponse)
      .catch((e: unknown) =>
        sendResponse({
          id: msg.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    return true; // 保持消息通道开放，等异步结果
  },
);
