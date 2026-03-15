/**
 * attention-queue.ts — 主 Agent 动态注意力队列 (Q3)
 *
 * 管理所有群组的注意力条目，支持：
 * - 优先级排序（engagement + stickiness + 时间衰减）
 * - block/unblock（正在执行 subagent 任务时阻塞）
 * - 动态评估（合并同群上报、时间衰减）
 *
 * 参考设计：subagent.md §4.3
 */

import type {
    AttentionQueueEntry,
    ObserverAlert,
    TopicDigest,
    QueueEvaluation,
    StickinessLevel,
    SubagentConfig,
} from "./types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("attention-queue");

/** 注意力队列配置 */
export interface AttentionQueueConfig {
    /** 时间衰减系数 (每秒衰减量)。默认 0.001 */
    timeDecayPerSecond: number;
    /** 最大队列大小。默认 100 */
    maxSize: number;
}

/**
 * DynamicAttentionQueue — 主 Agent 注意力队列
 *
 * 内部使用 Map<chatId, entry> 存储，dequeue 时按优先级排序。
 */
export class DynamicAttentionQueue {
    private entries = new Map<string, AttentionQueueEntry>();
    private config: AttentionQueueConfig;

    constructor(config?: Partial<AttentionQueueConfig>) {
        this.config = {
            timeDecayPerSecond: config?.timeDecayPerSecond
                ?? DEFAULT_SUBAGENT_CONFIG.attentionQueue.timeDecayPerSecond,
            maxSize: config?.maxSize
                ?? DEFAULT_SUBAGENT_CONFIG.attentionQueue.maxSize,
        };
    }

    /**
     * 入队或更新已有条目。
     * 如果 chatId 已存在，合并数据（priority 取最高值）。
     */
    enqueueOrUpdate(entry: Partial<AttentionQueueEntry> & { chatId: string }): void {
        const existing = this.entries.get(entry.chatId);

        if (existing) {
            // 合并：priority 取最高值
            if (entry.priority !== undefined && entry.priority > existing.priority) {
                existing.priority = entry.priority;
                existing.basePriority = entry.basePriority ?? entry.priority;
            }
            // 更新 source（取更高优先的来源）
            if (entry.source) existing.source = entry.source;
            // 更新其他字段
            if (entry.topicDigests) existing.topicDigests = entry.topicDigests;
            if (entry.alert) existing.alert = entry.alert;
            if (entry.newMessageCount !== undefined) existing.newMessageCount = entry.newMessageCount;
            if (entry.hasFastPathRequest !== undefined) existing.hasFastPathRequest = entry.hasFastPathRequest;
            if (entry.stickinessLevel) existing.stickinessLevel = entry.stickinessLevel;

            log.debug("enqueueOrUpdate: UPDATE", { chatId: entry.chatId, priority: existing.priority, source: existing.source });
        } else {
            // 新增
            if (this.entries.size >= this.config.maxSize) {
                // 移除最低优先级的非阻塞条目
                this.evictLowest();
            }

            const newEntry: AttentionQueueEntry = {
                chatId: entry.chatId,
                source: entry.source ?? "DIGEST_UPDATE",
                priority: entry.priority ?? 0,
                basePriority: entry.basePriority ?? entry.priority ?? 0,
                enqueuedAt: entry.enqueuedAt ?? Date.now(),
                lastAttendedAt: entry.lastAttendedAt ?? null,
                attendCount: entry.attendCount ?? 0,
                blocked: entry.blocked ?? false,
                blockReason: entry.blockReason,
                hasFastPathRequest: entry.hasFastPathRequest ?? false,
                alert: entry.alert,
                newMessageCount: entry.newMessageCount ?? 0,
                topicDigests: entry.topicDigests ?? [],
                stickinessLevel: entry.stickinessLevel ?? "STRANGER",
            };

            this.entries.set(entry.chatId, newEntry);
            log.debug("enqueueOrUpdate: INSERT", { chatId: entry.chatId, priority: newEntry.priority, source: newEntry.source });
        }
    }

    /**
     * 提升指定 chatId 的优先级
     */
    boost(chatId: string, amount: number): void {
        const entry = this.entries.get(chatId);
        if (entry) {
            entry.priority = Math.min(100, entry.priority + amount);
            entry.basePriority = Math.min(100, entry.basePriority + amount);
            log.debug("boost", { chatId, amount, newPriority: entry.priority });
        }
    }

    /**
     * 阻塞指定 chatId（正在执行任务）
     */
    block(chatId: string, reason?: string): void {
        const entry = this.entries.get(chatId);
        if (entry) {
            entry.blocked = true;
            entry.blockReason = reason;
            log.debug("block", { chatId, reason });
        }
    }

    /**
     * 解除阻塞
     */
    unblock(chatId: string): void {
        const entry = this.entries.get(chatId);
        if (entry) {
            entry.blocked = false;
            entry.blockReason = undefined;
            log.debug("unblock", { chatId });
        }
    }

    /**
     * 出队最高优先级的非阻塞条目。
     * @returns 条目，或 null（如果队列为空或全被阻塞）
     */
    dequeue(): AttentionQueueEntry | null {
        const sorted = this.getSortedActive();
        if (sorted.length === 0) return null;

        const top = sorted[0];
        this.entries.delete(top.chatId);
        log.debug("dequeue", { chatId: top.chatId, priority: top.priority });
        return top;
    }

    /**
     * 查看最高优先级的非阻塞条目（不移除）
     */
    peek(): AttentionQueueEntry | null {
        const sorted = this.getSortedActive();
        return sorted.length > 0 ? sorted[0] : null;
    }

    /**
     * 动态评估队列：应用时间衰减
     */
    evaluate(): QueueEvaluation {
        const now = Date.now();
        let activeCount = 0;
        let blockedCount = 0;
        let maxPriority = 0;

        for (const entry of this.entries.values()) {
            // 时间衰减
            const elapsedSec = (now - entry.enqueuedAt) / 1000;
            const decay = elapsedSec * this.config.timeDecayPerSecond;
            entry.priority = Math.max(0, entry.basePriority - decay);

            if (entry.blocked) {
                blockedCount++;
            } else {
                activeCount++;
                maxPriority = Math.max(maxPriority, entry.priority);
            }
        }

        return {
            queueSize: this.entries.size,
            activeCount,
            blockedCount,
            maxPriority,
        };
    }

    /**
     * 获取指定 chatId 的条目
     */
    get(chatId: string): AttentionQueueEntry | undefined {
        return this.entries.get(chatId);
    }

    /**
     * 移除指定 chatId
     */
    remove(chatId: string): boolean {
        return this.entries.delete(chatId);
    }

    /**
     * 队列大小
     */
    get size(): number {
        return this.entries.size;
    }

    /**
     * 清空队列
     */
    clear(): void {
        this.entries.clear();
    }

    /**
     * 获取所有条目（不排序）
     */
    getAll(): AttentionQueueEntry[] {
        return Array.from(this.entries.values());
    }

    // ─── 内部方法 ───

    private getSortedActive(): AttentionQueueEntry[] {
        return Array.from(this.entries.values())
            .filter(e => !e.blocked)
            .sort((a, b) => b.priority - a.priority);
    }

    private evictLowest(): void {
        const sorted = Array.from(this.entries.values())
            .filter(e => !e.blocked)
            .sort((a, b) => a.priority - b.priority);

        if (sorted.length > 0) {
            this.entries.delete(sorted[0].chatId);
            log.debug("evictLowest", { chatId: sorted[0].chatId });
        }
    }
}
