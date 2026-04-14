/**
 * attend-handler.ts — 主 Agent Attend Handler (Phase 4-5)
 *
 * 从 main.ts 提取的 LLM 决策逻辑：
 * - Phase 4: 构建 GroupContextPackage (Cosine Decay → 上下文深度 → 消息原文/FastPath 历史)
 * - Phase 5: 主 Agent LLM 决策 (系统 prompt + 上下文注入 + JSON 解析 + 算法 fallback)
 *
 * 参考设计：subagent.md §12.2 ➋➌➍
 */

import type { AttentionQueueEntry, AttendResult, MiniCodeActCall } from "../subagent/types.js";
import { executeMiniCodeActs } from "./minicodeact-executor.js";
import { formatMiniCodeActReport } from "./minicodeact-formatter.js";
import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { DynamicAttentionQueue } from "../subagent/attention-queue.js";
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
import { getRawId, getGroupModelKey } from "../core/chat-id.js";
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
    /** 所有平台 adapter（用于平台无关的媒体下载） */
    adapters?: PlatformAdapter[];
    /** 共享的媒体下载管理器 */
    mediaDownloader?: MediaDownloader;
    /** 注意力队列（MiniCodeAct 依赖） */
    attentionQueue?: DynamicAttentionQueue;
}

/**
 * 创建 attend handler 工厂函数
 *
 * 返回可直接传给 MainAgentLoop.setAttendHandler() 的函数。
 */
