/**
 * post-task-window.ts — Subagent 发言后的短时发酵窗口
 *
 * Subagent 发完消息后，先暂缓把 callback 交给 Meta。
 * 窗口内普通群聊只记录，L0/direct attention 直接交给同群 subagent 补一轮。
 */

import type { NotificationEvent } from "../event/notification-center.js";
import type { AttentionAccumulator } from "../accumulator/attention-accumulator.js";
import type { CallbackQueue } from "./callback-queue.js";
import type { SubagentManager } from "./subagent-manager.js";
import type {
    CodeActReplyTask,
    DispatchedSubagentTaskRecord,
    GroupContextPackage,
    PostTaskReactionMessage,
    SubagentCallback,
    SubagentPostTaskFollowUpCallback,
} from "./types.js";
import { createLogger } from "../core/logger.js";
import { prefixedShortUuid } from "../core/ids.js";
import { callLLMWithFallback, type ChatMessage, type ImagePart } from "../core/llm.js";
import { loadConfig, resolveComponentProfiles, resolveComponentTimeout, type AppConfig, type LLMConfig, type VisionConfig } from "../core/config.js";
import { loadPromptFile } from "../core/prompt-loader.js";
import { renderTemplate } from "../context-engine/template-engine.js";
import {
    enrichMessages,
    formatMessageLine,
    type RawMessage,
    type StickerDescriptionLookup,
} from "../core/message-enricher.js";
import type { DownloadFn } from "../core/vision-processor.js";
import type { MediaDownloader } from "../core/media-downloader.js";

const log = createLogger("post-task-window");

const DEFAULT_WINDOW_MS = 120_000;
const DEFAULT_FOLLOW_UP_CHECK_INTERVAL_MS = 5_000;
const IDLE_RECHECK_MS = 2_000;
const MIN_MAX_WINDOW_MS = 5 * 60_000;
const FOLLOW_UP_CONTEXT_MESSAGE_LIMIT = 20;
const POST_TASK_FOLLOWUP_PROMPT_PATH = "subagent/post-task-followup.md";

const DEFAULT_POST_TASK_FOLLOWUP_PROMPT = [
    "你是一个极轻量的 post-task follow-up 判定器。",
    "当前 agent 的名字是「{{personaName}}」。",
    "你会看到最近 20 条上下文消息，以及之后短时间窗口内新出现的一批群聊消息。",
    "判断这些新消息里是否出现了需要让 agent 像被自然追问/接话一样补一轮的 follow-up。",
    "",
    "判定为 true 的情况：",
    "- 有人追问、质疑、纠正、补充或明确接住了 agent 刚才的话",
    "- 有人回复 agent 刚发出的消息，即使没有 @ 或名字",
    "- 对话对象在私聊中继续向 agent 发出需要回应的信息",
    "- 新消息让刚才的任务结果出现明显需要澄清或继续处理的点",
    "",
    "判定为 false 的情况：",
    "- 只是哈哈、收到、表情、无行动价值的附和",
    "- 群里转向了和 agent 刚才发言无关的新话题",
    "- 已经有别人自然接住并解决，无需 agent 介入",
    "- 只是在闲聊背景中提到相近词，但没有要求 agent 继续",
    "",
    "只输出严格 JSON，不要 markdown：",
    '{ "hasFollowUp": true, "triggerMessageId": "msg-id", "reason": "一句话说明" }',
].join("\n");

interface ExecutorLike {
    enqueue(task: CodeActReplyTask): void;
    isProcessing?(): boolean;
    getQueueSize?(): number;
}

export interface PostTaskSentMessage {
    messageId?: string;
    text: string;
    timestamp: string;
}

export interface PostTaskFollowUpJudgeInput {
    chatId: string;
    chatTitle?: string;
    isDirectMessage?: boolean;
    recentMessages?: PostTaskReactionMessage[];
    sentMessages: PostTaskSentMessage[];
    callbacks: SubagentCallback[];
    messages: PostTaskReactionMessage[];
    stickerDescriptionLookup?: StickerDescriptionLookup;
    /** 图片下载函数（委托给 adapter）；存在时新批次消息中的图片会被识别/内联 */
    downloadFn?: DownloadFn;
    /** 媒体下载管理器（存在时将识别到的图片保存到磁盘） */
    mediaDownloader?: MediaDownloader;
}

export interface PostTaskFollowUpJudgeResult {
    hasFollowUp: boolean;
    reason?: string;
    triggerMessageId?: string;
}

export interface PostTaskFollowUpEnrichConfig {
    llmConfig: LLMConfig;
    visionConfig?: VisionConfig;
    visionLlmConfig?: LLMConfig[];
    /** 图片下载函数；存在时启用图片识别管线 */
    downloadFn?: DownloadFn;
    /** 媒体下载管理器；存在时将图片保存到磁盘 */
    mediaDownloader?: MediaDownloader;
}

