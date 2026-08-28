/**
 * main-agent-loop.ts — 主 Agent Meta-CodeAct 循环
 *
 * 当前实现：
 * 1. drain Q5 callbacks
 * 2. flush AttentionAccumulator
 * 3. 将整组 AttentionSet 交给单一 Meta session handler
 * 4. 持久化 session digest / global state
 */

import { CallbackQueue } from "../subagent/callback-queue.js";
import { SubagentManager } from "../subagent/subagent-manager.js";
import { GlobalState } from "./global-state.js";
import type {
    AttentionQueueEntry,
    CodeActReplyTask,
    DispatchedSubagentTaskRecord,
    SubagentCallback,
    AttendResult,
    Decision,
} from "../subagent/types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "../subagent/types.js";
import type { AttentionItem } from "../accumulator/types.js";
import { AttentionAccumulator } from "../accumulator/attention-accumulator.js";
import { createLogger } from "../core/logger.js";
import { ensureCompositeId, getPlatform } from "../core/chat-id.js";
import { buildWakeConditionPayload, matchCallbackWakeConditions } from "./wake-conditions.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";
import { markChatAsRead } from "../adapter/read-receipts.js";
import type { MetaSessionHandler } from "./meta-session-handler.js";
import { shortUuid } from "../core/ids.js";
import { truncateForPrompt } from "../core/text-safety.js";
import type { HarnessNotify } from "../harness/types.js";

const log = createLogger("main-agent-loop");
const DISPATCH_SOURCE_NOTIFICATION_TASK_PREFIX = "dispatch-notify:";

/** 主循环配置 */
export interface MainAgentLoopConfig {
    /** 轮询间隔 (ms)。默认 5000 */
    pollInterval: number;
}

const DEFAULT_LOOP_CONFIG: MainAgentLoopConfig = {
    pollInterval: DEFAULT_SUBAGENT_CONFIG.pollInterval,
};

const PROACTIVE_IDLE_INITIAL_DELAY_MS = 15 * 60 * 1000;
const PROACTIVE_IDLE_REPEAT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * MainAgentLoop — 主 Agent Meta-CodeAct 循环
 */
export class MainAgentLoop {
    private config: MainAgentLoopConfig;

    /** 依赖组件 */
     private accumulator: AttentionAccumulator;
    private callbackQueue: CallbackQueue;
    private subagentManager: SubagentManager;
    private globalState: GlobalState | null;
    private adapters: PlatformAdapter[];

    /** 循环状态 */
    private running = false;
    private tickCount = 0;
    private lastTickAt: number = 0;
    private lastNonIdleActivityAt: number = Date.now();
    private lastProactiveIdleAt: number = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    /** Circuit Breaker — 主 LLM 不可用时暂停 attend */
    private circuitBreakerOpenUntil: number = 0;
    private circuitBreakerBackoff: number = 30_000; // 初始 30s
    private static readonly CB_MAX_BACKOFF = 10 * 60_000; // 最大 10min

    /** 外部 Meta session handler */
    private metaSessionHandler: MetaSessionHandler | null = null;

    /** attend 完成后的回调（metrics 使用） */
    private onAttendCompleteCallback: ((chatId: string, decisions: AttendResult) => void) | null = null;
    private proactiveIdleHandler: ((payload: { id: string; description: string; enqueuedAt: number }) => boolean) | null = null;
    private harnessDispatchCallbackHandler: ((payload: HarnessNotify) => boolean) | null = null;

    constructor(
        accumulator: AttentionAccumulator,
        callbackQueue: CallbackQueue,
        subagentManager: SubagentManager,
        config?: Partial<MainAgentLoopConfig>,
        globalState?: GlobalState | null,
        adapters?: PlatformAdapter[],
    ) {
        this.accumulator = accumulator;
        this.callbackQueue = callbackQueue;
        this.subagentManager = subagentManager;
        this.globalState = globalState ?? null;
        this.adapters = adapters ?? [];
        this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    }

    /**
     * 设置 Meta session handler
     */
    setMetaSessionHandler(handler: MetaSessionHandler): void {
        this.metaSessionHandler = handler;
    }

    resetMetaSessionContext(): boolean {
        if (!this.metaSessionHandler?.resetMetaSessionContext) {
            return false;
        }
        this.metaSessionHandler.resetMetaSessionContext();
        return true;
    }



    /**
     * 设置 attend 完成回调（metrics 使用）
     */
    setOnAttendComplete(fn: (chatId: string, result: AttendResult) => void): void {
        this.onAttendCompleteCallback = fn;
    }

