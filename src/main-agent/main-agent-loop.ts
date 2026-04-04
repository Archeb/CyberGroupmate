/**
 * main-agent-loop.ts — 主 Agent 注意力循环
 *
 * 7 阶段循环 (subagent.md §8)：
 * Phase 1: 收集 Q5 callback
 * Phase 2: Q3 evaluate (时间衰减)
 * Phase 3: dequeue 最高优先级群组
 * Phase 4: 构建 GroupContextPackage
 * Phase 5: 主 Agent 决策
 * Phase 6: 分派 CodeActReplyTask / FastPath
 * Phase 7: 更新 Q3 状态
 *
 * 参考设计：subagent.md §8, subtask.md S5
 */

import { DynamicAttentionQueue } from "../subagent/attention-queue.js";
import { CallbackQueue } from "../subagent/callback-queue.js";
import { SubagentManager } from "../subagent/subagent-manager.js";
import { GlobalState } from "./global-state.js";
import type {
    AttentionQueueEntry,
    SubagentCallback,
    AttendResult,
    MiniCodeActCall,
} from "../subagent/types.js";
import { executeMiniCodeActs } from "./minicodeact-executor.js";
import { DEFAULT_SUBAGENT_CONFIG } from "../subagent/types.js";
import type { ChatMessage } from "../core/llm.js";
import type { LLMConfig } from "../core/config.js";
import { renderPrompt, buildCallbackVariables } from "./prompt-renderer.js";
import { shouldCompact, compact as contextManagerCompact } from "../memory-v2/context-manager.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("main-agent-loop");

/** 主循环配置 */
export interface MainAgentLoopConfig {
    /** 轮询间隔 (ms)。默认 5000 */
    pollInterval: number;
    /** 每旋转最大 attend 群组数。默认 3 */
    maxAttendsPerTick: number;
    /** Cosine Decay 周期。默认 20 */
    cosineDecayCyclePeriod: number;
    /** 主 Agent LLM 对话历史最大消息数（不含 system）。默认 30 */
    maxHistoryMessages: number;
}

const DEFAULT_LOOP_CONFIG: MainAgentLoopConfig = {
    pollInterval: DEFAULT_SUBAGENT_CONFIG.pollInterval,
    maxAttendsPerTick: 3,
    cosineDecayCyclePeriod: 20,
    maxHistoryMessages: 30,
};

/**
 * MainAgentLoop — 主 Agent 注意力循环
 *
 * 串行处理，模拟人类注意力的轮询模式。
 * 每个 tick:
 * 1. 收集 callback
 * 2. 评估 Q3
 * 3. dequeue 并 attend 最高优先级群组
 * 4. 分派任务
 */
export class MainAgentLoop {
    private config: MainAgentLoopConfig;

    /** 依赖组件 */
    private attentionQueue: DynamicAttentionQueue;
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
     * 超过 maxHistoryMessages 时先截断，后使用 LLM compact。
     */
    private conversationHistory: ChatMessage[] = [];

    /** LLM 配置（用于对话历史 compact） */
    private llmConfigs: LLMConfig[] = [];

    /** 外部 attend handler（由 main.ts 集成注入） */
    private attendHandler: ((entry: AttentionQueueEntry) => Promise<AttendResult | null>) | null = null;

    /** 外部 dispatch handler */
    private dispatchHandler: ((result: AttendResult) => Promise<void>) | null = null;

    /** MemoryStoreV2 引用（MiniCodeAct corrections 使用） */
    private memory: any = null;

    /** attend 完成后的回调（metrics 使用） */
    private onAttendCompleteCallback: ((chatId: string, decisions: AttendResult) => void) | null = null;

