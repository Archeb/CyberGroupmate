/**
 * phase6/topic-registry.ts — 话题注册表
 *
 * 维护所有活跃话题的内存数据结构。
 * 提供话题 CRUD、状态机转换、超时清理、流变继承。
 *
 * 在整体架构中的位置：
 * - RecordingPipeline 通过 create/addMessages/setDecision 写入
 * - FastRouter 通过 getEngaged 查询 ENGAGED 话题
 * - EngagedTopicHandler 通过 transition 驱动状态变更
 * - main.ts 定时调用 cleanup() 清理过期话题
 */

import { EventEmitter } from "node:events";
import { createLogger } from "../core/logger.js";
import type {
    Topic,
    TopicState,
    TriageDecision,
    Message,
    ExitSignal,
} from "./types.js";

const log = createLogger("topic-registry");

// ─── 常量 ───

/** 话题进入 STALE 的不活跃时间（毫秒） */
const STALE_TIMEOUT = 15 * 60 * 1000;      // 15 min

/** 话题进入 ARCHIVED 的不活跃时间（毫秒） */
const ARCHIVE_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

/** IGNORED 状态的 TTL（毫秒） */
const IGNORED_TTL = 10 * 60 * 1000;         // 10 min

/** COOLDOWN 默认持续时间（毫秒） */
const DEFAULT_COOLDOWN = 5 * 60 * 1000;     // 5 min

/** COOLDOWN 长持续时间（身份探测等） */
const LONG_COOLDOWN = 30 * 60 * 1000;       // 30 min

/** ID 计数器 */
let topicCounter = 0;

/** 生成话题 ID */
function generateTopicId(): string {
    const ts = Date.now().toString(36);
    const seq = (++topicCounter).toString(36).padStart(4, "0");
    return `topic_${ts}_${seq}`;
}

// ─── 合法状态转换表 ───

const VALID_TRANSITIONS: Record<TopicState, TopicState[]> = {
    ACTIVE:            ["TRIAGING", "STALE"],
    TRIAGING:          ["PRELOADING", "IGNORED", "IGNORED_LOW_VALUE", "ACTIVE"],
    PRELOADING:        ["ENGAGED", "ACTIVE"],
    ENGAGED:           ["EXITING", "COOLDOWN"],
    EXITING:           ["COOLDOWN"],
    COOLDOWN:          ["ACTIVE"],
    IGNORED:           ["ACTIVE", "STALE"],
    IGNORED_LOW_VALUE: ["STALE"],
    STALE:             ["ACTIVE", "ARCHIVED"],
    ARCHIVED:          [],
};

// ─── TopicRegistry ───

/**
 * TopicRegistry — 话题注册表
 *
 * 内存数据结构，管理所有活跃话题的生命周期。
 * 通过 EventEmitter 通知状态变更。
 *
 * Events:
 * - `topic:created` (topic: Topic)
 * - `topic:stateChanged` (topic: Topic, from: TopicState, to: TopicState)
 * - `topic:engaged` (topic: Topic)
 * - `topic:exit` (topic: Topic, signal: ExitSignal)
 * - `topic:archived` (topic: Topic)
 */
export class TopicRegistry extends EventEmitter {
    private topics: Map<string, Topic> = new Map();

    /**
     * 创建新话题
     */
    create(
        chatId: string,
        label: string,
        keywords: string[],
        messages: Message[],
        parentTopicId?: string
    ): Topic {
        const now = Date.now();
        const topic: Topic = {
            id: generateTopicId(),
            chatId,
            label,
            keywords,
            participantIds: new Set(messages.map(m => m.senderId)),
            messageIds: messages.map(m => m.id),
            state: "ACTIVE",
            parentTopicId,
            createdAt: now,
            lastActivityAt: now,
            turnCount: 0,
            maxTurns: 5,
            pendingMessages: [],
            exitSignals: [],
            irrelevantStreak: 0,
            messageCount: messages.length,
            recentContext: messages.map(m => `${m.senderName}: ${m.text}`).slice(-5).join("\n"),
        };

        this.topics.set(topic.id, topic);
        log.info("话题创建", { id: topic.id, label, chatId, messages: messages.length });
        this.emit("topic:created", topic);
        return topic;
    }

    /**
     * 获取指定话题
     */
    get(topicId: string): Topic | undefined {
        return this.topics.get(topicId);
    }

    /**
     * 获取指定群组的所有非归档话题
     */
    getByChat(chatId: string): Topic[] {
        return Array.from(this.topics.values())
            .filter(t => t.chatId === chatId && t.state !== "ARCHIVED");
    }

    /**
     * 获取指定群组的所有 ENGAGED 话题
     */
    getEngaged(chatId: string): Topic[] {
        return Array.from(this.topics.values())
            .filter(t => t.chatId === chatId && t.state === "ENGAGED");
    }

