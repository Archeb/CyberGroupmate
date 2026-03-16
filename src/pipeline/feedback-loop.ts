/**
 * feedback-loop.ts — 发言后反馈评估
 *
 * 记录 agent 发言，并在一段时间后观察群内是否出现后续互动，
 * 将结果回写到 memory，并生成系统通知。
 */

import { createLogger } from "../core/logger.js";
import type { NotificationCenter } from "../event/notification-center.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { TopicRegistry } from "./topic-registry.js";

const log = createLogger("feedback-loop");

export interface AgentMessageSentEvent {
    scene: string;
    chatId: string;
    messageId?: string;
    text: string;
    timestamp: string;
    replyToMessageId?: string;
}

interface PendingFeedback {
    key: string;
    scene: string;
    chatId: string;
    messageId?: string;
    text: string;
    sentAtMs: number;
}

export class FeedbackLoop {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    /**
     * @param memory - 记忆存储
     * @param nc - 通知中心
     * @param registryLookup - 按 chatId 查找 per-group TopicRegistry
     * @param evaluationDelayMs - 评估延迟
     */
    constructor(
        private memory: MemoryStoreV2,
        private nc: NotificationCenter,
        private registryLookup: (chatId: string) => TopicRegistry | null,
        private evaluationDelayMs: number = 3 * 60 * 1000,
    ) {}

    recordAgentMessage(event: AgentMessageSentEvent): void {
        const sentAtMs = Date.parse(event.timestamp);
        const key = event.messageId ? String(event.messageId) : `${event.chatId}:${sentAtMs}`;
        const pending: PendingFeedback = {
            key,
            scene: event.scene,
            chatId: event.chatId,
            messageId: event.messageId,
            text: event.text,
            sentAtMs,
        };

        // 先记录一次交互
        this.memory.storeInteraction({
            chatId: event.chatId,
            userId: "agent",
            topicId: null,
            type: "agent_replied",
            summary: event.text.slice(0, 200),
            sentiment: "neutral",
            significance: 0.6,
            date: event.timestamp,
        });

        const old = this.timers.get(key);
        if (old) clearTimeout(old);

        const timer = setTimeout(() => {
            this.timers.delete(key);
            void this.evaluate(pending);
        }, this.evaluationDelayMs);

        this.timers.set(key, timer);
    }

    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
    }

    private async evaluate(pending: PendingFeedback): Promise<void> {
        try {
            const effectiveRegistry = this.registryLookup(pending.chatId);
            if (!effectiveRegistry) {
                log.debug("evaluate: 无法找到该群的 TopicRegistry", { chatId: pending.chatId });
                return;
            }
            const topics = effectiveRegistry.getByChat(pending.chatId);

            const followUp = topics.some(topic => topic.lastActivityAt > pending.sentAtMs);
            const recentFeedback = followUp ? "agent 发言后群里有后续互动" : "agent 发言后暂无明显互动";
            const engagementLevel = followUp ? "high" : "low";

            this.memory.upsertGroupModel(pending.chatId, {
                recentFeedback,
                engagementLevel,
            });

            this.nc.push({
                type: "system.feedback_evaluated",
                scene: pending.scene,
                chatId: pending.chatId,
                messageId: pending.messageId,
                feedback: recentFeedback,
                engagementLevel,
            });

            log.info("反馈评估完成", {
                chatId: pending.chatId,
                messageId: pending.messageId,
                followUp,
            });
        } catch (err) {
            log.warn("反馈评估失败", {
                chatId: pending.chatId,
                messageId: pending.messageId,
                error: String(err),
            });
        }
    }
}
