/**
 * dispatch-handler.ts — 主 Agent Dispatch Handler (Phase 6)
 *
 * 从 main.ts 提取的任务分派逻辑：
 * - REPLY → 构建 CodeActReplyTask + 创建/获取 CodeActExecutor → enqueue
 * - FAST_PATH_AUTH → 创建/获取 FastPathHandler → authorize
 * - DEFER → 重新入队 Q3 (DEFERRED_RE_ENTRY)
 * - OBSERVE / IGNORE → 仅记录
 *
 * 参考设计：subagent.md §13.2 B1/B2, subtask.md S3/S4
 */

import type { AttendResult, CodeActReplyTask, SubagentCallback } from "../subagent/types.js";
import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { LLMConfig } from "../core/config.js";
import type { SandboxPool } from "../sandbox/sandbox-pool.js";
import type { NotificationCenter } from "../event/notification-center.js";
import type { DynamicAttentionQueue } from "../subagent/attention-queue.js";
import type { CallbackQueue } from "../subagent/callback-queue.js";
import type { GlobalState } from "./global-state.js";
import { CodeActExecutor } from "../subagent/code-act-executor.js";
import { FastPathHandler } from "../subagent/fast-path-handler.js";
import { buildGroupContext } from "./context-builder.js";
import { formatTopicList, formatRelativeTime } from "./prompt-renderer.js";
import { createLogger } from "../core/logger.js";
import { formatTsForDisplay } from "../core/timezone.js";
import { loadConfig, resolveComponentProfiles } from "../core/config.js";
import { resolveReplyText } from "../core/message-enricher.js";
import { MediaDownloader } from "../core/media-downloader.js";
import type { AppConfig } from "../core/config.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";
import { getGroupModelKey } from "../core/chat-id.js";
import { TopicRegistry } from "../pipeline/topic-registry.js";

const log = createLogger("dispatch-handler");

// formatRelativeTime 和 formatTopicList 已从 prompt-renderer.ts 导入

/** Dispatch handler 依赖 */
export interface DispatchHandlerDeps {
    memory: MemoryStoreV2;
    globalState: GlobalState;
    subagentManager: SubagentManager;
    sandboxPool: SandboxPool;
    nc: NotificationCenter;
    q3: DynamicAttentionQueue;
    q5: CallbackQueue;
    llmConfigs: LLMConfig[];
    fastPathConfigs: LLMConfig[];
    persona: { name: string; description: string };

    /** 完整 AppConfig（用于解析 vision 等配置） */
    appConfig: AppConfig;
    /** 所有平台 adapter（用于平台无关的媒体下载和消息发送） */
    adapters?: PlatformAdapter[];
    /** 平台无关的 typing 状态发送（sandbox 执行期间展示 typing） */
    sendTyping?: (chatId: string) => Promise<void>;
    /** 共享的媒体下载管理器 */
    mediaDownloader: MediaDownloader;
}

/**
 * 创建 dispatch handler 工厂函数
 *
 * 返回可直接传给 MainAgentLoop.setDispatchHandler() 的函数。
 */