    /**
     * 启动主循环
     */
    start(): void {
        if (this.running) return;
        this.running = true;
        log.info("start: 主循环启动", { pollInterval: this.config.pollInterval });
        this.scheduleNext();
    }

    /**
     * 停止主循环
     */
    stop(): void {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        log.info("stop: 主循环停止", { tickCount: this.tickCount });
    }

    /**
     * 触发熔断（attend-handler 在 LLM 配额耗尽时调用）。
     * 熔断期间 tick() 跳过 Phase 3-6（不 attend），仅处理 callback。
     * 每次熔断时间指数递增，最大 10 分钟。
     */
    tripCircuitBreaker(reason: string): void {
        this.circuitBreakerOpenUntil = Date.now() + this.circuitBreakerBackoff;
        log.error("Circuit breaker OPEN", {
            backoffMs: this.circuitBreakerBackoff,
            until: new Date(this.circuitBreakerOpenUntil).toISOString(),
            reason: reason.slice(0, 100),
        });
        // 指数退避
        this.circuitBreakerBackoff = Math.min(
            this.circuitBreakerBackoff * 2,
            MainAgentLoop.CB_MAX_BACKOFF,
        );
    }

    /**
     * 重置熔断器（attend-handler 在 LLM 成功时调用）
     */
    resetCircuitBreaker(): void {
        if (this.circuitBreakerBackoff > 30_000) {
            log.info("Circuit breaker RESET", { previousBackoffMs: this.circuitBreakerBackoff });
        }
        this.circuitBreakerOpenUntil = 0;
        this.circuitBreakerBackoff = 30_000;
    }