    /**
     * 获取指定群组的所有 ACTIVE 话题（供 Recording Pipeline 用）
     */
    getActive(chatId: string): Topic[] {
        return Array.from(this.topics.values())
            .filter(t => t.chatId === chatId && t.state === "ACTIVE");
    }

    /**
     * 获取所有话题（调试用）
     */
    getAll(): Topic[] {
        return Array.from(this.topics.values());
    }

    /**
     * 状态机转换
     *
     * @throws 如果转换不合法
     */
    transition(topicId: string, newState: TopicState): void {
        const topic = this.topics.get(topicId);
        if (!topic) {
            log.warn("话题不存在", { topicId, targetState: newState });
            return;
        }

        const from = topic.state;
        const allowed = VALID_TRANSITIONS[from];
        if (!allowed.includes(newState)) {
            log.warn("非法状态转换", { topicId, from, to: newState });
            return;
        }

        topic.state = newState;
        log.debug("状态转换", { topicId: topic.id, label: topic.label, from, to: newState });
        this.emit("topic:stateChanged", topic, from, newState);

        if (newState === "ENGAGED") {
            this.emit("topic:engaged", topic);
        }
        if (newState === "ARCHIVED") {
            this.emit("topic:archived", topic);
        }
    }

    /**
     * 添加消息到话题
     */
    addMessages(topicId: string, messages: Message[]): void {
        const topic = this.topics.get(topicId);
        if (!topic) return;

        for (const msg of messages) {
            topic.messageIds.push(msg.id);
            topic.participantIds.add(msg.senderId);
        }
        topic.messageCount += messages.length;

        // 只对活跃状态的话题刷新 lastActivityAt，
        // STALE/IGNORED/ARCHIVED 状态不应因新消息聚类到此而重置超时计时器
        const activeStates: TopicState[] = ["ACTIVE", "TRIAGING", "PRELOADING", "ENGAGED", "EXITING", "COOLDOWN"];
        if (activeStates.includes(topic.state)) {
            topic.lastActivityAt = Date.now();
        }

        // 更新最近上下文
        const allMsgTexts = messages.map(m => `${m.senderName}: ${m.text}`);
        const existing = topic.recentContext ? topic.recentContext.split("\n") : [];
        topic.recentContext = [...existing, ...allMsgTexts].slice(-8).join("\n");
    }

    /**
     * 设置 Triage 结果
     */
    setDecision(topicId: string, decision: TriageDecision): void {
        const topic = this.topics.get(topicId);
        if (!topic) return;

        topic.decision = decision;
        topic.lastTriagedAt = Date.now();
    }

    /**
     * 话题流变继承
     *
     * 根据父话题的状态决定子话题的初始状态和修饰。
     */
    inheritDecision(parentTopicId: string, childTopicId: string): void {
        const parent = this.topics.get(parentTopicId);
        const child = this.topics.get(childTopicId);
        if (!parent || !child) return;

        switch (parent.state) {
            case "ENGAGED":
            case "COOLDOWN":
            case "EXITING":
                // 刚回复过/冷却中/退出中 → 冷静一下
                child.cooldownBoost = true;
                break;

            case "IGNORED":
            case "IGNORED_LOW_VALUE":
                // 之前不介入 → 传递原因供参考
                child.ignoreReason = parent.ignoreReason ?? parent.decision?.reason;
                break;

            default:
                break;
        }

        log.debug("话题流变继承", {
            parent: parentTopicId,
            child: childTopicId,
            parentState: parent.state,
            cooldownBoost: child.cooldownBoost,
        });
    }

