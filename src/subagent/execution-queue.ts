/**
 * execution-queue.ts — per-subagent 执行队列 (Q4)
 *
 * 串行执行队列，确保同一群组的任务按顺序执行。
 * CodeActExecutor 已内置 Q4 功能，此模块提供独立的通用实现。
 *
 * 参考设计：subagent.md §5
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("execution-queue");

/** 可执行任务接口 */
export interface ExecutableTask<T = unknown> {
    id: string;
    execute: () => Promise<T>;
}

/**
 * ExecutionQueue — 串行执行队列
 *
 * 按入队顺序串行执行任务，确保不并发。
 */
export class ExecutionQueue<T = unknown> {
    private queue: ExecutableTask<T>[] = [];
    private processing = false;
    private results: Array<{ id: string; result?: T; error?: string }> = [];

    /** 入队一个任务 */
    enqueue(task: ExecutableTask<T>): void {
        this.queue.push(task);
        log.debug("enqueue", { taskId: task.id, queueSize: this.queue.length });
        this.processNext();
    }

    /** 获取队列大小 */
    get size(): number {
        return this.queue.length;
    }

    /** 是否正在处理 */
    get isProcessing(): boolean {
        return this.processing;
    }

    /** 获取已完成结果 */
    getResults(): ReadonlyArray<{ id: string; result?: T; error?: string }> {
        return this.results;
    }

    /** 清空队列（不影响正在执行的任务） */
    clear(): void {
        this.queue = [];
    }

    /** 等待所有任务完成 */
    async waitForCompletion(): Promise<void> {
        while (this.processing || this.queue.length > 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    // ─── 内部 ───

    private async processNext(): Promise<void> {
        if (this.processing) return;
        if (this.queue.length === 0) return;

        this.processing = true;

        try {
            while (this.queue.length > 0) {
                const task = this.queue.shift()!;
                try {
                    const result = await task.execute();
                    this.results.push({ id: task.id, result });
                    log.debug("processNext: 完成", { taskId: task.id });
                } catch (err) {
                    this.results.push({ id: task.id, error: String(err) });
                    log.error("processNext: 失败", { taskId: task.id, error: String(err) });
                }
            }
        } finally {
            this.processing = false;
        }
    }
}
