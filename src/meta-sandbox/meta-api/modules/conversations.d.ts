/**
 * conversations — Meta 跨群检索 API。
 *
 * 用于在 MetaSandbox 中检索所有聊天的消息和话题。读权限无界限；结果带 chatLabel，方便输出给模型继续决策。
 */

interface ConversationsQueryFilters {
    /** 限定群组 ID；空则搜索全部可见群。 */
    chatIds?: string[];
    /** 人名、别名、username 或 userId，会先解析已知身份。 */
    user?: string;
    /** 精确限定发言者 ID，如 "telegram:123456"。 */
    userId?: string;
    /** 正文关键词；无 user 或 user 未解析时会先匹配 displayName，再匹配正文。 */
    keyword?: string;
    /** ISO 时间下限。 */
    after?: string;
    /** ISO 时间上限。 */
    before?: string;
    /** 结果数上限，默认 20，最大 100。 */
    limit?: number;
}

interface ConversationMessageResult {
    messageId: string;
    chatId: string;
    chatTitle: string;
    /** 形如 "[群名(telegram:-100123)]"，打印时可直接使用。 */
    chatLabel: string;
    userId: string;
    displayName: string;
    content: string;
    timestamp: string;
}

interface ConversationTopicResult {
    topicId: string;
    chatId: string;
    chatTitle: string;
    /** 形如 "[群名(telegram:-100123)]"，打印时可直接使用。 */
    chatLabel: string;
    label: string;
    summary: string;
    keywords: string[];
    participants: string[];
    startedAt: string;
    endedAt?: string | null;
    sentiment?: string;
    callbackPotential?: number;
}

interface ResolvedConversationUser {
    userId: string;
    displayName: string;
    username?: string;
    aliases: string[];
}

interface ConversationsQueryResult {
    messages: ConversationMessageResult[];
    topics: ConversationTopicResult[];
    resolvedUsers: ResolvedConversationUser[];
}

interface ConversationsMessagesOptions {
    /** 返回条数，默认 50，最大 99。 */
    limit?: number;
    /** 上一页返回的游标；继续往更早消息滚动时原样传回。 */
    cursor?: string;
    /** ISO 时间上限；cursor 未传时生效。 */
    before?: string;
    /** ISO 时间下限。 */
    after?: string;
}

interface ConversationsMessagesResult {
    chatId: string;
    chatTitle: string;
    /** 形如 "[群名(compositeId)]"，打印时可直接使用。 */
    chatLabel: string;
    messages: ConversationMessageResult[];
    nextCursor?: string;
}

interface ConversationsInboxOptions {
    /** 返回条数，默认 20，最大 100。 */
    limit?: number;
    /** 上一页返回的游标；不需要理解其内容，原样传回即可。 */
    cursor?: string;
    /** 未读聊天置顶，默认 true。 */
    unreadFirst?: boolean;
    /** 限定聊天 ID。 */
    chatIds?: string[];
    /** 是否包含没有消息的已知聊天，默认 false。 */
    includeEmpty?: boolean;
}

interface ConversationInboxMessage {
    messageId: string;
    chatId: string;
    userId: string;
    displayName: string;
    content: string;
    timestamp: string;
}

interface ConversationInboxItem {
    chatId: string;
    /** composite chatId 的平台前缀，例如 "telegram" / "discord" / "onebot"。 */
    platform?: string;
    chatTitle: string;
    /** 形如 "[群名(compositeId)]"，打印时可直接使用。 */
    chatLabel: string;
    isDirectMessage?: boolean;
    latestMessage?: ConversationInboxMessage;
    /** latestMessage 晚于 lastAttendedAt，或从未 attend 但已有消息。 */
    unread: boolean;
    /** 最近未读消息数；最多精确到最近 100 条。 */
    unreadCount: number;
    lastAttendedAt: string | null;
    lastActiveAt?: string;
    queueSize: number;
    isProcessing: boolean;
    stickinessLevel: string;
}

interface ConversationsInboxResult {
    items: ConversationInboxItem[];
    total: number;
    unreadTotal: number;
    nextCursor?: string;
}

declare const conversations: {
    /**
     * 打开 Meta 视角的消息列表。
     *
     * 默认把未读聊天放在最前面；未读的含义是该聊天最新消息晚于 lastAttendedAt，
     * 或者这个聊天从未被 attend 但已经有消息。nextCursor 可用于继续往前滚动。
     *
     * @param options 可选分页、过滤和排序选项。
     * @returns 聊天列表、最新消息预览和未读状态。
     * @example
     * let page = await conversations.inbox({ limit: 20 });
     * for (const item of page.items) {
     *   const badge = item.unread ? `unread:${item.unreadCount}` : "read";
     *   console.log(`${badge} ${item.chatLabel} ${item.latestMessage?.displayName}: ${item.latestMessage?.content}`);
     * }
     * if (page.nextCursor) {
     *   page = await conversations.inbox({ cursor: page.nextCursor, limit: 20 });
     * }
     */
    inbox(options?: ConversationsInboxOptions): Promise<ConversationsInboxResult>;

    /**
     * 读取单个聊天的消息时间线。
     *
     * 默认返回最新消息页；如果返回 nextCursor，把它传给下一次调用即可继续往更早消息滚动。
     * 这是“点进 inbox 某个聊天看历史”的入口，不承担跨群关键词搜索。
     *
     * @param chatId 目标 composite chatId。
     * @param options 可选分页和时间过滤。
     * @returns 聊天标题、消息页和下一页游标。
     * @example
     * let page = await conversations.messages("telegram:-1001234567890", { limit: 50 });
     * console.log(page.messages.map(m => `${m.displayName}: ${m.content}`));
     * if (page.nextCursor) {
     *   page = await conversations.messages("telegram:-1001234567890", {
     *     cursor: page.nextCursor,
     *     limit: 50
     *   });
     * }
     */
    messages(chatId: string, options?: ConversationsMessagesOptions): Promise<ConversationsMessagesResult>;

    /**
     * 跨群检索消息与话题。
     *
     * chatLabel 已格式化为 "[群名(compositeId)]"，打印时直接使用它，例如 `${m.chatLabel} ${m.displayName}: ${m.content}`。
     *
     * @param filters 检索条件；不传 chatIds 时搜索全部可见群。
     * @returns 匹配的消息、话题和解析出的用户身份。
     * @example
     * const conv = await conversations.query({
     *   chatIds: ["telegram:-1001234567890"],
     *   keyword: "API 网关 技术方案",
     *   limit: 10
     * });
     * console.log("messages:", conv.messages.length, "topics:", conv.topics.length);
     */
    query(filters?: ConversationsQueryFilters): Promise<ConversationsQueryResult>;
};