export type PostTaskFollowUpJudge = (input: PostTaskFollowUpJudgeInput) => Promise<PostTaskFollowUpJudgeResult>;
export type PostTaskRecentMessagesProvider = (
    chatId: string,
    limit: number,
) => PostTaskReactionMessage[] | Promise<PostTaskReactionMessage[]>;

interface ActivePostTaskWindow {
    chatId: string;
    chatTitle?: string;
    isDirectMessage?: boolean;
    startedAtMs: number;
    flushAtMs: number;
    maxFlushAtMs: number;
    callbacks: SubagentCallback[];
    messages: PostTaskReactionMessage[];
    sentMessages: PostTaskSentMessage[];
    sentMessageIds: Set<string>;
    deliveredMessageIds: Set<string>;
    triagedMessageIds: Set<string>;
    followUpCheckInFlight: boolean;
    timer: ReturnType<typeof setTimeout> | null;
    followUpTimer: ReturnType<typeof setTimeout> | null;
}

export interface PostTaskWindowManagerOptions {
    windowMs?: number;
    maxWindowMs?: number;
    callbackQueue: CallbackQueue;
    accumulator: Pick<AttentionAccumulator, "block" | "unblock">;
    subagentManager: Pick<SubagentManager, "get">;
    onDirectTaskEnqueued?: (task: CodeActReplyTask) => void;
    followUpCheckIntervalMs?: number;
    followUpJudge?: PostTaskFollowUpJudge | null;
    recentMessagesProvider?: PostTaskRecentMessagesProvider;
    stickerDescriptionLookup?: StickerDescriptionLookup;
    /** 按 chatId 解析图片下载函数；存在时 follow-up 判定会识别/内联新消息里的图片 */
    downloadFnProvider?: (chatId: string) => DownloadFn | undefined;
    /** 共享媒体下载管理器（将识别到的图片保存到磁盘） */
    mediaDownloader?: MediaDownloader;
}

export class PostTaskWindowManager {
    private readonly windowMs: number;
    private readonly maxWindowMs: number;
    private readonly callbackQueue: CallbackQueue;
    private readonly accumulator: Pick<AttentionAccumulator, "block" | "unblock">;
    private readonly subagentManager: Pick<SubagentManager, "get">;
    private readonly onDirectTaskEnqueued?: (task: CodeActReplyTask) => void;
    private readonly followUpCheckIntervalMs: number;
    private readonly followUpJudge: PostTaskFollowUpJudge | null;
    private readonly recentMessagesProvider?: PostTaskRecentMessagesProvider;
    private readonly stickerDescriptionLookup?: StickerDescriptionLookup;
    private readonly downloadFnProvider?: (chatId: string) => DownloadFn | undefined;
    private readonly mediaDownloader?: MediaDownloader;
    private readonly windows = new Map<string, ActivePostTaskWindow>();

    constructor(options: PostTaskWindowManagerOptions) {
        this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
        this.maxWindowMs = options.maxWindowMs ?? Math.max(MIN_MAX_WINDOW_MS, this.windowMs * 3);
        this.callbackQueue = options.callbackQueue;
        this.accumulator = options.accumulator;
        this.subagentManager = options.subagentManager;
        this.onDirectTaskEnqueued = options.onDirectTaskEnqueued;
        this.followUpCheckIntervalMs = options.followUpCheckIntervalMs ?? DEFAULT_FOLLOW_UP_CHECK_INTERVAL_MS;
        this.followUpJudge = options.followUpJudge === undefined ? judgePostTaskFollowUpWithLLM : options.followUpJudge;
        this.recentMessagesProvider = options.recentMessagesProvider;
        this.stickerDescriptionLookup = options.stickerDescriptionLookup;
        this.downloadFnProvider = options.downloadFnProvider;
        this.mediaDownloader = options.mediaDownloader;
    }

    handleSentMessage(chatId: string, event: NotificationEvent): void {
        if (this.windowMs <= 0) return;

        const existing = this.windows.get(chatId);
        if (existing) {
            rememberWindowChatMetadata(existing, event);
            rememberSentEventMessage(existing, event);
            existing.flushAtMs = Date.now() + this.windowMs;
            this.scheduleFlush(existing, this.windowMs);
            return;
        }

        const startedAtMs = Date.now();
        const window: ActivePostTaskWindow = {
            chatId,
            chatTitle: event.chatTitle != null ? String(event.chatTitle) : undefined,
            isDirectMessage: event.isDirectMessage != null ? Boolean(event.isDirectMessage) : undefined,
            startedAtMs,
            flushAtMs: startedAtMs + this.windowMs,
            maxFlushAtMs: startedAtMs + this.maxWindowMs,
            callbacks: [],
            messages: [],
            sentMessages: [],
            sentMessageIds: new Set<string>(),
            deliveredMessageIds: new Set<string>(),
            triagedMessageIds: new Set<string>(),
            followUpCheckInFlight: false,
            timer: null,
            followUpTimer: null,
        };
        rememberSentEventMessage(window, event);
        this.accumulator.block(chatId);
        this.windows.set(chatId, window);
        this.scheduleFlush(window, this.windowMs);

        log.info("post-task window opened from sent message", {
            chatId,
            windowMs: this.windowMs,
            messageId: event.messageId ?? event.id,
        });
    }

