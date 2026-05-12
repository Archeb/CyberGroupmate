/**
 * memory-v2/types.ts — Memory V2 类型定义
 *
 * 定义三层记忆模型所需的全部 TypeScript 接口。
 * 参考设计文档 memory.md。
 *
 * 在整体架构中的位置：
 * - 被 MemoryStoreV2 实现类使用
 * - 被 compaction.ts、main.ts、cli.ts 等消费者导入
 * - sandbox/modules/memory.d.ts 的实际对应类型
 */

import type { LLMConfig, ReflectionExternalConfig } from "../core/config.js";

// ─── 事实分类 ───

/** 核心事实的分类枚举 */
export type FactCategory =
    | "biographical"    // 个人信息（"alice 是前端程序员"）
    | "preference"      // 喜好（"bob 喜欢抹茶拿铁"）
    | "anecdote"        // 趣事/黑历史（永不过期、永不在合并中删除）
    | "opinion"         // 观点（"alice 觉得 Rust 比 Go 好"）
    | "plan"            // 计划（"alice 下周去东京"，带 expires_at）
    | "relationship"    // 人际关系（"alice 和 bob 是同事"）
    | "general";        // 通用事实

export type AssociatedMemory =
    | {
        type: "core_fact";
        factId: string;
        subject: string;
        subjectLabel?: string;
        category: FactCategory;
        content: string;
        confidence: number;
        sourceChatId?: string | null;
        sourceChatLabel?: string | null;
        sourceTopicLabel?: string | null;
        visibility?: "private" | "contextual" | "public";
        sensitivity?: "low" | "medium" | "high";
    }
    | {
        type: "topic";
        topicId: string;
        label: string;
        summary: string;
        startedAt: string;
        endedAt: string | null;
    };

// ─── 话题节点 ───