export function createDispatchHandler(
    deps: DispatchHandlerDeps,
): (result: AttendResult) => Promise<void> {
    const { memory, globalState, subagentManager, sandboxPool, nc, q3, q5, llmConfigs, fastPathConfigs, appConfig: _appConfig, adapters: adapterList, sendTyping, mediaDownloader } = deps;
    // 构建下载函数（根据 chatId 平台路由到对应 adapter）
    const buildDownloadFn = (chatId: string) => {
        if (!adapterList?.length) return undefined;
        const adapter = adapterList.find(a => chatId.startsWith(a.platform + ":"));
        if (!adapter) return undefined;
        return async (fileId: string, _chatId?: string, _messageId?: string, _uniqueFileId?: string): Promise<Buffer> => {
            const result = await adapter.handleCall(`${adapter.platform}.downloadMedia`, [fileId, _chatId, _messageId, _uniqueFileId]) as { buffer: string; size: number };
            return Buffer.from(result.buffer, "base64");
        };
    };

    return async (result: AttendResult): Promise<void> => {
        // 动态读取 persona 和 vision 配置（支持热重载）
        const currentConfig = loadConfig();
        const persona = currentConfig.persona;
        const visionConfig = currentConfig.vision;
        // 解析 vision LLM 配置（Path B: 独立 vision 模型描述图片）
        const visionLlmConfig = currentConfig.llmRouting.vision
            ? resolveComponentProfiles("vision", currentConfig)[0]
            : undefined;
        const subagent = subagentManager.get(result.chatId);
        if (!subagent) return;

        let hasCodeActTask = false;

        for (const decision of result.decisions) {
            if (decision.action === "REPLY") {
                // Fix 3: 构建符合 subagent.md §13.2 B1 规格的 contextSnapshot
                // 获取话题摘要
                // Fix: getActive() 只返回 ACTIVE 状态话题，但 triage 通过后话题可能进入 ENGAGED 或 IGNORED 状态。
                // 使用 getByChat() 获取所有非归档话题，确保各状态话题都可见。
                const allTopics = subagent?.topicRegistry.getByChat(result.chatId) ?? [];
                const topicForDecision = decision.topicId
                    ? allTopics.find((t: any) => String(t.id) === decision.topicId)
                    : allTopics[0];

                // 构建话题摘要：优先使用 TopicRegistry，空时 fallback 到 MemoryV2
                let topicSummary = "";
                if (allTopics.length > 0) {
                    // 按 createdAt 降序排列，取最近 20 条
                    const sortedTopics = [...allTopics]
                        .sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
                        .slice(0, 20);
                    topicSummary = formatTopicList(sortedTopics.map(t =>
                        TopicRegistry.toFormattable(t, id => {
                            const identity = memory.getPersonIdentity(id);
                            return identity?.displayName ?? id;
                        })
                    ));
                } else {
                    // Fallback: TopicRegistry 为空时（Pipeline 尚未 flush 或重启后无近期话题），
                    // 从 MemoryV2 查询最近 20 条持久化话题（无时间限制）
                    try {
                        const memTopics = memory.getRecentTopics(result.chatId, 20);
                        if (memTopics.length > 0) {
                            topicSummary = formatTopicList(memTopics.map(t => ({
                                label: t.label,
                                summary: t.summary,
                                createdAt: t.startedAt,
                            })));
                        }
                    } catch (err) {
                        // 静默失败，topicSummary 留空
                    }
                }

                // 获取最近消息
                const recentMsgs = memory.getRecentMessages(result.chatId, 50);
                // 构建 messageId → displayName 映射，用于解析 replyTo 关系
                const dispatchMsgIdToName = new Map<string, string>();
                for (const m of recentMsgs) {
                    dispatchMsgIdToName.set(m.messageId, m.displayName || `(uid:${m.userId})`);
                }
                const formattedMessages = await Promise.all(recentMsgs.map(async (m: any) => {
                    const isInContext = m.replyToMessageId ? dispatchMsgIdToName.has(m.replyToMessageId) : false;
                    // 不在上下文中时，从 DB 查询原消息并解析文本/媒体描述（含 vision 处理）
                    let replyToText: string | undefined;
                    if (m.replyToMessageId && !isInContext) {
                        try {
                            const origMsg = memory.getMessageById(result.chatId, m.replyToMessageId);
                            if (origMsg) {
                                replyToText = await resolveReplyText(origMsg, {
                                    stickerCache: memory,
                                    visionConfig,
                                    llmConfig: llmConfigs[0],
                                    visionLlmConfig,
                                    downloadFn: buildDownloadFn(result.chatId),
                                    chatId: result.chatId,
                                });
                            }
                        } catch { /* 非关键路径 */ }
                    }
                    return {
                        id: String(m.messageId ?? m.id ?? m.message_id ?? ""),
                        sender: String(m.displayName ?? m.display_name ?? m.sender ?? m.user_id ?? "?"),
                        text: String(m.text ?? ""),
                        timestamp: formatTsForDisplay(m.timestamp),
                        replyTo: m.replyToMessageId
                            ? (dispatchMsgIdToName.get(m.replyToMessageId) ?? `msg#${m.replyToMessageId}`)
                            : undefined,
                        replyToMsgId: m.replyToMessageId ?? undefined,
                        replyToText,
                        mediaType: m.mediaType ?? undefined,
                        mediaInfo: m.mediaInfo ?? undefined,
                    };
                }));

                // Vision 处理已移至 CodeActExecutor.executeWithSandbox()，
                // 利用 mediaInfo 中的 fileId 在执行时按需下载和识图

                // personContext: 由 code-act-executor 执行前根据 recentMessages 中的发言者查询
                let personContext = "";

                // 获取群组画像
                const groupModel = memory.getGroupModel(getGroupModelKey(result.chatId)) ?? undefined;

                const contextSnapshot = buildGroupContext({
                    chatId: result.chatId,
                    depth: 2, // 提供足够上下文
                    snapshotTimestamp: new Date().toISOString(),
                    topicDigests: subagent.topicRegistry.getByChat(result.chatId).map(t => TopicRegistry.toDigest(t)),
                    engagementScore: subagent.observer.getEngagementScore(),
                    groupModel,
                    lastCallbacks: subagent.lastCallbacks,
                    chatTitle: groupModel?.chatTitle,
                    isDirectMessage: groupModel?.isDirectMessage,
                    stickiness: subagent.stickiness,
                });

                // 增强 contextSnapshot：注入 spec 要求的额外上下文（类型安全）
                contextSnapshot.topicSummary = topicSummary;
                contextSnapshot.recentMessages = formattedMessages;
                contextSnapshot.personContext = personContext;
                contextSnapshot.toneGuidance = decision.toneGuidance
                    ?? (subagent.stickiness.level === "CORE" ? "随意友好" : "礼貌得体");
                contextSnapshot.contentDirection = decision.contentDirection ?? "";

                // 贴纸查找：根据 suggestedEmojis 查找可发送的贴纸
                if (decision.suggestedEmojis && decision.suggestedEmojis.length > 0) {
                    try {
                        const { existsSync } = await import("node:fs");
                        const stickerMatches = memory.searchStickersByEmoji(decision.suggestedEmojis);
                        const availableStickers: Array<{ emoji: string; description: string; uniqueFileId: string }> = [];
                        for (const s of stickerMatches) {
                            const filePath = mediaDownloader.getExistingPath(s.uniqueFileId);
                            if (filePath && existsSync(filePath) && !filePath.toLowerCase().endsWith(".webm")) {
                                availableStickers.push({
                                    emoji: s.emoji,
                                    description: s.description,
                                    uniqueFileId: s.uniqueFileId,
                                });
                            } else if (filePath && existsSync(filePath) && filePath.toLowerCase().endsWith(".webm")) {
                                // 排除 webm 格式贴纸，不加入 availableStickers
                                log.debug("跳过 webm 格式贴纸", { uniqueFileId: s.uniqueFileId, filePath });
                            } else {
                                // 文件不存在：清理 DB 中的过期条目
                                memory.deleteStickerDescription(s.uniqueFileId);
                                log.debug("贴纸文件不存在，已删除 DB 条目", { uniqueFileId: s.uniqueFileId });
                            }
                        }
                        if (availableStickers.length > 0) {
                            contextSnapshot.availableStickers = availableStickers;
                            log.debug("贴纸查找完成", {
                                chatId: result.chatId,
                                suggestedEmojis: decision.suggestedEmojis,
                                matched: stickerMatches.length,
                                withFile: availableStickers.length,
                            });
                        }
                    } catch (err) {
                        log.debug("贴纸查找失败", { error: String(err) });
                    }
                }

                // 构建 CodeActReplyTask
                const task: CodeActReplyTask = {
                    type: "CODEACT_REPLY",
                    chatId: result.chatId,
                    taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    decisions: [decision],
                    contextSnapshot,
                    replyMode: result.replyMode === "BATCH" ? "BATCH" : "SINGLE",
                    createdAt: new Date().toISOString(),
                    targetMessageIds: decision.targetMessageIds,
                };

                // 获取或创建 CodeActExecutor
                let executor = subagent.codeActExecutor as CodeActExecutor | null;
                if (!executor) {
                    executor = new CodeActExecutor(result.chatId);
                    executor.setSessionFilePath(subagentManager.getSessionFilePath(result.chatId));
                    // 尝试从磁盘加载已有 session
                    executor.loadSession();
                    subagent.codeActExecutor = executor;
                }

                // 确保依赖已注入（restoreAll 恢复的 executor 可能缺少依赖）
                if (!executor.hasDependencies()) {
                    executor.setCallbackHandler((cb: SubagentCallback) => {
                        q5.enqueue(cb);
                        log.info("Subagent 执行完成 → Q5", {
                            chatId: cb.chatId,
                            taskId: cb.taskId,
                            status: cb.status,
                            summary: cb.summary,
                            sentMessages: cb.sentMessages?.length ?? 0,
                            sentPreviews: cb.sentMessages?.map(m => m.text.length > 60 ? m.text.slice(0, 60) + "..." : m.text),
                            durationMs: cb.durationMs,
                        });
                        // Unblock in Q3 when callback arrives
                        q3.unblock(cb.chatId);
                        globalState.recordDecision(cb.chatId, `CALLBACK: ${cb.executionType} ${cb.status} (${cb.summary})`);

                        // Post-session: 1 分钟后触发 RecordingPipeline flush
                        // 追踪话题变化 + triage 判断是否需要再次介入
                        setTimeout(() => {
                            try {
                                const sub = subagentManager.get(cb.chatId);
                                if (sub?.recordingPipeline) {
                                    log.info("post-session → RecordingPipeline flush", { chatId: cb.chatId, taskId: cb.taskId });
                                    sub.recordingPipeline.flush();
                                }
                            } catch (err) {
                                log.debug("post-session flush failed", { chatId: cb.chatId, error: String(err) });
                            }
                        }, 60_000);
                    });
                    // Fix 9: 注入 Sandbox + NC + LLM 依赖 + Memory + Vision
                    const downloadFn = buildDownloadFn(result.chatId);
                    // 获取平台对应的 formatMention 函数
                    const chatAdapter = adapterList?.find(a => result.chatId.startsWith(a.platform + ":"));
                    const formatMention = chatAdapter ? (rawId: string, username?: string) => chatAdapter.formatMention(rawId, username) : undefined;
                    executor.setDependencies(sandboxPool, nc, llmConfigs, persona, memory, visionConfig, downloadFn, sendTyping, visionLlmConfig, mediaDownloader, formatMention);
                }

                executor.enqueue(task);
                hasCodeActTask = true;

                // 记录已分派的 topicId（防重复分派）
                // 仅标记 TopicRegistry 中真实存在的话题——LLM 在无话题上下文时可能编造 topicId
                if (decision.topicId) {
                    const isRealTopic = subagent.topicRegistry.get(decision.topicId) !== undefined;
                    if (isRealTopic) {
                        subagent.markTopicDispatched(decision.topicId);
                    } else {
                        log.debug("跳过非标准 topicId 的 dispatched 标记", {
                            chatId: result.chatId,
                            topicId: decision.topicId,
                        });
                    }
                }

                log.info("分派 CodeActReplyTask", {
                    chatId: result.chatId,
                    taskId: task.taskId,
                    replyMode: task.replyMode,
                    action: decision.action,
                    topicId: decision.topicId,
                    contentDirection: decision.contentDirection ?? "(无)",
                    reason: decision.reason ?? "",
                    confidence: decision.confidence,
                    contextMessageCount: formattedMessages.length,
                    topicSummary: topicSummary ? topicSummary.slice(0, 100) : "(无)",
                });
            } else if (decision.action === "FAST_PATH_AUTH" && result.fastPathAuth) {
                // 授权 FastPath
                let fp = subagent.fastPathHandler as FastPathHandler | null;
                const fpGroupModel = memory.getGroupModel(getGroupModelKey(result.chatId));
                if (!fp) {
                    fp = new FastPathHandler(result.chatId);
                    fp.setCallbackHandler((cb: SubagentCallback) => q5.enqueue(cb));
                    fp.setLLMConfig(fastPathConfigs, persona, fpGroupModel?.chatTitle ?? result.chatId, fpGroupModel?.isDirectMessage);
                    // 注入发送函数：通过平台 adapter 路由发送消息
                    const fpAdapter = adapterList?.find(a => result.chatId.startsWith(a.platform + ":"));
                    if (fpAdapter) {
                        fp.setSendFunction(async (chatId: string, text: string): Promise<string | undefined> => {
                            const sendResult = await fpAdapter.handleCall(`${fpAdapter.platform}.sendText`, [chatId, text]) as any;
                            const messageId = sendResult?.messageId ?? sendResult?.id ? String(sendResult.messageId ?? sendResult.id) : undefined;
                            // 发出 agent_message_sent 事件：触发 FeedbackLoop 追踪 + 消息落盘
                            nc.push({
                                type: "system.agent_message_sent",
                                scene: "fastpath",
                                chatId,
                                text,
                                messageId,
                                timestamp: new Date().toISOString(),
                            });
                            return messageId;
                        });
                    }
                    subagent.fastPathHandler = fp;
                }

                // 构建任务上下文（话题摘要、人物背景），类似 CODEACT_REPLY
                let fpTopicSummary = "";
                const fpTopics = subagent.topicRegistry.getActive(result.chatId);
                if (fpTopics.length > 0) {
                    fpTopicSummary = formatTopicList(fpTopics.map(t => ({
                        label: t.label,
                        summary: t.lastSummary,
                        createdAt: t.createdAt,
                    })));
                }

                fp.setTaskContext({
                    topicSummary: fpTopicSummary || undefined,
                    toneGuidance: subagent.stickiness.level === "CORE" ? "随意友好" : "礼貌得体",
                });

                fp.authorize(result.fastPathAuth);
                log.info("授权 FastPath", {
                    chatId: result.chatId,
                    taskDescription: result.fastPathAuth.taskDescription ?? "(无)",
                    maxReplies: result.fastPathAuth.maxRepliesBeforeReauth,
                    expiresAt: result.fastPathAuth.expiresAt,
                    actions: result.fastPathAuth.preauthorizedActions,
                    topicCount: fpTopics.length,
                });
            } else if (decision.action === "DEFER") {
                // Fix 2: DEFERRED_RE_ENTRY — 延迟重新入队 (subagent.md §13.1 D1)
                q3.enqueueOrUpdate({
                    chatId: result.chatId,
                    source: "DEFERRED_RE_ENTRY",
                    priority: Math.max(0, (subagent.observer.getEngagementScore() * subagent.stickiness.priorityMultiplier) * 0.5),
                    basePriority: Math.max(0, (subagent.observer.getEngagementScore() * subagent.stickiness.priorityMultiplier) * 0.5),
                });
                log.info("DEFER → 重新入队", {
                    chatId: result.chatId,
                    reason: decision.reason,
                    topicId: decision.topicId,
                });
                globalState.recordDecision(result.chatId, `DEFERRED: ${decision.reason}`);
            } else if (decision.action === "OBSERVE" || decision.action === "IGNORE") {
                // 仅记录，不分派
                log.debug("决策: 不操作", {
                    chatId: result.chatId,
                    action: decision.action,
                    reason: decision.reason,
                });
            }
        }

        if (hasCodeActTask) {
            q3.block(result.chatId, "CodeAct executing");
        }
    };
}
