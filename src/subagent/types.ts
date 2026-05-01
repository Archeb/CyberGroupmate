/**
 * subagent/types.ts — Subagent 架构核心类型定义
 *
 * 定义 SubagentManager、Observer、CodeActExecutor、
 * 注意力队列、回调队列等组件间的数据交换格式。
 *
 * 参考设计文档：subagent.md v0.5.0
 */

import type {
    TopicNode,
    GroupModel,
    AssociatedMemory,
    FactSearchResult,
    TopicSearchResult,
    InteractionSearchResult,
} from "../memory-v2/types.js";
import type { SnapshotMessage } from "../memory-v2/message-snapshot.js";

export interface ActiveUserProfile {
    userId: string;
    displayName: string;
    aliases: string[];
    dunbarTier?: 1 | 2 | 3 | 4;
    rapport?: number;
    traits?: string[];
    communicationStyle?: string;
    relationToAgent?: string;
    messageCount: number;
    mention?: string;
    username?: string;
}

export interface MemoryHints {
    keywords?: string[];
    userIds?: string[];
    timeRange?: "24h" | "7d" | "30d" | "all";
}

export interface AdditionalMemoryContext {
    facts: Array<FactSearchResult & { displayName?: string }>;
    topics: TopicSearchResult[];
    interactions: Array<InteractionSearchResult & { displayName?: string }>;
}

// ─── Observer 产出 ───

/** 话题摘要（Observer → AttentionQueueEntry 快照） */
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
    /** Triage 判断理由 / 行动提示 */
    triageReason?: string;
    /** 与当前话题程序化关联的记忆 */
    associatedMemories?: AssociatedMemory[];
    /** 触发回梗/主动接话的潜力分 */
    callbackPotential?: number;
}

export interface AttentionRecentMessage {
    userId: string;
    displayName?: string;
    text: string;
    timestamp: string;
}


// ─── 主循环 attend 快照 ───

/** 注意力队列条目 */
export interface AttentionQueueEntry {
    /** 群组 chatId */
    chatId: string;
    /** 来源标记 (subagent.md §2.2) */
    source: 'DIGEST_UPDATE' | 'OBSERVER_ALERT' | 'DEFERRED_RE_ENTRY' | 'DIRECT_ADDRESS' | 'SCHEDULED_REVISIT' | 'SCHEDULER_TRIGGER';
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
    /** 消息计数（自上次 attend 以来） — 即 pendingMessageCount */
    newMessageCount: number;
    /** 话题摘要列表 — 即 topicDigest */
    topicDigests: TopicDigest[];
    /** GroupStickiness 类别 */
    stickinessLevel: StickinessLevel;

    // ─── subagent.md §2.2 补齐字段 ───
    /** Engagement 评分 (0-100) */
    engagementScore?: number;
    /** DIRECT_ADDRESS 的触发原因（DM / @mention / name-mention） */
    directAddressReason?: string;
    /** 紧急信号列表（如 @mention、关键词命中等） */
    urgentSignals?: string[];
    /** 快照时间戳 */
    snapshotTimestamp?: string;
    /** Scheduler 触发描述列表（watchdog 注入，source=SCHEDULER_TRIGGER 时存在） */
    schedulerTriggers?: Array<{ id: string; type: "reminder" | "cron" | "wake_condition"; description: string }>;
    /** 当前队列快照中的最大 callbackPotential */
    callbackPotential?: number;
    /** 是否存在高 callbackPotential 话题 */
    hasHighCallbackPotential?: boolean;
    /** 最近原始消息快照，用于 Meta 在话题摘要缺失时仍能看到内容 */
    recentMessages?: AttentionRecentMessage[];
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
    /** 主 Agent 指定的模块路由（限制 Subagent Pass 1 可见的额外技能模块） */
    useSkills?: string[];
    /** 主 Agent / dispatch 阶段检索到的额外记忆上下文 */
    memoryContext?: AdditionalMemoryContext | null;
}

/** 回复策略 (subagent.md §2.2 B1) */
export type ReplyStrategy =
    | "DIRECT_REPLY"
    | "TOPIC_CONTINUATION"
    | "NEW_CONTRIBUTION"
    | "CLARIFICATION"
    | "CASUAL";

// ─── Subagent Callback (Q5) ───

/** Subagent 执行完成后的回调 */
export interface SubagentCallback {
    /** 任务 ID */
    taskId: string;
    /** 来源群组 */
    chatId: string;
    /** 群组/私聊标题（用于 callback 渲染） */
    chatTitle?: string;
    /** 是否为私聊 */
    isDirectMessage?: boolean;
    /** 执行类型 */
    executionType: "CODEACT";
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
    /** 是否为私聊（由 adapter 层提供，平台无关） */
    isDirectMessage?: boolean;
    /** 群组亲密度配置 */
    stickiness?: GroupStickiness;
    /** 待执行的 CodeAct 任务数 */
    pendingCodeActTasks?: number;
    /** 活跃参与者概况 */
    activePersons?: Array<{ userId: string; displayName: string; recentMessageCount: number }>;
    /** 当前上下文窗口中的活跃用户画像 */
    activeUserProfiles?: ActiveUserProfile[];