/** 话题节点 — 中期记忆的持久化形式（SQLite topics 表） */
export interface TopicNode {
    /** UUID v4（持久化主键） */
    id: string;
    /** 对应 Pipeline TopicRegistry 的运行时 ID */
    pipelineTopicId?: string;
    /** 所属群组 */
    chatId: string;
    /** 话题标签（如 "新番推荐"，LLM 生成） */
    label: string;
    /** 话题摘要（1-3句话，来自 Recording Pipeline Step 2） */
    summary: string;
    /** 关键要点（来自 Recording Pipeline Step 2） */
    keyPoints: string[];
    /** 参与者 userId 列表 */
    participants: string[];
    /** 关联消息 ID 列表（完整存储每条归属消息的 ID） */
    messageRange: {
        messageIds: string[];
        count: number;
    };
    /** 话题开始时间 (ISO 8601) */
    startedAt: string;
    /** 话题结束时间（null=仍在进行） */
    endedAt: string | null;
    /** 情感倾向 */
    sentiment: "positive" | "neutral" | "negative" | "mixed";
    /** 关联话题 ID 列表（话题演变链） */
    relatedTopicIds: string[];
    /** 关键词（与 Pipeline Topic.keywords 共享） */
    keywords: string[];
    /** 与该话题程序化关联的历史记忆 */
    associatedMemories?: AssociatedMemory[];
    /** 触发回梗/主动接话的潜力分（0-100） */
    callbackPotential?: number;
    /** 向量表示（语义检索用，Phase M4） */
    embedding?: Float32Array;
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

// ─── 个体画像：双层模型 ───

/** 个体身份（全局，跨群共享） */
export interface PersonIdentity {
    /** 主键（Telegram userId） */
    userId: string;
    /** 最常用的名字 */
    displayName: string;
    /** 平台用户名（Telegram @username / Discord username） */
    username?: string;
    /** 所有已知昵称/曾用名 */
    aliases: string[];
    /** 跨群总消息数 */
    totalMessageCount: number;
    /** 最后出现时间 (ISO 8601) */
    lastSeenAt: string;
    /** 首次出现时间 (ISO 8601) */
    firstSeenAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

/** 个体全局画像（跨群共享的长期认知） */
export interface PersonProfile {
    /** 用户 ID（全局主键，composite userId） */
    userId: string;
    /** 跨群稳定性格/行为特点 */
    traits: string[];
    /** 跨群长期兴趣和偏好 */
    interests: string[];
    /** 跨群一致的沟通风格 */
    communicationStyle: string;
    /** 与 agent 的总体关系描述 */
    relationToAgent: string;
    /** 稳定互动模式 */
    stablePatterns: string[];
    /** 面向 agent 的长期响应策略 */
    agentPolicyHints: string[];
    /** 之后可自然回访的长期候选 */
    followupCandidates: string[];
    /** 本全局认知来自哪些 chat */
    sourceChatIds: string[];
    /** 置信度 0-1 */
    confidence: number;
    /** 上次由 reflection 更新的时间 */
    lastReflectedAt: string | null;
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

/** 个体群内画像（每群独立） */
export interface PersonGroupProfile {
    /** 用户 ID（联合主键） */
    userId: string;
    /** 群组 ID（联合主键） */
    chatId: string;
    /** 邓巴分层 1=核心<=15, 2=熟悉<=50, 3=认识<=150, 4=陌生 */
    dunbarTier: 1 | 2 | 3 | 4;
    /** LLM 给出的分层理由 */
    dunbarReason: string;
    /** 好感度分数 (0-100)，由 percentile ranking + quality delta 计算 */
    affinityScore: number;
    /** 在这个群的性格表现 */
    traits: string[];
    /** 在这个群的兴趣话题 */
    interests: string[];
    /** 在这个群的说话风格 */
    communicationStyle: string;
    /** 在这个群与 agent 的关系描述 */
    relationToAgent: string;
    /** 近 7 天的详细交互 */
    recentEpisodes: InteractionEpisode[];
    /** 更早的合并后记忆 */
    mergedMemory: MergedMemory[];
    /** 此群的消息数 */
    messageCount: number;
    /** 最后出现时间 (ISO 8601) */
    lastSeenAt: string;
    /** 活跃时段分布（0-23） */
    activeHours: number[];
    /** 首次出现时间 (ISO 8601) */
    firstSeenAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

/** 近期的详细交互记录（7 天内保留） */
export interface InteractionEpisode {
    /** UUID v4 */
    id: string;
    /** ISO date */
    date: string;
    /** 所属会话 */
    chatId: string;
    /** 关联用户 */
    userId: string;
    /** 关联话题 */
    topicId: string | null;
    /** 交互类型 */
    type: "agent_replied" | "agent_mentioned" | "direct_message" | "reaction";
    /** 详细描述 */
    summary: string;
    /** 情感倾向 */
    sentiment: "positive" | "neutral" | "negative";
    /** 重要程度 0-1 */
    significance: number;
    /** 发言人显示名（用于长期记忆可读性） */
    displayName?: string;
    /** 方向：谁主动触发了这段互动 */
    direction?: "user_to_agent" | "agent_to_user" | "mixed" | "ambient";
    /** 交互质量，来自 reflection 或规则判断 */
    interactionQuality?: "friendly" | "dependent" | "instrumental" | "hostile";
    /** 关联消息 ID，用于回溯证据 */
    messageIds?: string[];
    /** 关联源 ID（interaction/message/topic 等） */
    sourceIds?: string[];
    /** 关联话题名称 */
    topicLabel?: string;
    /** 关联话题摘要 */
    topicSummary?: string;
    /** 用于合并 LLM 的短证据片段 */
    evidence?: string[];
    /** Agent 后续反应或结果 */
    agentOutcome?: string;
    /** 置信度 0-1 */
    confidence?: number;
    /** 关联媒体类型 */
    mediaTypes?: string[];
    /** 回复链目标消息 ID */
    replyToMessageIds?: string[];
}

/** 合并后的记忆（周/月/季度/年粒度） */
export interface MergedMemory {
    /** 时期开始 */
    periodStart: string;
    /** 时期结束 */
    periodEnd: string;
    /** 粒度级别 */
    granularity: "week" | "month" | "quarter" | "year";
    /** 整体情感倾向 */
    overallSentiment: "positive" | "neutral" | "negative" | "mixed";
    /** 该时期的交互次数 */
    interactionCount: number;
    /** 只保留重要事件（significance > 0.7）的摘要 */
    highlights: string[];
    /** 关系变化描述 */
    relationshipTrend: string;
    /** 来源 InteractionEpisode ID */
    sourceEventIds?: string[];
    /** 来源 MergedMemory ID/时期标识 */
    sourceMemoryIds?: string[];
    /** 各交互类型计数 */
    eventTypeCounts?: Record<string, number>;
    /** 话题出现次数 */
    topicCounts?: Record<string, number>;
    /** 活跃天数 */
    activeDays?: number;
    /** 交互质量分布 */
    qualityDistribution?: Record<string, number>;
    /** 这个时期形成的稳定互动模式 */
    stablePatterns?: string[];
    /** 该用户偏好/雷点/常聊对象等可执行信息 */
    userPreferences?: string[];
    /** 给 agent 后续互动的提示 */
    agentPolicyHints?: string[];
    /** 经过筛选、带来源的关键事件 */
    salientEvents?: Array<{
        summary: string;
        sourceIds?: string[];
        confidence?: number;
    }>;
    /** 未来可自然接回的话题或行动 */
    followupCandidates?: string[];
    /** 合并摘要置信度 0-1 */
    confidence?: number;
}

// ─── 群组画像 ───

/** 群组画像 */
export interface GroupModel {
    /** 主键 */
    chatId: string;
    /** 群组标题 */
    chatTitle: string;
    /** 是否为私聊（由 adapter 层提供） */
    isDirectMessage?: boolean;
    /** 群组描述/定位 */
    description: string;
    /** 主要语言 */
    dominantLanguage: string;
    /** 交流规范 */
    communicationNorms: string[];
    /** 活跃成员数 */
    activeMembers: number;
    /** 日均消息量 */
    avgMessagesPerDay: number;
    /** 活跃高峰时段 */
    peakHours: number[];
    /** agent 在群中扮演的角色 */
    agentRole: string;
    /** 参与度级别 */
    engagementLevel: "high" | "medium" | "low";
    /** 最近收到的反馈总结 */
    recentFeedback: string;
    /** 近期热门话题 */
    hotTopics: string[];
    /** 不宜讨论的话题 */
    tabooTopics: string[];
    /** 上次反思时间 (ISO 8601) */
    lastReflectedAt: string | null;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
}

// ─── 核心事实 ───

/** 核心事实（长期记忆，跨群共享） */
export interface CoreFact {
    /** UUID v4 */
    id: string;
    /** userId / chatId / 通用主题 */
    subject: string;
    /** 事实内容 */
    content: string;
    /** 分类 */
    category: FactCategory;
    /** 置信度 0-1 */
    confidence: number;
    /** 来源（topic_id 或 interaction_id） */
    source: string | null;
    /** 来源 chatId */
    sourceChatId?: string | null;
    /** 来源 chat 标题 */
    sourceChatTitle?: string | null;
    /** 来源 topicId */
    sourceTopicId?: string | null;
    /** 来源 topic 标签 */
    sourceTopicLabel?: string | null;
    /** 来源 messageId 列表 */
    sourceMessageIds?: string[];
    /** 来源 interactionId 列表 */
    sourceInteractionIds?: string[];
    /** 事实被观察到的时间 */
    observedAt?: string | null;
    /** 可披露/使用范围 */
    visibility?: "private" | "contextual" | "public";
    /** 敏感度 */
    sensitivity?: "low" | "medium" | "high";
    /** 向量表示 */
    embedding?: Float32Array;
    /** 创建时间 (ISO 8601) */
    createdAt: string;
    /** 更新时间 (ISO 8601) */
    updatedAt: string;
    /** 时效性事实的过期时间 */
    expiresAt: string | null;
}

// ─── recall() 检索接口 ───

/** recall() 的查询选项 */
export interface RecallOptions {
    /** 限定群组 */
    chatId?: string;
    /** 限定用户 */
    userId?: string;
    /** 时间范围（天） */
    daysBack?: number;
    /** 最大结果数 */
    maxResults?: number;
    /** 按事实类别过滤 */
    categories?: FactCategory[];
    /** 结果 token 超过此值时启用 cheap model 深度总结 */
    deepRecallThreshold?: number;
}

/** recall() 的返回结果 */
export interface RecallResult {
    /** 匹配的话题节点 */
    topics: TopicNode[];
    /** 匹配的核心事实 */
    facts: Array<{
        content: string;
        category: FactCategory;
        subject: string;
        confidence: number;
    }>;
    /** 匹配的个体画像 */
    persons: PersonGroupProfile[];
    /** 如果触发了深度总结，包含 cheap model 综合摘要 */
    deepSummary?: string;
}

export interface FactSearchResult {
    factId: string;
    subject: string;
    category: FactCategory;
    content: string;
    confidence: number;
    sourceChatId?: string | null;
    sourceChatTitle?: string | null;
    sourceTopicId?: string | null;
    sourceTopicLabel?: string | null;
    sourceMessageIds?: string[];
    sourceInteractionIds?: string[];
    observedAt?: string | null;
    visibility?: "private" | "contextual" | "public";
    sensitivity?: "low" | "medium" | "high";
    updatedAt: string;
}

export interface TopicSearchResult {
    topicId: string;
    chatId: string;
    label: string;
    summary: string;
    keywords: string[];
    participants: string[];
    startedAt: string;
    endedAt: string | null;
    sentiment: TopicNode["sentiment"];
    callbackPotential: number;
    associatedMemories: AssociatedMemory[];
}

export interface MessageSearchResult {
    messageId: string;
    chatId: string;
    userId: string;
    displayName: string;
    content: string;
    timestamp: string;
}

export interface MessageQueryOptions {
    chatIds?: string[];
    userIds?: string[];
    displayNameLike?: string;
    textLike?: string;
    after?: string;
    before?: string;
    limit?: number;
}

export interface InteractionSearchResult {
    timestamp: string;
    chatId: string;
    userId: string;
    type: string;
    summary: string;
    sentiment: "positive" | "neutral" | "negative";
    significance: number;
}

export interface UserProfileSearchResult {
    identity: PersonIdentity | null;
    globalProfile: PersonProfile | null;
    groupProfile: PersonGroupProfile | null;
    recentFacts: FactSearchResult[];
}

export interface CoreFactProvenance {
    sourceChatId?: string | null;
    sourceChatTitle?: string | null;
    sourceTopicId?: string | null;
    sourceTopicLabel?: string | null;
    sourceMessageIds?: string[];
    sourceInteractionIds?: string[];
    observedAt?: string | null;
    visibility?: "private" | "contextual" | "public";
    sensitivity?: "low" | "medium" | "high";
}

// ─── browseHistory() 消息档案接口 ───

/** 消息档案检索请求 */
export interface HistoryBrowseRequest {
    /** 自然语言描述的搜索意图（支持模糊） */
    intent: string;
    /** 搜索提示（可选，缩小范围） */
    hints?: {
        chatId?: string;
        userId?: string;
        topicLabel?: string;
        topicId?: string;
        hoursBack?: number;
        daysBack?: number;
    };
    /** 上下文窗口大小（命中消息前后各多少条），默认 10 */
    contextWindow?: number;
    /** 最大结果数，默认 3 */
    maxSegments?: number;
}

/** 消息档案检索结果 */
export interface HistoryBrowseResult {
    /** cheap model 生成的针对性回答 */
    answer: string;
    /** 定位到的消息段落 */
    segments: Array<{
        topicLabel: string;
        timeRange: { from: string; to: string };
        messages: Array<{
            messageId: string;
            userId: string;
            displayName: string;
            text: string;
            timestamp: string;
        }>;
        relevanceScore: number;
    }>;
    /** 总共阅读了多少条消息 */
    messagesRead: number;
}

// ─── reflect() 反思接口 ───

/** reflect() 的返回结果 */
export interface ReflectionResult {
    reflectedPeriod: { from: string; to: string };
    topicsSummary: Array<{
        label: string;
        summary: string;
        participants: string[];
        sentiment: string;
    }>;
    personUpdates: Array<{
        userId: string;
        chatId: string;
        changes: string;
    }>;
    groupUpdates: string;
    newCoreFacts: string[];
    mergedEpisodes: number;
    insights: string;
}

// ─── 消息日志条目 ───

/** message_log 表的写入条目 */
export interface MessageLogEntry {
    /** Telegram 消息 ID */
    messageId: string;
    /** 所属群组 */
    chatId: string;
    /** 发送者 userId */
    userId: string;
    /** 发送者显示名称 */
    displayName: string;
    /** 消息文本 */
    text: string;
    /** 回复目标消息 ID */
    replyToMessageId?: string;
    /** 消息时间 (ISO 8601) */
    timestamp: string;
    /** 媒体类型: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other" */
    mediaType?: string;
    /** 媒体元数据 JSON（含 fileId, uniqueFileId, emoji 等） */
    mediaInfo?: string;
}

export interface RecentMessageEntry {
    messageId: string;
    chatId: string;
    userId: string;
    displayName: string;
    text: string;
    replyToMessageId?: string;
    timestamp: string;
    /** 媒体类型 */
    mediaType?: string;
    /** 媒体元数据 JSON */
    mediaInfo?: string;
}

// ─── MemoryStoreV2 接口 ───

/**
 * IMemoryStoreV2 — Memory V2 纯 V2 接口
 *
 * 不保留任何 V1 兼容方法。直接面向 memory.md v3.0 设计。
 * 分为三类方法：
 * - 写入方法（由 Recording Pipeline / Compaction / Reflection 调用）
 * - 检索方法（由 Agent CodeAct session 调用）
 * - 生命周期方法
 */
export interface IMemoryStoreV2 {
    // ─── 写入方法 ───

