import { MSG, type MsgRequest, type MsgResponse, type RevokePayload } from '../shared/messages';
import type { ContentItem, LlmConfig, Mode, SettingsPatch, UserProfileInput, CollectReport, UserProfile } from '../shared/types';
import {
  getSettings, saveSettings, getProfile, saveProfile, clearProfile,
  getLlmConfig, saveLlmConfig, getWhitelist, addToWhitelist,
  getJson, setJson, getLastError,
  getProfileOverrides, saveProfileOverrides,
} from './storage';
import { STORAGE_KEYS, DEFAULT_JUDGE_LEVEL } from '../shared/constants';
import { createLlmClient } from './llm/client';
import { ProfileService } from './profile-service';
import { PipelineService } from './pipeline-service';
import { applyProfileFeedback, recordProfileOverride } from '../profile/feedback';
import { WordlistService } from '../pipeline/wordlist-service';
import { judgeOpposition } from '../recommend/opposition';
import type { SearchItem } from '../bili/types';
import type { Subject, VideoContext } from '../pipeline/types';
import { videoSubject } from '../pipeline/subject';

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

      case MSG.GET_PROFILE_OVERRIDES:
        return { id, ok: true, data: await getProfileOverrides() };

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
            ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}),
            ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
          },
        };
      }

      case MSG.SET_LLM_CONFIG: {
        const cfg = (req.payload as { config?: LlmConfig })?.config;
        if (!cfg) return { id, ok: false, error: '缺少 LLM 配置' };
        // Key 不回显给 popup（安全），所以用户改别的字段时 Key 框是空的。
        // 空 Key 表示「沿用已存的」，而不是「把 Key 清空」。
        let apiKey = cfg.apiKey;
        if (!apiKey) {
          const prev = await getLlmConfig();
          apiKey = prev?.apiKey ?? '';
        }
        if (!apiKey) {
          return { id, ok: false, error: '请填写 API Key（留空表示沿用已保存的 Key）' };
        }
        await saveLlmConfig({ ...cfg, apiKey });
        return { id, ok: true, data: { saved: true } };
      }

      case MSG.TEST_LLM: {
        const override = (req.payload as { config?: LlmConfig })?.config;
        const cfg = override ?? (await getLlmConfig());
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM' };
        const client = createLlmClient(cfg);
        // 预算不能给太小：推理模型会先思考，思考和答案共用预算，
        // 给小了会拿到空 content，然后报一个用户看不懂的「格式异常」。
        const out = await client.complete('回复「ok」两个字即可。');
        return { id, ok: true, data: { output: out } };
      }

      case MSG.SYNC_PROFILE_SAMPLES: {
        const p = req.payload as {
          samples?: UserProfileInput[];
          report?: CollectReport;
        } | undefined;
        // **采集报告要落库**：面板上要能看出「哪个来源没通」，
        // 否则用户只看到「样本 0 条」，完全不知道是接口坏了还是没登录。
        if (p?.report) {
          await setJson(STORAGE_KEYS.collectReport, p.report);
        }
        const samples = p?.samples ?? [];
        if (samples.length === 0) {
          // 没采到样本：只记报告，不去问 LLM 要一个空画像。
          return { id, ok: true, data: { profile: await getProfile(), sampleCount: 0 } };
        }
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM，无法归纳画像' };
        const client = createLlmClient(cfg);
        const svc = new ProfileService(client);
        const total = await svc.addSamples(samples);
        const profile = await svc.refresh(client, { force: true });
        return { id, ok: true, data: { profile, sampleCount: total } };
      }

      case MSG.GET_COLLECT_REPORT:
        return {
          id, ok: true,
          data: await getJson<CollectReport | null>(STORAGE_KEYS.collectReport, null),
        };

      case MSG.GET_RECOMMENDATIONS: {
        // 候选视频由 content script 在页面上下文搜好后传进来——
        // 后台发不了 B 站搜索请求（拿不到 cookie），只负责 LLM 立场判定。
        const p = req.payload as {
          video?: VideoContext | null;
          candidates?: SearchItem[];
        } | undefined;
        const candidates = p?.candidates ?? [];
        if (candidates.length === 0) return { id, ok: true, data: { items: [] } };

        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM' };

        const client = createLlmClient(cfg);
        const settings = await getSettings();
        const profile = await getProfile();

        // 立场摘要从词表缓存里取（词表已经生成过，不额外花钱）
        let stance = '';
        if (p?.video) {
          const svc = new WordlistService(client);
          const wl = await svc.get(videoSubject(p.video), profile, settings.mode);
          stance = wl.stance;
        }

        const items = await judgeOpposition(
          client,
          { title: p?.video?.title ?? '', stance },
          candidates,
        );
        return { id, ok: true, data: { items } };
      }

      case MSG.GET_WHITELIST:
        return { id, ok: true, data: await getWhitelist() };

      case MSG.GET_LAST_ERROR:
        return { id, ok: true, data: await getLastError() };

      case MSG.REVOKE: {
        const p = req.payload as RevokePayload | undefined;
        const itemId = p?.itemId;
        if (!itemId) return { id, ok: false, error: '缺少 itemId' };
        await addToWhitelist(itemId);

        // 顺手更新画像：用户点「我喜欢这类」= 「这条其实想看」。
        // 画像里的「不喜欢」是归纳出来的，会错；不修正的话同题材还会被折叠。
        let profile: UserProfile | null = null;
        if (p?.updateProfile) {
          const feedback = {
            matchedTag: p.matchedTag,
            text: p.text,
            kind: p.kind,
          };
          const cur = await getProfile();
          if (cur) {
            profile = applyProfileFeedback(cur, feedback);
            await saveProfile(profile);
          }
          // **纠正要单独记一份**：画像每 24 小时会被自动归纳重算，
          // 用户的显式纠正不能被顶掉（详见 ProfileOverrides 的说明）。
          const overrides = await getProfileOverrides();
          const next = recordProfileOverride(overrides, feedback);
          await saveProfileOverrides(next);
        }

        return {
          id, ok: true,
          data: { revoked: itemId, profileUpdated: profile !== null, profile },
        };
      }

      case MSG.GET_BLOCKED_LOG:
        return { id, ok: true, data: await getJson<BlockedEntry[]>(STORAGE_KEYS.blockedLog, []) };

      case MSG.CLEAR_BLOCKED_LOG:
        await setJson(STORAGE_KEYS.blockedLog, []);
        return { id, ok: true, data: { cleared: true } };

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
        const p = req.payload as { subject?: Subject; mode?: Mode } | undefined;
        const cfg = await getLlmConfig();
        if (!cfg) return { id, ok: false, error: '尚未配置 LLM' };
        if (!p?.subject) return { id, ok: false, error: '缺少判定语境' };
        const client = createLlmClient(cfg);
        const svc = new WordlistService(client);
        const settings = await getSettings();
        const profile = await getProfile();
        const wordlist = await svc.get(p.subject, profile, p.mode ?? settings.mode);
        return { id, ok: true, data: wordlist };
      }

      case MSG.JUDGE_ITEMS: {
        const p = req.payload as {
          items?: ContentItem[]; mode?: Mode; subject?: Subject | null;
        } | undefined;
        const items = p?.items ?? [];
        if (items.length === 0) return { id, ok: true, data: { verdicts: [] } };

        const settings = await getSettings();
        const mode = p?.mode ?? settings.mode;
        // 判定档位：全部 LLM / 关键词初筛 / 仅关键词。
        // 「仅关键词」档**不需要 LLM**——没配 Key 也能用。
        const judgeLevel = settings.judgeLevel ?? DEFAULT_JUDGE_LEVEL;

        const cfg = await getLlmConfig();
        const client = cfg ? createLlmClient(cfg) : null;
        if (!client && judgeLevel !== 'keyword') {
          // 没配 LLM 又不是「仅关键词」档 → 判不了，全部放行。
          return { id, ok: true, data: { verdicts: [] } };
        }

        // 判定语境由 content script 传进来——
        // service worker 自己发不了 B 站请求（拿不到 SESSDATA），
        // 所以「当前视频」和「列表页这批内容」都只能由页面侧取好再传。
        //
        // **语境是判定的根**：没有它就没有动态词表，规则粗筛永不命中，
        // 内容会全部原样放行（看起来就是「插件没反应」）。
        const subject = p?.subject ?? null;
        console.info(
          `[anti-bubble] JUDGE_ITEMS 收到 ${items.length} 条，档位=${judgeLevel}，语境=${
            subject
              ? subject.kind === 'video'
                ? `视频(bvid=${subject.video.bvid},aid=${subject.video.aid ?? '-'},title=${String(subject.video.title).slice(0, 20)})`
                : `列表(${subject.list.title},样本 ${subject.list.samples.length} 条)`
              : 'null'
          }`,
        );

        const svc = new PipelineService(client);
        const verdicts = await svc.judge(items, {
          mode,
          subject,
          threshold: settings.confidenceThreshold,
          judgeLevel,
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
