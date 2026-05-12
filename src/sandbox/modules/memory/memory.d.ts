/**
 * modules/memory.d.ts — 记忆检索模块类型定义
 */

type MemoryPersonMatchType =
    | "exact_user_id"
    | "exact_display_name"
    | "exact_alias"
    | "exact_username"
    | "partial_display_name"
    | "partial_alias"
    | "partial_username"
    | "fact_subject"
    | "topic_participant";

interface MemoryPersonMatch {
    identity: {
        userId: string;
        displayName: string;
        username?: string;
        aliases: string[];
        totalMessageCount: number;
        lastSeenAt: string;
        firstSeenAt: string;
        updatedAt: string;
    };
    profile: {
        identity: {
            userId: string;
            displayName: string;
            username?: string;
            aliases: string[];
        } | null;
        globalProfile: {
            traits: string[];
            interests: string[];
            communicationStyle: string;
            relationToAgent: string;
            stablePatterns: string[];
            agentPolicyHints: string[];
            followupCandidates: string[];
            sourceChatIds: string[];
            confidence: number;
        } | null;
        groupProfile: unknown | null;
        recentFacts: Array<{
            factId: string;
            category: string;
            content: string;
            sourceChatId?: string | null;
            sourceChatTitle?: string | null;
            sourceTopicLabel?: string | null;
            observedAt?: string | null;
            visibility?: "private" | "contextual" | "public";
            sensitivity?: "low" | "medium" | "high";
        }>;
    };
    matchType: MemoryPersonMatchType;
    score: number;
    reasons: string[];
}

interface MemoryModule {
    searchFacts(query: string, options?: {
        subject?: string;
        categories?: string[];
        limit?: number;
    }): Promise<Array<{
        factId: string;
        subject: string;
        category: string;
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
    }>>;

    searchTopics(query: string, options?: {
        chatId?: string;
        after?: string;
        before?: string;
        limit?: number;
    }): Promise<Array<{
        topicId: string;
        chatId: string;
        label: string;
        summary: string;
        keywords: string[];
        participants: string[];
        startedAt: string;
        endedAt: string | null;
        callbackPotential: number;
    }>>;

    searchMessages(query: string, options?: {
        chatId?: string;
        userId?: string;
        after?: string;
        before?: string;
        limit?: number;
    }): Promise<Array<{
        messageId: string;
        chatId: string;
        userId: string;
        displayName: string;
        content: string;
        timestamp: string;
    }>>;

    getUserProfile(userId: string, chatId?: string): Promise<{
        identity: {
            userId: string;
            displayName: string;
            username?: string;
            aliases: string[];
        } | null;
        globalProfile: {
            traits: string[];
            interests: string[];
            communicationStyle: string;
            relationToAgent: string;
            stablePatterns: string[];
            agentPolicyHints: string[];
            followupCandidates: string[];
            sourceChatIds: string[];
            confidence: number;
        } | null;
        groupProfile: {
            dunbarTier: number;
            affinityScore: number;
            traits: string[];
            interests: string[];
            communicationStyle: string;
            relationToAgent: string;
            recentEpisodes: Array<{
                date: string;
                type: string;
                summary: string;
                topicLabel?: string;
                evidence?: string[];
                agentOutcome?: string;
                confidence?: number;
            }>;
            mergedMemory: Array<{
                periodStart: string;
                periodEnd: string;
                granularity: string;
                relationshipTrend: string;
                highlights: string[];
                stablePatterns?: string[];
                agentPolicyHints?: string[];
                followupCandidates?: string[];
            }>;
        } | null;
        recentFacts: Array<{
            factId: string;
            category: string;
            content: string;
            sourceChatId?: string | null;
            sourceChatTitle?: string | null;
            sourceTopicLabel?: string | null;
            observedAt?: string | null;
            visibility?: "private" | "contextual" | "public";
            sensitivity?: "low" | "medium" | "high";
        }>;
    }>;

    getRecentInteractions(chatId?: string, userId?: string, limit?: number): Promise<Array<{
        timestamp: string;
        chatId: string;
        chatLabel?: string;
        userId: string;
        displayName?: string;
        userLabel?: string;
        type: string;
        summary: string;
        sentiment: string;
        significance: number;
    }>>;

    resolvePerson(query: string, options?: {
        chatId?: string;
        limit?: number;
    }): Promise<{
        matches: MemoryPersonMatch[];
    }>;

    getPersonDossier(queryOrUserId: string, options?: {
        chatId?: string;
        /** 默认 3，最大 10。 */
        limit?: number;
        factsLimit?: number;
        interactionsLimit?: number;
        topicsLimit?: number;
        messagesLimit?: number;
        groupProfilesLimit?: number;
    }): Promise<{
        dossiers: Array<{
            match: MemoryPersonMatch;
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
                category: string;
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
            recentInteractions: Array<{
                timestamp: string;
                chatId: string;
                userId: string;
                type: string;
                summary: string;
                sentiment: string;
                significance: number;
            }>;
            recentTopics: Array<{
                topicId: string;
                chatId: string;
                label: string;
                summary: string;
                keywords: string[];
                participants: string[];
                startedAt: string;
                endedAt: string | null;
                callbackPotential: number;
            }>;
            recentMessages: Array<{
                messageId: string;
                chatId: string;
                userId: string;
                displayName: string;
                content: string;
                timestamp: string;
            }>;
        }>;
    }>;

    semanticSearch(query: string, options?: {
        scope?: "facts" | "topics" | "all";
        limit?: number;
    }): Promise<Array<{
        type: "fact" | "topic";
        content: string;
        score: number;
    }>>;
}

declare const memory: MemoryModule;