    /** 按 pipeline_topic_id upsert 话题节点到 SQLite topics 表 */
    upsertTopic(pipelineTopicId: string, data: Partial<TopicNode>): string;

    /** 按 SQLite id 更新话题节点（Reflection 等内部调用者使用） */
    updateTopicById(id: string, data: Partial<TopicNode>): void;

    /** 标记话题结束（设置 ended_at），由 ARCHIVED 事件触发 */
    finalizeTopic(pipelineTopicId: string): void;

    /** 批量写入原始消息到 message_log 表 */
    storeMessageBatch(messages: MessageLogEntry[]): void;

    /** 写入核心事实到 core_facts 表 */
    storeFact(subject: string, content: string, category: FactCategory, source?: string, expiresAt?: string, embedding?: Float32Array, confidence?: number, provenance?: CoreFactProvenance): string;

    /** upsert 个体身份（全局，跨群） */
    upsertPersonIdentity(userId: string, data: Partial<PersonIdentity>): void;

    /** upsert 个体全局画像（跨群共享） */
    upsertPersonProfile(userId: string, data: Partial<PersonProfile>): void;

    /** upsert 个体群内画像（每群独立） */
    upsertPersonGroupProfile(userId: string, chatId: string, data: Partial<PersonGroupProfile>): void;