    handleCallback(callback: SubagentCallback): void {
        const existing = this.windows.get(callback.chatId);
        if (existing) {
            existing.callbacks.push(callback);
            rememberWindowChatMetadata(existing, callback);
            this.rememberSentMessages(existing, callback);
            log.info("callback merged into active post-task window", {
                chatId: callback.chatId,
                taskId: callback.taskId,
                callbacks: existing.callbacks.length,
            });
            return;
        }

        if (!this.shouldDelay(callback)) {
            this.callbackQueue.enqueue(callback);
            this.accumulator.unblock(callback.chatId);
            return;
        }

        if (this.windowMs <= 0) {
            this.callbackQueue.enqueue(callback);
            this.accumulator.unblock(callback.chatId);
            return;
        }

        const startedAtMs = Date.now();
        this.accumulator.block(callback.chatId);
        const window: ActivePostTaskWindow = {
            chatId: callback.chatId,
            chatTitle: callback.chatTitle,
            isDirectMessage: callback.isDirectMessage,
            startedAtMs,
            flushAtMs: startedAtMs + this.windowMs,
            maxFlushAtMs: startedAtMs + this.maxWindowMs,
            callbacks: [callback],
            messages: [],
            sentMessages: [],
            sentMessageIds: new Set<string>(),
            deliveredMessageIds: new Set<string>(),
            triagedMessageIds: new Set<string>(),
            followUpCheckInFlight: false,
            timer: null,
            followUpTimer: null,
        };
        this.rememberSentMessages(window, callback);
        this.windows.set(callback.chatId, window);
        this.scheduleFlush(window, this.windowMs);

        log.info("post-task window opened", {
            chatId: callback.chatId,
            taskId: callback.taskId,
            windowMs: this.windowMs,
            sentMessages: callback.sentMessages?.length ?? 0,
        });
    }

    hasActiveWindow(chatId: string): boolean {
        return this.windows.has(chatId);
    }

    isReplyToWindowSentMessage(chatId: string, event: NotificationEvent): boolean {
        const window = this.windows.get(chatId);
        const replyToMessageId = event.replyToMessageId != null ? String(event.replyToMessageId) : "";
        return !!window && replyToMessageId.length > 0 && window.sentMessageIds.has(replyToMessageId);
    }

    recordMessage(
        chatId: string,
        event: NotificationEvent,
        options?: { isDirectAttention?: boolean; directReason?: string },
    ): void {
        const window = this.windows.get(chatId);
        if (!window) return;
        rememberWindowChatMetadata(window, event);
        ensureWindowMessage(window, event, options);
        this.scheduleFollowUpCheck(window);
    }

    tryForwardDirectMessage(chatId: string, event: NotificationEvent, directReason: string): boolean {
        const window = this.windows.get(chatId);
        if (!window) return false;
        rememberWindowChatMetadata(window, event);
        const message = ensureWindowMessage(window, event, { isDirectAttention: true, directReason });
        return this.forwardWindowMessages(window, message, {
            directReason,
            decisionReason: `Post-task L0 direct attention: ${directReason}`,
            contentDirection: "Post-task window 内有人直接叫住你、回复你或提及你。请自然判断是否需要补一轮。",
            logKind: "direct",
        });
    }

    markMessagesInjected(chatId: string, messageIds: string[], source: string): void {
        const window = this.windows.get(chatId);
        if (!window || messageIds.length === 0) return;
        for (const rawId of messageIds) {
            const messageId = String(rawId);
            window.deliveredMessageIds.add(messageId);
            window.triagedMessageIds.add(messageId);
        }
        log.debug("post-task window messages marked as already injected", {
            chatId,
            source,
            messageIds,
        });
    }

    dispose(): void {
        for (const window of this.windows.values()) {
            if (window.timer) clearTimeout(window.timer);
            if (window.followUpTimer) clearTimeout(window.followUpTimer);
            this.accumulator.unblock(window.chatId);
        }
        this.windows.clear();
    }

    private shouldDelay(callback: SubagentCallback): boolean {
        return (callback.sentMessages?.length ?? 0) > 0;
    }

    private rememberSentMessages(window: ActivePostTaskWindow, callback: SubagentCallback): void {
        for (const sent of callback.sentMessages ?? []) {
            upsertSentMessage(window, {
                messageId: sent.messageId != null ? String(sent.messageId) : undefined,
                text: sent.text,
                timestamp: sent.timestamp,
            });
        }
    }

