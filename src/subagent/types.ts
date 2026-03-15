/**
 * subagent/types.ts — Subagent 架构核心类型定义
 *
 * 定义 SubagentManager、Observer、CodeActExecutor、FastPath、
 * 注意力队列、回调队列等组件间的数据交换格式。
 *
 * 参考设计文档：subagent.md v0.5.0
 */

import type { TopicNode, GroupModel } from "../memory-v2/types.js";
import type { SnapshotMessage } from "../memory-v2/message-snapshot.js";

// ─── Observer 产出 ───

/** 话题摘要（Observer → Q3 AttentionQueueEntry） */
export interface TopicDigest {
    /** Pipeline Topic ID */
    topicId: string;
    /** 话题标签 */
    label: string;
    /** 话题摘要 */
    summary: string;
    /** 当前状态 */
    state: string;
    /** 参与者 userId 列表 */
    participants: string[];
    /** 关键词 */
    keywords: string[];
    /** 消息数 */
    messageCount: number;
    /** 最后活跃时间 */
    lastActivityAt: string;
    /** Triage 决策（如果有） */
    triageDecision?: "ENGAGE" | "IGNORE" | null;
    /** Triage 置信度 */
    triageConfidence?: number;
}

/** Observer 告警（高 engagement 时主动上报） */
export interface ObserverAlert {
    type: "OBSERVER_ALERT";
    chatId: string;
    engagementScore: number;
    topicCount: number;
    /** 最活跃的话题 */
    hotTopic?: TopicDigest;
    /** 是否有 @ bot 消息 */
    hasMention: boolean;
    /** 告警原因 */
    reason: string;
    timestamp: string;
}

// ─── 注意力队列 (Q3) ───

/** 注意力队列条目 */
export interface AttentionQueueEntry {
    /** 群组 chatId */
    chatId: string;
    /** 来源标记 (subagent.md §2.2) */
    source: 'DIGEST_UPDATE' | 'OBSERVER_ALERT' | 'FAST_PATH_REQUEST' | 'DEFERRED_RE_ENTRY';
    /** 当前优先级分数 (0-100) */
    priority: number;
    /** 基础优先级（不含时间衰减） */
    basePriority: number;
    /** 入队时间 */
    enqueuedAt: number;
    /** 上次被主 Agent attend 的时间 */
    lastAttendedAt: string | null;
    /** 主 Agent 已 attend 此群的轮次计数（用于 cosine decay） */
    attendCount: number;
    /** 是否被阻塞（正在执行 subagent 任务） */
    blocked: boolean;
    /** 阻塞原因 */
    blockReason?: string;
    /** 是否有 FastPath 请求 */
    hasFastPathRequest: boolean;
    /** 最新 Observer 告警 */
    alert?: ObserverAlert;
    /** 消息计数（自上次 attend 以来） — 即 pendingMessageCount */
    newMessageCount: number;
    /** 话题摘要列表 — 即 topicDigest */
    topicDigests: TopicDigest[];
    /** GroupStickiness 类别 */
    stickinessLevel: StickinessLevel;

    // ─── subagent.md §2.2 补齐字段 ───
    /** Engagement 评分 (0-100) */
    engagementScore?: number;
    /** 紧急信号列表（如 @mention、关键词命中等） */
    urgentSignals?: string[];
    /** 快照时间戳 */
    snapshotTimestamp?: string;
}

/** AttentionQueue 评估结果 */
export interface QueueEvaluation {
    /** 当前队列大小 */
    queueSize: number;
    /** 非阻塞条目数 */
    activeCount: number;
    /** 阻塞条目数 */
    blockedCount: number;
    /** 最高优先级 */
    maxPriority: number;
}

// ─── CodeActExecutor 任务 ───

/** 主 Agent 分派给 CodeActExecutor 的执行任务 */
export interface CodeActReplyTask {
    type: "CODEACT_REPLY";
    /** 目标群组 */
    chatId: string;
    /** 任务 ID */
    taskId: string;
    /** 决策来源 */
    decisions: Decision[];
    /** 上下文快照（注入 Prompt ➎） */
    contextSnapshot: GroupContextPackage;
    /** 回复模式 */
    replyMode: "SINGLE" | "BATCH";
    /** 创建时间 */
    createdAt: string;