    /**
     * 执行一个 tick（适用于手动调用/测试）
     */
    async tick(): Promise<{
        phase1Callbacks: number;
        phase2Eval: { activeCount: number; blockedCount: number };
        phase3Attended: string[];
        phase4MetaEndReason: string | null;
        phase5Decisions: AttendResult[];
    }> {
        this.tickCount++;
        this.lastTickAt = Date.now();
        log.debug("tick: 开始", { tickCount: this.tickCount });

        // ═══ Phase 1: Drain Callbacks (Q5) ═══
        const callbacks = this.callbackQueue.drain();
        if (callbacks.length > 0) {
            this.lastNonIdleActivityAt = Date.now();
        }
        for (const cb of callbacks) {
            const cbSubagent = this.subagentManager.get(cb.chatId);
            if (cbSubagent) {
                cbSubagent.markTaskComplete(cb.taskId);
                cbSubagent.addCallback(cb);
            }
            this.accumulator.unblock(cb.chatId);
            const isDispatchSourceNotification = cb.taskId.startsWith(DISPATCH_SOURCE_NOTIFICATION_TASK_PREFIX);
            let dispatchedTask: DispatchedSubagentTaskRecord | null | undefined;

            if (this.globalState && !isDispatchSourceNotification) {
                dispatchedTask = this.globalState.getDispatchedSubagentTask(cb.taskId);
                if (dispatchedTask) {
                    this.globalState.addSessionDigest(formatDispatchCompletionDigest(dispatchedTask, cb), {
                        kind: "dispatch_done",
                        actorType: dispatchedTask.sourceType === "subagent" ? "subagent" : dispatchedTask.sourceType === "harness" ? "harness" : "meta",
                        actorId: dispatchedTask.sourceChatId,
                        sourceChatId: dispatchedTask.sourceChatId,
                        targetChatId: dispatchedTask.chatId,
                        taskId: dispatchedTask.taskId,
                        tags: ["dispatch", "callback"],
                        metadata: {
                            status: cb.status,
                            sourceTaskId: dispatchedTask.sourceTaskId,
                        },
                    });
                    this.enqueueDispatchSourceNotification(dispatchedTask, cb);
                }
            }

            const isSubagentOriginDispatchCallback =
                dispatchedTask?.sourceType === "subagent" && !!dispatchedTask.sourceChatId;

            if (!isDispatchSourceNotification && !isSubagentOriginDispatchCallback) {
                this.accumulator.ingest(1, {
                    chatId: cb.chatId,
                    source: "CALLBACK",
                    enqueuedAt: Date.now(),
                    payload: cb,
                });
            }

            if (this.globalState && !isDispatchSourceNotification && !isSubagentOriginDispatchCallback) {
                const matches = matchCallbackWakeConditions(cb, this.globalState.getWakeConditions());
                for (const match of matches) {
                    this.globalState.removeWakeCondition(match.conditionId);
                    this.accumulator.ingest(1, {
                        chatId: "__meta__",
                        source: "WAKE_CONDITION",
                        enqueuedAt: Date.now(),
                        payload: buildWakeConditionPayload(match, {
                            callback: {
                                taskId: cb.taskId,
                                chatId: cb.chatId,
                                status: cb.status,
                                summary: cb.summary,
                            },
                        }),
                    });
                }
            }
        }

        const evaluation = {
            activeCount: this.accumulator.getActiveCount(),
            blockedCount: this.accumulator.getBlockedCount(),
        };

        const queueSnapshot = this.accumulator.getSnapshot();
        if (queueSnapshot.active.length === 0 && callbacks.length === 0) {
            const now = Date.now();
            if (this.shouldTriggerProactiveIdle(now)) {
                this.lastProactiveIdleAt = now;
                const idlePayload = {
                    id: `idle:${now}`,
                    description: "系统空闲，执行一次主动巡视",
                    enqueuedAt: now,
                };
                if (this.proactiveIdleHandler?.(idlePayload)) {
                    log.info("proactive idle routed to consciousness harness", { id: idlePayload.id });
                } else {
                    this.accumulator.ingest(1, {
                        chatId: "__meta__",
                        source: "PROACTIVE_IDLE",
                        enqueuedAt: now,
                        payload: {
                            type: "proactive_idle",
                            id: idlePayload.id,
                            description: idlePayload.description,
                        },
                    });
                }
            }
        }
        if (queueSnapshot.active.length > 0 || queueSnapshot.blockedChatIds.length > 0) {
            log.info("tick: 队列快照", {
                tickCount: this.tickCount,
                activeCount: queueSnapshot.active.length,
                blockedCount: queueSnapshot.blockedChatIds.length,
                groups: queueSnapshot.active.map((item) => `${item.chatId}(L${item.layer}${item.kind === "signal" ? `,p=${(item.pressure ?? 0).toFixed(1)}` : ""})`).join(", "),
            });
        }

        const attended: string[] = [];
        const decisions: AttendResult[] = [];
        let metaEndReason: string | null = null;
        let metaHandledEntries = false;

        const cbOpen = Date.now() < this.circuitBreakerOpenUntil;
        if (cbOpen) {
            log.warn("tick: circuit breaker OPEN，跳过 Phase 3-6", {
                remainingMs: this.circuitBreakerOpenUntil - Date.now(),
                tickCount: this.tickCount,
            });
        }

        const attentionSet = cbOpen ? null : this.accumulator.flush();
        const releasedItems = attentionSet?.items ? [...attentionSet.items] : [];

        if (!cbOpen) {
            const uniqueEntries: AttentionQueueEntry[] = [];
            const callbacksForMeta: SubagentCallback[] = [];
            const attendedThisTick = new Set<string>();
            const entryByChatId = new Map<string, AttentionQueueEntry>();

            for (const item of releasedItems) {
                if (item.source !== "PROACTIVE_IDLE") {
                    this.lastNonIdleActivityAt = Date.now();
                }

                // 如果该 chatId 的 executor 正在处理或队列中有任务，
                // 跳过本轮（subagent 执行时已能看到新消息，无需重复派发）。
                // CALLBACK 不排除（那是 subagent 完成后的回调通知）。
                if (item.source !== "CALLBACK") {
                    const ex = this.subagentManager.get(item.chatId)?.codeActExecutor as
                        { isProcessing?(): boolean; getQueueSize?(): number } | null | undefined;
                    if (ex && (ex.isProcessing?.() || (ex.getQueueSize?.() ?? 0) > 0)) {
                        this.accumulator.requeue(item);
                        log.debug("executor busy，放回 accumulator", { chatId: item.chatId, layer: item.layer });
                        continue;
                    }
                }

                if (attendedThisTick.has(item.chatId)) {
                    const existingEntry = entryByChatId.get(item.chatId);
                    if (existingEntry && item.source === "TOPIC_SIGNAL") {
                        mergeTopicSignalPayload(existingEntry, item.payload, item.pressure);
                        log.debug("同 tick TOPIC_SIGNAL 合并到已有 attention entry", { chatId: item.chatId });
                        continue;
                    }
                    this.accumulator.requeue(item);
                    log.debug("同 tick 重复 chat，放回 accumulator", { chatId: item.chatId, layer: item.layer });
                    continue;
                }

                const entry = this.buildAttendEntry(item);
                if (!entry) {
                    continue;
                }

                attendedThisTick.add(entry.chatId);
                entryByChatId.set(entry.chatId, entry);
                attended.push(entry.chatId);
                uniqueEntries.push(entry);
                if (item.source === "CALLBACK" && isSubagentCallback(item.payload)) {
                    callbacksForMeta.push(item.payload);
                }
            }

            if (uniqueEntries.length > 0) {
                if (!this.metaSessionHandler) {
                    log.warn("metaSessionHandler 未设置，跳过", { groups: uniqueEntries.map((entry) => entry.chatId) });
                } else {
                    try {
                        const result = await this.metaSessionHandler(uniqueEntries, callbacksForMeta);
                        metaEndReason = result?.endReason ?? null;
                        metaHandledEntries = !!result;
                        if (result?.sessionDigest && this.globalState) {
                            this.globalState.addSessionDigest(result.sessionDigest, {
                                kind: "meta_turn",
                                actorType: "meta",
                                actorId: "__meta__",
                                sourceChatId: "__meta__",
                                tags: ["meta"],
                                metadata: { endReason: result.endReason },
                            });
                        }
                        if (result) {
                            this.resetCircuitBreaker();
                            for (const attendResult of result.attendResults ?? []) {
                                decisions.push(attendResult);
                                try {
                                    this.onAttendCompleteCallback?.(attendResult.chatId, attendResult);
                                } catch (error) {
                                    log.debug("onAttendComplete callback error", { error: String(error) });
                                }
                            }
                        }
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        if (looksLikeQuotaError(message)) {
                            this.tripCircuitBreaker(message);
                        }
                        throw error;
                    }
                }
            }

            for (const entry of uniqueEntries) {
                const subagent = this.subagentManager.get(entry.chatId);
                if (!subagent) {
                    continue;
                }
                subagent.markAttended();
                if (metaHandledEntries) {
                    this.markAsRead(entry.chatId);
                }
                if (subagent.recordingPipeline) {
                    subagent.recordingPipeline.flush({ clusterOnly: true }).catch((error) => {
                        log.warn("Meta turn 后 pipeline flush 失败", {
                            chatId: entry.chatId,
                            error: String(error),
                        });
                    });
                }
            }
        }

        if (this.globalState) {
            this.globalState.save();
        }

        log.debug("tick: 完成", {
            tickCount: this.tickCount,
            callbacks: callbacks.length,
            attended: attended.length,
            decisions: decisions.length,
        });

        return {
            phase1Callbacks: callbacks.length,
            phase2Eval: {
                activeCount: evaluation.activeCount,
                blockedCount: evaluation.blockedCount,
            },
            phase3Attended: attended,
            phase4MetaEndReason: metaEndReason,
            phase5Decisions: decisions,
        };
    }