    private forwardWindowMessages(
        window: ActivePostTaskWindow,
        triggerMessage: PostTaskReactionMessage,
        options: {
            directReason: string;
            decisionReason: string;
            contentDirection: string;
            classifierReason?: string;
            logKind: "direct" | "follow-up";
        },
    ): boolean {
        const chatId = window.chatId;
        const subagent = this.subagentManager.get(chatId);
        const executor = subagent?.codeActExecutor as ExecutorLike | null | undefined;
        if (!subagent || !executor) {
            log.warn("post-task window message has no executor", {
                chatId,
                directReason: options.directReason,
                logKind: options.logKind,
            });
            return false;
        }

        const undeliveredMessages = collectUndeliveredMessages(window, triggerMessage);
        if (undeliveredMessages.length === 0) return false;

        const targetMessageIds = undeliveredMessages.map((item) => item.messageId);
        const contextSnapshot: GroupContextPackage = {
            depth: 2,
            chatId,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: subagent.buildQueueEntry("DIRECT_ADDRESS").topicDigests,
            engagementScore: subagent.observer.getEngagementScore(),
            chatTitle: String(window.chatTitle ?? window.callbacks[0]?.chatTitle ?? ""),
            isDirectMessage: Boolean(window.isDirectMessage ?? window.callbacks[0]?.isDirectMessage),
            lastCallbacks: window.callbacks.slice(-3),
            toneGuidance: "自然、简短，优先像刚被人叫住时那样接一句。",
            contentDirection: options.contentDirection,
        };
        const task: CodeActReplyTask = {
            type: "CODEACT_REPLY",
            chatId,
            taskId: prefixedShortUuid("post-task-"),
            decisions: [{
                action: "REPLY",
                reason: options.decisionReason,
                confidence: 1,
                contentDirection: options.contentDirection,
                targetMessageIds,
                toneGuidance: contextSnapshot.toneGuidance,
            }],
            contextSnapshot,
            replyMode: "SINGLE",
            createdAt: new Date().toISOString(),
            targetMessageIds,
            replyStrategy: "DIRECT_REPLY",
            continuationPrompt: formatPostTaskContinuationPrompt(
                undeliveredMessages,
                options.directReason,
                options.classifierReason,
            ),
            continuationMessages: undeliveredMessages,
            continuationReason: options.directReason,
            continuationClassifierReason: options.classifierReason,
            skipRefreshTaskMessages: true,
        };

        executor.enqueue(task);
        for (const item of undeliveredMessages) {
            window.deliveredMessageIds.add(item.messageId);
            window.triagedMessageIds.add(item.messageId);
        }
        this.onDirectTaskEnqueued?.(task);
        log.info("post-task window messages forwarded to subagent", {
            chatId,
            taskId: task.taskId,
            directReason: options.directReason,
            logKind: options.logKind,
            messageIds: targetMessageIds,
        });
        return true;
    }

    private scheduleFollowUpCheck(window: ActivePostTaskWindow, delayMs = this.followUpCheckIntervalMs): void {
        if (!this.followUpJudge || this.followUpCheckIntervalMs <= 0) return;
        if (window.followUpTimer) return;
        const maxDelayMs = window.maxFlushAtMs - Date.now();
        if (maxDelayMs <= 0) return;
        window.followUpTimer = setTimeout(() => {
            void this.checkFollowUpBatch(window.chatId);
        }, Math.max(0, Math.min(delayMs, maxDelayMs)));
        if (window.followUpTimer.unref) window.followUpTimer.unref();
    }

