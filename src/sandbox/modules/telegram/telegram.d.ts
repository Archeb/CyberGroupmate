/**
 * telegram.d.ts — Telegram 平台 API
 *
 * 这是系统注入的 Telegram host proxy 的接口子集。
 * 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。
 * 平台连接与消息监听由宿主侧官方 adapter 管理。
 */

type TelegramMessage = {
    id: number;
    text: string;
    date: Date;
    chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; };
    sender: { id: number; displayName?: string; title?: string; username?: string; } | null;
    isMention: boolean;
    replyToMessage?: { id: number } | null;
    media?: unknown;
    mediaInfo?: {
        type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other";
        rawType?: string;
        fileId?: string;
        uniqueFileId?: string;
        emoji?: string;
        mimeType?: string;
        fileName?: string;
        width?: number;
        height?: number;
        fileSize?: number;
        filePath?: string;
        downloadStatus?: "downloaded" | "cached" | "too_large" | "failed";
        downloadError?: string;
    };
    forwardFrom?: string;
    forwardFromUrl?: string;
};

declare const telegram: {
    // ─── 按需能力指南 ───
    /** 加载 inline bot 使用指南。用于像 Telegram 客户端输入 `@bot query` 一样查询 inline bot 并发送某个结果；调用本方法只披露指南，不会执行实际发送。 */
    useInlineBot(): Promise<string>;
    /** 加载 Stories 使用指南。用于读取、发布、编辑、删除、置顶 Story，以及查看互动和观看者；调用本方法只披露指南，不会执行实际 Story 操作。 */
    useStories(): Promise<string>;
    /** 加载投票流程指南。用于创建投票/测验、读取投票结果等成组流程；调用本方法只披露相关 API，不会发起投票。 */
    usePolls(): Promise<string>;
    /** 加载 peer 解析指南。用于处理 PEER_ID_INVALID、access hash 缺失、裸数字 user id 无法发送等问题；调用本方法只披露排障流程。 */
    usePeerResolution(): Promise<string>;
    /** 加载历史消息检索指南。用于主动爬楼、搜索视野外上下文或流式遍历历史；调用本方法只披露检索 API 和使用流程。 */
    useMessageSearch(): Promise<string>;
    /** 加载账号资料指南。用于修改 bio、姓名、用户名、头像、生日、emoji status、close friends 等个人资料；调用本方法只披露指南，不直接修改账号。 */
    useAccountProfile(): Promise<string>;
    /** 加载高级消息指南。用于复制、评论、引用、定时消息、网页预览、reaction 用户和消息关联查询等成组能力；调用本方法只披露指南。 */
    useAdvancedMessages(): Promise<string>;
    /** 加载群组/频道管理指南。用于建群建频道、成员权限、管理员、标题描述头像、慢速模式和内容保护等管理操作；调用本方法只披露指南。 */
    useChatAdministration(): Promise<string>;
    /** 加载邀请链接与入群请求指南。用于创建/编辑/撤销邀请链接、查看邀请成员、处理 join request 或预览邀请链接；调用本方法只披露指南。 */
    useInvites(): Promise<string>;
    /** 加载论坛话题指南。用于确认群是否开启 Forum、列出话题或定位 topic id；调用本方法只披露相关 API。 */
    useForumTopics(): Promise<string>;
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
     * 转发一条或多条已有消息到目标聊天，用于复读、搬运或保留原消息来源。
     * 支持隐藏原作者/原 caption；目标聊天放第一个参数，便于遵守绑定聊天写限制。
     * @param toChatId 目标聊天 ID、username、"me" 或 "self"
     * @param fromChatId 原消息所在聊天 ID、username、"me" 或 "self"
     * @param messageIds 要转发的消息 ID；数组最多 100 条
     * @example const sent = await telegram.forwardMessage(chatId, chatId, msg.id);
     * @example await telegram.forwardMessage(targetChatId, sourceChatId, [101, 102], { silent: true, noAuthor: true });
     */
    forwardMessage(toChatId: number | string, fromChatId: number | string, messageIds: number | number[], opts?: { silent?: boolean; schedule?: Date | number | string; clearDraft?: boolean; noAuthor?: boolean; noCaption?: boolean; forbidForwards?: boolean; toThreadId?: number; sendAs?: number | string; videoTimestamp?: number; }): Promise<TelegramMessage | TelegramMessage[]>;
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
    /**
     * 按消息 ID 精确获取一条或多条消息。（在别人回复或者提及某消息但是你看不见的时候，善用该函数爬楼获取上下文）
     * @example const msgs = await telegram.getMessages(chatId, [100, 101, 102]);
     */
    getMessages(chatId: number | string, messageIds: number[]): Promise<Array<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; } | null>>;
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