    /**
     * 程序化增量更新群内画像统计字段（Recording Pipeline 专用）
     * - messageCount: 增量累加（+= delta）
     * - activeHours: 逐 slot 累加合并
     * - lastSeenAt: 取较新值
     * 如果 profile 不存在则自动创建
     */
    incrementProfileStats(userId: string, chatId: string, stats: {
        messageCountDelta: number;
        activeHoursDelta: number[];
        lastSeenAt: string;
    }): void;

    /** upsert 群组画像 */
    upsertGroupModel(chatId: string, data: Partial<GroupModel>): void;

    /** 获取群组画像 */
    getGroupModel(chatId: string): GroupModel | null;

    /** 获取全局个体身份 */
    getPersonIdentity(userId: string): PersonIdentity | null;

    /** 获取个体全局画像 */
    getPersonProfile(userId: string): PersonProfile | null;

    /** 按 displayName / aliases / username 搜索个体身份 */
    searchByAlias(query: string, limit?: number): PersonIdentity[];

    /** 写入交互记录到 interactions 表 */
    storeInteraction(episode: Omit<InteractionEpisode, "id">): string;

    /** 按 chat 聚合近期 DIRECT_ADDRESS 类互动次数 */
    countInteractionsPerChat(days?: number): Map<string, { interactionCount: number; activeDays: number; lastInteractionAt: string | null }>;

