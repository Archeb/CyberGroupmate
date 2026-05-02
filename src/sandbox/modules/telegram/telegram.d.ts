/**
 * telegram.d.ts — Telegram 平台 API
 *
 * 这是系统注入的 Telegram host proxy 的接口子集。
 * 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。
 * 平台连接与消息监听由宿主侧官方 adapter 管理。
 */

declare const telegram: {
    // ─── 发送与交互 ───
    /** 发送普通文本消息 */
    sendText(chatId: number | string, text: string, opts?: { replyTo?: number; silent?: boolean; }): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 发送媒体消息。支持 URL 和本地文件路径（支持绝对路径或基于 cwd 工作区的相对路径）。
     * @example sendMedia(chatId, { type: 'photo', file: 'https://example.com/img.jpg', caption: '看看这个' })
     * @example sendMedia(chatId, { type: 'photo', file: 'ip_skk_moe.png' }) // 自动基于 process.cwd() 解析
     */
    sendMedia(chatId: number | string, media: string | { type: 'photo' | 'video' | 'document' | 'audio' | 'auto'; file: string; caption?: string; fileName?: string }, opts?: { replyTo?: number; silent?: boolean; }): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /** 发送磁盘文件到聊天。支持绝对路径或基于 cwd 的相对路径。host 侧读取文件并上传。始终作为文件/文档发送。 */
    sendFile(chatId: number | string, filePath: string, opts?: { replyTo?: number; caption?: string; fileName?: string; mimeType?: string }): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 发送贴纸。通过 uniqueFileId 引用本地已缓存的贴纸文件。
     * @example sendSticker(chatId, 'AgADAgATxxxxxx')
     */
    sendSticker(chatId: number | string, uniqueFileId: string, opts?: { replyTo?: number }): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 发送媒体相册（多张图片/视频合并为一组）。
     * 第一个媒体项的 caption 将作为整组的文案。
     * @example sendMediaGroup(chatId, [
     *   { type: 'photo', file: 'https://example.com/1.jpg', caption: '相册标题' },
     *   { type: 'photo', file: 'https://example.com/2.jpg' },
     * ])
     */
    sendMediaGroup(chatId: number | string, medias: Array<{ type: 'photo' | 'video' | 'document' | 'audio'; file: string; caption?: string; fileName?: string }>, opts?: { replyTo?: number; silent?: boolean; }): Promise<Array<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>>;
    /**
     * 发起投票或测验。
     * @param question 投票标题
     * @param options 候选选项文本列表（2-10 个）
     * @example sendPoll(chatId, '今晚吃什么？', ['火锅', '烧烤', '外卖'], { isAnonymous: false })
     * @example sendPoll(chatId, 'JS 中 typeof null 是？', ['object', 'null', 'undefined'], { type: 'quiz', correctOptionId: 0 })
     */
    sendPoll(chatId: number | string, question: string, options: string[], opts?: { replyTo?: number; silent?: boolean; isAnonymous?: boolean; type?: "regular" | "quiz"; allowsMultipleAnswers?: boolean; correctOptionId?: number; explanation?: string; }): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 对消息发送表情表态。传 null 以撤销表态。
     * @example sendReaction(chatId, msgId, '👍')
     * @example sendReaction(chatId, msgId, null) // 撤销
     */
    sendReaction(chatId: number | string, messageId: number, emoji: string | null): Promise<void>;
    /**
     * 编辑已发送的消息文本。
     * @example editMessage(chatId, msgId, '已更正：新文本内容')
     */
    editMessage(chatId: number | string, messageId: number, text: string): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 删除一条或多条消息。
     * @example deleteMessages(chatId, [msgId1, msgId2])
     */
    deleteMessages(chatId: number | string, messageIds: number[]): Promise<void>;
    /** 置顶一条消息 */
    pinMessage(chatId: number | string, messageId: number, opts?: { silent?: boolean }): Promise<void>;
    /** 取消置顶一条消息 */
    unpinMessage(chatId: number | string, messageId: number): Promise<void>;

    // ─── 信息获取 ───
    /** 获取当前登录机器人的基础信息 */
    getMe(): Promise<{ id: number; displayName?: string; title?: string; username?: string; firstName: string; lastName?: string; isBot: boolean; }>;
    /** 精确获取指定会话的基础信息 */
    getChat(chatId: number | string): Promise<{ id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }>;
    /** 精确获取指定用户的基础信息 */
    getUser(userId: number | string): Promise<{ id: number; displayName?: string; title?: string; username?: string; firstName: string; lastName?: string; isBot: boolean; }>;
    /** 获取最近的对话列表（包含 peer、最后一条消息、未读数） */
    getDialogs(opts?: { limit?: number }): Promise<Array<{ peer: { id: number; displayName?: string; title?: string; username?: string; }; lastMessage?: { id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }; unreadCount: number; }>>;
    /**
     * 获取用户的完整资料（包含个人简介 bio 等）。
     * @example const full = await telegram.getFullUser(userId); console.log(full.bio);
     */
    getFullUser(userId: number | string): Promise<{ id: number; displayName?: string; title?: string; username?: string; firstName: string; lastName?: string; isBot: boolean; bio?: string; commonChatsCount?: number; }>;
    /**
     * 获取群组/频道的完整资料（包含群描述 about、成员数等）。
     * @example const full = await telegram.getFullChat(chatId); console.log(full.about, full.isForum);
     */
    getFullChat(chatId: number | string): Promise<{ id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; about?: string; membersCount?: number; onlineCount?: number; isForum?: boolean; }>;
    // [USERBOT_ONLY_BEGIN]
    /** 分页拉取群组成员列表 */
    getChatMembers(chatId: number | string, opts?: { limit?: number }): Promise<Array<{ id: number; displayName?: string; title?: string; username?: string; }>>;
    /** 拉取指定会话的历史消息（一次性返回列表） */
    getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Array<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>>;
    /**
     * 按消息 ID 精确获取一条或多条消息。（在别人回复或者提及某消息但是你看不见的时候，善用该函数爬楼获取上下文）
     * @example const msgs = await telegram.getMessages(chatId, [100, 101, 102]);
     */
    getMessages(chatId: number | string, messageIds: number[]): Promise<Array<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; } | null>>;
    /**
     * 在群组内搜索消息。（可主动利用该函数获取视野外上下文信息）
     * @example const results = await telegram.searchMessages(chatId, '关键词', { limit: 20 });
     */
    searchMessages(chatId: number | string, query: string, opts?: { limit?: number }): Promise<Array<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>>;
    /**
     * 获取指定群组的论坛板块（话题）列表。要求该群组已开启 Forum 模式。
     * @example const topics = await telegram.getForumTopics(chatId);
     */
    getForumTopics(chatId: number | string, opts?: { limit?: number }): Promise<Array<{ id: number; title: string; isClosed: boolean; isPinned: boolean; creatorId: number; unreadCount: number; }>>;
    /**
     * 主动拉取某条投票消息的最新计票结果。
     * @example const poll = await telegram.getPollResults(chatId, pollMsgId);
     */
    getPollResults(chatId: number | string, messageId: number): Promise<{ type: "poll"; id: string; question: string; answers: Array<{ text: string; voterCount: number; chosen: boolean; correct: boolean; }>; totalVoters: number; isClosed: boolean; isPublic: boolean; isQuiz: boolean; isMultiple: boolean; solution?: string; } | null>;
    /**
     * 主动拉取某条消息的表态（Reaction）汇总数据。
     * @example const reactions = await telegram.getMessageReactions(chatId, [msgId]);
     */
    getMessageReactions(chatId: number | string, messageIds: number[]): Promise<Array<{ emoji: string; count: number; }>>;
    /**
     * 下载媒体文件的二进制数据。返回 base64 编码的 buffer 和文件大小。
     * 需要传入通过 mediaInfo.fileId 获取的文件标识符。
     * @param fileId TDLib/Bot API 兼容的文件 ID
     * @param chatId  可选，用于 file reference 过期时自动 refetch
     * @param messageId 可选，同上
     * @param uniqueFileId 可选，用于缓存命中
     * @example
     * const msg = messages[0];
     * if (msg.mediaInfo?.fileId) {
     *   const data = await telegram.downloadMedia(msg.mediaInfo.fileId, chatId, msg.id, msg.mediaInfo.uniqueFileId);
     *   // data.buffer 是 base64 编码的文件内容, data.size 是字节数
     * }
     */
    downloadMedia(fileId: string, chatId?: number | string, messageId?: number, uniqueFileId?: string): Promise<{ buffer: string; size: number; }>;

    // ─── 迭代器 (for await) ───
    /** 以异步迭代器方式遍历历史消息，用于深入流式检索 */
    iterHistory(chatId: number | string, opts?: { limit?: number }): AsyncIterable<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /** 以异步迭代器方式遍历最近的对话列表 */
    iterDialogs(opts?: { limit?: number }): AsyncIterable<{ peer: { id: number; displayName?: string; title?: string; username?: string; }; lastMessage?: { id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }; unreadCount: number; }>;

    // ─── 群组管理 ───
    /** 加入一个群聊或频道 */
    joinChat(chatId: number | string): Promise<void>;
    /** 退出一个群聊或频道 */
    leaveChat(chatId: number | string): Promise<void>;

    // ─── 状态操作 ───
    /** 将指定会话的所有未读消息标记为已读 */
    readHistory(chatId: number | string): Promise<void>;
    // [USERBOT_ONLY_END]
    /** 触发短暂的 `Typing` 正在输入反馈状态 */
    sendTyping(chatId: number | string): Promise<void>;
};
