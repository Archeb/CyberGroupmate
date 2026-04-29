/**
 * modules/memory.d.ts — 记忆检索模块类型定义
 */

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
        groupProfile: {
            dunbarTier: number;
            affinityScore: number;
            traits: string[];
            communicationStyle: string;
            relationToAgent: string;
        } | null;
        recentFacts: Array<{
            factId: string;
            category: string;
            content: string;
        }>;
    }>;

    getRecentInteractions(chatId?: string, userId?: string, limit?: number): Promise<Array<{
        timestamp: string;
        chatId: string;
        userId: string;
        type: string;
        summary: string;
        sentiment: string;
        significance: number;
    }>>;

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