    private markAsRead(chatId: string): void {
        markChatAsRead(this.adapters, chatId, "meta-attend");
    }

    private enqueueDispatchSourceNotification(
        dispatchedTask: DispatchedSubagentTaskRecord,
        callback: SubagentCallback,
    ): void {
        if (dispatchedTask.sourceType === "harness") {
            this.enqueueHarnessDispatchCallback(dispatchedTask, callback);
            return;
        }
        if (dispatchedTask.sourceType !== "subagent" || !dispatchedTask.sourceChatId) {
            return;
        }
        if (dispatchedTask.sourceChatId === dispatchedTask.chatId) {
            return;
        }

        const sourceSubagent = this.subagentManager.get(dispatchedTask.sourceChatId);
        const executor = sourceSubagent?.codeActExecutor as { enqueue?: (task: CodeActReplyTask) => void } | null | undefined;
        if (!executor?.enqueue) {
            log.warn("dispatch source notification skipped: source executor unavailable", {
                sourceChatId: dispatchedTask.sourceChatId,
                targetChatId: dispatchedTask.chatId,
                taskId: dispatchedTask.taskId,
            });
            return;
        }

        const notificationTaskId = `${DISPATCH_SOURCE_NOTIFICATION_TASK_PREFIX}${shortUuid()}`;
        const continuationPrompt = formatDispatchSourceNotificationPrompt(dispatchedTask, callback);
        const task: CodeActReplyTask = {
            type: "CODEACT_REPLY",
            chatId: dispatchedTask.sourceChatId,
            taskId: notificationTaskId,
            decisions: [{
                action: "OBSERVE",
                contentDirection: `你之前派发给 ${dispatchedTask.chatId} 的任务 ${dispatchedTask.taskId} 已返回结果。根据通知判断是否需要继续跟进；不需要公开回应时直接写 SESSION_DIGEST 后结束。`,
                confidence: 1,
                reason: "Dispatch source notification",
            }],
            contextSnapshot: {
                depth: 1,
                chatId: dispatchedTask.sourceChatId,
                snapshotTimestamp: new Date().toISOString(),
                topicDigests: [],
                engagementScore: 0,
                contentDirection: "dispatch source notification",
            },
            replyMode: "SINGLE",
            createdAt: new Date().toISOString(),
            continuationPrompt,
            skipRefreshTaskMessages: true,
        };
        executor.enqueue(task);
        log.info("dispatch source notification enqueued", {
            sourceChatId: dispatchedTask.sourceChatId,
            targetChatId: dispatchedTask.chatId,
            taskId: dispatchedTask.taskId,
            notificationTaskId,
        });
    }