    /**
     * 定时清理：检测超时话题
     *
     * 应由主循环定时调用（如每分钟一次）。
     */
    cleanup(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const topic of this.topics.values()) {
            const elapsed = now - topic.lastActivityAt;

            // ACTIVE/TRIAGING/PRELOADING → STALE（15min 不活跃）
            if (
                ["ACTIVE", "TRIAGING", "PRELOADING"].includes(topic.state) &&
                elapsed > STALE_TIMEOUT
            ) {
                this.transition(topic.id, "STALE");
                cleaned++;
                continue;
            }

            // STALE → ARCHIVED（2h 不活跃）
            if (topic.state === "STALE" && elapsed > ARCHIVE_TIMEOUT) {
                this.transition(topic.id, "ARCHIVED");
                cleaned++;
                continue;
            }

            // IGNORED → STALE（TTL 过期，渐渐淡出而非循环回 ACTIVE 重 triage）
            if (
                topic.state === "IGNORED" &&
                topic.lastTriagedAt &&
                now - topic.lastTriagedAt > IGNORED_TTL
            ) {
                this.transition(topic.id, "STALE");
                cleaned++;
                continue;
            }

            // IGNORED_LOW_VALUE → STALE
            if (
                topic.state === "IGNORED_LOW_VALUE" &&
                topic.lastTriagedAt &&
                now - topic.lastTriagedAt > IGNORED_TTL
            ) {
                this.transition(topic.id, "STALE");
                cleaned++;
                continue;
            }

            // COOLDOWN → ACTIVE（冷却结束）
            if (topic.state === "COOLDOWN") {
                const cooldownDuration = topic.exitSignals.some(s => s.type === "IDENTITY_PROBING")
                    ? LONG_COOLDOWN
                    : DEFAULT_COOLDOWN;
                const exitTime = topic.exitSignals.length > 0
                    ? topic.exitSignals[topic.exitSignals.length - 1].timestamp
                    : topic.lastActivityAt;

                if (now - exitTime > cooldownDuration) {
                    this.transition(topic.id, "ACTIVE");
                    // 重置对话模式字段
                    topic.turnCount = 0;
                    topic.pendingMessages = [];
                    topic.exitSignals = [];
                    topic.irrelevantStreak = 0;
                    topic.nextReplyInstruction = undefined;
                    topic.exitAfterNextReply = undefined;
                    cleaned++;
                }
            }

            // ENGAGED 话题超时检测（3min 无用户消息）
            if (topic.state === "ENGAGED") {
                const lastUserMsg = topic.pendingMessages.length > 0
                    ? topic.pendingMessages[topic.pendingMessages.length - 1].timestamp
                    : topic.lastActivityAt;

                if (now - lastUserMsg > 3 * 60 * 1000) {
                    topic.exitSignals.push({
                        type: "TIMEOUT",
                        confidence: 1.0,
                        reason: "3分钟无新用户消息",
                        timestamp: now,
                    });
                    this.emit("topic:exit", topic, topic.exitSignals[topic.exitSignals.length - 1]);
                }
            }
        }

        // 清除已归档太久的话题（从内存中移除）
        for (const [id, topic] of this.topics) {
            if (topic.state === "ARCHIVED" && now - topic.lastActivityAt > 24 * 60 * 60 * 1000) {
                this.topics.delete(id);
            }
        }

        if (cleaned > 0) {
            log.debug("话题清理", { cleaned, remaining: this.topics.size });
        }
    }

    /**
     * 是否有其他 ENGAGED 话题（某群内）
     * 用于消息归属判定时的回退
     */
    hasOtherEngagedTopic(chatId: string, excludeTopicId?: string): boolean {
        return Array.from(this.topics.values()).some(
            t => t.chatId === chatId && t.state === "ENGAGED" && t.id !== excludeTopicId
        );
    }

    /**
     * 从 MemoryV2 恢复最近话题到 registry（启动时调用）
     *
     * 从 MemoryV2 topics 表恢复最近的话题，重建内存状态。
     *
     * @param topics 从 MemoryV2 getTopicsSince() 获取的话题列表
     * @returns 恢复的话题数量
     */
    restoreFromMemory(topics: RestorableTopic[]): number {
        let restored = 0;

        for (const t of topics) {
            // 跳过已存在的话题（避免重复）
            if (this.topics.has(t.id)) continue;

            // 计算话题是否过期（2小时不活跃 → 不恢复）
            const startedMs = new Date(t.startedAt).getTime();
            const age = Date.now() - startedMs;
            if (age > 6 * 60 * 60 * 1000) continue; // 超过 6 小时的不恢复

            // 决定恢复后的状态
            // 15分钟内设 ACTIVE（可能还活跃），超过15分钟设 STALE
            let state: TopicState;
            if (age < 15 * 60 * 1000) {
                state = "ACTIVE";
            } else {
                state = "STALE";  // 老话题但未回复，设 STALE 但不立即归档
            }

            const topic: Topic = {
                id: t.id,
                chatId: t.chatId,
                label: t.label,
                keywords: t.keywords ?? [],
                participantIds: new Set(t.participants ?? []),
                messageIds: t.messageIds ?? [],
                state,
                createdAt: startedMs,
                // Fix: 使用当前时间而非 startedMs，防止 cleanup 立即归档
                // cleanup 会在 lastActivityAt 超过 15min 时转 STALE，超过 2h 时转 ARCHIVED
                lastActivityAt: Date.now(),
                turnCount: 0,
                maxTurns: 5,
                pendingMessages: [],
                exitSignals: [],
                irrelevantStreak: 0,
                messageCount: t.messageCount ?? 0,
                recentContext: "",
                lastSummary: t.summary ?? undefined,
            };

            this.topics.set(topic.id, topic);
            restored++;

            log.info("话题恢复", {
                id: topic.id,
                label: topic.label,
                state: topic.state,
                chatId: topic.chatId,
            });
        }

        return restored;
    }

    /** 当前话题总数（调试用） */
    get size(): number {
        return this.topics.size;
    }
}

/** 可恢复话题的最小数据（来自 MemoryV2 TopicNode） */
export interface RestorableTopic {
    id: string;
    chatId: string;
    label: string;
    summary?: string;
    keywords?: string[];
    participants?: string[];
    messageIds?: string[];
    startedAt: string;
    messageCount?: number;
}