    /** 向量搜索 topics（纯 JS 余弦相似度） */
    vectorSearchTopics(queryEmbedding: Float32Array, limit?: number, chatId?: string): Array<TopicNode & { similarity: number }>;

    /** 向量搜索 core_facts（纯 JS 余弦相似度） */
    vectorSearchFacts(queryEmbedding: Float32Array, limit?: number, categories?: FactCategory[]): Array<{ id: string; content: string; category: FactCategory; subject: string; confidence: number; similarity: number }>;

    // ─── 检索方法 ───

    /**
     * 统一记忆检索入口
     * M1: FTS5 关键词搜索；M4 升级为向量 + FTS5 混合检索
     */
    recall(query: string, options?: RecallOptions): Promise<RecallResult>;

    /**
     * 消息档案检索
     * M1: 关键词匹配 topics → message_log 拉消息
     * M4 升级为 LLM 意图解析 + 向量搜索 + 深度阅读
     */
    browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult>;

    /** 获取指定 chatId 在 since 之后的 topics */
    getTopicsSince(chatId: string, since: string): TopicNode[];

    /** 获取指定 chatId 最近 N 条 topics（按 started_at DESC，无时间限制） */
    getRecentTopics(chatId: string, limit?: number): TopicNode[];

    /** 通过持久化 topic id 获取单条话题 */
    getTopicById(topicId: string): TopicNode | null;