    // ─── subagent.md §2.2 B1 补齐字段 ───
    /** 目标消息 ID 列表（需要回复的消息） */
    targetMessageIds?: string[];
    /** 回复策略 */
    replyStrategy?: ReplyStrategy;
    /** 最大响应时间 (ms) */
    maxResponseTime?: number;
}

/** 回复策略 (subagent.md §2.2 B1) */
export type ReplyStrategy =
    | "DIRECT_REPLY"
    | "TOPIC_CONTINUATION"
    | "NEW_CONTRIBUTION"
    | "CLARIFICATION"
    | "CASUAL";

/** FastPath 授权任务 */
export interface FastPathAuthTask {
    type: "FAST_PATH_AUTH";
    chatId: string;
    config: FastPathConfig;
    createdAt: string;
}

// ─── Subagent Callback (Q5) ───

/** Subagent 执行完成后的回调 */
export interface SubagentCallback {
    /** 任务 ID */
    taskId: string;
    /** 来源群组 */
    chatId: string;
    /** 执行类型 — spec 中为 source: 'CODE_ACT' | 'FAST_PATH' */
    executionType: "CODEACT" | "FAST_PATH";
    /** 执行状态 — spec 中为 type: 'COMPLETED' | 'FAILED' | 'TIMEOUT' */
    status: "COMPLETED" | "ERROR" | "SKIPPED" | "TIMEOUT";
    /** 结果摘要 */
    summary: string;
    /** 回复内容（spec §2.2 result.replyContent） */
    replyContent?: string;
    /** 发送的消息列表 */
    sentMessages?: Array<{
        messageId?: string;
        text: string;
        timestamp: string;
    }>;
    /** Token 使用量（spec §2.2 result.tokensUsed） */
    tokensUsed?: number;
    /** 错误信息 */
    error?: string;
    /** 执行耗时 (ms) — spec 中为 duration */
    durationMs: number;
    /** 创建时间 */
    createdAt: string;

    // ─── subagent.md §2.2 C1/C2 补齐字段 ───
    /** Session 摘要（CodeAct session 的结构化摘要） */
    sessionSummary?: string;
}

// ─── FastPath ───

/** FastPath 预授权配置 */
export interface FastPathConfig {
    /** 预授权的动作类型 */
    preauthorizedActions: string[];
    /** 禁止的动作类型 */
    blockedActions: string[];
    /** 语气预设 */
    tonePreset: string;
    /** 重新授权前最大回复数 */
    maxRepliesBeforeReauth: number;
    /** 过期时间 (ISO 8601) */
    expiresAt: string;
    /** 授权时间 */
    authorizedAt: string;
}

// ─── GroupStickiness ───

/** 群组亲密度级别 */
export type StickinessLevel = "CORE" | "FAMILIAR" | "ACQUAINTANCE" | "STRANGER";

/** 群组亲密度配置 */
export interface GroupStickiness {
    /** 亲密度级别 */
    level: StickinessLevel;
    /** 优先级乘数 (0.0-1.0) */
    priorityMultiplier: number;
    /** cosine decay 周期 */
    depthCyclePeriod: number;
    /** 是否允许 FastPath */
    fastPathEligible: boolean;
    /** 过度活跃阈值（超过后降低回复频率） */
    overactiveThreshold: number;
    /** 上次更新时间 */
    updatedAt: string;
    /** 回复频率控制 (0.0-1.0)，越高越倾向回复 */
    replyFrequency: number;
    /** 主动发起程度 (0.0-1.0)，越高越主动参与话题 */
    initiativeLevel: number;
    /** 每小时最大干预次数 */
    maxInterventionsPerHour: number;
    /** 干预后冷却时间 (ms) */
    cooldownAfterIntervention: number;
}

// ─── 主 Agent 上下文 ───

/** 群组上下文包（主 Agent attend 时构建） */
export interface GroupContextPackage {
    /** 上下文深度 (0=L0, 1=L1, 2=L2, 3=L3) */
    depth: 0 | 1 | 2 | 3;
    /** 群组 chatId */
    chatId: string;
    /** 快照时间戳 */
    snapshotTimestamp: string;
    /** L0: 话题摘要（始终有） */
    topicDigests: TopicDigest[];
    /** L0: Engagement 分数 */
    engagementScore: number;
    /** L1+: 群组画像 */
    groupModel?: GroupModel;
    /** L1+: 上次 callback 结果 */
    lastCallbacks?: SubagentCallback[];
    /** L2+: 消息原文 */
    messages?: SnapshotMessage[];
    /** L3+: 深度摘要 */
    deepSummary?: string;

