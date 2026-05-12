/**
 * memory — Meta 跨群实体检索 API。
 *
 * 用于检索人物身份、画像、事实、近期话题和历史 session digest。适合在跨群转述或派发前查证不确定事实。
 */

type MetaFactCategory =
    | "biographical"
    | "preference"
    | "anecdote"
    | "opinion"
    | "plan"
    | "relationship"
    | "skill"
    | "general";

type MemoryIdentityMatchType =
    | "exact_user_id"
    | "exact_display_name"
    | "exact_alias"
    | "exact_username"
    | "partial_display_name"
    | "partial_alias"
    | "partial_username"
    | "fact_subject"
    | "topic_participant";

interface MemorySearchEntitiesOptions {
    /** 限定群组。 */
    chatId?: string;
    /** ISO 时间下限。 */
    after?: string;
    /** ISO 时间上限。 */
    before?: string;
    /** 事实分类过滤。 */
    categories?: MetaFactCategory[];
    /** 默认 10，最大 50。 */
    limit?: number;
}

interface MemoryIdentityMatch {
    identity: {
        userId: string;
        aliases: string[];
        displayName: string;
        username?: string;
        totalMessageCount?: number;
        lastSeenAt?: string;
    };
    profile: {
        recentFacts?: unknown[];
        dunbarTier?: number;
    };
    /** 命中原因类型；exact_* 通常比 topic_participant 更可信。 */
    matchType: MemoryIdentityMatchType;
    /** 相关性分数，越高越相关。 */
    score: number;
    reasons: string[];
}

interface MemorySearchEntitiesResult {
    identities: MemoryIdentityMatch[];
    recentSessions: Array<{
        topicId: string;
        chatId: string;
        label: string;
        summary: string;
        keywords: string[];
        participants: string[];
    }>;
    sessionDigests: Array<{ createdAt: string; content: string }>;
    coreFacts: Array<{
        factId: string;
        subject: string;
        content: string;
        category: MetaFactCategory;
        updatedAt: string;
        sourceChatId?: string;
        sourceChatTitle?: string;
        sourceTopicLabel?: string;
        observedAt?: string;
        visibility?: "private" | "contextual" | "public";
        sensitivity?: "low" | "medium" | "high";
    }>;
    topicKeywords: string[];
}

interface MemoryResolvePersonResult {
    matches: MemoryIdentityMatch[];
}

interface MemoryGetPersonDossierOptions {
    /** 高亮当前群画像，但 dossier 仍会聚合跨群资料。 */
    chatId?: string;
    /** 要返回的候选身份数，默认 3，最大 10。 */
    limit?: number;
    factsLimit?: number;
    interactionsLimit?: number;
    topicsLimit?: number;
    messagesLimit?: number;
    groupProfilesLimit?: number;
}

interface MemoryGetPersonDossierResult {
    dossiers: Array<{
        match: MemoryIdentityMatch;
        groupProfiles: Array<{
            userId: string;
            chatId: string;
            chatTitle?: string;
            isDirectMessage?: boolean;
            dunbarTier: number;
            affinityScore: number;
            traits: string[];
            interests: string[];
            communicationStyle: string;
            relationToAgent: string;
            messageCount: number;
            lastSeenAt: string;
        }>;
        facts: Array<{
            id: string;
            subject: string;
            category: MetaFactCategory;
            content: string;
            confidence: number;
            sourceChatId?: string | null;
            sourceChatTitle?: string | null;
            sourceTopicLabel?: string | null;
            observedAt?: string | null;
            visibility?: "private" | "contextual" | "public";
            sensitivity?: "low" | "medium" | "high";
            updatedAt: string;
        }>;
        recentInteractions: unknown[];
        recentTopics: unknown[];
        recentMessages: unknown[];
    }>;
}

declare const memory: {
    /**
     * 把人名、别名、username 或 userId 解析成候选身份，并按相关性排序。
     * 优先级大致为 exact userId / exact alias > partial alias > fact subject > topic participant。
     */
    resolvePerson(query: string, options?: MemorySearchEntitiesOptions): Promise<MemoryResolvePersonResult>;

    /**
     * 面向“评价某人 / 了解某人”的一站式人物资料包。
     * 先解析身份，再聚合跨群画像、核心事实、近期互动、近期话题和消息样本。
     */
    getPersonDossier(queryOrUserId: string, options?: MemoryGetPersonDossierOptions): Promise<MemoryGetPersonDossierResult>;

    /**
     * 跨群检索实体、事实、话题和历史 session 摘要。
     *
     * 默认返回 10 条，最大 50 条；身份结果按相关性排序，exact alias 会排在普通 topic participant 前。
     * 不确定的最新事实先用此方法、getPersonDossier() 或 conversations.query() 查证，再做派发决策。
     *
     * @param query 人名、别名、关键词或事实线索。
     * @param options 可选的群组、时间、分类和数量过滤。
     * @returns 与 query 相关的身份、话题、session digest、事实和关键词。
     * @example
     * const result = await memory.searchEntities("团建", { limit: 5 });
     * console.log(JSON.stringify(result.coreFacts, null, 2));
     */
    searchEntities(query: string, options?: MemorySearchEntitiesOptions): Promise<MemorySearchEntitiesResult>;
};
