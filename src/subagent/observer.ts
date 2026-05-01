/**
 * observer.ts — per-group Observer 组件
 *
 * 每个群组的感知层：
 * - 消费消息到 Q2 buffer
 * - 维护 per-group TopicRegistry（话题状态机）
 * - 计算 Engagement Score（纯算法）
 * - 检测告警条件（engagement 超阈值）
 *
 * 参考设计：subagent.md §3.2
 */

import type { NotificationEvent } from "../event/notification-center.js";
import type {
    SubagentConfig,
} from "./types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("observer");

/** Observer 配置 */
export interface ObserverConfig {
    /** 告警 engagement 阈值 (0-100)。默认 60 */
    alertEngagementThreshold: number;
    /** engagement 计算时间窗口 (ms)。默认 5 分钟 */
    engagementWindowMs: number;
    /** @ bot 的关键词列表 */
    mentionKeywords: string[];
}

const DEFAULT_OBSERVER_CONFIG: ObserverConfig = {
    alertEngagementThreshold: DEFAULT_SUBAGENT_CONFIG.alertEngagementThreshold,
    engagementWindowMs: 5 * 60 * 1000,
    mentionKeywords: [],
};

/** Q2 buffer 中的消息条目 */
interface BufferedMessage {
    event: NotificationEvent;
    timestamp: number;
}

/**
 * Observer — per-group 感知组件
 *
 * 不持有 TopicRegistry/RecordingPipeline 实例（在 GroupSubagent 中注入）。
 * Observer 负责：
 * 1. 消息缓冲 (Q2)
 * 2. Engagement 计算
 * 3. Alert 检测
 */
export class Observer {
    readonly chatId: string;
    private config: ObserverConfig;

    /** Q2: 消息缓冲 */
    private buffer: BufferedMessage[] = [];

    /** 最后一条消息的时间 */
    private lastMessageAt: number = 0;

    /** 独立发言者集合（用于 engagement 计算） */
    private recentSenders = new Map<string, number>(); // userId → lastMessageAt

    /** 独立的消息时间戳追踪（不受 clearBuffer 影响，用于 engagement 计算） */
    private messageTimestamps: Array<{ timestamp: number; userId: string }> = [];

    /** 当前 engagement score 缓存 */
    private cachedEngagement: number = 0;

    /** 总消息数（自创建以来） */
    private totalMessageCount = 0;

    /** @ bot 消息数 */
    private mentionCount = 0;

    constructor(chatId: string, config?: Partial<ObserverConfig>) {
        this.chatId = chatId;
        this.config = { ...DEFAULT_OBSERVER_CONFIG, ...config };
    }

    /**
     * 接收一条消息到 Q2 buffer
     */
    onMessage(event: NotificationEvent): void {
        const now = Date.now();
        this.buffer.push({ event, timestamp: now });
        this.lastMessageAt = now;
        this.totalMessageCount++;

        // 更新 sender 追踪
        const userId = String(event.userId ?? event.user_id ?? event.senderId ?? "");
        if (userId) {
            this.recentSenders.set(userId, now);
            this.messageTimestamps.push({ timestamp: now, userId });
        }

        // 检测 mention
        const text = String(event.text ?? event.message ?? "");
        if (this.config.mentionKeywords.some(kw => text.includes(kw))) {
            this.mentionCount++;
        }

        // 清理过期条目
        this.cleanExpired(now);

        // 重算 engagement
        this.cachedEngagement = this.calculateEngagement(now);

        log.debug("onMessage", {
            chatId: this.chatId,
            bufferSize: this.buffer.length,
            engagement: this.cachedEngagement,
        });
    }

    /**
     * 获取当前 engagement score (0-100)
     *
     * 算法 (subagent.md §3.4)：
     * E = min(100, msgRate × 20 + senderDiversity × 15 + mentionBoost)
     * - msgRate: 窗口内每分钟消息数
     * - senderDiversity: 独立发言者数
     * - mentionBoost: 有 @bot 时 +20
     */
    getEngagementScore(): number {
        return this.cachedEngagement;
    }

    /**
     * 检查文本是否包含 mentionKeywords 中的任意关键字
    * 用于即时注意力注入判定（文本提及 agent 名字等）
     */
    hasMentionKeyword(text: string): boolean {
        if (this.config.mentionKeywords.length === 0) return false;
        const lower = text.toLowerCase();
        return this.config.mentionKeywords.some(kw => lower.includes(kw.toLowerCase()));
    }

