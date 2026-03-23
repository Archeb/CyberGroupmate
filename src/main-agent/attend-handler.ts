/**
 * attend-handler.ts — 主 Agent Attend Handler (Phase 4-5)
 *
 * 从 main.ts 提取的 LLM 决策逻辑：
 * - Phase 4: 构建 GroupContextPackage (Cosine Decay → 上下文深度 → 消息原文/FastPath 历史)
 * - Phase 5: 主 Agent LLM 决策 (系统 prompt + 上下文注入 + JSON 解析 + 算法 fallback)
 *
 * 参考设计：subagent.md §12.2 ➋➌➍
 */

import type { AttentionQueueEntry, AttendResult } from "../subagent/types.js";
import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { FastPathHandler } from "../subagent/fast-path-handler.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { LLMConfig, AppConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import type { GlobalState } from "./global-state.js";
import type { MainAgentLoop } from "./main-agent-loop.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import { calculateDepth } from "./cosine-decay.js";
import { buildGroupContext } from "./context-builder.js";
import { renderPrompt, buildAttentionVariables, buildMainSystemVariables } from "./prompt-renderer.js";
import { callLLMWithFallback } from "../core/llm.js";
import { getRawId, getPlatform } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { formatTsForDisplay } from "../core/timezone.js";
import { enrichMessages, formatMessageLine, resolveReplyText, type RawMessage } from "../core/message-enricher.js";
import { loadConfig, resolveComponentProfiles } from "../core/config.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";

const log = createLogger("attend-handler");

/** 构建 OBSERVE 决策（LLM 失败时的兼底返回） */
function buildObserve(chatId: string): AttendResult {
    return {
        chatId,
        replyMode: "NONE",
        decisions: [{ action: "OBSERVE", confidence: 0, reason: "fallback" }],
        reasoning: "LLM unavailable",
    };
}

/** Attend handler 依赖 */
export interface AttendHandlerDeps {
    memory: MemoryStoreV2;
    globalState: GlobalState;
    subagentManager: SubagentManager;
    mainLoop: MainAgentLoop;
    /** SOTA tier 的 LLM 配置列表（按 fallback 顺序） */
    sotaConfigs: LLMConfig[];
    persona: { name: string; description: string };
    /** Telegram Adapter 引用（用于下载媒体进行 sticker 识别） */
    telegramAdapter?: { handleCall(method: string, args: unknown[]): Promise<unknown> };
    /** 所有平台 adapter（用于平台无关的媒体下载） */
    adapters?: PlatformAdapter[];
    /** 共享的媒体下载管理器 */
    mediaDownloader?: MediaDownloader;
}

/**
 * 创建 attend handler 工厂函数
 *
 * 返回可直接传给 MainAgentLoop.setAttendHandler() 的函数。
 */
