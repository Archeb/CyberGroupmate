/**
 * callback-queue.ts — 全局回调队列 (Q5)
 *
 * 收集所有 Subagent 的执行回调，供主 Agent 循环批量 drain。
 *
 * 参考设计：subagent.md §5
 */

import type { SubagentCallback } from "./types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("callback-queue");

/**
 * CallbackQueue — 全局回调队列 (Q5)
 *
 * 线程安全的生产者-消费者队列。
 * 生产者: CodeActExecutor, FastPathHandler
 * 消费者: MainAgentLoop (Phase 1)
 */
export class CallbackQueue {
    private queue: SubagentCallback[] = [];

    /**
     * 入队一个回调
     */
    enqueue(callback: SubagentCallback): void {
        this.queue.push(callback);
        log.debug("enqueue", {
            taskId: callback.taskId,
            chatId: callback.chatId,
            status: callback.status,
            queueSize: this.queue.length,
        });
    }

    /**
     * 批量取出所有排队中的回调（清空队列）
     * @returns 回调数组（可能为空）
     */
    drain(): SubagentCallback[] {
        if (this.queue.length === 0) return [];

        const drained = this.queue;
        this.queue = [];
        log.debug("drain", { count: drained.length });
        return drained;
    }

    /**
     * 查看队列中的回调（不移除）
     */
    peek(): ReadonlyArray<SubagentCallback> {
        return this.queue;
    }

    /**
     * 按 chatId 查看特定群组的回调
     */
    peekByChatId(chatId: string): SubagentCallback[] {
        return this.queue.filter(cb => cb.chatId === chatId);
    }

    /**
     * 队列大小
     */
    get size(): number {
        return this.queue.length;
    }

    /**
     * 队列是否为空
     */
    get isEmpty(): boolean {
        return this.queue.length === 0;
    }

    /**
     * 清空队列（不返回内容）
     */
    clear(): void {
        this.queue = [];
    }
}
