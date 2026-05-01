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
import type { AttentionQueueEntry, SubagentCallback, AttendResult, Decision } from "../subagent/types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "../subagent/types.js";
import type { AttentionItem } from "../accumulator/types.js";
import { AttentionAccumulator } from "../accumulator/attention-accumulator.js";
import { createLogger } from "../core/logger.js";
import { buildWakeConditionPayload, matchCallbackWakeConditions } from "./wake-conditions.js";

const log = createLogger("main-agent-loop");

/** 主循环配置 */
export interface MainAgentLoopConfig {
    /** 轮询间隔 (ms)。默认 5000 */
    pollInterval: number;
}

const DEFAULT_LOOP_CONFIG: MainAgentLoopConfig = {
    pollInterval: DEFAULT_SUBAGENT_CONFIG.pollInterval,
};

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

    /** 循环状态 */
    private running = false;
    private tickCount = 0;
    private lastTickAt: number = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    /** Circuit Breaker — 主 LLM 不可用时暂停 attend */
    private circuitBreakerOpenUntil: number = 0;
    private circuitBreakerBackoff: number = 30_000; // 初始 30s
    private static readonly CB_MAX_BACKOFF = 10 * 60_000; // 最大 10min

    /** 外部 Meta session handler */
    private metaSessionHandler: ((entries: AttentionQueueEntry[], callbacks: SubagentCallback[]) => Promise<MetaTurnResult | null>) | null = null;

    /** attend 完成后的回调（metrics 使用） */
    private onAttendCompleteCallback: ((chatId: string, decisions: AttendResult) => void) | null = null;

    constructor(
        accumulator: AttentionAccumulator,
        callbackQueue: CallbackQueue,
        subagentManager: SubagentManager,
        config?: Partial<MainAgentLoopConfig>,
        globalState?: GlobalState | null,
    ) {
        this.accumulator = accumulator;
        this.callbackQueue = callbackQueue;
        this.subagentManager = subagentManager;
        this.globalState = globalState ?? null;
        this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
    }

    /**
     * 设置 Meta session handler
     */
    setMetaSessionHandler(handler: (entries: AttentionQueueEntry[], callbacks: SubagentCallback[]) => Promise<MetaTurnResult | null>): void {
        this.metaSessionHandler = handler;
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
        for (const cb of callbacks) {
            const cbSubagent = this.subagentManager.get(cb.chatId);
            if (cbSubagent) {
                cbSubagent.markTaskComplete(cb.taskId);
                cbSubagent.addCallback(cb);
            }
            this.accumulator.unblock(cb.chatId);

            if (this.globalState) {
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
            const attendedThisTick = new Set<string>();

            for (const item of releasedItems) {
                if (attendedThisTick.has(item.chatId)) {
                    this.accumulator.requeue(item);
                    log.debug("同 tick 重复 chat，放回 accumulator", { chatId: item.chatId, layer: item.layer });
                    continue;
                }

                const entry = this.buildAttendEntry(item);
                if (!entry) {
                    continue;
                }

                attendedThisTick.add(entry.chatId);
                attended.push(entry.chatId);
                uniqueEntries.push(entry);
            }

            if (uniqueEntries.length > 0) {
                if (!this.metaSessionHandler) {
                    log.warn("metaSessionHandler 未设置，跳过", { groups: uniqueEntries.map((entry) => entry.chatId) });
                } else {
                    try {
                        const result = await this.metaSessionHandler(uniqueEntries, callbacks);
                        metaEndReason = result?.endReason ?? null;
                        if (result?.sessionDigest && this.globalState) {
                            this.globalState.addSessionDigest(result.sessionDigest);
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


    private buildAttendEntry(item: AttentionItem): AttentionQueueEntry | null {
        const subagent = this.subagentManager.get(item.chatId);
        if (!subagent && !(item.chatId === "__meta__" && item.source === "WAKE_CONDITION")) {
            return null;
        }

        let entry: AttentionQueueEntry;
        switch (item.source) {
            case "DIRECT_ADDRESS":
                if (!subagent) return null;
                entry = subagent.buildQueueEntry("DIRECT_ADDRESS");
                break;
            case "SCHEDULER":
            case "WAKE_CONDITION":
                entry = subagent
                    ? subagent.buildQueueEntry("SCHEDULER_TRIGGER")
                    : createSyntheticMetaEntry(item);
                entry.schedulerTriggers = extractSchedulerTriggers(item.payload);
                break;
            case "CALLBACK":
                if (!subagent) return null;
                entry = subagent.buildQueueEntry("DEFERRED_RE_ENTRY");
                break;
            case "TOPIC_SIGNAL":
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

function extractSchedulerTriggers(payload: unknown): Array<{ id: string; type: "reminder" | "cron" | "wake_condition"; description: string }> {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    if ("type" in payload && "id" in payload && "description" in payload) {
        const type = payload.type;
        if ((type === "reminder" || type === "cron" || type === "wake_condition") && typeof payload.id === "string" && typeof payload.description === "string") {
            return [{ id: payload.id, type, description: payload.description }];
        }
    }

    return [];
}

function createSyntheticMetaEntry(item: AttentionItem): AttentionQueueEntry {
    return {
        chatId: "__meta__",
        source: "SCHEDULER_TRIGGER",
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

function looksLikeQuotaError(message: string): boolean {
    return message.includes("429")
        || message.includes("quota")
        || message.includes("RESOURCE_EXHAUSTED")
        || message.includes("rate limit")
        || message.includes("overloaded");
}