    /**
     * 获取 buffer 中的消息数
     */
    getBufferSize(): number {
        return this.buffer.length;
    }

    /**
     * 获取总消息数
     */
    getTotalMessageCount(): number {
        return this.totalMessageCount;
    }

    /**
     * 获取 mention 数
     */
    getMentionCount(): number {
        return this.mentionCount;
    }

    /**
     * 获取自上次 attend 以来的新消息数
     */
    getNewMessageCount(sinceTimestamp?: number): number {
        if (!sinceTimestamp) return this.totalMessageCount;
        return this.buffer.filter(m => m.timestamp > sinceTimestamp).length;
    }

    /**
     * Flush buffer — 触发 RecordingPipeline 消费 (subagent.md §3.1)
     *
     * 在 per-group 架构中，RecordingPipeline 在 onMessage() 时直接
     * 接收消息到自己的 buffer，此方法仅标记 Observer buffer 已消费。
     */
    async flushBuffer(): Promise<void> {
        // RecordingPipeline 独立管理 flush 定时逻辑，
        // Observer 的 buffer 在 clearBuffer() 时由 attend 流程清理
        log.debug("flushBuffer", { chatId: this.chatId, bufferSize: this.buffer.length });
    }

    /**
     * 获取消息快照 (subagent.md §3.1)
     *
     * 返回最近 upTo 条 buffer 中的消息事件，供上下文构建使用。
     */
    getMessageSnapshot(upTo: number = 20): Array<{
        userId: string;
        displayName?: string;
        text: string;
        timestamp: string;
    }> {
        const slice = this.buffer.slice(-upTo);
        return slice.map(m => ({
            userId: String(m.event.userId ?? m.event.user_id ?? m.event.senderId ?? ""),
            displayName: typeof m.event.displayName === "string"
                ? m.event.displayName
                : typeof m.event.display_name === "string"
                    ? m.event.display_name
                    : undefined,
            text: String(m.event.text ?? m.event.message ?? ""),
            timestamp: new Date(m.timestamp).toISOString(),
        }));
    }

    /**
     * 清空 buffer（attend 后调用）
     */
    clearBuffer(): void {
        this.buffer = [];
        this.mentionCount = 0;
        // attend 后清零 engagement 相关状态（subagent.md §4.5）：
        // 已审视的群组不应因历史 engagement 被反复入队。
        // 新消息到达时 onMessage() 会重新累积。
        this.messageTimestamps = [];
        this.recentSenders.clear();
        this.cachedEngagement = 0;
    }

    /**
     * 重置统计（用于测试）
     */
    reset(): void {
        this.buffer = [];
        this.recentSenders.clear();
        this.messageTimestamps = [];
        this.cachedEngagement = 0;
        this.totalMessageCount = 0;
        this.mentionCount = 0;
        this.lastMessageAt = 0;
    }

    // ─── 内部方法 ───

    private calculateEngagement(now: number): number {
        const windowStart = now - this.config.engagementWindowMs;

        // 使用独立的 messageTimestamps（不受 clearBuffer 影响）
        const windowMessages = this.messageTimestamps.filter(m => m.timestamp >= windowStart);
        const msgCount = windowMessages.length;

        // 消息频率（每分钟）
        const windowMinutes = this.config.engagementWindowMs / 60_000;
        const msgRate = msgCount / windowMinutes;

        // 独立发言者数
        const activeSenders = new Set<string>();
        for (const m of windowMessages) {
            if (m.userId) activeSenders.add(m.userId);
        }
        const senderDiversity = activeSenders.size;

        // mention boost
        const mentionBoost = this.mentionCount > 0 ? 20 : 0;

        return Math.min(100, Math.round(msgRate * 20 + senderDiversity * 15 + mentionBoost));
    }

    private cleanExpired(now: number): void {
        const windowStart = now - this.config.engagementWindowMs;
        this.buffer = this.buffer.filter(m => m.timestamp >= windowStart);
        this.messageTimestamps = this.messageTimestamps.filter(m => m.timestamp >= windowStart);

        // 清理过期 sender 追踪
        for (const [userId, lastSeen] of this.recentSenders.entries()) {
            if (lastSeen < windowStart) {
                this.recentSenders.delete(userId);
            }
        }
    }
}
