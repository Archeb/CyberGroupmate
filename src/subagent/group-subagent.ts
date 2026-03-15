/**
 * group-subagent.ts — 群组 Subagent 容器
 *
 * 每个群组的 Subagent 容器，持有三个组件：
 * - Observer: 消费消息、计算 Engagement、检测告警
 * - CodeActExecutor: CodeAct 执行器（S3 实现）
 * - FastPathHandler: 快速回复处理器（S4 实现）
 *
 * GroupSubagent 本身是一个轻量级容器，持有组件引用并提供
 * 构建 Q3 AttentionQueueEntry 的便捷方法。
 *
 * 参考设计：subagent.md §3
 */

import { Observer } from "./observer.js";
import type {
    AttentionQueueEntry,
    GroupStickiness,
    StickinessLevel,
    TopicDigest,
} from "./types.js";
import { createStickiness } from "./stickiness.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("group-subagent");

/** GroupSubagent 构造参数 */
export interface GroupSubagentOptions {
    chatId: string;
    /** Observer 配置 */
    observerConfig?: ConstructorParameters<typeof Observer>[1];
    /** 初始 stickiness */
    stickiness?: GroupStickiness;
}

/**
 * GroupSubagent — 群组级 Subagent 容器
 */
export class GroupSubagent {
    readonly chatId: string;
    readonly observer: Observer;

    /** 群组亲密度 */
    stickiness: GroupStickiness;

    /** 上次被主 Agent attend 的时间 */
    lastAttendedAt: string | null = null;

    /** attend 计数 */
    attendCount: number = 0;

    /** 最后活跃时间 */
    lastActivityAt: number = Date.now();

    /** CodeActExecutor 和 FastPathHandler 预留接口（S3/S4 实现后注入） */
    codeActExecutor: unknown = null;
    fastPathHandler: unknown = null;

    /** 已完成任务 ID 集合（用于状态追踪） */
    private completedTaskIds = new Set<string>();

    constructor(options: GroupSubagentOptions) {
        this.chatId = options.chatId;
        this.observer = new Observer(options.chatId, options.observerConfig);
        this.stickiness = options.stickiness ?? createStickiness("STRANGER");
    }

    /**
     * 构建 AttentionQueueEntry（供 Q3 入队）
     */
    buildQueueEntry(): AttentionQueueEntry {
        const engagement = this.observer.getEngagementScore();
        const alert = this.observer.checkAlert();
        const hasFastPathRequest = this.observer.checkFastPathRequest();
        const basePriority = engagement * this.stickiness.priorityMultiplier;

        // 来源标记 (subagent.md §2.2)
        const source: AttentionQueueEntry["source"] = alert
            ? "OBSERVER_ALERT"
            : hasFastPathRequest
                ? "FAST_PATH_REQUEST"
                : "DIGEST_UPDATE";

        return {
            chatId: this.chatId,
            source,
            priority: basePriority,
            basePriority,
            enqueuedAt: Date.now(),
            lastAttendedAt: this.lastAttendedAt,
            attendCount: this.attendCount,
            blocked: false,
            hasFastPathRequest,
            alert: alert ?? undefined,
            newMessageCount: this.observer.getBufferSize(),
            topicDigests: this.observer.getDigest(),
            stickinessLevel: this.stickiness.level,
        };
    }

    /**
     * 标记已被主 Agent attend
     */
    markAttended(): void {
        this.lastAttendedAt = new Date().toISOString();
        this.attendCount++;
        this.observer.clearBuffer();
        log.debug("markAttended", { chatId: this.chatId, attendCount: this.attendCount });
    }

    /**
     * 标记任务已完成（主循环 Phase 1 回调处理时调用）
     */
    markTaskComplete(taskId: string): void {
        this.completedTaskIds.add(taskId);
        log.debug("markTaskComplete", { chatId: this.chatId, taskId });
    }

    /**
     * 检查任务是否已完成
     */
    isTaskCompleted(taskId: string): boolean {
        return this.completedTaskIds.has(taskId);
    }

    /**
     * 更新活跃时间
     */
    touch(): void {
        this.lastActivityAt = Date.now();
    }

    /**
     * 检查是否空闲
     */
    isIdle(maxIdleMs: number): boolean {
        return Date.now() - this.lastActivityAt > maxIdleMs;
    }
}
