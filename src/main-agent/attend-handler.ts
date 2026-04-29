/**
 * attend-handler.ts — 主 Agent Attend Handler (Phase 4-5)
 *
 * 从 main.ts 提取的 LLM 决策逻辑：
 * - Phase 4: 构建 GroupContextPackage (Cosine Decay → 上下文深度 → 消息原文)
 * - Phase 5: 主 Agent LLM 决策 (系统 prompt + 上下文注入 + JSON 解析 + 算法 fallback)
 *
 * 参考设计：subagent.md §12.2 ➋➌➍
 */

import type { AttentionQueueEntry, AttendResult } from "../subagent/types.js";
import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { AppConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import type { GlobalState } from "./global-state.js";
import type { MainAgentLoop } from "./main-agent-loop.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import type { ImageCatalog } from "../core/image-catalog.js";
import { calculateDepth } from "./cosine-decay.js";
import { buildGroupContext } from "./context-builder.js";
import { renderPrompt, buildMainSystemVariables } from "../context-engine/template-engine.js";
import { callLLMWithFallback } from "../core/llm.js";
import { getRawId, getGroupModelKey } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { enrichMessages, formatMessageLine, resolveReplyText, type RawMessage } from "../core/message-enricher.js";
import { loadConfig, resolveComponentProfiles } from "../core/config.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";
import { generateModuleRoster } from "../sandbox/modules/module-registry.js";
import { runParallelGrounding } from "./grounding-util.js";
import { deriveChatType } from "../context-engine/prompt-renderer-utils.js";
import type { ResolveContext } from "../context-engine/types.js";

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

/**
 * 构建精简的历史 attend 记录（仅标题 + 增量消息）。
 *
 * @deprecated 由 ContextEngine 的 history 策略替代。
 * 保留作为向后兼容引用，不再被主流程调用。
 */
function buildHistoricalAttendEntry(
    chatId: string,
    chatTitle: string | undefined,
    depth: number,
    rawMessages: RawMessage[],
    mainLoop: MainAgentLoop,
): string {
    const header = `═══ Attend: ${chatTitle ?? chatId} (${getRawId(chatId)}) [L${depth}] ═══`;
    if (rawMessages.length === 0) return `${header}\n(无消息)`;
    const lastStoredId = mainLoop.getLastStoredMsgId(chatId);
    let deltaStartIdx = 0;
    if (lastStoredId) {
        const lastIdx = rawMessages.findIndex(m => m.id === lastStoredId);
        if (lastIdx >= 0) deltaStartIdx = lastIdx + 1;
    }
    const deltaMessages = rawMessages.slice(deltaStartIdx);
    const newestMsg = rawMessages[rawMessages.length - 1];
    if (newestMsg?.id) mainLoop.setLastStoredMsgId(chatId, newestMsg.id);
    if (deltaMessages.length === 0) return `${header}\n(无新消息)`;
    const deltaText = deltaMessages.map(m => formatMessageLine(m, { includeMediaTags: true })).join("\n");
    const deltaNote = deltaStartIdx > 0
        ? `(增量: ${deltaMessages.length} 条新消息，前 ${deltaStartIdx} 条已在历史中)`
        : `(${deltaMessages.length} 条消息)`;
    return `${header}\n${deltaNote}\n${deltaText}`;
}

/** Attend handler 依赖 */
export interface AttendHandlerDeps {
    memory: MemoryStoreV2;
    globalState: GlobalState;
    subagentManager: SubagentManager;
    mainLoop: MainAgentLoop;
    persona: { name: string; description: string };
    /** 所有平台 adapter（用于平台无关的媒体下载） */
    adapters?: PlatformAdapter[];
    /** 共享的媒体下载管理器 */
    mediaDownloader?: MediaDownloader;
    /** 图片目录（用于表情包频率追踪） */
    imageCatalog?: ImageCatalog;

}

/**
 * 创建 attend handler 工厂函数
 *
 * 返回可直接传给 MainAgentLoop.setAttendHandler() 的函数。
 */
export function createAttendHandler(
    deps: AttendHandlerDeps,
): (entry: AttentionQueueEntry) => Promise<AttendResult | null> {
    const { memory, globalState, subagentManager, mainLoop, adapters: adapterList, mediaDownloader, imageCatalog } = deps;

    // 构建下载函数（用于 vision 处理 sticker/photo）
    // 从 adapters 数组中按 chatId 平台路由到对应 adapter 的 downloadMedia
    const buildDownloadFn = (chatId: string) => {
        if (!adapterList?.length) return undefined;
        const adapter = adapterList.find(a => chatId.startsWith(a.platform + ":"));
        if (!adapter) return undefined;
        return async (fileId: string, _chatId?: string, _messageId?: string, _uniqueFileId?: string): Promise<Buffer> => {
            const result = await adapter.handleCall(`${adapter.platform}.downloadMedia`, [fileId]);
            if (Buffer.isBuffer(result)) return result;
            if (result && typeof result === "object" && "buffer" in result) {
                return Buffer.from((result as { buffer: string }).buffer, "base64");
            }
            throw new Error(`downloadMedia: unexpected result type: ${typeof result}`);
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
        const activeUserProfiles = [] as NonNullable<ReturnType<typeof buildGroupContext>["activeUserProfiles"]>;
        if (recentMessages?.length) {
            const senderCounts = new Map<string, { name: string; count: number }>();
            for (const m of recentMessages) {
                const uid = String((m as any).userId ?? (m as any).user_id ?? "");
                if (!uid) continue;
                const prev = senderCounts.get(uid) ?? { name: String((m as any).displayName ?? (m as any).display_name ?? uid), count: 0 };
                senderCounts.set(uid, { name: prev.name, count: prev.count + 1 });
            }
            const profiles = memory.getProfilesForChat(entry.chatId);
            const profileLimit = depth === 0 ? 2 : Number.POSITIVE_INFINITY;
            let profileIndex = 0;
            for (const [uid, { name, count }] of senderCounts) {
                try {
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
                    if (profileIndex < profileLimit) {
                        activeUserProfiles.push({
                            userId: rawId,
                            username,
                            mention,
                            displayName: identity?.displayName ?? name,
                            aliases: identity?.aliases ?? [],
                            dunbarTier: profile?.dunbarTier,
                            rapport: typeof profile?.affinityScore === "number" ? Math.round(profile.affinityScore) : undefined,
                            traits: profile?.traits ?? [],
                            communicationStyle: profile?.communicationStyle,
                            relationToAgent: profile?.relationToAgent,
                            messageCount: count,
                        });
                        profileIndex += 1;
                    }
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
            associatedMemories: (() => {
                if (depth === 0) return undefined;
                const topic = memory.getTopicById(d.topicId);
                if (!topic?.associatedMemories?.length) return undefined;
                if (depth === 1 && (topic.callbackPotential ?? 0) <= 70) return undefined;
                return topic.associatedMemories;
            })(),
            callbackPotential: memory.getTopicById(d.topicId)?.callbackPotential ?? 0,
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
            pendingCodeActTasks: (subagent.codeActExecutor as any)?.getQueueSize?.() ?? 0,
            activePersons,
            activeUserProfiles,
        });

        // ═══ Phase 5: LLM 决策路径 (subagent.md §12.2 ➋➌➍) ═══
        try {
            const currentConfig = loadConfig();
            const attendProfiles = resolveComponentProfiles("attend", currentConfig);
            // 只有显式声明 vision:true 的 attend profile 才能接收图片。
            const attendSupportsVision = attendProfiles.some(p => p.vision === true);
            // attend 媒体策略：vision=看图，describe=仅文字描述，disable=禁用媒体富化（默认）。
            const attendVisionMode = currentConfig.vision?.attendMode ?? "disable";
            const effectiveAttendVisionMode = attendVisionMode === "vision" && !attendSupportsVision
                ? "describe"
                : attendVisionMode;
            if (attendVisionMode === "vision" && !attendSupportsVision) {
                log.warn("attend_mode=vision 但 attend profile 未启用 vision，降级为 describe", {
                    chatId: entry.chatId,
                });
            }

            // 构建消息原文（所有深度均获取）+ Vision 富化 sticker/photo
            let messagesText = "";
            let rawMessagesForHistory: RawMessage[] = [];
            const imageParts: Array<{ url: string }> = [];
            {
                let recentMsgs = memory.getRecentMessages(entry.chatId, messageLimit);
                recentMsgs.reverse(); // DESC→ASC: LLM 需要时间正序
                if (recentMsgs.length > 0) {
                    // 构建 messageId 集合以过滤
                    const msgIdsInContext = new Set<string>();
                    for (const m of recentMsgs) {
                        msgIdsInContext.add(m.messageId);
                    }

                    // 收集所有需要额外拉取的上下文消息（Reply Chain + Surrounding User Context）
                    const extraMsgsMap = new Map<string, any>();
                    for (const m of recentMsgs) {
                        if (m.replyToMessageId && !msgIdsInContext.has(m.replyToMessageId)) {
                            // 提取深度到10，连带下文各提取最多2条历史消息
                            const chain = memory.getReplyChainWithContext(entry.chatId, m.replyToMessageId, 10, 2);
                            for (const c of chain) {
                                if (!msgIdsInContext.has(c.messageId)) {
                                    extraMsgsMap.set(c.messageId, c);
                                }
                            }
                        }
                    }

                    // 组合并重新按时间 ASC 排序
                    if (extraMsgsMap.size > 0) {
                        recentMsgs = [...Array.from(extraMsgsMap.values()), ...recentMsgs];
                        recentMsgs.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                    }

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

                    rawMessagesForHistory = rawMessages;

                    if (effectiveAttendVisionMode === "disable") {
                        // 完全禁用媒体富化，仅保留文本与媒体标签。
                        messagesText = rawMessages
                            .map(m => formatMessageLine(m, { includeMediaTags: true }))
                            .join("\n");
                    } else {
                        // 使用 enrichMessages 进行 Vision 富化
                        const visionConfig = currentConfig.vision;
                        const visionLlmConfig = currentConfig.llmRouting.vision
                            ? resolveComponentProfiles("vision", currentConfig)
                            : undefined;
                        const enrichLlmConfig = visionLlmConfig?.[0] ?? attendProfiles[0];
                        const downloadFn = buildDownloadFn(entry.chatId);

                        const { formattedText, imageParts: parsedImageParts } = await enrichMessages(rawMessages, {
                            visionConfig,
                            llmConfig: enrichLlmConfig,
                            visionLlmConfig,
                            downloadFn,
                            stickerCache: memory,
                            chatId: entry.chatId,
                            mediaDownloader,
                            imageCatalog,
                            forceTextDescriptions: effectiveAttendVisionMode === "describe",
                        });
                        messagesText = formattedText;
                        if (effectiveAttendVisionMode === "vision" && parsedImageParts.length > 0) {
                            imageParts.push(...parsedImageParts);
                        }
                    }
                }
            }

            // 计算时间差
            const timeSinceLastAttend = entry.lastAttendedAt
                ? `${Math.round((Date.now() - new Date(entry.lastAttendedAt).getTime()) / 60_000)}分钟`
                : "从未关注";

            // ➌ Attend 上下文注入
            const recentDecisions = globalState.getRecentDecisions().slice(-5)
                .map(d => `- [${d.chatId}] ${d.decision}`).join("\n") || "（无）";
            const activeTasks = globalState.getTaskList()
                .filter(t => t.status !== "DONE" && t.status !== "CANCELLED")
                .map(t => `- [${t.priority}][${t.status}] ${t.description}${t.chatId ? ` (群:${t.chatId})` : ""}`)
                .join("\n") || "（无待办任务）";

            // ═══ ContextEngine 声明式渲染 ═══
            const attendEngine = mainLoop.getAttendEngine();
            const resolveCtx: ResolveContext = {
                chatId: entry.chatId,
                chatTitle: contextPkg.chatTitle ?? groupModel?.chatTitle ?? entry.chatId,
                chatType: deriveChatType(contextPkg.isDirectMessage),
                attentionSummary: globalState.getAttentionSummary() || "（无）",
                recentDecisions,
                activeTasks,
                stickinessLevel: entry.stickinessLevel,
                snapshotTimestamp: contextPkg.snapshotTimestamp,
                lastAttendedAt: entry.lastAttendedAt ?? "无记录",
                timeSinceLastAttend,
                depth,
                priorityMultiplier: subagent.stickiness.priorityMultiplier,
                recentFeedback: groupModel?.recentFeedback ?? undefined,
                topicDigests: resolvedTopicDigests,
                rawMessages: rawMessagesForHistory,
                newMessageCount: entry.newMessageCount,
                callbacks: subagent.lastCallbacks.length > 0
                    ? subagent.lastCallbacks.slice(-3) : undefined,
                groupModel: groupModel ?? undefined,
                tonePreset: subagent.stickiness.level === "CORE" ? "随意友好" :
                    subagent.stickiness.level === "FAMILIAR" ? "轻松" : "礼貌得体",
                activeUserProfiles: activeUserProfiles.length > 0 ? activeUserProfiles : undefined,
                schedulerTriggers: (entry.source === "SCHEDULER_TRIGGER" && entry.schedulerTriggers?.length)
                    ? entry.schedulerTriggers.map(t => ({ type: t.type, description: t.description }))
                    : undefined,
                dispatchedTopicIds: (() => {
                    const ids = [...subagent.getDispatchedTopicIds()];
                    return ids.length > 0 ? ids : undefined;
                })(),
            };

            const renderResult = attendEngine.render(resolveCtx);

            // historical + ephemeral 拼入同一条 user message（Anthropic cache 友好）
            const currentTurnContent = renderResult.ephemeralContent
                ? `${renderResult.historicalContent}\n\n---\n\n${renderResult.ephemeralContent}`
                : renderResult.historicalContent;

            // ═══ System Prompt ═══
            const mainSystemVars = buildMainSystemVariables(persona);
            const baseSkills = new Set(currentConfig.subagent?.baseSkills ?? [
                "runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "vision", "shell",
            ]);
            if (currentConfig.telegram) baseSkills.add("telegram");
            if (currentConfig.discord) baseSkills.add("discord");
            const { getModuleRegistryCache } = await import("../subagent/code-act-executor.js");
            const moduleRoster = generateModuleRoster(getModuleRegistryCache(), baseSkills);
            if (moduleRoster) {
                mainSystemVars.hasAvailableSkills = true;
                mainSystemVars.availableSkillsRoster = moduleRoster;
            }
            const mainSystemPrompt = renderPrompt("MAIN_SYSTEM", mainSystemVars);

            // ═══ 构建 LLM messages ═══
            const history = mainLoop.getConversationHistory() as ChatMessage[];
            const historyWithCache = history.map((msg, i) =>
                i === history.length - 1
                    ? { ...msg, cacheBreakpoint: true }
                    : msg
            );
            const messages: ChatMessage[] = [
                { role: "system", content: mainSystemPrompt },
                ...historyWithCache,
                { role: "user", content: currentTurnContent, imageParts: imageParts.length > 0 ? imageParts : undefined },
            ];

            const llmPromise = callLLMWithFallback(
                messages,
                attendProfiles,
                {
                    caller: "attend-handler",
                    prefill: `让${persona.name}看看，`,
                    contextManifest: renderResult.manifest,
                },
            );

            // ═══ 并行 Grounding（联网事实查证） ═══
            const groundingConfig = loadConfig().grounding;
            const groundingPromise = groundingConfig?.apiKey
                ? runParallelGrounding(
                    groundingConfig,
                    messagesText,
                    activePersons as any[],
                )
                : Promise.resolve(undefined);

            // 同时等待两个异步任务，Grounding 失败不影响主流程
            const [llmSettled, groundingSettled] = await Promise.allSettled([
                llmPromise,
                groundingPromise,
            ]);

            if (llmSettled.status === "rejected") {
                throw llmSettled.reason;
            }
            const llmResponse = llmSettled.value;

            const groundingContext = groundingSettled.status === "fulfilled"
                ? groundingSettled.value
                : undefined;
            if (groundingContext) {
                log.info("Grounding 查证结果已获取", {
                    chatId: entry.chatId,
                    length: groundingContext.length,
                });
            }

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
                    memoryHints: d.memoryHints && typeof d.memoryHints === "object"
                        ? {
                            keywords: Array.isArray(d.memoryHints.keywords) ? d.memoryHints.keywords.map(String) : undefined,
                            userIds: Array.isArray(d.memoryHints.userIds) ? d.memoryHints.userIds.map(String) : undefined,
                            timeRange: typeof d.memoryHints.timeRange === "string" ? d.memoryHints.timeRange : undefined,
                        }
                        : undefined,
                    confidence: d.confidence ?? 0.5,
                    reason: d.reason ?? "",

                })) : [{ action: "OBSERVE", confidence: 0.3, reason: "LLM 返回格式异常" }],
                reasoning: parsed.reasoning ?? "",
                useSkills: Array.isArray(parsed.useSkills) ? parsed.useSkills : undefined,
                groundingContext,
            };

            // ═══ 追加本轮对话到历史（通过 ContextEngine 的 history 策略自动分离） ═══
            // historicalContent = persistent + delta-only 部分（ephemeral 已自动排除）
            await mainLoop.appendToHistory({ role: "user", content: renderResult.historicalContent });
            await mainLoop.appendToHistory({ role: "assistant", content: jsonContent });

            // 提交当前渲染树到 ledger（LLM 成功后才提交）
            attendEngine.commit(renderResult.tree);

            log.debug("ContextEngine manifest", {
                chatId: entry.chatId,
                sections: renderResult.manifest.sections.map(s => ({
                    name: s.name, changed: s.changed, skipped: s.skipped,
                    chars: s.renderedChars, delta: s.deltaStats,
                })),
                summary: renderResult.manifest.summary,
            });


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
