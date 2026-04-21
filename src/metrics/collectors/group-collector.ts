/**
 * group-collector.ts — 群聊统计指标收集器
 *
 * 两类更新方式：
 * 1. scrape 时（pull）：遍历 SubagentManager 读取当前快照，更新 Gauge 类指标
 * 2. 事件时（push）：onMessage/onAttend 从 main.ts NC hook 调用，
 *    更新 Counter 类指标（消息总量、attend 次数）
 */

import type { SubagentManager } from "../../subagent/subagent-manager.js";
import {
    groupsTotal,
    groupMessagesTotal,
    groupAttendsTotal,
    groupEngagementScore,
    groupStickiness,
    groupBufferSize,
    groupTopicCount,
    groupCodeActQueueSize,
    groupLastAttendAgeSeconds,
} from "../registry.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("metrics:group-collector");

const STICKINESS_LEVELS = ["CORE", "FAMILIAR", "ACQUAINTANCE", "STRANGER"] as const;
const TOPIC_STATES = ["OPEN", "SEALED", "STALE", "ARCHIVED"] as const;

/** GroupCollector 依赖 */
export interface GroupCollectorDeps {
    subagentManager: SubagentManager;
}

export class GroupCollector {
    private subagentManager: SubagentManager;

    constructor(deps: GroupCollectorDeps) {
        this.subagentManager = deps.subagentManager;
        log.info("GroupCollector 已初始化");
    }

    /**
     * 在 Prometheus scrape 时调用，从 SubagentManager 读取当前快照更新 Gauge 指标。
     * 不直接更新 Counter（Counter 由 push 事件驱动）。
     */
    collect(): void {
        const subagents = this.subagentManager.getAllSubagents();

        // groups_total
        groupsTotal.set({}, subagents.length);

        for (const sub of subagents) {
            try {
                const chatId = sub.chatId;
                const labels = { chat_id: chatId };

                // engagement score
                groupEngagementScore.set(labels, sub.observer.getEngagementScore());

                // buffer size (Q2)
                groupBufferSize.set(labels, sub.observer.getBufferSize());

                // CodeActExecutor queue size
                const executor = sub.codeActExecutor as any;
                groupCodeActQueueSize.set(labels, executor?.getQueueSize?.() ?? 0);

                // last attend age (seconds since lastAttendedAt)
                if (sub.lastAttendedAt) {
                    const ageMs = Date.now() - new Date(sub.lastAttendedAt).getTime();
                    groupLastAttendAgeSeconds.set(labels, Math.round(ageMs / 1000));
                } else {
                    groupLastAttendAgeSeconds.set(labels, -1); // -1 = never attended
                }

                // stickiness level indicators
                const currentLevel = sub.stickiness.level;
                for (const level of STICKINESS_LEVELS) {
                    groupStickiness.set({ ...labels, level }, level === currentLevel ? 1 : 0);
                }

                // topic count by state
                const allTopics = sub.topicRegistry.getAll();
                const countByState = new Map<string, number>();
                for (const state of TOPIC_STATES) {
                    countByState.set(state, 0);
                }
                for (const topic of allTopics) {
                    const state = topic.state as string;
                    if (TOPIC_STATES.includes(state as any)) {
                        countByState.set(state, (countByState.get(state) ?? 0) + 1);
                    }
                }
                for (const [state, count] of countByState) {
                    groupTopicCount.set({ ...labels, state }, count);
                }
            } catch (err) {
                log.warn("collect: subagent 指标收集失败，跳过", { chatId: sub.chatId, error: String(err).slice(0, 100) });
            }
        }
    }

    /**
     * 消息到达时调用（Counter 驱动），从 NC.onPush hook 触发。
     */
    onMessage(chatId: string): void {
        groupMessagesTotal.inc({ chat_id: chatId });
    }

    /**
     * 主 Agent attend 并完成决策时调用。
     */
    onAttend(chatId: string, decision: string): void {
        groupAttendsTotal.inc({ chat_id: chatId, decision });
    }
}