    private enqueueHarnessDispatchCallback(
        dispatchedTask: DispatchedSubagentTaskRecord,
        callback: SubagentCallback,
    ): void {
        if (!this.harnessDispatchCallbackHandler) {
            log.warn("harness dispatch callback skipped: harness handler unavailable", {
                sourceChatId: dispatchedTask.sourceChatId,
                targetChatId: dispatchedTask.chatId,
                taskId: dispatchedTask.taskId,
            });
            return;
        }
        const handled = this.harnessDispatchCallbackHandler({
            content: formatHarnessDispatchCallbackContent(dispatchedTask, callback),
            source: "dispatch-callback",
            actorId: dispatchedTask.sourceChatId ?? "harness",
            runId: dispatchedTask.sourceRunId,
            triggerReason: "subagent_dispatch_callback",
            sourceChatId: dispatchedTask.sourceChatId,
            taskId: dispatchedTask.taskId,
            metadata: {
                targetChatId: dispatchedTask.chatId,
                status: callback.status,
                summary: callback.summary,
                error: callback.error,
                sentMessages: callback.sentMessages,
            },
        });
        if (handled) {
            log.info("harness dispatch callback enqueued", {
                sourceChatId: dispatchedTask.sourceChatId,
                targetChatId: dispatchedTask.chatId,
                taskId: dispatchedTask.taskId,
                runId: dispatchedTask.sourceRunId,
            });
        }
    }

    /**
     * 获取 tick 计数
     */
    getTickCount(): number {
        return this.tickCount;
    }

    /**
     * 是否正在运行
     */
    isRunning(): boolean {
        return this.running;
    }

    /**
     * 设置 GlobalState（用于延迟注入或测试）
     */
    setGlobalState(gs: GlobalState): void {
        this.globalState = gs;
    }

    setProactiveIdleHandler(handler: ((payload: { id: string; description: string; enqueuedAt: number }) => boolean) | null): void {
        this.proactiveIdleHandler = handler;
    }

    setHarnessDispatchCallbackHandler(handler: ((payload: HarnessNotify) => boolean) | null): void {
        this.harnessDispatchCallbackHandler = handler;
    }

    private shouldTriggerProactiveIdle(now: number): boolean {
        const hasIdleRunAfterRecentActivity = this.lastProactiveIdleAt > 0
            && this.lastProactiveIdleAt >= this.lastNonIdleActivityAt;
        const baselineAt = hasIdleRunAfterRecentActivity
            ? this.lastProactiveIdleAt
            : this.lastNonIdleActivityAt;
        const requiredDelay = hasIdleRunAfterRecentActivity
            ? PROACTIVE_IDLE_REPEAT_INTERVAL_MS
            : PROACTIVE_IDLE_INITIAL_DELAY_MS;
        return now - baselineAt >= requiredDelay;
    }


