/**
 * context-builder.ts — GroupContextPackage 构建器
 *
 * 根据上下文深度（L0-L3）构建不同详度的群组上下文包。
 *
 * 参考设计：subagent.md §7, subtask.md S5.4
 */

import type {
    GroupContextPackage,
    GroupStickiness,
    TopicDigest,
    SubagentCallback,
} from "../subagent/types.js";
import type { GroupModel } from "../memory-v2/types.js";
import type { SnapshotMessage } from "../memory-v2/message-snapshot.js";
import type { ContextDepth } from "./cosine-decay.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("context-builder");

/** 上下文构建器输入 */
export interface ContextBuildInput {
    chatId: string;
    depth: ContextDepth;
    snapshotTimestamp: string;
    /** L0: 话题摘要 */
    topicDigests: TopicDigest[];
    /** L0: Engagement 分数 */
    engagementScore: number;
    /** L1+: 群组画像 */
    groupModel?: GroupModel | null;
    /** L1+: 最近的 callback 结果 */
    lastCallbacks?: SubagentCallback[];
    /** L2+: 消息原文 */
    messages?: SnapshotMessage[];
    /** L3+: 深度摘要 */
    deepSummary?: string;
    /** 群组标题 */
    chatTitle?: string;
    /** 是否为私聊 */
    isDirectMessage?: boolean;
    /** 群组亲密度 */
    stickiness?: GroupStickiness;
    /** 待执行任务数 */
    pendingCodeActTasks?: number;
    /** 活跃参与者 */
    activePersons?: Array<{ userId: string; displayName: string; recentMessageCount: number }>;
}

/**
 * 构建 GroupContextPackage
 *
 * 按深度裁剪信息量：
 * - L0: topicDigests + engagementScore
 * - L1: + groupModel + lastCallbacks + recentMessages(少量)
 * - L2: + messages(完整)
 * - L3: + deepSummary
 */
export function buildGroupContext(input: ContextBuildInput): GroupContextPackage {
    const pkg: GroupContextPackage = {
        depth: input.depth,
        chatId: input.chatId,
        snapshotTimestamp: input.snapshotTimestamp,
        topicDigests: input.topicDigests,
        engagementScore: input.engagementScore,
    };

    if (input.depth >= 1) {
        pkg.groupModel = input.groupModel ?? undefined;
        pkg.lastCallbacks = input.lastCallbacks;
        pkg.chatTitle = input.chatTitle;
        pkg.isDirectMessage = input.isDirectMessage;
        pkg.stickiness = input.stickiness;
        pkg.pendingCodeActTasks = input.pendingCodeActTasks;
        pkg.activePersons = input.activePersons;
    }

    // 所有深度都包含消息（数量由 attend-handler 按深度控制）
    pkg.messages = input.messages;

    if (input.depth >= 3) {
        pkg.deepSummary = input.deepSummary;
    }

    log.debug("buildGroupContext", {
        chatId: input.chatId,
        depth: input.depth,
        topicCount: input.topicDigests.length,
        hasGroupModel: !!pkg.groupModel,
        messageCount: pkg.messages?.length ?? 0,
        hasDeepSummary: !!pkg.deepSummary,
    });

    return pkg;
}

/**
 * 估算 GroupContextPackage 的 token 大小（粗略估算：字符数 / 4）
 */
export function estimateContextTokens(pkg: GroupContextPackage): number {
    let charCount = 0;

    // Topic digests
    for (const d of pkg.topicDigests) {
        charCount += (d.label?.length ?? 0) + (d.summary?.length ?? 0) + 50;
    }

    // GroupModel
    if (pkg.groupModel) {
        charCount += JSON.stringify(pkg.groupModel).length;
    }

    // Callbacks
    if (pkg.lastCallbacks) {
        for (const cb of pkg.lastCallbacks) {
            charCount += (cb.summary?.length ?? 0) + 100;
        }
    }

    // Messages
    if (pkg.messages) {
        for (const m of pkg.messages) {
            charCount += (m.text?.length ?? 0) + (m.displayName?.length ?? 0) + 30;
        }
    }

    // Deep summary
    if (pkg.deepSummary) {
        charCount += pkg.deepSummary.length;
    }

    return Math.ceil(charCount / 4);
}
