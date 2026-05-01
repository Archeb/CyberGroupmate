/**
 * main-agent-loop.ts — 主 Agent 注意力循环
 *
 * 主循环：
 * Phase 1: 收集 Q5 callback
 * Phase 2: flush AttentionAccumulator
 * Phase 3: 逐个处理 AttentionSet
 * Phase 4: 构建 GroupContextPackage
 * Phase 5: 主 Agent 决策
 * Phase 6: 分派 CodeActReplyTask
 * Phase 7: 持久化全局状态
 *
 * 参考设计：subagent.md §8, subtask.md S5
 */

import { CallbackQueue } from "../subagent/callback-queue.js";
import { SubagentManager } from "../subagent/subagent-manager.js";
import { GlobalState } from "./global-state.js";
import type {
    AttentionQueueEntry,
    SubagentCallback,
    AttendResult,
} from "../subagent/types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "../subagent/types.js";
import type { ChatMessage } from "../core/llm.js";
import type { AttentionItem } from "../accumulator/types.js";
import { AttentionAccumulator } from "../accumulator/attention-accumulator.js";

import { resolveComponentProfiles } from "../core/config.js";
import { ContextEngine } from "../context-engine/context-engine.js";
import { getAttendProviders } from "../context-engine/providers/attend-providers.js";
// renderPrompt/buildCallbackVariables no longer needed — callback uses callbackProvider.render()
import { shouldCompact, compact as contextManagerCompact } from "../memory-v2/context-manager.js";
import { createLogger } from "../core/logger.js";
import { getRawId } from "../core/chat-id.js";
import { callbackProvider } from "../context-engine/providers/pipeline-providers.js";
import { deriveChatType } from "../context-engine/prompt-renderer-utils.js";

const log = createLogger("main-agent-loop");

/** 主循环配置 */
export interface MainAgentLoopConfig {
    /** 轮询间隔 (ms)。默认 5000 */
    pollInterval: number;
    /** 每旋转最大 attend 群组数。默认 3 */
    maxAttendsPerTick: number;
    /** Cosine Decay 周期。默认 20 */
    cosineDecayCyclePeriod: number;
    /** Compaction 后保留的最近消息条数。默认 10 */
    retainAfterCompact: number;
    /** 紧急截断硬上限（仅当 compact 失败/未配置时生效）。默认 100 */
    hardCapMessages: number;
}

const DEFAULT_LOOP_CONFIG: MainAgentLoopConfig = {
    pollInterval: DEFAULT_SUBAGENT_CONFIG.pollInterval,
    maxAttendsPerTick: 3,
    cosineDecayCyclePeriod: 20,
    retainAfterCompact: 10,
    hardCapMessages: 100,
};