    private async checkFollowUpBatch(chatId: string): Promise<void> {
        const window = this.windows.get(chatId);
        if (!window || !this.followUpJudge) return;
        window.followUpTimer = null;

        if (window.followUpCheckInFlight) {
            this.scheduleFollowUpCheck(window, IDLE_RECHECK_MS);
            return;
        }

        const subagent = this.subagentManager.get(chatId);
        const executor = subagent?.codeActExecutor as ExecutorLike | null | undefined;
        const isBusy = Boolean(executor?.isProcessing?.()) || (executor?.getQueueSize?.() ?? 0) > 0;
        if (isBusy) {
            this.scheduleFollowUpCheck(window, IDLE_RECHECK_MS);
            return;
        }

        const pendingDirect = window.messages.find((message) =>
            message.isDirectAttention && !window.deliveredMessageIds.has(message.messageId)
        );
        if (pendingDirect) {
            this.forwardWindowMessages(window, pendingDirect, {
                directReason: pendingDirect.directReason ?? "direct",
                decisionReason: `Post-task L0 direct attention: ${pendingDirect.directReason ?? "direct"}`,
                contentDirection: "Post-task window 内有人直接叫住你、回复你或提及你。请自然判断是否需要补一轮。",
                logKind: "direct",
            });
            if (hasUntriagedMessages(window)) this.scheduleFollowUpCheck(window);
            return;
        }

        const candidates = window.messages.filter((message) =>
            !window.deliveredMessageIds.has(message.messageId) &&
            !window.triagedMessageIds.has(message.messageId)
        );
        if (candidates.length === 0) return;

        window.followUpCheckInFlight = true;
        try {
            const recentMessages = await this.loadRecentContextMessages(chatId, candidates);
            const decision = await this.followUpJudge({
                chatId,
                chatTitle: window.chatTitle ?? window.callbacks[0]?.chatTitle,
                isDirectMessage: window.isDirectMessage ?? window.callbacks[0]?.isDirectMessage,
                recentMessages,
                sentMessages: window.sentMessages,
                callbacks: window.callbacks.slice(-3),
                messages: candidates,
                stickerDescriptionLookup: this.stickerDescriptionLookup,
                downloadFn: this.downloadFnProvider?.(chatId),
                mediaDownloader: this.mediaDownloader,
            });
            if (this.windows.get(chatId) !== window) return;

            for (const message of candidates) {
                window.triagedMessageIds.add(message.messageId);
            }

            if (!decision.hasFollowUp) {
                log.debug("post-task follow-up classifier: no follow-up", {
                    chatId,
                    messages: candidates.length,
                    reason: decision.reason,
                });
                return;
            }

            const triggerMessage = candidates.find((message) => message.messageId === decision.triggerMessageId)
                ?? candidates[candidates.length - 1];
            this.forwardWindowMessages(window, triggerMessage, {
                directReason: "llm-followup",
                decisionReason: `Post-task follow-up classifier: ${decision.reason ?? "follow-up detected"}`,
                contentDirection: "Post-task window 内出现了可能针对你刚才发言的 follow-up。请像被自然接住话题一样判断是否需要补一轮。",
                classifierReason: decision.reason,
                logKind: "follow-up",
            });
        } catch (err) {
            for (const message of candidates) {
                window.triagedMessageIds.add(message.messageId);
            }
            log.warn("post-task follow-up classifier failed", {
                chatId,
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            window.followUpCheckInFlight = false;
            if (this.windows.get(chatId) === window && hasUntriagedMessages(window)) {
                this.scheduleFollowUpCheck(window);
            }
        }
    }

    private async loadRecentContextMessages(
        chatId: string,
        excludedMessages: PostTaskReactionMessage[],
    ): Promise<PostTaskReactionMessage[]> {
        if (!this.recentMessagesProvider) return [];
        const excludedIds = new Set(excludedMessages.map((message) => message.messageId));
        try {
            const messages = await this.recentMessagesProvider(
                chatId,
                FOLLOW_UP_CONTEXT_MESSAGE_LIMIT + excludedIds.size,
            );
            return messages
                .filter((message) => !excludedIds.has(message.messageId))
                .slice(-FOLLOW_UP_CONTEXT_MESSAGE_LIMIT);
        } catch (err) {
            log.warn("post-task follow-up context load failed", {
                chatId,
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        }
    }

    private scheduleFlush(window: ActivePostTaskWindow, delayMs: number): void {
        if (window.timer) clearTimeout(window.timer);
        const maxDelayMs = Math.max(0, window.maxFlushAtMs - Date.now());
        window.timer = setTimeout(() => {
            this.flushIfIdle(window.chatId);
        }, Math.max(0, Math.min(delayMs, maxDelayMs)));
        if (window.timer.unref) window.timer.unref();
    }

    private flushIfIdle(chatId: string): void {
        const window = this.windows.get(chatId);
        if (!window) return;

        const now = Date.now();
        const isExpired = now >= window.maxFlushAtMs;
        const subagent = this.subagentManager.get(chatId);
        const executor = subagent?.codeActExecutor as ExecutorLike | null | undefined;
        const isBusy = Boolean(executor?.isProcessing?.()) || (executor?.getQueueSize?.() ?? 0) > 0;
        if (isBusy && !isExpired) {
            this.scheduleFlush(window, IDLE_RECHECK_MS);
            return;
        }
        if (window.callbacks.length === 0) {
            if (isExpired) {
                this.windows.delete(chatId);
                if (window.timer) clearTimeout(window.timer);
                if (window.followUpTimer) clearTimeout(window.followUpTimer);
                this.accumulator.unblock(chatId);
                log.warn("post-task window expired without callback; unblocked chat", {
                    chatId,
                    durationMs: now - window.startedAtMs,
                    messages: window.messages.length,
                });
                return;
            }
            this.scheduleFlush(window, IDLE_RECHECK_MS);
            return;
        }
        if (isBusy && isExpired) {
            log.warn("post-task window force flushed while executor busy", {
                chatId,
                callbacks: window.callbacks.length,
                durationMs: now - window.startedAtMs,
            });
        }

        this.windows.delete(chatId);
        if (window.timer) clearTimeout(window.timer);
        if (window.followUpTimer) clearTimeout(window.followUpTimer);
        const callback = this.buildCallback(window);
        this.accumulator.unblock(chatId);
        this.callbackQueue.enqueue(callback);

        log.info("post-task window flushed", {
            chatId,
            taskId: callback.taskId,
            messages: callback.postTaskMessages?.length ?? 0,
            followUps: callback.postTaskFollowUpCallbacks?.length ?? 0,
        });
    }

    private buildCallback(window: ActivePostTaskWindow): SubagentCallback {
        const [primary, ...followUps] = window.callbacks;
        const endedAtMs = Date.now();
        return {
            ...primary,
            postTaskMessages: window.messages,
            postTaskFollowUpCallbacks: followUps.map(toFollowUpCallback),
            postTaskWindow: {
                startedAt: window.startedAtMs,
                endedAt: endedAtMs,
                durationMs: endedAtMs - window.startedAtMs,
                messageCount: window.messages.length,
                directMessageCount: window.messages.filter((msg) => msg.isDirectAttention).length,
                followUpCallbackCount: followUps.length,
            },
        };
    }
}

function rememberSentEventMessage(window: ActivePostTaskWindow, event: NotificationEvent): void {
    const messageId = event.messageId ?? event.id;
    upsertSentMessage(window, {
        messageId: messageId != null ? String(messageId) : undefined,
        text: String(event.text ?? event.message ?? ""),
        timestamp: String(event.timestamp ?? event._ts ?? new Date().toISOString()),
    });
}

function rememberWindowChatMetadata(
    window: ActivePostTaskWindow,
    source: unknown,
): void {
    const meta = source as { chatTitle?: unknown; isDirectMessage?: unknown };
    if (meta.chatTitle != null && String(meta.chatTitle).trim()) {
        window.chatTitle = String(meta.chatTitle);
    }
    if (meta.isDirectMessage != null) {
        window.isDirectMessage = Boolean(meta.isDirectMessage);
    }
}

function upsertSentMessage(window: ActivePostTaskWindow, sent: PostTaskSentMessage): void {
    if (sent.messageId) {
        window.sentMessageIds.add(sent.messageId);
        const existing = window.sentMessages.find((item) => item.messageId === sent.messageId);
        if (existing) {
            existing.text = sent.text || existing.text;
            existing.timestamp = sent.timestamp || existing.timestamp;
            return;
        }
    }
    window.sentMessages.push(sent);
}

function hasUntriagedMessages(window: ActivePostTaskWindow): boolean {
    return window.messages.some((message) =>
        !window.deliveredMessageIds.has(message.messageId) &&
        !window.triagedMessageIds.has(message.messageId)
    );
}

function toFollowUpCallback(callback: SubagentCallback): SubagentPostTaskFollowUpCallback {
    return {
        taskId: callback.taskId,
        status: callback.status,
        summary: callback.summary,
        sentMessages: callback.sentMessages,
        error: callback.error,
        durationMs: callback.durationMs,
        createdAt: callback.createdAt,
        contentDirection: callback.contentDirection,
    };
}

function toReactionMessage(
    event: NotificationEvent,
    options?: { isDirectAttention?: boolean; directReason?: string },
): PostTaskReactionMessage {
    return {
        messageId: String(event.messageId ?? event.id ?? event._id ?? `msg_${Date.now()}`),
        sender: String(event.displayName ?? event.senderName ?? event.userName ?? event.userId ?? event.senderId ?? "?"),
        text: String(event.text ?? event.message ?? ""),
        timestamp: String(event.timestamp ?? event._ts ?? new Date().toISOString()),
        isDirectAttention: options?.isDirectAttention,
        directReason: options?.directReason,
        replyToMessageId: event.replyToMessageId != null ? String(event.replyToMessageId) : undefined,
        mediaType: (event as { mediaInfo?: { type?: unknown } }).mediaInfo?.type != null
            ? String((event as { mediaInfo?: { type?: unknown } }).mediaInfo?.type)
            : undefined,
        mediaInfo: event.mediaInfo != null ? JSON.stringify(event.mediaInfo) : undefined,
    };
}

function ensureWindowMessage(
    window: ActivePostTaskWindow,
    event: NotificationEvent,
    options?: { isDirectAttention?: boolean; directReason?: string },
): PostTaskReactionMessage {
    const messageId = String(event.messageId ?? event.id ?? event._id ?? `msg_${Date.now()}`);
    const existing = window.messages.find((item) => item.messageId === messageId);
    if (existing) {
        existing.isDirectAttention = options?.isDirectAttention ?? existing.isDirectAttention;
        existing.directReason = options?.directReason ?? existing.directReason;
        return existing;
    }

    const message = toReactionMessage(event, options);
    window.messages.push(message);
    return message;
}

function collectUndeliveredMessages(
    window: ActivePostTaskWindow,
    triggerMessage: PostTaskReactionMessage,
): PostTaskReactionMessage[] {
    const selected = window.messages.filter((item) => !window.deliveredMessageIds.has(item.messageId));
    if (!selected.some((item) => item.messageId === triggerMessage.messageId)) {
        selected.push(triggerMessage);
    }
    return selected;
}

function formatPostTaskContinuationPrompt(
    messages: PostTaskReactionMessage[],
    directReason: string,
    classifierReason?: string,
): string {
    const lines = messages.map((message) => formatReactionMessageLine(message));
    return [
        "[📩 新消息到达]",
        ...lines,
        "",
        `[post-task direct attention: ${directReason}]${classifierReason ? ` 判定原因: ${classifierReason}` : ""} 请基于上下文决定如何行动。`,
    ].join("\n");
}

function formatReactionMessageLine(
    message: PostTaskReactionMessage,
    stickerDescriptionLookup?: StickerDescriptionLookup,
): string {
    return formatMessageLine({
        id: message.messageId,
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp,
        replyTo: message.replyToMessageId ? `msg#${message.replyToMessageId}` : undefined,
        replyToMsgId: message.replyToMessageId,
        mediaType: message.mediaType,
        mediaInfo: message.mediaInfo,
    }, { includeMediaTags: true, stickerDescriptionLookup });
}

async function judgePostTaskFollowUpWithLLM(input: PostTaskFollowUpJudgeInput): Promise<PostTaskFollowUpJudgeResult> {
    const config = loadConfig();
    const hasDedicatedRoute = config.llmRouting.post_task_followup != null;
    const profiles = hasDedicatedRoute
        ? resolveComponentProfiles("post_task_followup", config)
        : resolveComponentProfiles("recording_triage", config);
    const timeoutMs = hasDedicatedRoute
        ? (resolveComponentTimeout("post_task_followup", config) ?? 15_000)
        : (resolveComponentTimeout("recording_triage", config) ?? 15_000);
    const personaName = config.persona?.name ?? "agent";
    // 开关：是否在 follow-up 判定中识别图片（默认开启）。关闭时不传 downloadFn，
    // enrichMessages 走纯占位文本路径，跳过下载/识别/内联。
    const recognizeImages = config.subagent?.postTaskFollowUpImageRecognition !== false;
    const enrichConfig = resolvePostTaskFollowUpEnrichConfig(config, profiles, {
        downloadFn: recognizeImages ? input.downloadFn : undefined,
        mediaDownloader: recognizeImages ? input.mediaDownloader : undefined,
    });

    const { content, imageParts } = await buildFollowUpJudgePrompt(input, enrichConfig);
    const userMessage: ChatMessage = { role: "user", content };
    // 路径 A（判定 profile 自身支持 vision）时 enrichMessages 会内联 base64 图片，附加给 LLM
    if (imageParts.length > 0) {
        userMessage.imageParts = imageParts;
    }
    const llmMessages: ChatMessage[] = [
        { role: "system", content: getPostTaskFollowUpPrompt(personaName) },
        userMessage,
    ];
    const response = await callLLMWithFallback(llmMessages, profiles, {
        caller: "post-task-followup",
        component: hasDedicatedRoute ? "post_task_followup" : "recording_triage",
        timeoutMs,
    });
    return parseFollowUpJudgeResult(response.content);
}

function getPostTaskFollowUpPrompt(personaName: string): string {
    const template = loadPromptFile(POST_TASK_FOLLOWUP_PROMPT_PATH) ?? DEFAULT_POST_TASK_FOLLOWUP_PROMPT;
    return renderTemplate(template, { personaName }).trim();
}

/**
 * 构建 follow-up 判定的 user prompt + 附带图片。
 *
 * - 最近 20 条上下文消息：仅做轻量缓存格式化（不下载/识别），避免无谓开销。
 * - 本批次新消息：当配置了 downloadFn 时识别图片；若判定 profile 支持 vision（路径 A），
 *   则收集内联 base64 图片随 prompt 一起送给 LLM。
 */
export async function buildFollowUpJudgePrompt(
    input: PostTaskFollowUpJudgeInput,
    enrichConfig: PostTaskFollowUpEnrichConfig = resolvePostTaskFollowUpEnrichConfig(),
): Promise<{ content: string; imageParts: ImagePart[] }> {
    const imageParts: ImagePart[] = [];
    const recentLines = input.recentMessages?.length
        ? await enrichFollowUpJudgeMessages(
            input.recentMessages.slice(-FOLLOW_UP_CONTEXT_MESSAGE_LIMIT),
            input,
            enrichConfig,
        )
        : "(无可用上下文)";
    const callbackLines = input.callbacks.length > 0
        ? input.callbacks.map((callback) => [
            `- taskId=${callback.taskId}, status=${callback.status}`,
            callback.contentDirection ? `  contentDirection=${callback.contentDirection}` : "",
            formatCallbackDigestLine(callback.summary),
        ].filter(Boolean).join("\n")).join("\n")
        : "(暂无 callback)";
    const messageLines = input.messages.length
        ? await enrichFollowUpJudgeMessages(input.messages, input, enrichConfig, { processMedia: true, imageParts })
        : "(无新消息)";
    const content = [
        `chatId: ${input.chatId}`,
        input.chatTitle ? `chatTitle: ${input.chatTitle}` : "",
        `isDirectMessage: ${input.isDirectMessage ? "true" : "false"}`,
        "",
        "## 最近 20 条上下文消息",
        recentLines,
        "",
        "## 最近 callback 摘要",
        callbackLines,
        "",
        "## 本 5 秒批次内的新消息",
        messageLines,
        "",
        "请判断这批新消息中是否出现 follow-up。triggerMessageId 必须来自上方 [msgId:...]。",
    ].filter(Boolean).join("\n");
    return { content, imageParts };
}

export async function formatFollowUpJudgeInput(
    input: PostTaskFollowUpJudgeInput,
    enrichConfig: PostTaskFollowUpEnrichConfig = resolvePostTaskFollowUpEnrichConfig(),
): Promise<string> {
    return (await buildFollowUpJudgePrompt(input, enrichConfig)).content;
}

function resolvePostTaskFollowUpEnrichConfig(
    config: AppConfig = loadConfig(),
    judgeProfiles?: LLMConfig[],
    extra?: { downloadFn?: DownloadFn; mediaDownloader?: MediaDownloader },
): PostTaskFollowUpEnrichConfig {
    const llmConfig = judgeProfiles?.[0]
        ?? (config.llmRouting.post_task_followup != null
            ? resolveComponentProfiles("post_task_followup", config)[0]
            : resolveComponentProfiles("recording_triage", config)[0]);
    if (!llmConfig) {
        throw new Error("No LLM profile configured for post-task follow-up formatting");
    }
    return {
        llmConfig,
        visionConfig: config.vision,
        visionLlmConfig: config.llmRouting.vision
            ? resolveComponentProfiles("vision", config)
            : undefined,
        downloadFn: extra?.downloadFn,
        mediaDownloader: extra?.mediaDownloader,
    };
}

async function enrichFollowUpJudgeMessages(
    messages: PostTaskReactionMessage[],
    input: PostTaskFollowUpJudgeInput,
    enrichConfig: PostTaskFollowUpEnrichConfig,
    options?: { processMedia?: boolean; imageParts?: ImagePart[] },
): Promise<string> {
    const rawMessages = messages.map((message): RawMessage => ({
        id: message.messageId,
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp,
        replyTo: message.replyToMessageId ? `msg#${message.replyToMessageId}` : undefined,
        replyToMsgId: message.replyToMessageId,
        mediaType: message.mediaType,
        mediaInfo: message.mediaInfo,
        chatId: input.chatId,
    }));
    // 只有在配置了 downloadFn 且针对新批次消息时，才启用图片识别管线（识别 + 路径 A 内联）。
    // 上下文消息与无下载能力时保持轻量缓存格式化，避免下载所有历史图片。
    const enableMedia = Boolean(options?.processMedia && enrichConfig.downloadFn);
    const enriched = await enrichMessages(rawMessages, {
        llmConfig: enrichConfig.llmConfig,
        visionConfig: enrichConfig.visionConfig,
        visionLlmConfig: enrichConfig.visionLlmConfig,
        downloadFn: enableMedia ? enrichConfig.downloadFn : undefined,
        mediaDownloader: enableMedia ? enrichConfig.mediaDownloader : undefined,
        chatId: input.chatId,
        stickerDescriptionLookup: input.stickerDescriptionLookup,
        enableMediaProcessing: enableMedia,
        enableMediaDownload: enableMedia,
        enableOgPreview: false,
    });
    if (options?.imageParts && enriched.imageParts.length > 0) {
        options.imageParts.push(...enriched.imageParts);
    }
    return enriched.formattedText;
}

function formatCallbackDigestLine(summary?: string): string {
    const digest = extractLatestSessionDigest(summary);
    return digest ? `  sessionDigest=${digest}` : "";
}

function extractLatestSessionDigest(summary?: string): string | undefined {
    const trimmed = summary?.trim();
    if (!trimmed) return undefined;
    const re = /\[SESSION_DIGEST\]([\s\S]*?)(?:\[\/SESSION_DIGEST\]|$)/g;
    let latest: string | undefined;
    let match: RegExpExecArray | null;
    while ((match = re.exec(trimmed)) !== null) {
        const value = match[1]?.trim();
        if (value) latest = value;
    }
    return latest;
}

function parseFollowUpJudgeResult(raw: string): PostTaskFollowUpJudgeResult {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
        const firstBrace = cleaned.indexOf("{");
        const lastBrace = cleaned.lastIndexOf("}");
        if (firstBrace < 0 || lastBrace <= firstBrace) {
            throw new Error(`invalid follow-up classifier JSON: ${cleaned.slice(0, 160)}`);
        }
        parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as Record<string, unknown>;
    }

    const hasFollowUpRaw = parsed.hasFollowUp ?? parsed.has_follow_up ?? parsed.followUp ?? parsed.follow_up;
    return {
        hasFollowUp: hasFollowUpRaw === true || hasFollowUpRaw === "true",
        reason: parsed.reason != null ? String(parsed.reason) : undefined,
        triggerMessageId: (parsed.triggerMessageId ?? parsed.trigger_message_id) != null
            ? String(parsed.triggerMessageId ?? parsed.trigger_message_id)
            : undefined,
    };
}

export function buildDispatchedRecordForPostTaskDirect(task: CodeActReplyTask): DispatchedSubagentTaskRecord {
    return {
        taskId: task.taskId,
        chatId: task.chatId,
        contentDirection: task.contextSnapshot.contentDirection ?? task.decisions[0]?.contentDirection ?? "post-task direct follow-up",
        toneGuidance: task.contextSnapshot.toneGuidance,
        status: "PENDING",
        createdAt: task.createdAt,
        updatedAt: task.createdAt,
    };
}