    private buildAttendEntry(item: AttentionItem): AttentionQueueEntry | null {
        const subagent = this.subagentManager.get(item.chatId);
        if (!subagent && !(item.chatId === "__meta__" && isSyntheticMetaSource(item.source))) {
            return null;
        }

        let entry: AttentionQueueEntry;
        switch (item.source) {
            case "DIRECT_ADDRESS":
                if (!subagent) return null;
                entry = subagent.buildQueueEntry("DIRECT_ADDRESS");
                {
                    applyEmbeddedQueueEntry(entry, item.payload);
                    const directAddress = extractDirectAddressPayload(item.payload, item.chatId);
                    entry.directAddressReason = directAddress.reason;
                    if (directAddress.messageIds.length > 0) {
                        entry.directAddressMessageIds = directAddress.messageIds;
                    }
                    if (directAddress.userIds.length > 0) {
                        entry.directAddressUserIds = directAddress.userIds;
                    }
                }
                break;
            case "SCHEDULER":
            case "WAKE_CONDITION":
            case "PROACTIVE_IDLE":
                entry = subagent
                    ? subagent.buildQueueEntry("SCHEDULER_TRIGGER")
                    : createSyntheticMetaEntry(item);
                entry.schedulerTriggers = item.source === "PROACTIVE_IDLE" ? [] : extractSchedulerTriggers(item.payload);
                break;
            case "BACKGROUND_AGENT":
                entry = createSyntheticMetaEntry(item);
                entry.schedulerTriggers = extractBackgroundAgentTriggers(item.payload);
                break;
            case "CALLBACK":
                if (!subagent) return null;
                entry = subagent.buildQueueEntry("DEFERRED_RE_ENTRY");
                break;
            case "TOPIC_SIGNAL":
                if (!subagent) return null;
                entry = subagent.buildQueueEntry("TOPIC_SIGNAL");
                if (!applyTopicSignalPayload(entry, item.payload, item.pressure)) {
                    return null;
                }
                break;
            default:
                if (!subagent) return null;
                entry = subagent.buildQueueEntry();
                break;
        }

        entry.enqueuedAt = item.enqueuedAt;
        if (typeof item.pressure === "number") {
            const boundedPressure = Math.max(0, Math.min(100, item.pressure));
            entry.priority = boundedPressure;
            entry.basePriority = boundedPressure;
        }
        return entry;
    }

    // ─── 内部方法 ───

    private scheduleNext(): void {
        if (!this.running) return;
        this.timer = setTimeout(async () => {
            try {
                await this.tick();
            } catch (err) {
                log.error("tick 异常", { error: String(err) });
            }
            this.scheduleNext();
        }, this.config.pollInterval);
        if (this.timer.unref) this.timer.unref();
    }
}

export interface MetaTurnResult {
    endReason: string;
    sessionDigest?: string;
    attendResults?: AttendResult[];
}

function isSyntheticMetaSource(source: AttentionItem["source"]): boolean {
    return source === "WAKE_CONDITION" || source === "SCHEDULER" || source === "PROACTIVE_IDLE" || source === "BACKGROUND_AGENT";
}

function isSubagentCallback(value: unknown): value is SubagentCallback {
    if (!value || typeof value !== "object") {
        return false;
    }
    const record = value as Partial<SubagentCallback>;
    return typeof record.taskId === "string"
        && typeof record.chatId === "string"
        && typeof record.summary === "string";
}

function applyTopicSignalPayload(entry: AttentionQueueEntry, payload: unknown, pressure?: number): boolean {
    const topicDigest = extractTopicDigest(payload);
    if (!topicDigest) {
        return false;
    }

    entry.topicDigests = [topicDigest];
    applyTopicSignalMetadata(entry, topicDigest, pressure);
    return true;
}

function mergeTopicSignalPayload(entry: AttentionQueueEntry, payload: unknown, pressure?: number): boolean {
    const topicDigest = extractTopicDigest(payload);
    if (!topicDigest) {
        return false;
    }

    entry.topicDigests = [
        topicDigest,
        ...entry.topicDigests.filter((digest) => digest.topicId !== topicDigest.topicId),
    ];
    applyTopicSignalMetadata(entry, topicDigest, pressure);
    return true;
}

function extractTopicDigest(payload: unknown): AttentionQueueEntry["topicDigests"][number] | null {
    if (!payload || typeof payload !== "object") {
        return null;
    }
    const topicDigest = (payload as { topicDigest?: unknown }).topicDigest;
    if (!isTopicDigest(topicDigest)) {
        return null;
    }

    return topicDigest;
}

function applyTopicSignalMetadata(
    entry: AttentionQueueEntry,
    topicDigest: AttentionQueueEntry["topicDigests"][number],
    pressure?: number,
): void {
    entry.callbackPotential = Math.max(entry.callbackPotential ?? 0, topicDigest.callbackPotential ?? 0);
    entry.hasHighCallbackPotential = (entry.callbackPotential ?? 0) > 70;
    entry.newMessageCount = Math.max(entry.newMessageCount, topicDigest.messageCount);
    if (typeof pressure === "number") {
        const boundedPressure = Math.max(0, Math.min(100, pressure));
        entry.priority = Math.max(entry.priority, boundedPressure);
        entry.basePriority = Math.max(entry.basePriority, boundedPressure);
    }
    const signalLabel = `TOPIC_SIGNAL:${topicDigest.label}`;
    entry.urgentSignals = entry.urgentSignals?.includes(signalLabel)
        ? entry.urgentSignals
        : [...(entry.urgentSignals ?? []), signalLabel];
}

