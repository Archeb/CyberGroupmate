/**
 * decision-maker.ts — 主 Agent 决策器
 *
 * 基于 GroupContextPackage 中的多项指标，估算回复模式和回复数量。
 *
 * estimateReplyCount() 综合以下信号：
 * - engagement score
 * - message count
 * - topic thread 数量
 * - @ mention
 * - stickiness level
 *
 * 参考设计：subagent.md §8.4, subtask.md S5.3
 */

import type {
    GroupContextPackage,
    AttendResult,
    Decision,
    StickinessLevel,
} from "../subagent/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("decision-maker");

/** 决策器配置 */
export interface DecisionMakerConfig {
    /** engagement 达到此值时推荐 BATCH 回复。默认 50 */
    batchThreshold: number;
    /** engagement 低于此值时推荐 NONE。默认 10 */
    noneThreshold: number;
    /** 新消息数达到此值时推荐 BATCH。默认 10 */
    batchMessageThreshold: number;
}

const DEFAULT_CONFIG: DecisionMakerConfig = {
    batchThreshold: 50,
    noneThreshold: 10,
    batchMessageThreshold: 10,
};

/**
 * 估算回复模式
 *
 * subagent.md §4.2 — 7 维信号:
 * engagementScore, newMessageCount, distinctTopicCount,
 * mentionCount/hasMention, avgMessageLength, stickiness, timeSinceLastAttend
 *
 * @returns "NONE" | "SINGLE" | "BATCH"
 */
export function estimateReplyMode(
    pkg: GroupContextPackage,
    newMessageCount: number,
    hasMention: boolean,
    stickinessLevel: StickinessLevel,
    distinctTopicCount: number = 0,
    timeSinceLastAttendMs: number = 0,
    avgMessageLength: number = 0,
    config?: Partial<DecisionMakerConfig>,
): "NONE" | "SINGLE" | "BATCH" {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // @ mention 总是至少 SINGLE
    if (hasMention) {
        return newMessageCount >= cfg.batchMessageThreshold ? "BATCH" : "SINGLE";
    }

    // STRANGER 群组高阈值
    if (stickinessLevel === "STRANGER" && pkg.engagementScore < cfg.batchThreshold) {
        return pkg.engagementScore >= cfg.noneThreshold ? "SINGLE" : "NONE";
    }

    // BATCH 条件（subagent.md §4.2）:
    // - 多消息积压 OR
    // - 多话题线程 OR
    // - 高 engagement + 长时间未关注
    if (
        (pkg.engagementScore >= cfg.batchThreshold && newMessageCount >= cfg.batchMessageThreshold) ||
        distinctTopicCount >= 2 ||
        (pkg.engagementScore >= cfg.batchThreshold && timeSinceLastAttendMs > 5 * 60_000)
    ) {
        return "BATCH";
    }

    // 中等 engagement → SINGLE
    if (pkg.engagementScore >= cfg.noneThreshold) {
        return "SINGLE";
    }

    return "NONE";
}

/**
 * 估算 BATCH 模式下应回复的消息数
 */
export function estimateReplyCount(
    replyMode: "NONE" | "SINGLE" | "BATCH",
    topicCount: number,
    newMessageCount: number,
): number {
    if (replyMode === "NONE") return 0;
    if (replyMode === "SINGLE") return 1;

    // BATCH: 每个活跃话题 1 条，至少 2，最多 5
    return Math.min(5, Math.max(2, topicCount));
}

/**
 * 构建默认 OBSERVE 决策（不回复，仅观察）
 */
export function buildObserveDecision(chatId: string): AttendResult {
    return {
        chatId,
        decisions: [{ action: "OBSERVE", confidence: 1.0, reason: "Low engagement" }],
        replyMode: "NONE",
        reasoning: "Engagement too low, observing only",
    };
}

/**
 * 构建默认 REPLY 决策
 */
export function buildReplyDecisions(
    chatId: string,
    replyMode: "SINGLE" | "BATCH",
    topicDigests: Array<{ topicId: string; label: string }>,
    reasoning: string,
): AttendResult {
    const decisions: Decision[] = topicDigests.map(t => ({
        action: "REPLY" as const,
        topicId: t.topicId,
        contentDirection: `Reply to topic: ${t.label}`,
        confidence: 0.8,
        reason: `Active topic: ${t.label}`,
    }));

    if (decisions.length === 0) {
        decisions.push({
            action: "REPLY",
            confidence: 0.6,
            reason: "General reply",
        });
    }

    return {
        chatId,
        decisions,
        replyMode,
        reasoning,
    };
}
