/**
 * memory.d.ts — Memory V2 Agent API 类型定义
 *
 * 记忆系统 V2 接口。Agent 可通过 memory 全局对象使用：
 * - recall()：统一记忆检索（向量 + 关键词混合搜索）
 * - browseHistory()：消息档案检索（LLM 深度阅读）
 * - reflect()：触发群组反思总结
 *
 * 注意：记忆的写入由后台 Pipeline 自动完成（RecordingPipeline +
 * post-session fact extraction），Agent 不需要手动写入。
 *
 * memory: MemoryStore — 全局可用
 */

// ─── 事实分类 ───

/** 核心事实的分类 */
type FactCategory =
    | 'biographical'
    | 'preference'
    | 'anecdote'
    | 'opinion'
    | 'plan'
    | 'relationship'
    | 'general';

// ─── Memory V2 核心类型 ───

/** 话题节点 */
interface TopicNode {
    id: string;
    chatId: string;
    label: string;
    summary: string;
    keyPoints: string[];
    participants: string[];
    messageRange: { messageIds: string[]; count: number };
    startedAt: string;
    endedAt: string | null;
    sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
    keywords: string[];
    createdAt: string;
    updatedAt: string;
}

/** 核心事实（长期记忆，跨群共享） */
interface CoreFact {
    id: string;
    subject: string;
    content: string;
    category: FactCategory;
    confidence: number;
    createdAt: string;
    expiresAt: string | null;
}

/** 个体身份（全局，跨群共享） */
interface PersonIdentity {
    userId: string;
    displayName: string;
    aliases: string[];
    totalMessageCount: number;
    lastSeenAt: string;
    firstSeenAt: string;
}

/** 个体群内画像（每群独立） */
interface PersonGroupProfile {
    userId: string;
    chatId: string;
    dunbarTier: 1 | 2 | 3 | 4;
    traits: string[];
    interests: string[];
    communicationStyle: string;
    relationToAgent: string;
    messageCount: number;
    lastSeenAt: string;
}

// ─── 检索接口 ───

/** recall() 查询选项 */
interface RecallOptions {
    chatId?: string;
    userId?: string;
    daysBack?: number;
    maxResults?: number;
    categories?: FactCategory[];
    deepRecallThreshold?: number;
}

/** recall() 返回结果 */
interface RecallResult {
    topics: TopicNode[];
    facts: Array<{
        content: string;
        category: FactCategory;
        subject: string;
        confidence: number;
    }>;
    persons: PersonGroupProfile[];
    deepSummary?: string;
}

/** 消息档案检索请求 */
interface HistoryBrowseRequest {
    /** 自然语言搜索意图 */
    intent: string;
    hints?: {
        chatId?: string;
        userId?: string;
        topicLabel?: string;
        topicId?: string;
        hoursBack?: number;
        daysBack?: number;
    };
    contextWindow?: number;
    maxSegments?: number;
}

/** 消息档案检索结果 */
interface HistoryBrowseResult {
    answer: string;
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
    messagesRead: number;
}

/**
 * Memory V2 — 记忆存储系统（只读 API）
 *
 * 三层记忆模型：短期（上下文）、中期（话题/画像）、长期（核心事实）。
 * 记忆的写入由后台 Pipeline 自动完成，Agent 仅负责读取。
 */
interface MemoryStore {
    /**
     * 统一记忆检索入口
     * 使用向量搜索 + 关键词搜索混合检索
     * @example
     * const result = await memory.recall("alice 东京", {
     *   chatId: "-100xxx",
     *   userId: "alice_123",
     *   categories: ['preference', 'plan'],
     * });
     */
    recall(query: string, options?: RecallOptions): Promise<RecallResult>;

    /**
     * 消息档案检索
     * 话题索引引导 + 模糊搜索 + cheap model 深度阅读
     * @example
     * const result = await memory.browseHistory({
     *   intent: "谁说过要去京都吃抹茶",
     *   hints: { chatId: "-100xxx", daysBack: 7 },
     * });
     */
    browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult>;

    /**
     * 对指定群组进行反思总结
     * 读取上次反思以来的 topics 和 interactions，生成结构化总结
     */
    reflect(chatId: string): Promise<{
        reflectedPeriod: { from: string; to: string };
        topicsSummary: Array<{ label: string; summary: string; participants: string[]; sentiment: string }>;
        personUpdates: Array<{ userId: string; chatId: string; changes: string }>;
        groupUpdates: string;
        newCoreFacts: string[];
        mergedEpisodes: number;
        insights: string;
    }>;
}

/** 全局记忆存储实例 */
declare const memory: MemoryStore;