    // ─── Dispatch handler 注入的执行上下文（CodeActExecutor prompt 使用） ───
    /** 话题摘要文本 */
    topicSummary?: string;
    /** 格式化的最近消息（含 reply-to 关系 + 媒体信息） */
    recentMessages?: Array<{
        id: string;
        sender: string;
        text: string;
        timestamp: string;
        replyTo?: string;
        mediaType?: string;
        mediaInfo?: string;
        /** Vision 处理后的媒体结果 */
        processedMedia?: Array<{
            index: number;
            base64Data?: string;
            mimeType?: string;
            description?: string;
        }>;
    }>;
    /** 人物背景 JSON */
    personContext?: string;
    /** 语气指导 */
    toneGuidance?: string;
    /** 回复方向 */
    contentDirection?: string;
    /** 可用贴纸目录（emoji + 描述 + 本地文件路径） */
    availableStickers?: Array<{ emoji: string; description: string; uniqueFileId: string }>;
    /** 并行 Grounding 查证结果（联网搜索得到的事实信息） */
    groundingContext?: string;
}

/** 主 Agent attend 后的决策结果 */
export interface AttendResult {
    chatId: string;
    /** 决策列表 */
    decisions: Decision[];
    /** 回复模式 */
    replyMode: "NONE" | "SINGLE" | "BATCH";
    /** 决策理由 */
    reasoning: string;
    /** 主 Agent 指定的模块路由（Subagent 可见的额外技能模块名） */
    useSkills?: string[];
    /** 并行 Grounding 查证结果（联网搜索得到的事实信息） */
    groundingContext?: string;
}

/** 单条决策 */
export interface Decision {
    /** 决策动作 */
    action: "REPLY" | "IGNORE" | "DEFER" | "OBSERVE";
    /** 目标话题 ID（可选） */
    topicId?: string;
    /** 目标消息 ID 列表（main agent 圈定的需要回复的消息） */
    targetMessageIds?: string[];
    /** 回复方向提示 */
    contentDirection?: string;
    /** 语气指导（LLM 输出，fallback 到 stickiness 推断） */
    toneGuidance?: string;
    /** 建议的相关 emoji（用于查找可发送的贴纸） */
    suggestedEmojis?: string[];
    /** 回复前希望系统帮忙召回的记忆范围 */
    memoryHints?: MemoryHints;
    /** 置信度 */
    confidence: number;
    /** 理由 */
    reason: string;
}



/** Agent 工作笔记 */
/** 调度事件（scheduler 命名空间） */
export interface SchedulerEvent {
    /** 任务 ID */
    id: string;
    /** 类型：一次性提醒 or 周期 cron */
    type: "reminder" | "cron";
    /** 关联群组 */
    chatId: string;
    /** 描述 / 自然语言任务描述（触发时注入 ATTENTION prompt） */
    description: string;
    /** 触发时间 ISO 8601（reminder） */
    triggerAt?: string;
    /** cron 表达式（cron） */
    cronExpr?: string;
    /** 每次触发时的自然语言任务描述（cron） */
    taskTemplate?: string;
    /** 请求人 userId */
    requestedBy?: string;
    /** 创建时间 */
    createdAt: string;
    /** 是否已触发（reminder 触发后标记） */
    triggered?: boolean;
    /** 上次触发时间（cron） */
    lastTriggeredAt?: string;
}

export interface MemoEntry {
    key: string;
    value: unknown;
    expiresAt?: string;
    createdAt: string;
}

export interface SessionDigestEntry {
    content: string;
    createdAt: string;
}

export interface SignalPoolItem {
    chatId: string;
    source: string;
    payload: unknown;
    enqueuedAt: number;
    pressure: number;
    ignoredCount: number;
}

export type WakeCondition =
    | { type: "delay"; ms: number }
    | { type: "callback_received"; taskId: string };

export interface WakeConditionRecord {
    id: string;
    condition: WakeCondition;
    registeredAt: string;
}

// ─── 全局状态 ───

/** 主 Agent 全局状态 */
export interface MainAgentGlobalState {
    /** 调度事件（定时提醒 + cron 任务） */
    schedulerEvents: SchedulerEvent[];
    /** Meta-CodeAct 全局备忘录 */
    memos: MemoEntry[];
    /** Meta-CodeAct 历史会话摘要 */
    sessionDigests: SessionDigestEntry[];
    /** Accumulator 信号池 */
    signalPool: SignalPoolItem[];
    /** Meta-CodeAct 唤醒条件 */
    wakeConditions: WakeConditionRecord[];
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