/**
 * MainAgentLoop — 主 Agent 注意力循环
 *
 * 串行处理，模拟人类注意力的轮询模式。
 * 每个 tick:
 * 1. 收集 callback
 * 2. flush 当前注意力窗口
 * 3. attend 本轮释放的群组
 * 4. 分派任务
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

    /**
     * 主 Agent LLM 对话历史
     * 按时间顺序存放：attend 上下文 (user) → 决策 (assistant) → callback (user) → ...
     * 使用 LLM compact 作为唯一的历史管理机制，硬上限截断仅作安全网。
     */
    private conversationHistory: ChatMessage[] = [];

    /**
     * 同群消息增量追踪：chatId → 上次存入历史的最新 messageId。
     * 用于 attend-handler 构建增量历史记录，避免跨轮次重复存储相同消息。
     * Compaction 成功后重置。
     * @deprecated 由 ContextEngine.ledger 的 messages provider delta 追踪替代
     */
    private lastStoredMsgId = new Map<string, string>();

    /**
     * Context Engine — 声明式 prompt 组装引擎（attend 层）。
     * 所有 attend prompt 的数据管理、delta 计算、渲染都通过此引擎完成。
     * Ledger 在 compaction/硬截断后自动 reset。
     */
    private _attendEngine: ContextEngine;


    /** 外部 attend handler（由 main.ts 集成注入） */
    private attendHandler: ((entry: AttentionQueueEntry) => Promise<AttendResult | null>) | null = null;

    /** 外部 dispatch handler */
    private dispatchHandler: ((result: AttendResult) => Promise<void>) | null = null;



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

        // 初始化 attend ContextEngine，注册所有 attend providers
        this._attendEngine = new ContextEngine("attend");
        this._attendEngine.registerAll(getAttendProviders());
    }

    /**
     * 设置 attend handler
     * 当主循环 dequeue 一个群组后，调用此 handler 由外部决策逻辑处理
     */
    setAttendHandler(handler: (entry: AttentionQueueEntry) => Promise<AttendResult | null>): void {
        this.attendHandler = handler;
    }

    /**
     * 设置 dispatch handler
     * 当决策完成后，调用此 handler 分派任务
     */
    setDispatchHandler(handler: (result: AttendResult) => Promise<void>): void {
        this.dispatchHandler = handler;
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
        phase5Decisions: AttendResult[];
    }> {
        this.tickCount++;
        this.lastTickAt = Date.now();
        log.debug("tick: 开始", { tickCount: this.tickCount });

        // ═══ Phase 1: Drain Callbacks (Q5) ═══
        const callbacks = this.callbackQueue.drain();
        for (const cb of callbacks) {
            await this.appendToHistory({
                role: "user",
                content: formatCallbackMessage(cb),
            });
            const cbSubagent = this.subagentManager.get(cb.chatId);
            if (cbSubagent) {
                cbSubagent.markTaskComplete(cb.taskId);
                cbSubagent.addCallback(cb);
            }
            this.accumulator.unblock(cb.chatId);
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
        const attendedThisTick = new Set<string>();

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
            for (let i = 0; i < this.config.maxAttendsPerTick; i++) {
                if (i > 0) {
                    const midCallbacks = this.callbackQueue.drain();
                    for (const cb of midCallbacks) {
                        callbacks.push(cb);
                        await this.appendToHistory({
                            role: "user",
                            content: formatCallbackMessage(cb),
                        });
                        const cbSubagent = this.subagentManager.get(cb.chatId);
                        if (cbSubagent) {
                            cbSubagent.markTaskComplete(cb.taskId);
                            cbSubagent.addCallback(cb);
                        }
                        this.accumulator.unblock(cb.chatId);
                    }
                }

                const item = releasedItems.shift();
                if (!item) break;

                if (attendedThisTick.has(item.chatId)) {
                    this.accumulator.requeue(item);
                    log.debug("Phase 3: 同 tick 重复 attend，放回 accumulator", { chatId: item.chatId, layer: item.layer });
                    continue;
                }

                const entry = this.buildAttendEntry(item);
                if (!entry) {
                    continue;
                }

                attendedThisTick.add(entry.chatId);
                attended.push(entry.chatId);

                let result: AttendResult | null = null;
                if (this.attendHandler) {
                    result = await this.attendHandler(entry);
                } else {
                    log.warn("attendHandler 未设置，跳过", { chatId: entry.chatId });
                }

                if (result) {
                    decisions.push(result);
                    if (item.layer === 2) {
                        this.accumulator.markActioned(entry.chatId);
                    }

                    try {
                        this.onAttendCompleteCallback?.(entry.chatId, result);
                    } catch (e) {
                        log.debug("onAttendComplete callback error", { error: String(e) });
                    }

                    if (this.dispatchHandler) {
                        await this.dispatchHandler(result);
                    }

                    await this.manageHistory();
                }

                const subagent = this.subagentManager.get(entry.chatId);
                if (subagent) {
                    subagent.markAttended();
                    if (subagent.recordingPipeline) {
                        subagent.recordingPipeline.flush({ clusterOnly: true }).catch(err => {
                            log.warn("attend 后 pipeline flush 失败", {
                                chatId: entry.chatId,
                                error: String(err),
                            });
                        });
                    }
                }
            }
        }

        for (const item of releasedItems) {
            this.accumulator.requeue(item);
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


    // ─── 对话历史管理 ───

    /**
     * 追加消息到主 Agent 对话历史。
     *
     * 仅做 push，不截断。历史管理由 manageHistory() 统一处理。
     */
    async appendToHistory(msg: ChatMessage): Promise<void> {
        this.conversationHistory.push(msg);
    }

    /**
     * 统一的对话历史管理入口。
     *
     * 应在任务完成后（dispatch 之后）调用，避免 compact 延迟任务分派。
     *
     * 流程：
     * 1. token 超预算 → 触发 LLM compaction，压缩旧消息为 briefing
     * 2. compaction 成功后重置消息增量追踪
     * 3. compaction 失败/未配置且消息数超硬上限 → 紧急截断（安全网）
     */
    async manageHistory(): Promise<void> {
        const compactConfigs = resolveComponentProfiles("compact");

        // ─── 尝试 LLM Compaction ───
        if (compactConfigs.length > 0 && shouldCompact(this.conversationHistory, undefined, compactConfigs[0])) {
            try {
                log.info("主 Agent 对话历史 compact: token 超预算", {
                    messageCount: this.conversationHistory.length,
                });
                this.conversationHistory = await contextManagerCompact(
                    this.conversationHistory,
                    compactConfigs,
                );
                // Compaction 成功 → 重置消息增量追踪 + Context Engine ledger
                // 旧消息已被压缩为 briefing，下次 attend 需存完整消息
                this.lastStoredMsgId.clear();
                this._attendEngine.ledger.reset();
                log.info("主 Agent 对话历史 compact 完成", {
                    afterCount: this.conversationHistory.length,
                    deltaTrackingReset: true,
                });
                return;
            } catch (err) {
                log.warn("主 Agent 对话历史 compact 失败，检查硬上限", {
                    error: String(err),
                });
            }
        }

        // ─── 安全网：硬上限截断 ───
        // 仅当 compaction 失败/未配置且消息数过多时触发
        if (this.conversationHistory.length > this.config.hardCapMessages) {
            const before = this.conversationHistory.length;
            this.conversationHistory = this.conversationHistory.slice(
                -this.config.retainAfterCompact,
            );
            // 硬截断也需要重置增量追踪 + Context Engine ledger
            this.lastStoredMsgId.clear();
            this._attendEngine.ledger.reset();
            log.warn("主 Agent 对话历史硬上限截断（安全网）", {
                before,
                after: this.conversationHistory.length,
                hardCap: this.config.hardCapMessages,
            });
        }
    }

    // ─── 消息增量追踪 ───

    /**
     * 获取指定 chatId 上次存入历史的最新 messageId。
     * 用于 attend-handler 计算增量消息。
     */
    getLastStoredMsgId(chatId: string): string | undefined {
        return this.lastStoredMsgId.get(chatId);
    }

    /**
     * 更新指定 chatId 的最新存储 messageId。
     */
    setLastStoredMsgId(chatId: string, msgId: string): void {
        this.lastStoredMsgId.set(chatId, msgId);
    }

    /**
     * 获取当前对话历史（供 attendHandler 构建 LLM messages 使用）
     */
    getConversationHistory(): ReadonlyArray<ChatMessage> {
        return this.conversationHistory;
    }

    /**
     * 获取 attend 层的 ContextEngine 实例。
     * attend-handler 通过此引擎进行声明式 prompt 组装。
     */
    getAttendEngine(): ContextEngine {
        return this._attendEngine;
    }

    /**
     * 获取对话历史长度
     */
    getConversationHistorySize(): number {
        return this.conversationHistory.length;
    }

    private buildAttendEntry(item: AttentionItem): AttentionQueueEntry | null {
        const subagent = this.subagentManager.get(item.chatId);
        if (!subagent) {
            return null;
        }

        let entry: AttentionQueueEntry;
        switch (item.source) {
            case "DIRECT_ADDRESS":
                entry = subagent.buildQueueEntry("DIRECT_ADDRESS");
                break;
            case "SCHEDULER":
            case "WAKE_CONDITION":
                entry = subagent.buildQueueEntry("SCHEDULER_TRIGGER");
                entry.schedulerTriggers = extractSchedulerTriggers(item.payload);
                break;
            case "CALLBACK":
                entry = subagent.buildQueueEntry("DEFERRED_RE_ENTRY");
                break;
            case "TOPIC_SIGNAL":
            default:
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

// ─── 模块级辅助函数 ───

/**
 * 将 SubagentCallback 格式化为对话历史中的 user 消息。
 * 使用 callbackProvider 的结构化数据 + render（统一视图层）。
 */
export function formatCallbackMessage(cb: SubagentCallback, chatTitle?: string): string {
    const isCompleted = cb.status === "COMPLETED";
    const sentMessages = cb.sentMessages?.length
        ? cb.sentMessages.map(m => {
            const text = m.text.length > 80 ? m.text.slice(0, 80) + "..." : m.text;
            return `- "${text}"`;
        }).join("\n")
        : "（无）";

    const data = {
        chatId: getRawId(cb.chatId),
        chatType: deriveChatType(cb.isDirectMessage),
        chatTitle: chatTitle ?? cb.chatTitle ?? cb.chatId,
        taskId: cb.taskId,
        executionType: cb.executionType,
        status: cb.status,
        durationMs: cb.durationMs,
        isCompleted,
        sentMessages,
        summary: cb.summary,
        error: cb.error ?? undefined,
    };

    return callbackProvider.render(data);
}

function extractSchedulerTriggers(payload: unknown): Array<{ id: string; type: "reminder" | "cron"; description: string }> {
    if (!payload || typeof payload !== "object") {
        return [];
    }

    if ("type" in payload && "id" in payload && "description" in payload) {
        const type = payload.type;
        if ((type === "reminder" || type === "cron") && typeof payload.id === "string" && typeof payload.description === "string") {
            return [{ id: payload.id, type, description: payload.description }];
        }
    }

    return [];
}