function isTopicDigest(value: unknown): value is AttentionQueueEntry["topicDigests"][number] {
    if (!value || typeof value !== "object") {
        return false;
    }
    const record = value as Partial<AttentionQueueEntry["topicDigests"][number]>;
    return typeof record.topicId === "string"
        && typeof record.label === "string"
        && Array.isArray(record.participants)
        && Array.isArray(record.keywords);
}

function extractSchedulerTriggers(payload: unknown): NonNullable<AttentionQueueEntry["schedulerTriggers"]> {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    if ("type" in payload && "id" in payload && "description" in payload) {
        const type = payload.type;
        if ((type === "reminder" || type === "cron" || type === "wake_condition") && typeof payload.id === "string" && typeof payload.description === "string") {
            const record = payload as {
                id: string;
                type: "reminder" | "cron" | "wake_condition";
                description: string;
                bindingId?: unknown;
                callback?: unknown;
                data?: unknown;
            };
            const trigger: NonNullable<AttentionQueueEntry["schedulerTriggers"]>[number] = {
                id: record.id,
                type: record.type,
                description: record.description,
            };
            if (typeof record.bindingId === "string") {
                trigger.bindingId = record.bindingId;
            }
            if (typeof record.callback === "string") {
                trigger.callback = record.callback;
            }
            if (record.data !== undefined) {
                trigger.data = record.data;
            }
            return [trigger];
        }
    }

    return [];
}

function extractBackgroundAgentTriggers(payload: unknown): NonNullable<AttentionQueueEntry["schedulerTriggers"]> {
    if (!payload || typeof payload !== "object") return [];
    const p = payload as Record<string, unknown>;
    const desc = typeof p.description === "string" ? p.description : "Background Agent notification";
    const id = typeof p.id === "string" ? p.id : `bg:${Date.now()}`;
    return [{ id, type: "reminder" as const, description: `[Background Agent] ${desc}` }];
}

function extractDirectAddressPayload(payload: unknown, chatId: string): { reason?: string; messageIds: string[]; userIds: string[] } {
    if (!payload || typeof payload !== "object") {
        return { messageIds: [], userIds: [] };
    }
    const record = payload as Record<string, unknown>;
    const event = record.event && typeof record.event === "object"
        ? record.event as Record<string, unknown>
        : {};
    const messageId = event.messageId;
    const userId = event.userId;
    const platform = getPlatform(chatId);
    return {
        reason: typeof record.reason === "string" ? record.reason : undefined,
        messageIds: typeof messageId === "string" || typeof messageId === "number" ? [String(messageId)] : [],
        userIds: typeof userId === "string" || typeof userId === "number"
            ? [ensureCompositeId(platform, String(userId))]
            : [],
    };
}

/**
 * Dashboard approval and other consolidated wakeups may carry a bounded
 * historical snapshot. Only merge the context fields needed by attend; never
 * trust payload data to replace chat identity, source, or queue state.
 */
function applyEmbeddedQueueEntry(entry: AttentionQueueEntry, payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const raw = (payload as Record<string, unknown>).queueEntry;
    if (!raw || typeof raw !== "object") return;
    const embedded = raw as Partial<AttentionQueueEntry>;

    if (Array.isArray(embedded.recentMessages)) {
        entry.recentMessages = embedded.recentMessages;
    }
    if (typeof embedded.newMessageCount === "number" && Number.isFinite(embedded.newMessageCount)) {
        entry.newMessageCount = Math.max(0, Math.floor(embedded.newMessageCount));
    }
    if (Array.isArray(embedded.directAddressMessageIds)) {
        entry.directAddressMessageIds = embedded.directAddressMessageIds.map(String);
    }
    if (Array.isArray(embedded.directAddressUserIds)) {
        entry.directAddressUserIds = embedded.directAddressUserIds.map(String);
    }
}

