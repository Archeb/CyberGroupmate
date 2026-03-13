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
}

const DEFAULT_LOOP_CONFIG: MainAgentLoopConfig = {
    pollInterval: DEFAULT_SUBAGENT_CONFIG.pollInterval,
    maxAttendsPerTick: 3,
    cosineDecayCyclePeriod: 20,
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

    /** 循环状态 */
    private running = false;
    private tickCount = 0;
    private lastTickAt: number = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    /** 最近收集的 callbacks */
    private pendingCallbacks: SubagentCallback[] = [];

    /** 外部 attend handler（由 main.ts 集成注入） */
    private attendHandler: ((entry: AttentionQueueEntry) => Promise<AttendResult | null>) | null = null;

    /** 外部 dispatch handler */
    private dispatchHandler: ((result: AttendResult) => Promise<void>) | null = null;

    constructor(
        attentionQueue: DynamicAttentionQueue,
        callbackQueue: CallbackQueue,
        subagentManager: SubagentManager,
        config?: Partial<MainAgentLoopConfig>,
    ) {
        this.attentionQueue = attentionQueue;
        this.callbackQueue = callbackQueue;
        this.subagentManager = subagentManager;
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
        phase2Eval: { activeCount: number; blockedCount: number };
        phase3Attended: string[];
        phase5Decisions: AttendResult[];
    }> {
        this.tickCount++;
        this.lastTickAt = Date.now();
        log.debug("tick: 开始", { tickCount: this.tickCount });

        // Phase 1: 收集 Q5 callback
        const callbacks = this.callbackQueue.drain();
        this.pendingCallbacks.push(...callbacks);

        // Phase 2: Q3 evaluate (时间衰减)
        const evaluation = this.attentionQueue.evaluate();

        // Phase 3-6: 按 maxAttendsPerTick 处理
        const attended: string[] = [];
        const decisions: AttendResult[] = [];

        for (let i = 0; i < this.config.maxAttendsPerTick; i++) {
            const entry = this.attentionQueue.dequeue();
            if (!entry) break;

            attended.push(entry.chatId);

            // Phase 4-5: attend 并决策
            let result: AttendResult | null = null;

            if (this.attendHandler) {
                result = await this.attendHandler(entry);
            } else {
                result = this.defaultAttend(entry);
            }

            if (result) {
                decisions.push(result);

                // Phase 6: dispatch
                if (this.dispatchHandler) {
                    await this.dispatchHandler(result);
                }
            }

            // Phase 7: 更新 subagent 状态
            const subagent = this.subagentManager.get(entry.chatId);
            if (subagent) {
                subagent.markAttended();
            }
        }

        // 清理已处理的 callback
        this.pendingCallbacks = [];

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
     * 获取待处理 callback
     */
    getPendingCallbacks(): SubagentCallback[] {
        return [...this.pendingCallbacks];
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

        // 决策
        const replyMode = estimateReplyMode(
            contextPkg,
            entry.newMessageCount,
            entry.hasFastPathRequest,
            entry.stickinessLevel,
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
