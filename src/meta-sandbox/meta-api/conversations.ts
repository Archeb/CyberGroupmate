import { getGroupModelKey } from "../../core/chat-id.js";
import type {
    GroupModel,
    IMemoryStoreV2,
    MessageSearchResult,
    PersonIdentity,
    TopicNode,
    TopicSearchResult,
} from "../../memory-v2/index.js";

export interface ConversationsQueryFilters {
    chatIds?: string[];
    /** 人名、别名、username 或 userId。 */
    user?: string;
    /** 精确 userId 过滤。自然语言调用优先用 user。 */
    userId?: string;
    /** 正文关键词。若 user 未传或未解析到，会先匹配 displayName，再匹配正文。 */
    keyword?: string;
    after?: string;
    before?: string;
    limit?: number;
}

export type ConversationMessageResult = MessageSearchResult & {
    chatTitle: string;
    /** 形如 "[早苗群(telegram:-100123)]"。 */
    chatLabel: string;
};

export type ConversationTopicResult = TopicSearchResult & {
    chatTitle: string;
    /** 形如 "[早苗群(telegram:-100123)]"。 */
    chatLabel: string;
};

export interface ResolvedConversationUser {
    userId: string;
    displayName: string;
    username?: string;
    aliases: string[];
}

export interface ConversationsQueryResult {
    messages: ConversationMessageResult[];
    topics: ConversationTopicResult[];
    resolvedUsers: ResolvedConversationUser[];
}

type ConversationsReader = Pick<IMemoryStoreV2,
    "queryMessages" |
    "searchTopics" |
    "getRecentMessages" |
    "getRecentTopics" |
    "getGroupModel" |
    "searchByAlias" |
    "getPersonIdentity" |
    "listGroupModels"
>;

export function createConversationsApi(memory: ConversationsReader) {
    return {
        query: async (filters: ConversationsQueryFilters = {}): Promise<ConversationsQueryResult> => {
            const limit = clampLimit(filters.limit, 20, 100);
            const chatIds = uniqueStrings(filters.chatIds);
            const keyword = filters.keyword?.trim();
            const resolvedUsers = resolveUsers(memory, filters, limit);
            const userIds = resolvedUsers.map((user) => user.userId);
            const fallbackName = filters.user && userIds.length === 0 ? filters.user.trim() : undefined;

            const messages = enrichMessages(memory, queryMessages(memory, {
                filters,
                limit,
                chatIds,
                keyword,
                userIds,
                fallbackName,
            }));
            const topics = enrichTopics(memory, queryTopics(memory, {
                filters,
                limit,
                chatIds,
                keyword,
                userIds,
            }));

            return { messages, topics, resolvedUsers };
        },
    };
}

function resolveUsers(
    memory: ConversationsReader,
    filters: ConversationsQueryFilters,
    limit: number,
): ResolvedConversationUser[] {
    const resolved = new Map<string, PersonIdentity>();
    const explicitUserId = filters.userId?.trim();
    if (explicitUserId) {
        const identity = memory.getPersonIdentity(explicitUserId);
        resolved.set(explicitUserId, identity ?? identityFromUserId(explicitUserId));
    }

    const user = filters.user?.trim();
    if (user) {
        const exact = memory.getPersonIdentity(user);
        if (exact) {
            resolved.set(exact.userId, exact);
        }
        for (const identity of memory.searchByAlias(user, Math.min(limit, 20))) {
            resolved.set(identity.userId, identity);
        }
    }

    return [...resolved.values()]
        .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt))
        .slice(0, Math.min(limit, 20))
        .map((identity) => ({
            userId: identity.userId,
            displayName: identity.displayName,
            username: identity.username,
            aliases: identity.aliases,
        }));
}

function identityFromUserId(userId: string): PersonIdentity {
    const timestamp = new Date(0).toISOString();
    return {
        userId,
        displayName: userId,
        aliases: [],
        totalMessageCount: 0,
        lastSeenAt: timestamp,
        firstSeenAt: timestamp,
        updatedAt: timestamp,
    };
}

