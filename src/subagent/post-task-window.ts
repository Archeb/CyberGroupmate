/**
 * post-task-window.ts — Subagent 发言后的短时发酵窗口
 *
 * Subagent 发完消息后，先暂缓把 callback 交给 Meta。
 * 窗口内普通群聊只记录，L0/direct attention 直接交给同群 subagent 补一轮。
 */

import { randomUUID } from "node:crypto";
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

const log = createLogger("post-task-window");

const DEFAULT_WINDOW_MS = 120_000;
const IDLE_RECHECK_MS = 2_000;
const MIN_MAX_WINDOW_MS = 5 * 60_000;

interface ExecutorLike {
    enqueue(task: CodeActReplyTask): void;
    isProcessing?(): boolean;
    getQueueSize?(): number;
}

interface ActivePostTaskWindow {
    chatId: string;
    startedAtMs: number;
    flushAtMs: number;
    maxFlushAtMs: number;
    callbacks: SubagentCallback[];
    messages: PostTaskReactionMessage[];
    sentMessageIds: Set<string>;
    deliveredMessageIds: Set<string>;
    timer: ReturnType<typeof setTimeout> | null;
}

export interface PostTaskWindowManagerOptions {
    windowMs?: number;
    maxWindowMs?: number;
    callbackQueue: CallbackQueue;
    accumulator: Pick<AttentionAccumulator, "block" | "unblock">;
    subagentManager: Pick<SubagentManager, "get">;
    onDirectTaskEnqueued?: (task: CodeActReplyTask) => void;
}

export class PostTaskWindowManager {
    private readonly windowMs: number;
    private readonly maxWindowMs: number;
    private readonly callbackQueue: CallbackQueue;
    private readonly accumulator: Pick<AttentionAccumulator, "block" | "unblock">;
    private readonly subagentManager: Pick<SubagentManager, "get">;
    private readonly onDirectTaskEnqueued?: (task: CodeActReplyTask) => void;
    private readonly windows = new Map<string, ActivePostTaskWindow>();

    constructor(options: PostTaskWindowManagerOptions) {
        this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
        this.maxWindowMs = options.maxWindowMs ?? Math.max(MIN_MAX_WINDOW_MS, this.windowMs * 3);
        this.callbackQueue = options.callbackQueue;
        this.accumulator = options.accumulator;
        this.subagentManager = options.subagentManager;
        this.onDirectTaskEnqueued = options.onDirectTaskEnqueued;
    }