    /** 获取指定 chatId 在 since 之后的 interactions */
    getInteractionsSince(chatId: string, since: string): InteractionEpisode[];

    /** 获取指定 chatId 的所有群内画像 */
    getProfilesForChat(chatId: string): PersonGroupProfile[];

    /** 获取指定 chatId 最近的原始消息 */
    getRecentMessages(chatId: string, limit?: number): RecentMessageEntry[];

    /** 获取已缓存的 sticker 描述（只读，用于上下文富化） */
    getStickerDescription(uniqueFileId: string): { description: string; emoji?: string; emojis?: string[] } | null;

    /** 搜索核心事实 */
    searchFacts(query: string, options?: {
        subject?: string;
        categories?: FactCategory[];
        limit?: number;
    }): FactSearchResult[];

    /** 搜索历史话题 */
    searchTopics(query: string, options?: {
        chatId?: string;
        after?: string;
        before?: string;
        excludeTopicIds?: string[];
        limit?: number;
    }): TopicSearchResult[];

    /** 搜索聊天记录原文 */
    searchMessages(query: string, options?: {
        chatId?: string;
        userId?: string;
        after?: string;
        before?: string;
        limit?: number;
    }): MessageSearchResult[];

    /** 结构化搜索聊天记录，支持跨群、人名与正文组合过滤 */
    queryMessages(options?: MessageQueryOptions): MessageSearchResult[];

    /** 获取用户完整画像检索结果 */
    getUserProfile(userId: string, chatId?: string): UserProfileSearchResult;

    /** 获取近期交互日志 */
    getRecentInteractions(chatId?: string | null, userId?: string, limit?: number): InteractionSearchResult[];

    /** 分页列出全部 person identities */
    listPersonIdentities(limit?: number, offset?: number): { items: PersonIdentity[]; total: number };

    /** 分页列出全部全局 person profiles */
    listPersonProfiles(limit?: number, offset?: number): { items: PersonProfile[]; total: number };

    /** 列出全部群组画像 */
    listGroupModels(): GroupModel[];

    /** 列出指定 binding/chat 的 todo */
    todoList(chatId: string, options?: { includeExpired?: boolean }): Array<{
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    }>;

    /** 获取指定 binding/chat 的 todo */
    todoGet(chatId: string, key: string): {
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    } | null;

    /** 新增或更新指定 binding/chat 的 todo */
    todoUpsert(chatId: string, key: string, content: string, dueAt?: string | null): {
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    };

    /** 删除指定 binding/chat 的 todo */
    todoRemove(chatId: string, key: string): void;

    /** 按 messageId 查询单条消息（用于获取不在上下文窗口中的被回复消息） */
    getMessageById(chatId: string, messageId: string): RecentMessageEntry | null;
    getMessagesByIds(chatId: string, messageIds: string[]): RecentMessageEntry[];
    getMessagesBetweenIds(chatId: string, startMessageId: string, endMessageId: string): RecentMessageEntry[];

    /**
     * 对指定群组进行反思总结
     * 调用 runReflection() 执行 5 步流程
     */
    reflect(chatId: string, llmConfigs: LLMConfig[], reflectionConfig?: ReflectionExternalConfig): Promise<ReflectionResult>;

    // ─── 生命周期 ───

    /** 关闭数据库连接 */
    close(): void;
}
