/**
 * telegram.d.ts — Telegram 平台 API
 *
 * 这是系统注入的 Telegram host proxy 的接口子集。
 * 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。
 * 平台连接与消息监听由宿主侧官方 adapter 管理。
 */

declare const telegram: TelegramClient;

// ═══════════════════════════════════════════
//  基础实体 (Basic Entities)
// ═══════════════════════════════════════════

/** 用户/频道/群组通用对等实体 */
interface Peer {
    id: number;
    displayName?: string;
    title?: string;
    username?: string;
}

interface User extends Peer {
    firstName: string;
    lastName?: string;
    isBot: boolean;
}

interface Chat {
    id: number;
    title?: string;
    username?: string;
    type: "private" | "group" | "supergroup" | "channel";
}

interface Message {
    id: number;
    text: string;
    date: Date;
    chat: Chat;
    sender: Peer;
    isMention: boolean;
    replyToMessage?: { id: number } | null;
    media?: unknown;
    /** 结构化媒体元信息（由 adapter 提取），可直接判断类型 */
    mediaInfo?: MediaInfo;
}

/** adapter 提取的结构化媒体元数据 */
interface MediaInfo {
    type: "photo" | "sticker" | "video" | "document" | "animation" | "other";
    /** TDLib/Bot API 兼容的 File ID，可传给 downloadMedia */
    fileId?: string;
    /** 全局唯一文件标识符 */
    uniqueFileId?: string;
    emoji?: string;
    mimeType?: string;
    fileName?: string;
    width?: number;
    height?: number;
    fileSize?: number;
}

interface Dialog {
    peer: Peer;
    lastMessage?: Message;
    unreadCount: number;
}

// ═══════════════════════════════════════════
//  扩展实体 (Extended Entities)
// ═══════════════════════════════════════════

/** 完整用户画像（通过 getFullUser 主动拉取） */
interface FullUser extends User {
    /** 用户个人简介 */
    bio?: string;
    /** 与当前用户的共同群组数量 */
    commonChatsCount?: number;
}

/** 完整群组/频道画像（通过 getFullChat 主动拉取） */
interface FullChat extends Chat {
    /** 群组/频道的描述文本 */
    about?: string;
    /** 成员数量 */
    membersCount?: number;
    /** 当前在线成员数量 */
    onlineCount?: number;
    /** 是否开启了论坛（话题板块）模式 */
    isForum?: boolean;
}

/** 论坛话题板块（通过 getForumTopics 主动拉取） */
interface ForumTopic {
    id: number;
    title: string;
    isClosed: boolean;
    isPinned: boolean;
    creatorId: number;
    unreadCount: number;
}

// ─── 投票 (Poll) ───

/** 投票选项 */
interface PollAnswer {
    /** 选项文本 */
    text: string;
    /** 当前选项的投票人数 */
    voterCount: number;
    /** 当前用户是否投了此选项 */
    chosen: boolean;
    /** 此选项是否为正确答案（仅 quiz 模式） */
    correct: boolean;
}

/** 投票实体（通过 getPollResults 拉取，或作为 Message.media 出现） */
interface Poll {
    type: "poll";
    id: string;
    question: string;
    answers: PollAnswer[];
    /** 总投票人数 */
    totalVoters: number;
    /** 投票是否已关闭 */
    isClosed: boolean;
    /** 是否为公开投票（可查看投票人） */
    isPublic: boolean;
    /** 是否为测验模式 */
    isQuiz: boolean;
    /** 是否允许多选 */
    isMultiple: boolean;
    /** 测验模式的答案解释（答题后可见） */
    solution?: string;
}

// ─── 表态 (Reactions) ───

/** 单个表情及其计数 */
interface Reaction {
    emoji: string;
    count: number;
}

// ─── 下载结果 ───

/** downloadMedia 返回的结果 */
interface DownloadedMedia {
    /** base64 编码的文件数据 */
    buffer: string;
    /** 文件大小(字节) */
    size: number;
}

// ═══════════════════════════════════════════
//  操作选项 (Options)
// ═══════════════════════════════════════════

/** 发送消息的通用选项 */
interface SendMessageOptions {
    /** 回复指定消息 ID（也可用于指定 Forum Topic ID） */
    replyTo?: number;
    /** 不触发推送铃声 */
    silent?: boolean;
}

/** 发起投票的选项 */
interface SendPollOptions extends SendMessageOptions {
    /** 是否匿名（默认 true） */
    isAnonymous?: boolean;
    /** 'regular' 普通投票 | 'quiz' 测验模式 */
    type?: "regular" | "quiz";
    /** 是否允许多选（仅 type='regular' 有效） */
    allowsMultipleAnswers?: boolean;
    /** 正确答案的索引（仅 type='quiz' 有效，从 0 开始） */
    correctOptionId?: number;
    /** 答错后的解释说明（仅 type='quiz' 有效） */
    explanation?: string;
}

// ═══════════════════════════════════════════
//  事件发射器
// ═══════════════════════════════════════════

interface Emitter<T> {
    add(handler: (event: T) => void | Promise<void>): void;
    remove(handler: (event: T) => void | Promise<void>): void;
    once(handler: (event: T) => void | Promise<void>): void;
    clear(): void;
}

// ═══════════════════════════════════════════
//  TelegramClient 代理接口
// ═══════════════════════════════════════════