export function createAttendHandler(
    deps: AttendHandlerDeps,
): (entry: AttentionQueueEntry) => Promise<AttendResult | null> {
    const { memory, globalState, subagentManager, mainLoop, sotaConfigs, adapters: adapterList, mediaDownloader, attentionQueue } = deps;

    // 构建下载函数（用于 vision 处理 sticker/photo）
    // 从 adapters 数组中按 chatId 平台路由到对应 adapter 的 downloadMedia
    const buildDownloadFn = (chatId: string) => {
        if (!adapterList?.length) return undefined;
        const adapter = adapterList.find(a => chatId.startsWith(a.platform + ":"));
        if (!adapter) return undefined;
        return async (fileId: string, _chatId?: string, _messageId?: string, _uniqueFileId?: string): Promise<Buffer> => {
            const result = await adapter.handleCall(`${adapter.platform}.downloadMedia`, [fileId, _chatId, _messageId, _uniqueFileId]) as { buffer: string; size: number };
            return Buffer.from(result.buffer, "base64");
        };
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
        );

        // 获取群组画像和最近 callbacks（L1+ 深度可见）
        const groupModel = memory.getGroupModel(getGroupModelKey(entry.chatId)) ?? undefined;

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

        // 收集活跃参与者画像（含 aliases + mention），用于 Attend 决策上下文
        const chatAdapter = adapterList?.find(a => entry.chatId.startsWith(a.platform + ":"));
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
                    const rawId = getRawId(uid);
                    const username = identity?.username ?? undefined;
                    const mention = chatAdapter?.formatMention(rawId, username);
                    activePersons.push({
                        userId: rawId,
                        username,
                        mention,
                        displayName: name,
                        recentMessageCount: count,
                        ...(profile ? { dunbarTier: profile.dunbarTier, relationToAgent: profile.relationToAgent } : {}),
                        ...(identity?.aliases?.length ? { aliases: identity.aliases } : {}),
                    } as any);
                } catch { /* 非关键路径 */ }
            }
        }

        // 预解析话题参与者的 composite ID → display name（供 ATTENTION prompt 展示）
        const resolvedTopicDigests = entry.topicDigests.map(d => ({
            ...d,
            participants: d.participants.map(id => {
                try {
                    const identity = memory.getPersonIdentity(id);
                    return identity?.displayName ?? id;
                } catch { return id; }
            }),
        }));

        const contextPkg = buildGroupContext({
            chatId: entry.chatId,
            depth,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: resolvedTopicDigests,
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
                    // 使用 vision tier LLM 进行媒体富化，而非 attend LLM
                    const enrichLlmConfig = visionLlmConfig ?? sotaConfigs[0];

                    const downloadFn = buildDownloadFn(entry.chatId);

                    const { formattedText } = await enrichMessages(rawMessages, {
                        visionConfig,
                        llmConfig: enrichLlmConfig,
                        visionLlmConfig,
                        downloadFn,
                        stickerCache: memory,
                        chatId: entry.chatId,
                        mediaDownloader,
                        mediaTypes: ["sticker"], // 仅处理 sticker
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

            // ➌ Attend 上下文注入（动态内容全部注入 user message，确保 system prompt 可缓存）
            // 备注 #9: recentDecisions 和 activeTasks 保留完整 composite chatId，让主 Agent 能区分平台来源
            const recentDecisions = globalState.getRecentDecisions().slice(-5)
                .map(d => `- [${d.chatId}] ${d.decision}`).join("\n") || "（无）";
            const activeTasks = globalState.getTaskList()
                .filter(t => t.status !== "DONE" && t.status !== "CANCELLED")
                .map(t => `- [${t.priority}][${t.status}] ${t.description}${t.chatId ? ` (群:${t.chatId})` : ""}`)
                .join("\n") || "（无待办任务）";

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
                messages: messagesText || undefined,
                dispatchedTopicIds: [...subagent.getDispatchedTopicIds()],
                // 从 system prompt 迁移过来的动态字段
                attentionSummary: globalState.getAttentionSummary() || "（无）",
                recentDecisions,
                activeTasks,
            });

            // ═══ 笔记注入 (MiniCodeAct notes) ═══
            globalState.cleanExpiredNotes();
            const chatNotes = globalState.getNotes(entry.chatId);
            if (chatNotes.length > 0) {
                promptVars.hasNotes = true;
                promptVars.notes = chatNotes
                    .map(n => `- [${n.id}] ${n.content} (${n.tags.join(", ")})`)
                    .join("\n");
            }

            // ═══ Scheduler 触发上下文注入 ═══
            if (entry.source === "SCHEDULER_TRIGGER" && entry.schedulerTriggers?.length) {
                promptVars.hasSchedulerTriggers = true;
                promptVars.schedulerTriggers = entry.schedulerTriggers
                    .map(t => `- [${t.type}] ${t.description}`)
                    .join("\n");
            }

            const attentionPrompt = renderPrompt("ATTENTION", promptVars);

            // ➋ 主 Agent 系统 Prompt — 纯静态，确保前缀缓存命中 (subagent.md §12.2 ➋)
            const mainSystemVars = buildMainSystemVariables(persona);
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
                fastPathAuth: parsed.fastPathAuth ? {
                    preauthorizedActions: parsed.fastPathAuth.preauthorizedActions ?? [],
                    blockedActions: parsed.fastPathAuth.blockedActions ?? [],
                    tonePreset: parsed.fastPathAuth.tonePreset ?? "礼貌得体",
                    maxRepliesBeforeReauth: parsed.fastPathAuth.maxRepliesBeforeReauth ?? 3,
                    expiresAt: parsed.fastPathAuth.expiresInMinutes
                        ? new Date(Date.now() + parsed.fastPathAuth.expiresInMinutes * 60_000).toISOString()
                        : new Date(Date.now() + 5 * 60_000).toISOString(),
                    maxReplyLength: parsed.fastPathAuth.maxReplyLength,
                    authorizedAt: new Date().toISOString(),
                    // 从 FAST_PATH_AUTH 决策的 contentDirection 提取任务描述
                    taskDescription: Array.isArray(parsed.decisions)
                        ? parsed.decisions.find((d: any) => d.action === "FAST_PATH_AUTH")?.contentDirection
                        : undefined,
                } : undefined,
                decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((d: any) => ({
                    action: d.action ?? "REPLY",
                    topicId: d.topicId || undefined,
                    targetMessageIds: Array.isArray(d.targetMessageIds) ? d.targetMessageIds : undefined,
                    contentDirection: d.contentDirection,
                    toneGuidance: d.toneGuidance,
                    suggestedEmojis: Array.isArray(d.suggestedEmojis) ? d.suggestedEmojis : undefined,
                    confidence: d.confidence ?? 0.5,
                    reason: d.reason ?? "",
                    miniCodeActs: Array.isArray(d.miniCodeActs) ? d.miniCodeActs : undefined,
                })) : [{ action: "OBSERVE", confidence: 0.3, reason: "LLM 返回格式异常" }],
                reasoning: parsed.reasoning ?? "",
            };

            // ═══ 追加本轮对话到历史（下轮 LLM 可见） ═══
            await mainLoop.appendToHistory({ role: "user", content: currentTurnPrompt });
            await mainLoop.appendToHistory({ role: "assistant", content: jsonContent });

            // ═══ Phase 5.5: MiniCodeAct 即时执行 ═══
            const allMiniCodeActs: MiniCodeActCall[] = [];
            for (const decision of llmResult.decisions) {
                if (decision.miniCodeActs?.length) {
                    allMiniCodeActs.push(...decision.miniCodeActs);
                }
            }

            if (allMiniCodeActs.length > 0) {
                const miniResults = executeMiniCodeActs(allMiniCodeActs, entry.chatId, {
                    globalState,
                    memory,
                    attentionQueue: attentionQueue as any,
                    subagentManager,
                });

                const reportPrompt = renderPrompt("MINI_CODE_ACT_REPORT", {
                    chatId: entry.chatId,
                    results: formatMiniCodeActReport(miniResults),
                    timestamp: new Date().toISOString(),
                });
                await mainLoop.appendToHistory({ role: "user", content: reportPrompt });

                for (const r of miniResults) {
                    globalState.recordDecision(entry.chatId,
                        `MINI_ACT: ${r.call} → ${r.success ? "OK" : "FAIL"} ${r.summary}`);
                }

                llmResult.miniCodeActResults = miniResults;
                log.info("MiniCodeAct 执行完成", {
                    chatId: entry.chatId,
                    count: miniResults.length,
                    successes: miniResults.filter(r => r.success).length,
                    failures: miniResults.filter(r => !r.success).length,
                });
            }

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

            // ═══ 已读标记（fire-and-forget）═══
            // 在 attend 完成后，将该聊天中出现在上下文里的消息标记为已读。
            // 各平台 adapter 自行决定是否支持；不支持的平台不实现 markAsRead 即可。
            if (adapterList?.length) {
                const adapter = adapterList.find(a => entry.chatId.startsWith(a.platform + ":"));
                if (adapter?.markAsRead) {
                    adapter.markAsRead(entry.chatId)
                        .catch(e => log.debug("已读标记失败（非关键）", { chatId: entry.chatId, error: String(e).slice(0, 100) }));
                }
            }

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