    handleSentMessage(chatId: string, event: NotificationEvent): void {
        if (this.windowMs <= 0) return;

        const existing = this.windows.get(chatId);
        if (existing) {
            rememberEventMessageId(existing.sentMessageIds, event);
            existing.flushAtMs = Date.now() + this.windowMs;
            this.scheduleFlush(existing, this.windowMs);
            return;
        }

        const startedAtMs = Date.now();
        const window: ActivePostTaskWindow = {
            chatId,
            startedAtMs,
            flushAtMs: startedAtMs + this.windowMs,
            maxFlushAtMs: startedAtMs + this.maxWindowMs,
            callbacks: [],
            messages: [],
            sentMessageIds: new Set<string>(),
            deliveredMessageIds: new Set<string>(),
            timer: null,
        };
        rememberEventMessageId(window.sentMessageIds, event);
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
            this.rememberSentMessageIds(existing, callback);
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
            startedAtMs,
            flushAtMs: startedAtMs + this.windowMs,
            maxFlushAtMs: startedAtMs + this.maxWindowMs,
            callbacks: [callback],
            messages: [],
            sentMessageIds: new Set<string>(),
            deliveredMessageIds: new Set<string>(),
            timer: null,
        };
        this.rememberSentMessageIds(window, callback);
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
        window.messages.push(toReactionMessage(event, options));
    }

    tryForwardDirectMessage(chatId: string, event: NotificationEvent, directReason: string): boolean {
        const window = this.windows.get(chatId);
        if (!window) return false;

        const subagent = this.subagentManager.get(chatId);
        const executor = subagent?.codeActExecutor as ExecutorLike | null | undefined;
        if (!subagent || !executor) {
            log.warn("direct message in post-task window has no executor", { chatId, directReason });
            return false;
        }

        const message = ensureWindowMessage(window, event, { isDirectAttention: true, directReason });
        const undeliveredMessages = collectUndeliveredMessages(window, message);
        const targetMessageIds = undeliveredMessages.map((item) => item.messageId);
        const contentDirection = [
            "Post-task window 内有人直接叫住你、回复你或提及你。请自然判断是否需要补一轮。",
        ].join("");
        const contextSnapshot: GroupContextPackage = {
            depth: 2,
            chatId,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: subagent.buildQueueEntry("DIRECT_ADDRESS").topicDigests,
            engagementScore: subagent.observer.getEngagementScore(),
            chatTitle: String(event.chatTitle ?? window.callbacks[0]?.chatTitle ?? ""),
            isDirectMessage: Boolean(event.isDirectMessage ?? window.callbacks[0]?.isDirectMessage),
            lastCallbacks: window.callbacks.slice(-3),
            toneGuidance: "自然、简短，优先像刚被人叫住时那样接一句。",
            contentDirection,
        };
        const task: CodeActReplyTask = {
            type: "CODEACT_REPLY",
            chatId,
            taskId: `post-task-${randomUUID()}`,
            decisions: [{
                action: "REPLY",
                reason: `Post-task L0 direct attention: ${directReason}`,
                confidence: 1,
                contentDirection,
                targetMessageIds,
                toneGuidance: contextSnapshot.toneGuidance,
            }],
            contextSnapshot,
            replyMode: "SINGLE",
            createdAt: new Date().toISOString(),
            targetMessageIds,
            replyStrategy: "DIRECT_REPLY",
            continuationPrompt: formatPostTaskContinuationPrompt(undeliveredMessages, directReason),
            skipRefreshTaskMessages: true,
        };

        executor.enqueue(task);
        for (const item of undeliveredMessages) {
            window.deliveredMessageIds.add(item.messageId);
        }
        this.onDirectTaskEnqueued?.(task);
        log.info("direct message forwarded to subagent during post-task window", {
            chatId,
            taskId: task.taskId,
            directReason,
            messageIds: targetMessageIds,
        });
        return true;
    }

    dispose(): void {
        for (const window of this.windows.values()) {
            if (window.timer) clearTimeout(window.timer);
            this.accumulator.unblock(window.chatId);
        }
        this.windows.clear();
    }

    private shouldDelay(callback: SubagentCallback): boolean {
        return (callback.sentMessages?.length ?? 0) > 0;
    }

    private rememberSentMessageIds(window: ActivePostTaskWindow, callback: SubagentCallback): void {
        for (const sent of callback.sentMessages ?? []) {
            if (sent.messageId) {
                window.sentMessageIds.add(String(sent.messageId));
            }
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
                startedAt: new Date(window.startedAtMs).toISOString(),
                endedAt: new Date(endedAtMs).toISOString(),
                durationMs: endedAtMs - window.startedAtMs,
                messageCount: window.messages.length,
                directMessageCount: window.messages.filter((msg) => msg.isDirectAttention).length,
                followUpCallbackCount: followUps.length,
            },
        };
    }
}

function rememberEventMessageId(sentMessageIds: Set<string>, event: NotificationEvent): void {
    const messageId = event.messageId ?? event.id;
    if (messageId != null) {
        sentMessageIds.add(String(messageId));
    }
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

function formatPostTaskContinuationPrompt(messages: PostTaskReactionMessage[], directReason: string): string {
    const lines = messages.map((message) => formatReactionMessageLine(message));
    return [
        "[📩 新消息到达]",
        ...lines,
        "",
        `[post-task direct attention: ${directReason}] 这些消息发生在你刚完成上一轮任务后的发酵窗口内，其中有人直接叫住你、回复你或提及你。请基于上一轮会话、刚才发出的内容和上面所有尚未处理的新消息判断是否需要简短回应；需要时调用 sendMessage/sendSticker，不需要则直接结束，不要硬接。`,
    ].join("\n");
}

function formatReactionMessageLine(message: PostTaskReactionMessage): string {
    const mediaSuffix = message.mediaType
        ? ` [${message.mediaType}${message.mediaInfo ? ` ${message.mediaInfo}` : ""}]`
        : "";
    const replySuffix = message.replyToMessageId ? ` (replyTo=${message.replyToMessageId})` : "";
    const text = message.text || "[non-text message]";
    return `[${message.timestamp}] [msgId:${message.messageId}] ${message.sender}${replySuffix}: ${text}${mediaSuffix}`;
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
