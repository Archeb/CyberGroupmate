/**
 * code-act-executor.ts — per-group CodeAct 执行器
 *
 * 每个群组的 CodeAct 执行器：
 * - 持有独立 LLM session（ChatMessage[] 对话历史）
 * - 通过 SandboxPool 获取 sandbox 实例
 * - 执行主 Agent 分派的 CodeActReplyTask
 * - 串行执行（通过 Q4 执行队列）
 * - 产出 SubagentCallback 到 Q5
 *
 * 参考设计：subagent.md §3.2, subtask.md S3.2
 */

import type {
    CodeActReplyTask,
    SubagentCallback,
    GroupContextPackage,
} from "./types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("code-act-executor");

/** CodeActExecutor 配置 */
export interface CodeActExecutorConfig {
    /** 单次执行最大超时 (ms)。默认 60000 */
    maxExecutionTimeMs: number;
    /** session 最大消息数（超过后 compact）。默认 100 */
    maxSessionMessages: number;
}

const DEFAULT_EXECUTOR_CONFIG: CodeActExecutorConfig = {
    maxExecutionTimeMs: 60_000,
    maxSessionMessages: 100,
};

/** 简化的 ChatMessage 用于 session 持久化 */
export interface SessionMessage {
    role: "system" | "user" | "assistant";
    content: string;
    timestamp: string;
}

/**
 * CodeActExecutor — per-group CodeAct 执行器
 *
 * 注意：Sandbox 实例由 SandboxPool 管理，此处只持有引用。
 * 实际的 runCodeActSession 调用在 S5 主循环中由 main-agent 编排。
 */
export class CodeActExecutor {
    readonly chatId: string;
    private config: CodeActExecutorConfig;

    /** 独立对话历史 */
    session: SessionMessage[] = [];

    /** 任务执行队列 (Q4) */
    private taskQueue: CodeActReplyTask[] = [];
    /** 是否正在处理任务 */
    private processing = false;

    /** 上次 compact 时间 */
    lastCompactedAt: string | null = null;

    /** 执行计数 */
    private executionCount = 0;

    /** Callback handler（由 GroupSubagent 或 S8 集成时注入） */
    private callbackHandler: ((cb: SubagentCallback) => void) | null = null;

    constructor(chatId: string, config?: Partial<CodeActExecutorConfig>) {
        this.chatId = chatId;
        this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
    }

    /**
     * 设置 callback handler（回调到 Q5）
     */
    setCallbackHandler(handler: (cb: SubagentCallback) => void): void {
        this.callbackHandler = handler;
    }

    /**
     * 向 Q4 入队一个任务
     */
    enqueue(task: CodeActReplyTask): void {
        this.taskQueue.push(task);
        log.debug("enqueue", { chatId: this.chatId, taskId: task.taskId, queueSize: this.taskQueue.length });

        // 尝试开始处理
        this.processNext();
    }

    /**
     * 执行一个 CodeAct 任务（核心方法）
     *
     * 当前实现：
     * 1. 记录任务上下文到 session
     * 2. 产出 callback
     *
     * 完整实现在 S5 主循环中：会调用 SandboxPool.acquire(),
     * runCodeActSession() 等。此处提供结构骨架。
     */
    async execute(task: CodeActReplyTask): Promise<SubagentCallback> {
        const startTime = Date.now();
        this.executionCount++;

        log.info("execute: 开始", {
            chatId: this.chatId,
            taskId: task.taskId,
            replyMode: task.replyMode,
            decisionsCount: task.decisions.length,
        });

        // 记录 task 上下文到 session
        this.session.push({
            role: "user",
            content: `[TASK ${task.taskId}] ${JSON.stringify({
                replyMode: task.replyMode,
                decisions: task.decisions,
                topicDigests: task.contextSnapshot.topicDigests,
            })}`,
            timestamp: task.createdAt,
        });

        // 检查 session 长度
        if (this.session.length > this.config.maxSessionMessages) {
            this.compactSession();
        }

        try {
            // TODO S5: 实际的 sandbox 执行逻辑
            // 1. SandboxPool.acquire(this.chatId)
            // 2. 注入 Prompt ➎ 模板
            // 3. runCodeActSession()
            // 4. 解析结果

            const durationMs = Date.now() - startTime;

            // 记录 assistant 回复到 session
            this.session.push({
                role: "assistant",
                content: `[COMPLETED] Task ${task.taskId} executed in ${durationMs}ms`,
                timestamp: new Date().toISOString(),
            });

            const callback: SubagentCallback = {
                taskId: task.taskId,
                chatId: this.chatId,
                executionType: "CODEACT",
                status: "COMPLETED",
                summary: `Executed ${task.replyMode} task with ${task.decisions.length} decisions`,
                durationMs,
                createdAt: new Date().toISOString(),
            };

            log.info("execute: 完成", { chatId: this.chatId, taskId: task.taskId, durationMs });
            return callback;

        } catch (err) {
            const durationMs = Date.now() - startTime;
            const callback: SubagentCallback = {
                taskId: task.taskId,
                chatId: this.chatId,
                executionType: "CODEACT",
                status: "ERROR",
                summary: `Execution failed: ${String(err)}`,
                error: String(err),
                durationMs,
                createdAt: new Date().toISOString(),
            };

            log.error("execute: 失败", { chatId: this.chatId, taskId: task.taskId, error: String(err) });
            return callback;
        }
    }

    /**
     * 获取 Q4 队列大小
     */
    getQueueSize(): number {
        return this.taskQueue.length;
    }

    /**
     * 获取 session 大小
     */
    getSessionSize(): number {
        return this.session.length;
    }

    /**
     * 获取执行计数
     */
    getExecutionCount(): number {
        return this.executionCount;
    }

    /**
     * 是否正在处理
     */
    isProcessing(): boolean {
        return this.processing;
    }

    /**
     * 清空 session（用于测试）
     */
    clearSession(): void {
        this.session = [];
        this.lastCompactedAt = null;
    }

    // ─── 内部方法 ───

    private async processNext(): Promise<void> {
        if (this.processing) return;
        if (this.taskQueue.length === 0) return;

        this.processing = true;

        try {
            while (this.taskQueue.length > 0) {
                const task = this.taskQueue.shift()!;
                const callback = await this.execute(task);

                // 通知 callback handler (Q5)
                if (this.callbackHandler) {
                    this.callbackHandler(callback);
                }
            }
        } finally {
            this.processing = false;
        }
    }

    private compactSession(): void {
        // 保留 maxSessionMessages 的 40%（至少 4 条）
        const keep = Math.max(4, Math.floor(this.config.maxSessionMessages * 0.4));
        if (this.session.length > keep) {
            const summary: SessionMessage = {
                role: "system",
                content: `[COMPACTED] Previous ${this.session.length - keep} messages summarized. Total executions: ${this.executionCount}`,
                timestamp: new Date().toISOString(),
            };
            this.session = [summary, ...this.session.slice(-keep)];
            this.lastCompactedAt = new Date().toISOString();
            log.debug("compactSession", { chatId: this.chatId, remaining: this.session.length });
        }
    }
}