    constructor(
        attentionQueue: DynamicAttentionQueue,
        callbackQueue: CallbackQueue,
        subagentManager: SubagentManager,
        config?: Partial<MainAgentLoopConfig>,
        globalState?: GlobalState | null,
    ) {
        this.attentionQueue = attentionQueue;
        this.callbackQueue = callbackQueue;
        this.subagentManager = subagentManager;
        this.globalState = globalState ?? null;
        this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
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
     * 设置 Memory 引用（MiniCodeAct corrections 使用）
     */
    setMemory(memory: any): void {
        this.memory = memory;
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
        // subagent.md §4.5: drain → recordDecision → markTaskComplete → unblock
        const callbacks = this.callbackQueue.drain();
        for (const cb of callbacks) {
            // 记录到 GlobalState（持久化审计）
            if (this.globalState) {
                this.globalState.recordDecision(
                    cb.chatId,
                    `CALLBACK: ${cb.executionType} ${cb.status} (${cb.summary})`,
                );
            }
            // 追加到对话历史（LLM 可见）
            await this.appendToHistory({
                role: "user",
                content: formatCallbackMessage(cb),
            });
            // 标记任务完成
            const cbSubagent = this.subagentManager.get(cb.chatId);
            if (cbSubagent) {
                cbSubagent.markTaskComplete(cb.taskId);
                cbSubagent.addCallback(cb);
            }
            // 解除阻塞
            this.attentionQueue.unblock(cb.chatId);

            // ═══ Phase 1.5: corrections 处理 ═══
            if (cb.corrections?.length) {
                for (const correction of cb.corrections) {
                    log.info("correction from subagent", {
                        chatId: cb.chatId,
                        originalCall: correction.originalCall,
                        issue: correction.issue,
                    });
                    const fixResults = executeMiniCodeActs(
                        [correction.suggestedFix],
                        cb.chatId,
                        {
                            globalState: this.globalState!,
                            memory: this.memory!,
                            attentionQueue: this.attentionQueue,
                            subagentManager: this.subagentManager,
                        },
                    );
                    for (const r of fixResults) {
                        this.globalState?.recordDecision(cb.chatId,
                            `CORRECTION: ${r.call} → ${r.success ? "OK" : "FAIL"} (${correction.issue})`);
                    }
                }
            }
        }

        // ═══ Phase 2: 动态队列评估 (Q3) ═══
        // 入队条件：FastPath 请求 或 triage-engage（RecordingPipeline 话题介入）
        // Observer 告警（engagement 超阈值）不作为入队触发——engagement 仅用于 Q3 内部优先级排序。
        // 直接寻址（@mention/DM/文本提及）由 main.ts nc.onPush 即时入队，不经过 Phase 2。
        for (const sa of this.subagentManager.getAllSubagents()) {
            if (!sa.hasTriageEngaged) {
                continue;
            }
            const entry = sa.buildQueueEntry();
            this.attentionQueue.enqueueOrUpdate(entry);
        }

        // Fix 7: pendingFollowups 驱动的优先级提升 (subagent.md 场景 5)
        if (this.globalState) {
            const followups = this.globalState.getPendingFollowups();
            for (const fu of followups) {
                if (fu.status === "PENDING" || fu.status === "IN_PROGRESS") {
                    this.attentionQueue.boost(fu.targetChatId, 20);
                    log.debug("Phase 2: followup boost", { targetChatId: fu.targetChatId, description: fu.description });
                }
            }
        }

        const evaluation = this.attentionQueue.evaluate();

        // 问题 #1: 输出当前队列快照，让运维知道有哪些群在排队
        const queueSnapshot = this.attentionQueue.getAll();
        if (queueSnapshot.length > 0) {
            log.info("tick: 队列快照", {
                tickCount: this.tickCount,
                queueSize: queueSnapshot.length,
                groups: queueSnapshot.map(e => `${e.chatId}(p=${e.priority.toFixed(1)}${e.blocked ? ",blocked" : ""})`).join(", "),
            });
        }

        // ═══ Phase 3-6: 按 maxAttendsPerTick 处理 ═══
        const attended: string[] = [];
        const decisions: AttendResult[] = [];
        const attendedThisTick = new Set<string>();  // 同 tick 防重复 attend

        // Circuit Breaker 检查：主 LLM 不可用时跳过 attend
        const cbOpen = Date.now() < this.circuitBreakerOpenUntil;
        if (cbOpen) {
            log.warn("tick: circuit breaker OPEN，跳过 Phase 3-6", {
                remainingMs: this.circuitBreakerOpenUntil - Date.now(),
                tickCount: this.tickCount,
            });
        }

        if (!cbOpen) {
        for (let i = 0; i < this.config.maxAttendsPerTick; i++) {
            // Fix 6: 在每次 attend 迭代之间 drain Q5
            // (subagent.md §4.5 "→ 立即回到 Phase 1")
            if (i > 0) {
                const midCallbacks = this.callbackQueue.drain();
                for (const cb of midCallbacks) {
                    callbacks.push(cb);
                    if (this.globalState) {
                        this.globalState.recordDecision(
                            cb.chatId,
                            `CALLBACK: ${cb.executionType} ${cb.status} (${cb.summary})`,
                        );
                    }
                    await this.appendToHistory({
                        role: "user",
                        content: formatCallbackMessage(cb),
                    });
                    const cbSubagent = this.subagentManager.get(cb.chatId);
                    if (cbSubagent) {
                        cbSubagent.markTaskComplete(cb.taskId);
                        cbSubagent.addCallback(cb);
                    }
                    this.attentionQueue.unblock(cb.chatId);
                }
            }

            // ─── Phase 3: dequeue 最高优先级群组 ───
            const entry = this.attentionQueue.dequeue();
            if (!entry) break;

            // 同 tick 防重复：LLM 调用期间新消息可能导致同一群被重入队
            // Fix: 放回队列而非丢弃——dequeue() 已从 Map 删除 entry，
            // 如果直接 continue 会导致 entry 丢失（无 LLM 调用）
            if (attendedThisTick.has(entry.chatId)) {
                this.attentionQueue.enqueueOrUpdate(entry);
                log.debug("Phase 3: 同 tick 重复 attend，放回队列", { chatId: entry.chatId, priority: entry.priority });
                continue;
            }
            attendedThisTick.add(entry.chatId);

            attended.push(entry.chatId);

            // ─── Phase 4-5: 构建上下文 + 决策 ───
            let result: AttendResult | null = null;

            if (this.attendHandler) {
                result = await this.attendHandler(entry);
            } else {
                log.warn("attendHandler 未设置，跳过", { chatId: entry.chatId });
            }

            if (result) {
                decisions.push(result);

                // ─── attend 完成回调（metrics hook）───
                try {
                    this.onAttendCompleteCallback?.(entry.chatId, result);
                } catch (e) {
                    log.debug("onAttendComplete callback error", { error: String(e) });
                }

                // ─── Phase 6: dispatch ───
                if (this.dispatchHandler) {
                    await this.dispatchHandler(result);
                }

                // ─── Phase 6.5: dispatch 完成后 compact 对话历史 ───
                // 从 appendToHistory 移至此处，避免在 attend 阶段 compact 延迟任务分派
                await this.compactHistoryIfNeeded();
            }

            // 更新 subagent attend 状态
            const subagent = this.subagentManager.get(entry.chatId);
            if (subagent) {
                subagent.markAttended();

                // attend 后立即触发 RecordingPipeline flush（仅聚类，不 triage）。
                // 路径 1（DM/mention）入队时 pipeline 可能尚未 flush，
                // 此处补一次聚类使下一轮 attend 的 topicDigests 不为空。
                // clusterOnly=true: 刚 attend 过的话题不需要重新 triage。
                // flush() 内部有 isFlushing 锁 + buffer 空检查，不会与定时 flush 冲突。
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
        } // end if (!cbOpen)
        // ═══ Phase 7: 更新全局状态 ═══
        if (this.globalState) {
            const queueSnapshot = this.attentionQueue.getAll();
            const summary = `Tick #${this.tickCount}: attended ${attended.length} groups, ` +
                `${callbacks.length} callbacks, ${queueSnapshot.length} in queue`;
            this.globalState.updateAttentionSummary(summary);
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

    /**
     * 设置 LLM 配置（用于对话历史 compact）
     */
    setLLMConfig(config: LLMConfig | LLMConfig[]): void {
        this.llmConfigs = Array.isArray(config) ? config : [config];
    }

    // ─── 对话历史管理 ───

    /**
     * 追加消息到主 Agent 对话历史。
     *
     * 超限时进行 Layer 1 确定性截断（保留最近 maxHistoryMessages 条）。
     * Layer 2 LLM compact 由 compactHistoryIfNeeded() 在任务完成后触发，
     * 避免在 attend/dispatch 阶段因 compact 延迟任务分派。
     */
    async appendToHistory(msg: ChatMessage): Promise<void> {
        this.conversationHistory.push(msg);

        // Layer 1: 基础截断
        if (this.conversationHistory.length > this.config.maxHistoryMessages) {
            this.conversationHistory = this.conversationHistory.slice(
                -this.config.maxHistoryMessages,
            );
        }
    }

    /**
     * 检查并执行对话历史的 LLM compact（Layer 2）。
     *
     * 应在任务完成后（dispatch 之后）调用，避免 compact 延迟任务分派。
     * 如果 token 总量未超预算，不做任何操作。
     */
    async compactHistoryIfNeeded(): Promise<void> {
        if (this.llmConfigs.length === 0) return;
        if (!shouldCompact(this.conversationHistory, undefined, this.llmConfigs[0])) return;

        try {
            log.info("主 Agent 对话历史 compact: token 超预算", {
                messageCount: this.conversationHistory.length,
            });
            this.conversationHistory = await contextManagerCompact(
                this.conversationHistory,
                this.llmConfigs,
            );
            log.info("主 Agent 对话历史 compact 完成", {
                afterCount: this.conversationHistory.length,
            });
        } catch (err) {
            log.warn("主 Agent 对话历史 compact 失败", {
                error: String(err),
            });
        }
    }

    /**
     * 获取当前对话历史（供 attendHandler 构建 LLM messages 使用）
     */
    getConversationHistory(): ReadonlyArray<ChatMessage> {
        return this.conversationHistory;
    }

    /**
     * 获取对话历史长度
     */
    getConversationHistorySize(): number {
        return this.conversationHistory.length;
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
 * 主 Agent LLM 在后续轮次可以看到这些消息，了解上一轮 subagent 做了什么。
 */
export function formatCallbackMessage(cb: SubagentCallback, chatTitle?: string): string {
    return renderPrompt("CALLBACK", buildCallbackVariables(cb, chatTitle ?? cb.chatTitle, cb.isDirectMessage));
}
