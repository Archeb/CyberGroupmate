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
import { createLogger } from "../core/logger.js";
import { formatTsForDisplay } from "../core/timezone.js";
import { resolveTierProfile } from "../core/config.js";
import { resolveReplyText } from "../core/message-enricher.js";
import { MediaDownloader } from "../core/media-downloader.js";
import type { AppConfig } from "../core/config.js";

const log = createLogger("dispatch-handler");

/** 将时间戳格式化为相对时间描述（如 "3小时前"、"2天前"）。支持 ISO 字符串和毫秒数 */
function formatRelativeTime(timestamp: string | number | null | undefined): string {
    if (timestamp == null) return "";
    const ms = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
    if (isNaN(ms)) return "";
    const diffMs = Date.now() - ms;
    if (diffMs < 0) return "刚刚";
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
}

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
    cheapConfig: LLMConfig;
    persona: { name: string; description: string };

    /** 完整 AppConfig（用于解析 vision 等配置） */
    appConfig: AppConfig;
    /** Telegram Adapter 引用（用于下载媒体，传给 Executor） */
    telegramAdapter?: { handleCall(method: string, args: unknown[]): Promise<unknown> };
    /** 平台无关的 typing 状态发送（sandbox 执行期间展示 typing） */
    sendTyping?: (chatId: string) => Promise<void>;
}

/**
 * 创建 dispatch handler 工厂函数
 *
 * 返回可直接传给 MainAgentLoop.setDispatchHandler() 的函数。
 */
export function createDispatchHandler(
    deps: DispatchHandlerDeps,
): (result: AttendResult) => Promise<void> {
    const { memory, globalState, subagentManager, sandboxPool, nc, q3, q5, llmConfigs, cheapConfig, persona, appConfig, telegramAdapter: tgAdapter, sendTyping } = deps;
    const visionConfig = appConfig.vision;
    // 解析 vision tier LLM 配置（Path B: 独立 vision 模型描述图片）
    const visionLlmConfig = appConfig.modelTiers.vision
        ? resolveTierProfile("vision", appConfig)
        : undefined;
    // 构建下载函数（传给 Executor 用于懒加载 Vision 处理）
    const downloadFn = tgAdapter ? async (fileId: string, chatId?: string, messageId?: string, uniqueFileId?: string): Promise<Buffer> => {
        const result = await tgAdapter.handleCall("telegram.downloadMedia", [fileId, chatId, messageId, uniqueFileId]) as { buffer: string; size: number };
        return Buffer.from(result.buffer, "base64");
    } : undefined;

    // 创建共享的媒体下载管理器（所有 executor 共用）
    const mediaDownloader = new MediaDownloader({
        retentionDays: visionConfig?.mediaRetentionDays ?? 3,
        maxFileSize: (visionConfig?.maxMediaDownloadSize ?? 20) * 1024 * 1024,
    });

    return async (result: AttendResult): Promise<void> => {
        const subagent = subagentManager.get(result.chatId);
        if (!subagent) return;

        let hasCodeActTask = false;

        for (const decision of result.decisions) {
            if (decision.action === "REPLY") {
                // Fix 3: 构建符合 subagent.md §13.2 B1 规格的 contextSnapshot
                // 获取话题摘要
                // Fix: getActive() 只返回 ACTIVE 状态话题，但 triage 通过后话题进入 ENGAGED 状态。
                // 使用 getByChat() 获取所有非归档话题，确保 ENGAGED/TRIAGING 话题也可见。
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
                    topicSummary = sortedTopics.map((t: any) =>
                        `[${t.state}] (${formatRelativeTime(t.createdAt)}) ${t.label ?? ""}${t.lastSummary ? ` — ${t.lastSummary}` : (t.recentContext ? `: ${t.recentContext.split("\n").slice(-2).join("; ")}` : "")}`
                    ).join("\n");
                } else {
                    // Fallback: TopicRegistry 为空时（Pipeline 尚未 flush 或重启后无近期话题），
                    // 从 MemoryV2 查询最近 20 条持久化话题（无时间限制）
                    try {
                        const memTopics = memory.getRecentTopics(result.chatId, 20);
                        if (memTopics.length > 0) {
                            topicSummary = memTopics.map(t =>
                                `(${formatRelativeTime(t.startedAt)}) ${t.label}${t.summary ? ` — ${t.summary}` : ""}${t.wasEngaged ? " [已回复]" : ""}`
                            ).join("\n");
                        }
                    } catch (err) {
                        // 静默失败，topicSummary 留空
                    }
                }

                // 获取最近消息
                const recentMsgs = memory.getRecentMessages(result.chatId, 20);
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
                                    downloadFn,
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

                // 获取人物信息
                let personContext = "";
                try {
                    const recallResult = await memory.recall("", { chatId: result.chatId, maxResults: 5 });
                    if (recallResult.persons.length > 0) {
                        personContext = JSON.stringify(recallResult.persons, null, 2);
                    }
                } catch { /* 非关键路径 */ }

                // 获取群组画像
                const groupModel = memory.getGroupModel(result.chatId) ?? undefined;

                const contextSnapshot = buildGroupContext({
                    chatId: result.chatId,
                    depth: 2, // 提供足够上下文
                    snapshotTimestamp: new Date().toISOString(),
                    topicDigests: subagent.observer.getDigest(),
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
                contextSnapshot.toneGuidance = subagent.stickiness.level === "CORE" ? "随意友好" : "礼貌得体";
                contextSnapshot.contentDirection = decision.contentDirection ?? "";

                // 构建 CodeActReplyTask
                const task: CodeActReplyTask = {
                    type: "CODEACT_REPLY",
                    chatId: result.chatId,
                    taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    decisions: [decision],
                    contextSnapshot,
                    replyMode: result.replyMode === "BATCH" ? "BATCH" : "SINGLE",
                    createdAt: new Date().toISOString(),
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
                    });
                    // Fix 9: 注入 Sandbox + NC + LLM 依赖 + Memory + Vision
                    executor.setDependencies(sandboxPool, nc, llmConfigs, persona, memory, visionConfig, downloadFn, sendTyping, visionLlmConfig, mediaDownloader);
                }

                executor.enqueue(task);
                hasCodeActTask = true;

                // 记录已分派的 topicId（防重复分派）
                if (decision.topicId) {
                    subagent.markTopicDispatched(decision.topicId);
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
                if (!fp) {
                    fp = new FastPathHandler(result.chatId);
                    fp.setCallbackHandler((cb: SubagentCallback) => q5.enqueue(cb));
                    const fpGroupModel = memory.getGroupModel(result.chatId);
                    fp.setLLMConfig(cheapConfig, persona, fpGroupModel?.chatTitle ?? result.chatId);
                    subagent.fastPathHandler = fp;
                }
                fp.authorize(result.fastPathAuth);
                log.info("授权 FastPath", { chatId: result.chatId });
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