function createSyntheticMetaEntry(item: AttentionItem): AttentionQueueEntry {
    return {
        chatId: "__meta__",
        source: item.source === "PROACTIVE_IDLE" ? "PROACTIVE_IDLE" : "SCHEDULER_TRIGGER",
        priority: Math.max(1, item.pressure ?? 1),
        basePriority: Math.max(1, item.pressure ?? 1),
        enqueuedAt: item.enqueuedAt,
        lastAttendedAt: null,
        attendCount: 0,
        blocked: false,
        newMessageCount: 0,
        topicDigests: [],
        stickinessLevel: "STRANGER",
        engagementScore: 0,
        snapshotTimestamp: new Date(item.enqueuedAt).toISOString(),
    };
}

function formatDispatchCompletionDigest(
    task: DispatchedSubagentTaskRecord,
    callback: SubagentCallback,
): string {
    const source = task.sourceType === "subagent" && task.sourceChatId
        ? `Subagent ${task.sourceChatId}${task.sourceTaskId ? ` task=${task.sourceTaskId}` : ""}`
        : task.sourceType === "harness"
            ? `Harness${task.sourceChatId ? ` ${task.sourceChatId}` : ""}`
        : "Meta";
    const sent = callback.sentMessages?.length
        ? `sent=${callback.sentMessages.map((msg) => `"${truncateForPrompt(msg.text, 80)}"`).join(" / ")}`
        : "sent=none";
    return [
        `[DISPATCH_DONE] ${source} -> ${task.chatId}: task=${task.taskId}, status=${callback.status}`,
        `direction=${truncateForPrompt(task.contentDirection, 160)}`,
        `summary=${truncateForPrompt(callback.summary, 240)}`,
        callback.error ? `error=${truncateForPrompt(callback.error, 160)}` : "",
        sent,
    ].filter(Boolean).join("；");
}

function formatDispatchSourceNotificationPrompt(
    task: DispatchedSubagentTaskRecord,
    callback: SubagentCallback,
): string {
    const sentMessages = callback.sentMessages?.length
        ? callback.sentMessages.map((msg) => `- ${msg.messageId ? `[${msg.messageId}] ` : ""}${msg.text}`).join("\n")
        : "- (目标 Subagent 没有发送公开消息)";
    const error = callback.error ? `\nerror: ${callback.error}` : "";
    return [
        "[Dispatch Result Notification]",
        "这是内部通知：你之前派发给其他 Subagent 的任务已经返回结果。",
        "",
        `sourceChatId: ${task.sourceChatId}`,
        `targetChatId: ${task.chatId}`,
        `targetTaskId: ${task.taskId}`,
        `status: ${callback.status}`,
        `originalDirection: ${task.contentDirection}`,
        "",
        "targetSummary:",
        callback.summary,
        error,
        "",
        "targetSentMessages:",
        sentMessages,
        "",
        "处理要求：",
        "- 根据这个结果决定是否需要继续跟进、再次派发、更新 ctx/todo，或向当前群同步。",
        "- 如果不需要公开回应，不要调用平台发送 API；只写清 SESSION_DIGEST 后结束。",
        "- 这条通知本身不会再主动推给 Meta；系统已经把 source/target/result 写入全局 session digest。",
    ].filter((line) => line !== "").join("\n");
}

function formatHarnessDispatchCallbackContent(
    task: DispatchedSubagentTaskRecord,
    callback: SubagentCallback,
): string {
    const sentMessages = callback.sentMessages?.length
        ? callback.sentMessages.map((msg) => `- ${msg.messageId ? `[${msg.messageId}] ` : ""}${msg.text}`).join("\n")
        : "- (目标 Subagent 没有发送公开消息)";
    const error = callback.error ? `\nerror: ${callback.error}` : "";
    return [
        "[Harness Dispatch Result]",
        `sourceActor: ${task.sourceChatId ?? "harness"}`,
        task.sourceRunId ? `sourceRunId: ${task.sourceRunId}` : "",
        `targetChatId: ${task.chatId}`,
        `targetTaskId: ${task.taskId}`,
        `status: ${callback.status}`,
        `originalDirection: ${task.contentDirection}`,
        "",
        "targetSummary:",
        callback.summary,
        error,
        "",
        "targetSentMessages:",
        sentMessages,
        "",
        "处理要求：",
        "- 根据结果决定是否继续派发、callback 给 Meta、写入 digest，或结束本轮意识流。",
        "- 不要直接在群/私聊发消息；需要对话时继续走 dispatch/notify/attention 工具。",
    ].filter((line) => line !== "").join("\n");
}

function looksLikeQuotaError(message: string): boolean {
    return message.includes("429")
        || message.includes("quota")
        || message.includes("RESOURCE_EXHAUSTED")
        || message.includes("rate limit")
        || message.includes("overloaded");
}
