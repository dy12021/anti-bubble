import { MSG, type MsgRequest, type MsgResponse } from '../shared/messages';
import type { ContentItem, LlmConfig, Mode, SettingsPatch, UserProfileInput } from '../shared/types';
import {
  getSettings, saveSettings, getProfile, clearProfile,
  getLlmConfig, saveLlmConfig, getWhitelist, addToWhitelist,
  getJson, setJson,
} from './storage';
import { STORAGE_KEYS } from '../shared/constants';
import { createLlmClient } from './llm/client';
import { ProfileService } from './profile-service';
import { PipelineService } from './pipeline-service';
import { WordlistService } from './pipeline/wordlist-service';
import type { VideoContext } from '../pipeline/types';

/**
 * service worker 的消息路由。
 *
 * 抽成独立模块是为了能在 Node 里直接测——chrome.runtime.onMessage
 * 在测试环境里不存在，路由逻辑本身却完全不需要它。
 */

/** 一条被屏蔽的记录，写给 popup 展示。 */
export interface BlockedEntry {
  itemId: string;
  action: string;
  reason: string;
  reasonCode: string;
  at: string;
  /** 被屏蔽内容的一行摘要 */
  excerpt: string;
}

const MAX_BLOCKED_LOG = 500;

async function appendBlockedLog(entries: BlockedEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const log = await getJson<BlockedEntry[]>(STORAGE_KEYS.blockedLog, []);
  await setJson(STORAGE_KEYS.blockedLog, [...entries, ...log].slice(0, MAX_BLOCKED_LOG));
}

/** 从配置里造 LLM 客户端。没配置就返回 null。 */
function makeClient(config: LlmConfig | null) {
  return config ? createLlmClient(config) : null;
}

export async function handleMessage(req: MsgRequest): Promise<MsgResponse> {
  const id = req.id;
  try {
    switch (req.type) {
      case MSG.GET_SETTINGS:
        return { id, ok: true, data: await getSettings() };

      case MSG.SET_SETTINGS: {
        const patch = (req.payload as { settings?: SettingsPatch })?.settings ?? {};
        return { id, ok: true, data: await saveSettings(patch) };
      }

      case MSG.GET_PROFILE:
        return { id, ok: true, data: await getProfile() };

      case MSG.CLEAR_PROFILE: {
        const cfg = await getLlmConfig();
        if (cfg) {
          const svc = new ProfileService(createLlmClient(cfg));
          await svc.clear();
        } else {
          await clearProfile();
        }
        return { id, ok: true, data: null };
      }

      case MSG.REFRESH_PROFILE: {
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM，无法归纳画像' };
        const client = createLlmClient(cfg);
        const svc = new ProfileService(client);
        const profile = await svc.refresh(client, { force: true });
        return { id, ok: true, data: profile };
      }

      case MSG.GET_LLM_CONFIG: {
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: true, data: null };
        // Key 脱敏：popup 只需知道「配没配」，不需知道明文
        return {
          id, ok: true,
          data: {
            provider: cfg.provider,
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            timeoutMs: cfg.timeoutMs,
            hasKey: true,
          },
        };
      }

      case MSG.SET_LLM_CONFIG: {
        const cfg = (req.payload as { config?: LlmConfig })?.config;
        if (!cfg) return { id, ok: false, error: '缺少 LLM 配置' };
        await saveLlmConfig(cfg);
        return { id, ok: true, data: { saved: true } };
      }

      case MSG.TEST_LLM: {
        const override = (req.payload as { config?: LlmConfig })?.config;
        const cfg = override ?? (await getLlmConfig());
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM' };
        const client = createLlmClient(cfg);
        const out = await client.complete('回复「ok」两个字即可。', { maxTokens: 16 });
        return { id, ok: true, data: { output: out } };
      }

      case MSG.SYNC_PROFILE_SAMPLES: {
        const samples =
          (req.payload as { samples?: UserProfileInput[] })?.samples ?? [];
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM，无法归纳画像' };
        const client = createLlmClient(cfg);
        const svc = new ProfileService(client);
        const total = await svc.addSamples(samples);
        const profile = await svc.refresh(client, { force: true });
        return { id, ok: true, data: { profile, sampleCount: total } };
      }

      case MSG.GET_WHITELIST:
        return { id, ok: true, data: await getWhitelist() };

      case MSG.REVOKE: {
        const itemId = (req.payload as { itemId?: string })?.itemId;
        if (!itemId) return { id, ok: false, error: '缺少 itemId' };
        await addToWhitelist(itemId);
        return { id, ok: true, data: { revoked: itemId } };
      }

      case MSG.GET_BLOCKED_LOG:
        return { id, ok: true, data: await getJson<BlockedEntry[]>(STORAGE_KEYS.blockedLog, []) };

      case MSG.RECORD_WATCH: {
        const p = req.payload as { item?: ContentItem; watchSeconds?: number } | undefined;
        if (!p?.item) return { id, ok: false, error: '缺少 item' };
        const cfg = await getLlmConfig();
        if (cfg) {
          const svc = new ProfileService(createLlmClient(cfg));
          await svc.record(p.item, p.watchSeconds ?? 0);
        }
        return { id, ok: true, data: { recorded: true } };
      }

      case MSG.GET_WORDLIST: {
        const p = req.payload as { video?: VideoContext; mode?: Mode } | undefined;
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM' };
        if (!p?.video) return { id, ok: false, error: '缺少视频上下文' };
        const client = createLlmClient(cfg);
        const svc = new WordlistService(client);
        const settings = await getSettings();
        const profile = await getProfile();
        const wordlist = await svc.get(p.video, profile, p.mode ?? settings.mode);
        return { id, ok: true, data: wordlist };
      }

      case MSG.JUDGE_ITEMS: {
        const p = req.payload as {
          items?: ContentItem[]; mode?: Mode; video?: VideoContext | null;
        } | undefined;
        const items = p?.items ?? [];
        if (items.length === 0) return { id, ok: true, data: { verdicts: [] } };

        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: true, data: { verdicts: [] } };

        const settings = await getSettings();
        const mode = p?.mode ?? settings.mode;
        const client = createLlmClient(cfg);

        // 视频上下文由 content script 通过页面桥取好后随 payload 传进来——
        // service worker 自己发不了 B 站请求（拿不到 SESSDATA）。
        const video = p?.video ?? null;

        const svc = new PipelineService(client);
        const verdicts = await svc.judge(items, {
          mode,
          video,
          threshold: settings.confidenceThreshold,
        });

        // 记屏蔽日志（供 popup 查看）
        const byId = new Map(items.map((it) => [it.id, it]));
        await appendBlockedLog(
          verdicts
            .filter((v) => v.action === 'fold' || v.action === 'hide' || v.action === 'mark')
            .map((v) => ({
              itemId: v.itemId,
              action: v.action,
              reason: v.reason,
              reasonCode: v.reasonCode,
              at: new Date().toISOString(),
              excerpt: (byId.get(v.itemId)?.text ?? '').slice(0, 80),
            })),
        );

        return { id, ok: true, data: { verdicts } };
      }

      default:
        return { id, ok: false, error: `未知的消息类型：${String(req.type)}` };
    }
  } catch (e) {
    return { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
