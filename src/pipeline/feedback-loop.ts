/**
 * feedback-loop.ts — 发言后反馈评估 + 追问检测
 *
 * 记录 agent 发言，并在一段时间后观察群内是否出现后续互动，
 * 将结果回写到 memory，并生成系统通知。
 *
 * 追问检测 (architecture_v2.md §3 Q3 路径 5)：
 * Agent 发言后开启一个短窗口（默认 90 秒），在窗口期内收到同群
 * 用户消息时立即触发 onFollowUpDetected 回调，将该群入队 Q3。
 * 每个 chatId 同时只维护一个窗口，新 Agent 消息会刷新窗口。
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

/** 追问窗口状态 */
interface FollowUpWindow {
    sentAtMs: number;
    agentMsgId?: string;
    timer: ReturnType<typeof setTimeout>;
}

export class FeedbackLoop {
    private timers = new Map<string, ReturnType<typeof setTimeout>>();

    /** 追问检测窗口（key = chatId） */
    private followUpWindows = new Map<string, FollowUpWindow>();

    /**
     * @param memory - 记忆存储
     * @param nc - 通知中心
     * @param registryLookup - 按 chatId 查找 per-group TopicRegistry
     * @param evaluationDelayMs - 评估延迟
     * @param onFollowUpDetected - 追问检测回调：chatId + 触发消息文本
     * @param followUpWindowMs - 追问窗口时长（默认 90 秒）
     */
    constructor(
        private memory: MemoryStoreV2,
        private nc: NotificationCenter,
        private registryLookup: (chatId: string) => TopicRegistry | null,
        private evaluationDelayMs: number = 3 * 60 * 1000,
        private onFollowUpDetected?: (chatId: string, triggerMessageText: string) => void,
        private followUpWindowMs: number = 90_000,
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

        // ── 追问窗口管理 ──
        // 每次 agent 发言都刷新该 chatId 的追问窗口
        if (this.onFollowUpDetected) {
            const existingWindow = this.followUpWindows.get(event.chatId);
            if (existingWindow) {
                clearTimeout(existingWindow.timer);
            }

            const windowTimer = setTimeout(() => {
                this.followUpWindows.delete(event.chatId);
            }, this.followUpWindowMs);

            this.followUpWindows.set(event.chatId, {
                sentAtMs,
                agentMsgId: event.messageId,
                timer: windowTimer,
            });

            log.debug("追问窗口已开启", {
                chatId: event.chatId,
                windowMs: this.followUpWindowMs,
                agentMsgId: event.messageId,
            });
        }
    }

    /**
     * 检查追问 — 由 NC onPush Hook 在每条群消息到达时调用
     *
     * 如果该 chatId 处于追问窗口内且发言者不是 agent，
     * 触发 onFollowUpDetected 回调并关闭窗口（单次触发）。
     */
    checkFollowUp(chatId: string, userId: string, text: string): void {
        const window = this.followUpWindows.get(chatId);
        if (!window) return;

        // 排除 agent 自身的消息（可能是多条连续发送）
        if (userId === "agent" || userId === "self" || userId === "") return;

        // 检测到追问：关闭窗口，触发回调
        clearTimeout(window.timer);
        this.followUpWindows.delete(chatId);

        log.info("追问检测触发", {
            chatId,
            userId,
            textPreview: text.slice(0, 50),
            windowAge: Date.now() - window.sentAtMs,
            agentMsgId: window.agentMsgId,
        });

        this.onFollowUpDetected?.(chatId, text);
    }

    /**
     * 获取当前活跃的追问检测窗口（Dashboard 用）
     */
    getActiveWindows(): Array<{ chatId: string; sentAtMs: number; agentMsgId?: string; remainingMs: number }> {
        const now = Date.now();
        const result: Array<{ chatId: string; sentAtMs: number; agentMsgId?: string; remainingMs: number }> = [];
        for (const [chatId, w] of this.followUpWindows) {
            const elapsed = now - w.sentAtMs;
            const remaining = Math.max(0, this.followUpWindowMs - elapsed);
            result.push({ chatId, sentAtMs: w.sentAtMs, agentMsgId: w.agentMsgId, remainingMs: remaining });
        }
        return result;
    }

    dispose(): void {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();

        // 清理追问窗口
        for (const w of this.followUpWindows.values()) {
            clearTimeout(w.timer);
        }
        this.followUpWindows.clear();
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
