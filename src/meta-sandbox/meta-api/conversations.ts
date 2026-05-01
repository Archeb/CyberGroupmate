import type {
    IMemoryStoreV2,
    MessageSearchResult,
    TopicNode,
    TopicSearchResult,
} from "../../memory-v2/index.js";

export interface ConversationsQueryFilters {
    chatIds?: string[];
    keywords?: string[];
    userId?: string;
    after?: string;
    before?: string;
    limit?: number;
}

export interface ConversationsQueryResult {
    messages: MessageSearchResult[];
    topics: TopicSearchResult[];
}

type ConversationsReader = Pick<IMemoryStoreV2,
    "searchMessages" |
    "searchTopics" |
    "getRecentMessages" |
    "getRecentTopics"
>;

export function createConversationsApi(memory: ConversationsReader) {
    return {
        query: async (filters: ConversationsQueryFilters = {}): Promise<ConversationsQueryResult> => {
            const limit = clampLimit(filters.limit, 20, 100);
            const chatIds = uniqueStrings(filters.chatIds);
            const keywords = uniqueStrings(filters.keywords);

            const messages = keywords.length > 0
                ? searchMessages(memory, keywords, filters, limit, chatIds)
                : listRecentMessages(memory, filters, limit, chatIds);
            const topics = keywords.length > 0
                ? searchTopics(memory, keywords, filters, limit, chatIds)
                : listRecentTopics(memory, filters, limit, chatIds);

            return { messages, topics };
        },
    };
}

function searchMessages(
    memory: ConversationsReader,
    keywords: string[],
    filters: ConversationsQueryFilters,
    limit: number,
    chatIds: string[],
): MessageSearchResult[] {
    const scopes = chatIds.length > 0 ? chatIds : [undefined];
    const merged = new Map<string, MessageSearchResult>();

    for (const chatId of scopes) {
        for (const keyword of keywords) {
            const rows = memory.searchMessages(keyword, {
                chatId,
                userId: filters.userId,
                after: filters.after,
                before: filters.before,
                limit,
            });
            for (const row of rows) {
                merged.set(`${row.chatId}:${row.messageId}`, row);
            }
        }
    }

    return [...merged.values()]
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit);
}

function searchTopics(
    memory: ConversationsReader,
    keywords: string[],
    filters: ConversationsQueryFilters,
    limit: number,
    chatIds: string[],
): TopicSearchResult[] {
    const scopes = chatIds.length > 0 ? chatIds : [undefined];
    const query = keywords.join(" ");
    const merged = new Map<string, TopicSearchResult>();

    for (const chatId of scopes) {
        const rows = memory.searchTopics(query, {
            chatId,
            after: filters.after,
            before: filters.before,
            limit,
        });
        for (const row of rows) {
            if (!filters.userId || row.participants.includes(filters.userId)) {
                merged.set(row.topicId, row);
            }
        }
    }

    return [...merged.values()]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit);
}

function listRecentMessages(
    memory: ConversationsReader,
    filters: ConversationsQueryFilters,
    limit: number,
    chatIds: string[],
): MessageSearchResult[] {
    if (chatIds.length === 0) {
        return [];
    }

    const merged: MessageSearchResult[] = [];
    for (const chatId of chatIds) {
        const rows = memory.getRecentMessages(chatId, limit * 2)
            .filter((row) => matchesMessageFilters(row, filters))
            .map((row) => ({
                messageId: row.messageId,
                chatId: row.chatId,
                userId: row.userId,
                displayName: row.displayName,
                content: row.text,
                timestamp: row.timestamp,
            }));
        merged.push(...rows);
    }

    return merged
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
        .slice(0, limit);
}

function listRecentTopics(
    memory: ConversationsReader,
    filters: ConversationsQueryFilters,
    limit: number,
    chatIds: string[],
): TopicSearchResult[] {
    if (chatIds.length === 0) {
        return [];
    }

    const merged: TopicSearchResult[] = [];
    for (const chatId of chatIds) {
        const rows = memory.getRecentTopics(chatId, limit * 2)
            .filter((row) => matchesTopicFilters(row, filters))
            .map(topicNodeToSearchResult);
        merged.push(...rows);
    }

    return merged
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
        .slice(0, limit);
}

function matchesMessageFilters(
    row: Awaited<ReturnType<ConversationsReader["getRecentMessages"]>>[number],
    filters: ConversationsQueryFilters,
): boolean {
    if (filters.userId && row.userId !== filters.userId) {
        return false;
    }
    if (filters.after && row.timestamp < filters.after) {
        return false;
    }
    if (filters.before && row.timestamp > filters.before) {
        return false;
    }
    return true;
}

function matchesTopicFilters(topic: TopicNode, filters: ConversationsQueryFilters): boolean {
    if (filters.userId && !topic.participants.includes(filters.userId)) {
        return false;
    }
    if (filters.after && topic.startedAt < filters.after) {
        return false;
    }
    if (filters.before && topic.startedAt > filters.before) {
        return false;
    }
    return true;
}

function topicNodeToSearchResult(topic: TopicNode): TopicSearchResult {
    return {
        topicId: topic.id,
        chatId: topic.chatId,
        label: topic.label,
        summary: topic.summary,
        keywords: topic.keywords,
        participants: topic.participants,
        startedAt: topic.startedAt,
        endedAt: topic.endedAt,
        sentiment: topic.sentiment,
        callbackPotential: topic.callbackPotential ?? 0,
        associatedMemories: topic.associatedMemories ?? [],
    };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
    return Math.min(Math.max(value ?? fallback, 1), max);
}

function uniqueStrings(values?: string[]): string[] {
    if (!values?.length) {
        return [];
    }
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}