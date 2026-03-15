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
    GroupContextPackage,
    AttendResult,
    CodeActReplyTask,
    SubagentConfig,
} from "../subagent/types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "../subagent/types.js";
import { calculateDepth, type ContextDepth } from "./cosine-decay.js";
import { buildGroupContext, type ContextBuildInput } from "./context-builder.js";
import { estimateReplyMode, estimateReplyCount, buildObserveDecision, buildReplyDecisions } from "./decision-maker.js";
import { renderPrompt, buildAttentionVariables } from "./prompt-renderer.js";
import type { ChatMessage } from "../core/llm.js";
import { createLogger } from "../core/logger.js";
import { randomUUID } from "node:crypto";

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

    /**
     * 主 Agent LLM 对话历史
     * 按时间顺序存放：attend 上下文 (user) → 决策 (assistant) → callback (user) → ...
     * 超过 maxHistoryMessages 时从头部截断。
     */
    private conversationHistory: ChatMessage[] = [];

    /** 外部 attend handler（由 main.ts 集成注入） */
    private attendHandler: ((entry: AttentionQueueEntry) => Promise<AttendResult | null>) | null = null;

    /** 外部 dispatch handler */
    private dispatchHandler: ((result: AttendResult) => Promise<void>) | null = null;

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
     * 执行一个 tick（适用于手动调用/测试）
     */
    async tick(): Promise<{
        phase1Callbacks: number;
        phase2Eval: { activeCount: number; blockedCount: number; boostedAlerts: number };
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
            this.appendToHistory({
                role: "user",
                content: formatCallbackMessage(cb),
            });
            // 标记任务完成
            const cbSubagent = this.subagentManager.get(cb.chatId);
            if (cbSubagent) {
                cbSubagent.markTaskComplete(cb.taskId);
            }
            // 解除阻塞
            this.attentionQueue.unblock(cb.chatId);
        }

        // ═══ Phase 2: 动态队列评估 (Q3) ═══
        // subagent.md §4.5: 遍历所有 subagent → enqueueOrUpdate → alert boost → evaluate
        let boostedAlerts = 0;
        for (const sa of this.subagentManager.getAllSubagents()) {
            // 只有当 Observer 有新数据时才入队（buffer 非空、告警、FastPath 请求）
            // 避免空闲群组被反复 enqueue → dequeue → 白白调用 LLM
            const entry = sa.buildQueueEntry();
            if (entry.newMessageCount === 0 && !entry.alert && !entry.hasFastPathRequest) {
                continue;
            }
            this.attentionQueue.enqueueOrUpdate(entry);

            const alert = sa.observer.checkAlert();
            if (alert) {
                this.attentionQueue.boost(sa.chatId, 20);
                boostedAlerts++;
                log.debug("Phase 2: alert boost", { chatId: sa.chatId, engagement: alert.engagementScore });
            }
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
                    this.appendToHistory({
                        role: "user",
                        content: formatCallbackMessage(cb),
                    });
                    const cbSubagent = this.subagentManager.get(cb.chatId);
                    if (cbSubagent) {
                        cbSubagent.markTaskComplete(cb.taskId);
                    }
                    this.attentionQueue.unblock(cb.chatId);
                }
            }

            // ─── Phase 3: dequeue 最高优先级群组 ───
            const entry = this.attentionQueue.dequeue();
            if (!entry) break;

            attended.push(entry.chatId);

            // ─── Phase 4-5: 构建上下文 + 决策 ───
            let result: AttendResult | null = null;

            if (this.attendHandler) {
                result = await this.attendHandler(entry);
            } else {
                result = this.defaultAttend(entry);
            }

            if (result) {
                decisions.push(result);

                // ─── Phase 6: dispatch ───
                if (this.dispatchHandler) {
                    await this.dispatchHandler(result);
                }
            }

            // 更新 subagent attend 状态
            const subagent = this.subagentManager.get(entry.chatId);
            if (subagent) {
                subagent.markAttended();
            }
        }

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
            boostedAlerts,
        });

        return {
            phase1Callbacks: callbacks.length,
            phase2Eval: {
                activeCount: evaluation.activeCount,
                blockedCount: evaluation.blockedCount,
                boostedAlerts,
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
     * 追加消息到主 Agent 对话历史，超限时从头部截断。
     * attendHandler 产生的 attend prompt (user) 和 LLM 决策 (assistant)
     * 以及 callback 反馈 (user) 都通过此方法追加。
     */
    appendToHistory(msg: ChatMessage): void {
        this.conversationHistory.push(msg);
        if (this.conversationHistory.length > this.config.maxHistoryMessages) {
            this.conversationHistory = this.conversationHistory.slice(
                -this.config.maxHistoryMessages,
            );
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

    /**
     * 默认 attend 逻辑（无外部 handler 时）
     */
    private defaultAttend(entry: AttentionQueueEntry): AttendResult {
        const subagent = this.subagentManager.get(entry.chatId);
        if (!subagent) {
            return buildObserveDecision(entry.chatId);
        }



        // 计算上下文深度
        const depth = calculateDepth(
            entry.attendCount,
            this.config.cosineDecayCyclePeriod,
        );

        // 构建上下文
        const contextInput: ContextBuildInput = {
            chatId: entry.chatId,
            depth,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: entry.topicDigests,
            engagementScore: entry.priority,
        };
        const contextPkg = buildGroupContext(contextInput);

        // 决策 (Fix 4: 传入丰富信号)
        const timeSinceLastAttendMs = entry.lastAttendedAt
            ? Date.now() - new Date(entry.lastAttendedAt).getTime()
            : Infinity;
        const replyMode = estimateReplyMode(
            contextPkg,
            entry.newMessageCount,
            entry.hasFastPathRequest,
            entry.stickinessLevel,
            entry.topicDigests.filter(d => d.state === "ACTIVE").length,
            timeSinceLastAttendMs,
            0, // avgMessageLength: 不在 queue entry 中，后续由 Observer 提供
        );

        if (replyMode === "NONE") {
            return buildObserveDecision(entry.chatId);
        }

        return buildReplyDecisions(
            entry.chatId,
            replyMode,
            entry.topicDigests.map(d => ({ topicId: d.topicId, label: d.label })),
            `Auto-decision: ${replyMode} (engagement=${entry.priority}, depth=L${depth})`,
        );
    }

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
export function formatCallbackMessage(cb: SubagentCallback): string {
    let msg = `[Callback ${cb.chatId}] ${cb.executionType} ${cb.status}`;
    msg += ` | ${cb.summary}`;
    if (cb.sentMessages?.length) {
        msg += `\n已发消息:`;
        for (const m of cb.sentMessages) {
            const text = m.text.length > 80 ? m.text.slice(0, 80) + "..." : m.text;
            msg += `\n- "${text}"`;
        }
    }
    if (cb.error) {
        msg += `\n错误: ${cb.error}`;
    }
    msg += `\n耗时: ${cb.durationMs}ms`;
    return msg;
}