function queryMessages(
    memory: ConversationsReader,
    input: {
        filters: ConversationsQueryFilters;
        limit: number;
        chatIds: string[];
        keyword?: string;
        userIds: string[];
        fallbackName?: string;
    },
): MessageSearchResult[] {
    const { filters, limit, chatIds, keyword, userIds, fallbackName } = input;

    if (userIds.length > 0) {
        const rows = queryMessagesWith(memory, {
            chatIds,
            userIds,
            textLike: keyword,
            after: filters.after,
            before: filters.before,
            limit,
        });
        if (rows.length > 0 || !keyword) {
            return rows;
        }
    }

    const displayNameNeedle = fallbackName ?? keyword;
    if (displayNameNeedle) {
        const nameRows = queryMessagesWith(memory, {
            chatIds,
            displayNameLike: displayNameNeedle,
            after: filters.after,
            before: filters.before,
            limit,
        });
        if (nameRows.length > 0) {
            return nameRows;
        }
    }

    if (keyword) {
        return queryMessagesWith(memory, {
            chatIds,
            textLike: keyword,
            after: filters.after,
            before: filters.before,
            limit,
        });
    }

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

    return sortMessages(merged).slice(0, limit);
}

function queryMessagesWith(
    memory: ConversationsReader,
    input: {
        chatIds: string[];
        userIds?: string[];
        displayNameLike?: string;
        textLike?: string;
        after?: string;
        before?: string;
        limit: number;
    },
): MessageSearchResult[] {
    return sortMessages(memory.queryMessages(input)).slice(0, input.limit);
}

function queryTopics(
    memory: ConversationsReader,
    input: {
        filters: ConversationsQueryFilters;
        limit: number;
        chatIds: string[];
        keyword?: string;
        userIds: string[];
    },
): TopicSearchResult[] {
    const { filters, limit, chatIds, keyword, userIds } = input;
    const scopes = chatIds.length > 0 ? chatIds : [undefined];
    const merged = new Map<string, TopicSearchResult>();

    if (keyword) {
        for (const chatId of scopes) {
            const rows = memory.searchTopics(keyword, {
                chatId,
                after: filters.after,
                before: filters.before,
                limit,
            });
            for (const row of rows) {
                if (userIds.length === 0 || userIds.some((userId) => row.participants.includes(userId))) {
                    merged.set(row.topicId, row);
                }
            }
        }
        return sortTopics([...merged.values()]).slice(0, limit);
    }

    const topicChatIds = chatIds.length > 0
        ? chatIds
        : userIds.length > 0
            ? memory.listGroupModels().map((group) => group.chatId)
            : [];

    for (const chatId of topicChatIds) {
        const rows = memory.getRecentTopics(chatId, limit * 2)
            .filter((row) => matchesTopicFilters(row, filters, userIds))
            .map(topicNodeToSearchResult);
        for (const row of rows) {
            merged.set(row.topicId, row);
        }
    }

    return sortTopics([...merged.values()]).slice(0, limit);
}

function enrichMessages(
    memory: ConversationsReader,
    rows: MessageSearchResult[],
): ConversationMessageResult[] {
    return rows.map((row) => {
        const chatTitle = resolveChatTitle(memory, row.chatId);
        return {
            ...row,
            chatTitle,
            chatLabel: formatChatLabel(chatTitle, row.chatId),
        };
    });
}

function enrichTopics(
    memory: ConversationsReader,
    rows: TopicSearchResult[],
): ConversationTopicResult[] {
    return rows.map((row) => {
        const chatTitle = resolveChatTitle(memory, row.chatId);
        return {
            ...row,
            chatTitle,
            chatLabel: formatChatLabel(chatTitle, row.chatId),
        };
    });
}

function resolveChatTitle(memory: ConversationsReader, chatId: string): string {
    const direct = memory.getGroupModel(chatId);
    if (direct?.chatTitle) {
        return direct.chatTitle;
    }

    try {
        const groupKey = getGroupModelKey(chatId);
        const group = groupKey === chatId ? null : memory.getGroupModel(groupKey);
        if (group?.chatTitle) {
            return group.chatTitle;
        }
    } catch {
        // Non-composite test ids are allowed.
    }

    return chatId;
}

function formatChatLabel(chatTitle: string, chatId: string): string {
    return `[${chatTitle}(${chatId})]`;
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

function matchesTopicFilters(topic: TopicNode, filters: ConversationsQueryFilters, userIds: string[]): boolean {
    const participantFilters = userIds.length > 0 ? userIds : filters.userId ? [filters.userId] : [];
    if (participantFilters.length > 0 && !participantFilters.some((userId) => topic.participants.includes(userId))) {
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

function sortMessages(rows: MessageSearchResult[]): MessageSearchResult[] {
    return rows.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

function sortTopics(rows: TopicSearchResult[]): TopicSearchResult[] {
    return rows.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
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