export function createAttendHandler(
    deps: AttendHandlerDeps,
): (entry: AttentionQueueEntry) => Promise<AttendResult | null> {
    const { memory, globalState, subagentManager, mainLoop, sotaConfigs, telegramAdapter: tgAdapter, adapters: adapterList, mediaDownloader } = deps;

    // 构建下载函数（用于 vision 处理 sticker/photo）
    // 优先使用 adapters 数组中按 chatId 平台路由的 downloadMedia，
    // 兼容旧的 telegramAdapter 引用
    const buildDownloadFn = (chatId: string) => {
        // 尝试从 adapters 数组找到对应平台的 adapter
        if (adapterList?.length) {
            try {
                const platform = getPlatform(chatId);
                const adapter = adapterList.find(a => a.platform === platform);
                if (adapter?.downloadMedia) {
                    return async (fileId: string, _chatId?: string, _messageId?: string, _uniqueFileId?: string): Promise<Buffer> => {
                        if (adapter.platform === "telegram") {
                            // Telegram: use handleCall for downloadMedia (supports file reference refetch)
                            const result = await adapter.handleCall("telegram.downloadMedia", [fileId, _chatId, _messageId, _uniqueFileId]) as { buffer: string; size: number };
                            return Buffer.from(result.buffer, "base64");
                        }
                        // Other platforms: use downloadMedia directly
                        return adapter.downloadMedia!(null, fileId);
                    };
                }
            } catch { /* fallthrough to tgAdapter */ }
        }
        // Fallback: use legacy telegramAdapter
        if (tgAdapter) {
            return async (fileId: string, _chatId?: string, _messageId?: string, _uniqueFileId?: string): Promise<Buffer> => {
                const result = await tgAdapter.handleCall("telegram.downloadMedia", [fileId, _chatId, _messageId, _uniqueFileId]) as { buffer: string; size: number };
                return Buffer.from(result.buffer, "base64");
            };
        }
        return undefined;
    };

    return async (entry: AttentionQueueEntry): Promise<AttendResult | null> => {
        // 动态读取 persona（支持热重载）
        const persona = loadConfig().persona;
        const subagent = subagentManager.get(entry.chatId);
        if (!subagent) return buildObserve(entry.chatId);

        // ─── Phase 4: 构建上下文 ───

        let depth = calculateDepth(
            entry.attendCount,
            subagent.stickiness.depthCyclePeriod,
            entry.alert ? { forceMinDepth: 2 } : undefined,
        );

        // 获取群组画像和最近 callbacks（L1+ 深度可见）
        const groupModel = memory.getGroupModel(entry.chatId) ?? undefined;

        // 自动深度提升：当 topicDigests 和 groupModel 都为空时，
        // L0/L1 深度下 LLM 几乎没有可用信息来做决策，自动升级到 L2 以获取消息原文
        if (depth < 2 && entry.topicDigests.length === 0 && !groupModel) {
            log.info("深度自动提升: topicDigests 和 groupModel 均为空", { chatId: entry.chatId, from: `L${depth}`, to: "L2" });
            depth = 2 as import("./cosine-decay.js").ContextDepth;
        }

        // 所有深度都获取消息原文，数量随深度递增
        // L0: 10条  L1: 30条  L2: 50条  L3: 100条
        const messageLimit = depth >= 3 ? 100 : depth >= 2 ? 50 : depth >= 1 ? 30 : 10;
        const recentMessages = messageLimit > 0
            ? memory.getRecentMessages(entry.chatId, messageLimit).map(m => ({
                ...m,
                replyToMessageId: m.replyToMessageId ?? null,
            }))
            : undefined;

        // 收集活跃参与者画像（含 aliases），用于 Attend 决策上下文
        const activePersons: Array<{ userId: string; displayName: string; recentMessageCount: number }> = [];
        if (recentMessages?.length) {
            const senderCounts = new Map<string, { name: string; count: number }>();
            for (const m of recentMessages) {
                const uid = String((m as any).userId ?? (m as any).user_id ?? "");
                if (!uid) continue;
                const prev = senderCounts.get(uid) ?? { name: String((m as any).displayName ?? (m as any).display_name ?? uid), count: 0 };
                senderCounts.set(uid, { name: prev.name, count: prev.count + 1 });
            }
            for (const [uid, { name, count }] of senderCounts) {
                try {
                    const profiles = memory.getProfilesForChat(entry.chatId);
                    const profile = profiles.find(p => p.userId === uid);
                    const identity = memory.getPersonIdentity(uid);
                    activePersons.push({
                        userId: getRawId(uid),
                        displayName: name,
                        recentMessageCount: count,
                        ...(profile ? { dunbarTier: profile.dunbarTier, relationToAgent: profile.relationToAgent } : {}),
                        ...(identity?.aliases?.length ? { aliases: identity.aliases } : {}),
                    } as any);
                } catch { /* 非关键路径 */ }
            }
        }

        const contextPkg = buildGroupContext({
            chatId: entry.chatId,
            depth,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: entry.topicDigests,
            engagementScore: entry.priority,
            groupModel,
            lastCallbacks: subagent.lastCallbacks,
            messages: recentMessages,
            chatTitle: groupModel?.chatTitle,
            isDirectMessage: groupModel?.isDirectMessage,
            stickiness: subagent.stickiness,
            fastPathEnabled: !!(subagent.fastPathHandler as any)?.isAuthorized?.(),
            pendingCodeActTasks: (subagent.codeActExecutor as any)?.getQueueSize?.() ?? 0,
            activePersons,
        });

        // ─── Phase 5: LLM 决策 ───
        const suggestedReplyMode = "SINGLE"; // 简单提示，LLM 自行判断

        // ═══ Phase 5: LLM 决策路径 (subagent.md §12.2 ➋➌➍) ═══
        try {
            // 构建消息原文（所有深度均获取）+ Vision 富化 sticker/photo
            let messagesText = "";
            {
                const recentMsgs = memory.getRecentMessages(entry.chatId, messageLimit);
                recentMsgs.reverse(); // DESC→ASC: LLM 需要时间正序
                if (recentMsgs.length > 0) {
                    // 构建 messageId → displayName 映射，用于解析 replyTo 关系
                    const msgIdToName = new Map<string, string>();
                    for (const m of recentMsgs) {
                        msgIdToName.set(m.messageId, m.displayName || `(uid:${m.userId})`);
                    }

                    // 构建 RawMessage 列表
                    const rawMessages: RawMessage[] = await Promise.all(recentMsgs.map(
                        async (m: any) => {
                            const isInContext = m.replyToMessageId ? msgIdToName.has(m.replyToMessageId) : false;
                            let replyToText: string | undefined;
                            if (m.replyToMessageId && !isInContext) {
                                try {
                                    const origMsg = memory.getMessageById(entry.chatId, m.replyToMessageId);
                                    if (origMsg) {
                                        replyToText = await resolveReplyText(origMsg, { stickerCache: memory });
                                    }
                                } catch { /* 非关键路径 */ }
                            }
                            return {
                                id: m.messageId,
                                sender: m.displayName ?? `(uid:${m.userId})`,
                                text: m.text ?? "",
                                timestamp: m.timestamp,
                                replyTo: m.replyToMessageId
                                    ? (msgIdToName.get(m.replyToMessageId) ?? `msg#${m.replyToMessageId}`)
                                    : undefined,
                                replyToMsgId: m.replyToMessageId ?? undefined,
                                replyToText,
                                mediaType: m.mediaType,
                                mediaInfo: m.mediaInfo,
                                chatId: entry.chatId,
                            } as RawMessage;
                        }
                    ));

                    // 使用 enrichMessages 进行 Vision 富化（下载并分析 sticker/photo）
                    const currentConfig = loadConfig();
                    const visionConfig = currentConfig.vision;
                    const visionLlmConfig = currentConfig.llmRouting.vision
                        ? resolveComponentProfiles("vision", currentConfig)[0]
                        : undefined;
                    // 选择 attend LLM 配置作为主模型（检查 vision:true）
                    const primaryLlmConfig = sotaConfigs[0];

                    const downloadFn = buildDownloadFn(entry.chatId);

                    const { formattedText } = await enrichMessages(rawMessages, {
                        visionConfig,
                        llmConfig: primaryLlmConfig,
                        visionLlmConfig,
                        downloadFn,
                        stickerCache: memory,
                        chatId: entry.chatId,
                        mediaDownloader,
                    });
                    messagesText = formattedText;
                }
            }

            // 构建 FastPath 历史
            const fpHandler = subagent.fastPathHandler as FastPathHandler | null;
            const fpHistory = fpHandler?.getSentMessages()
                .map(m => `- [${formatTsForDisplay(m.timestamp)}] ${m.text}`)
                .join("\n") ?? "";

            // 计算时间差
            const timeSinceLastAttend = entry.lastAttendedAt
                ? `${Math.round((Date.now() - new Date(entry.lastAttendedAt).getTime()) / 60_000)}分钟`
                : "从未关注";

            // ➌ Attend 上下文注入 + ➍ Decision 输出格式
            const promptVars = buildAttentionVariables(contextPkg, entry.newMessageCount, {
                persona: `你是「${persona.name}」。${persona.description}`,
                lastAttendedAt: entry.lastAttendedAt,
                timeSinceLastAttend,
                stickinessLevel: entry.stickinessLevel,
                priorityMultiplier: subagent.stickiness.priorityMultiplier,
                tonePreset: subagent.stickiness.level === "CORE" ? "随意友好" :
                    subagent.stickiness.level === "FAMILIAR" ? "轻松" : "礼貌得体",
                callbacks: subagent.lastCallbacks.length > 0
                    ? subagent.lastCallbacks.slice(-3)
                    : undefined,
                fastPathHistory: fpHistory,
                alertReason: entry.alert?.reason,
                messages: messagesText || undefined,
                suggestedReplyMode,
                dispatchedTopicIds: [...subagent.getDispatchedTopicIds()],
            });

            const attentionPrompt = renderPrompt("ATTENTION", promptVars);
            const decisionPrompt = renderPrompt("DECISION", promptVars);

            // ➋ 主 Agent 系统 Prompt — 使用模板渲染 (subagent.md §12.2 ➋)
            const mainSystemVars = buildMainSystemVariables(persona, globalState, decisionPrompt);
            const mainSystemPrompt = renderPrompt("MAIN_SYSTEM", mainSystemVars);

            // ➝ 构建 messages: [system, ...历史对话, 当前轮 attend prompt]
            const currentTurnPrompt = `${attentionPrompt}`;
            const messages: ChatMessage[] = [
                { role: "system", content: mainSystemPrompt },
                ...(mainLoop.getConversationHistory() as ChatMessage[]),
                { role: "user", content: currentTurnPrompt },
            ];

            const llmResponse = await callLLMWithFallback(
                messages,
                sotaConfigs,
                {
                    caller: "attend-handler",
                    prefill: `让${persona.name}看看，`,
                },
            );

            // 解析 LLM 返回的 JSON（需兼容 prefill 前缀文本）
            const jsonContent = llmResponse.content.trim();
            // 先尝试 markdown 围栏，再尝试匹配第一个 JSON 对象
            const fenceMatch = jsonContent.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
            const jsonStr = fenceMatch?.[1]
                ?? jsonContent.match(/(\{[\s\S]*\})\s*$/)?.[1]
                ?? jsonContent;
            const parsed = JSON.parse(jsonStr);

            const llmResult: AttendResult = {
                chatId: entry.chatId,
                replyMode: parsed.replyMode ?? "NONE",
                decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((d: any) => ({
                    action: d.action ?? "REPLY",
                    topicId: d.topicId || undefined,
                    targetMessageIds: Array.isArray(d.targetMessageIds) ? d.targetMessageIds : undefined,
                    contentDirection: d.contentDirection,
                    toneGuidance: d.toneGuidance,
                    suggestedEmojis: Array.isArray(d.suggestedEmojis) ? d.suggestedEmojis : undefined,
                    confidence: d.confidence ?? 0.5,
                    reason: d.reason ?? "",
                })) : [{ action: "OBSERVE", confidence: 0.3, reason: "LLM 返回格式异常" }],
                reasoning: parsed.reasoning ?? "",
            };

            // ═══ 追加本轮对话到历史（下轮 LLM 可见） ═══
            await mainLoop.appendToHistory({ role: "user", content: currentTurnPrompt });
            await mainLoop.appendToHistory({ role: "assistant", content: jsonContent });

            globalState.recordDecision(entry.chatId,
                `LLM_DECISION: ${llmResult.replyMode} (${llmResult.decisions.length} decisions, engagement=${Math.round(entry.priority)}, depth=L${depth})`);
            log.info("LLM 决策完成", {
                chatId: entry.chatId,
                replyMode: llmResult.replyMode,
                decisions: llmResult.decisions.length,
                reasoning: llmResult.reasoning,
                decisionDetails: llmResult.decisions.map(d =>
                    `[${d.action}] ${d.contentDirection ?? d.reason ?? "(无方向)"} (topic=${d.topicId ?? "N/A"}, conf=${d.confidence})`
                ),
            });

            // LLM 成功 → 重置熔断器
            mainLoop.resetCircuitBreaker();

            return llmResult;

        } catch (err) {
            const errMsg = String(err);
            const isQuotaOrRateLimit = errMsg.includes("429") ||
                errMsg.includes("quota") ||
                errMsg.includes("RESOURCE_EXHAUSTED") ||
                errMsg.includes("rate limit") ||
                errMsg.includes("overloaded");

            if (isQuotaOrRateLimit) {
                // 所有 profile 都配额耗尽 → 熔断，不 fallback 到算法
                log.error("LLM 所有 profile 配额耗尽，触发熔断，返回 OBSERVE", {
                    chatId: entry.chatId,
                    error: errMsg.slice(0, 200),
                });
                mainLoop.tripCircuitBreaker(errMsg);
                globalState.recordDecision(entry.chatId,
                    `CIRCUIT_BREAKER: 配额耗尽 (error=${errMsg.slice(0, 100)})`);
                return buildObserve(entry.chatId);
            }

            // LLM 失败 → 返回 OBSERVE（不再算法 fallback）
            log.warn("LLM 决策失败，返回 OBSERVE", {
                chatId: entry.chatId,
                error: errMsg.slice(0, 200),
            });

            globalState.recordDecision(entry.chatId,
                `LLM_FAILED: OBSERVE (error=${errMsg.slice(0, 100)})`);
            return buildObserve(entry.chatId);
        }
    };
}