    // ─── subagent.md §4.1 补齐字段 ───
    /** 群组标题/名称 */
    chatTitle?: string;
    /** 群组亲密度配置 */
    stickiness?: GroupStickiness;
    /** FastPath 是否已启用 */
    fastPathEnabled?: boolean;
    /** 待执行的 CodeAct 任务数 */
    pendingCodeActTasks?: number;
    /** 活跃参与者概况 */
    activePersons?: Array<{ userId: string; displayName: string; recentMessageCount: number }>;
}

/** 主 Agent attend 后的决策结果 */
export interface AttendResult {
    chatId: string;
    /** 决策列表 */
    decisions: Decision[];
    /** 回复模式 */
    replyMode: "NONE" | "SINGLE" | "BATCH";
    /** FastPath 授权（如果决定授权） */
    fastPathAuth?: FastPathConfig;
    /** 决策理由 */
    reasoning: string;
}

/** 单条决策 */
export interface Decision {
    /** 决策动作 */
    action: "REPLY" | "IGNORE" | "DEFER" | "FAST_PATH_AUTH" | "OBSERVE";
    /** 目标话题 ID（可选） */
    topicId?: string;
    /** 回复方向提示 */
    contentDirection?: string;
    /** 置信度 */
    confidence: number;
    /** 理由 */
    reason: string;
}

// ─── 全局状态 ───

/** 主 Agent 全局状态 */
export interface MainAgentGlobalState {
    /** 最后活跃时间 */
    lastActiveAt: string;
    /** 当前任务列表 */
    taskList: AgentTask[];
    /** 最近决策记录（最近 50 条） */
    recentDecisions: Array<{
        chatId: string;
        decision: string;
        timestamp: string;
    }>;
    /** 跨群待办事项 */
    pendingFollowups: Array<{
        id: string;
        sourceChatId: string;
        targetChatId: string;
        description: string;
        status: "PENDING" | "IN_PROGRESS" | "DONE";
        createdAt: string;
        completedAt?: string;
    }>;
    /** 当前的注意力总结 */
    attentionSummary: string;
}

/** Agent 任务 */
export interface AgentTask {
    id: string;
    description: string;
    status: "PENDING" | "IN_PROGRESS" | "DONE" | "CANCELLED";
    chatId?: string;
    priority: "LOW" | "MEDIUM" | "HIGH";
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
}

// ─── 配置 ───

/** Subagent 系统配置（来自 config.yaml） */
export interface SubagentConfig {
    /** 最大 sandbox 实例数 */
    maxSandboxInstances: number;
    /** Sandbox 空闲超时 (ms) */
    sandboxIdleTimeout: number;
    /** 主循环轮询间隔 (ms) */
    pollInterval: number;
    /** Observer 告警的 engagement 阈值 */
    alertEngagementThreshold: number;
    /** FastPath 配置 */
    fastPath: {
        /** 默认最大回复数 */
        defaultMaxReplies: number;
        /** 默认过期时间（分钟） */
        defaultExpiresMinutes: number;
        /** 授权要求的最低 engagement */
        engagementThreshold: number;
    };
    /** Stickiness 默认值 */
    stickiness: {
        defaults: Record<StickinessLevel, {
            priorityMultiplier: number;
            depthCyclePeriod: number;
        }>;
    };
    /** 注意力队列配置 */
    attentionQueue: {
        /** 时间衰减系数 (每秒衰减) */
        timeDecayPerSecond: number;
        /** 最大队列大小 */
        maxSize: number;
    };
}

/** 默认配置 */
export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
    maxSandboxInstances: 5,
    sandboxIdleTimeout: 600_000,
    pollInterval: 5_000,
    alertEngagementThreshold: 60,
    fastPath: {
        defaultMaxReplies: 3,
        defaultExpiresMinutes: 5,
        engagementThreshold: 70,
    },
    stickiness: {
        defaults: {
            CORE: { priorityMultiplier: 1.0, depthCyclePeriod: 10 },
            FAMILIAR: { priorityMultiplier: 0.7, depthCyclePeriod: 20 },
            ACQUAINTANCE: { priorityMultiplier: 0.4, depthCyclePeriod: 35 },
            STRANGER: { priorityMultiplier: 0.2, depthCyclePeriod: 50 },
        },
    },
    attentionQueue: {
        timeDecayPerSecond: 0.001,
        maxSize: 100,
    },
};
