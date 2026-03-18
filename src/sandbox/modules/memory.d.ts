/**
 * memory.d.ts — Memory V2 场景类型定义 (L1)
 *
 * 记忆系统 V2 接口。Agent 进入 memory 场景后看到这些类型，
 * 用于统一检索（recall）、消息档案（browseHistory）、
 * 以及兼容的搜索/存储/画像管理功能。
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
    tags: string[];
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

// ─── V1 兼容类型 ───

/** 记忆条目（V1 兼容） */
interface MemoryEntry {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
    timestamp: string;
}

/** 群友画像（V1 兼容） */
interface PersonProfile {
    userId: string;
    displayName?: string;
    notes?: string;
    traits?: string[];
    lastInteraction?: string;
    [key: string]: unknown;
}

/** 对话摘要（V1 兼容） */
interface ConversationSummary {
    id: string;
    chatId: string;
    chatTitle: string;
    summary: string;
    keyPoints: string[];
    timestamp: string;
}

/** 待办事项 */
interface TodoItem {
    id: string;
    description: string;
    createdAt: string;
    dueDate?: string;
    done: boolean;
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
 * Memory V2 — 记忆存储系统
 *
 * 三层记忆模型：短期（上下文）、中期（话题/画像）、长期（核心事实）。
 * 当前为 V2 stub 实现（读空+写弃），后续接入真实数据层。
 */
interface MemoryStore {
    // ─── V1 兼容方法 ───

    /**
     * 搜索记忆（全文搜索）
     * @example const results = memory.search("抹茶", 5);
     */
    search(query: string, limit?: number): MemoryEntry[];

    /**
     * 存入一条记忆
     * @example memory.store("alice 喜欢抹茶", { source: "chat" })
     */
    store(content: string, metadata?: Record<string, unknown>): string;

    /** 获取群友画像（V1 兼容） */
    getPerson(userId: string): PersonProfile | null;

    /** 更新群友画像（V1 兼容，merge 模式） */
    updatePerson(userId: string, data: Partial<PersonProfile>): void;

    /** 获取最近的对话摘要 */
    getRecentConversations(chatId?: string, limit?: number): ConversationSummary[];

    /** 获取待办事项 */
    getPendingTasks(includeCompleted?: boolean): TodoItem[];

    /** 添加待办事项 */
    addTodo(description: string, dueDate?: string): string;

    /** 直接执行 SQL 查询（高级用法） */
    rawQuery(sql: string, ...params: unknown[]): unknown;

    // ─── V2 新方法 ───

    /**
     * 统一记忆检索入口（V2）
     * 使用向量搜索 + 关键词搜索混合检索
     * @example
     * const result = await memory.recall("alice 东京", {
     *   userId: "alice_123",
     *   categories: ['preference', 'plan'],
     * });
     */
    recall(query: string, options?: RecallOptions): Promise<RecallResult>;

    /**
     * 消息档案检索（V2）
     * 话题索引引导 + 模糊搜索 + cheap model 深度阅读
     * @example
     * const result = await memory.browseHistory({
     *   intent: "谁说过要去京都吃抹茶",
     *   hints: { chatId: "-100xxx", daysBack: 7 },
     * });
     */
    browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult>;

    /**
     * 对指定群组进行反思总结（V2）
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