/** 系统注入的 TelegramClient 代理接口。 */
interface TelegramClient {
    // ─── 发送与交互 ───
    sendText(chatId: number | string, text: string, opts?: SendMessageOptions): Promise<Message>;
    /**
     * 发送媒体消息。支持 URL 和本地文件路径。
     * @example sendMedia(chatId, { type: 'photo', file: 'https://example.com/img.jpg', caption: '看看这个' })
     * @example sendMedia(chatId, { type: 'photo', file: '/path/to/local/image.jpg' })
     */
    sendMedia(chatId: number | string, media: string | { type: 'photo' | 'video' | 'document' | 'audio' | 'auto'; file: string; caption?: string; fileName?: string }, opts?: SendMessageOptions): Promise<Message>;
    /** 发送磁盘文件到聊天（通过绝对路径）。host 侧读取文件并上传。始终作为文件/文档发送。 */
    sendFile(chatId: number | string, filePath: string, opts?: { replyTo?: number; caption?: string; fileName?: string; mimeType?: string }): Promise<Message>;
    /**
     * 发送贴纸。通过 uniqueFileId 引用本地已缓存的贴纸文件。
     * @example sendSticker(chatId, 'AgADAgATxxxxxx')
     */
    sendSticker(chatId: number | string, uniqueFileId: string, opts?: { replyTo?: number }): Promise<Message>;
    /**
     * 发送媒体相册（多张图片/视频合并为一组）。
     * 第一个媒体项的 caption 将作为整组的文案。
     * @example sendMediaGroup(chatId, [
     *   { type: 'photo', file: 'https://example.com/1.jpg', caption: '相册标题' },
     *   { type: 'photo', file: 'https://example.com/2.jpg' },
     * ])
     */
    sendMediaGroup(chatId: number | string, medias: Array<{ type: 'photo' | 'video' | 'document' | 'audio'; file: string; caption?: string; fileName?: string }>, opts?: SendMessageOptions): Promise<Message[]>;
    /**
     * 发起投票或测验。
     * @param question 投票标题
     * @param options 候选选项文本列表（2-10 个）
     * @example sendPoll(chatId, '今晚吃什么？', ['火锅', '烧烤', '外卖'], { isAnonymous: false })
     * @example sendPoll(chatId, 'JS 中 typeof null 是？', ['object', 'null', 'undefined'], { type: 'quiz', correctOptionId: 0 })
     */
    sendPoll(chatId: number | string, question: string, options: string[], opts?: SendPollOptions): Promise<Message>;
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
    editMessage(chatId: number | string, messageId: number, text: string): Promise<Message>;
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
    getMe(): Promise<User>;
    getChat(chatId: number | string): Promise<Chat>;
    getUser(userId: number | string): Promise<User>;
    /** 获取最近的对话列表（包含 peer、最后一条消息、未读数） */
    getDialogs(opts?: { limit?: number }): Promise<Dialog[]>;
    /**
     * 获取用户的完整资料（包含个人简介 bio 等）。
     * @example const full = await telegram.getFullUser(userId); console.log(full.bio);
     */
    getFullUser(userId: number | string): Promise<FullUser>;
    /**
     * 获取群组/频道的完整资料（包含群描述 about、成员数等）。
     * @example const full = await telegram.getFullChat(chatId); console.log(full.about, full.isForum);
     */
    getFullChat(chatId: number | string): Promise<FullChat>;
    // [USERBOT_ONLY_BEGIN]
    getChatMembers(chatId: number | string, opts?: { limit?: number }): Promise<Peer[]>;
    getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Message[]>;
    /**
     * 按消息 ID 精确获取一条或多条消息。（在别人回复或者提及某消息但是你看不见的时候，善用该函数爬楼获取上下文）
     * @example const msgs = await telegram.getMessages(chatId, [100, 101, 102]);
     */
    getMessages(chatId: number | string, messageIds: number[]): Promise<(Message | null)[]>;
    /**
     * 在群组内搜索消息。（可主动利用该函数获取视野外上下文信息）
     * @example const results = await telegram.searchMessages(chatId, '关键词', { limit: 20 });
     */
    searchMessages(chatId: number | string, query: string, opts?: { limit?: number }): Promise<Message[]>;
    /**
     * 获取指定群组的论坛板块（话题）列表。要求该群组已开启 Forum 模式。
     * @example const topics = await telegram.getForumTopics(chatId);
     */
    getForumTopics(chatId: number | string, opts?: { limit?: number }): Promise<ForumTopic[]>;
    /**
     * 主动拉取某条投票消息的最新计票结果。
     * @example const poll = await telegram.getPollResults(chatId, pollMsgId);
     */
    getPollResults(chatId: number | string, messageId: number): Promise<Poll | null>;
    /**
     * 主动拉取某条消息的表态（Reaction）汇总数据。
     * @example const reactions = await telegram.getMessageReactions(chatId, [msgId]);
     */
    getMessageReactions(chatId: number | string, messageIds: number[]): Promise<Reaction[]>;
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
    downloadMedia(fileId: string, chatId?: number | string, messageId?: number, uniqueFileId?: string): Promise<DownloadedMedia>;

    // ─── 迭代器 (for await) ───
    iterHistory(chatId: number | string, opts?: { limit?: number }): AsyncIterable<Message>;
    iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>;

    // ─── 群组管理 ───
    /** 加入一个群聊或频道 */
    joinChat(chatId: number | string): Promise<void>;
    /** 退出一个群聊或频道 */
    leaveChat(chatId: number | string): Promise<void>;

    // ─── 状态操作 ───
    readHistory(chatId: number | string): Promise<void>;
    // [USERBOT_ONLY_END]
    sendTyping(chatId: number | string): Promise<void>;
}
