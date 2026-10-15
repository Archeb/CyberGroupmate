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

type TelegramMtcuteRef = {
    /** Host-side mtcute object reference. Pass this object back to telegram mtcute methods to preserve native object identity. */
    __mtcuteRef: string;
    __mtcuteType?: string;
    [key: string]: unknown;
};

type TelegramInputText = string | {
    text: string;
    entities?: Array<Record<string, unknown>>;
};

interface TelegramCommonSendParams {
    replyTo?: number | TelegramMessage | TelegramMtcuteRef;
    replyToTodoItem?: number;
    replyToPollOption?: Uint8Array;
    toMonoforumPeer?: number | string | TelegramMtcuteRef;
    mustReply?: boolean;
    commentTo?: number | TelegramMessage | TelegramMtcuteRef;
    replyToStory?: number;
    quote?: TelegramInputText;
    quoteOffset?: number;
    silent?: boolean;
    schedule?: Date | number | "online";
    clearDraft?: boolean;
    forbidForwards?: boolean;
    sendAs?: number | string | TelegramMtcuteRef;
    quickReply?: number | string;
    shouldDispatch?: true;
    businessConnectionId?: string;
    allowPaidFloodskip?: boolean;
    allowPaidMessages?: string | number | Record<string, unknown>;
    effect?: string | number | Record<string, unknown>;
    abortSignal?: AbortSignal;
    [key: string]: unknown;
}

type TelegramSendTextParams = TelegramCommonSendParams & {
    randomId?: string | number | Record<string, unknown>;
    replyMarkup?: unknown;
    disableWebPreview?: boolean;
    invertMedia?: boolean;
};

type TelegramSendMediaParams = TelegramCommonSendParams & {
    randomId?: string | number | Record<string, unknown>;
    replyMarkup?: unknown;
    invert?: boolean;
    caption?: TelegramInputText;
    progressCallback?: (uploaded: number, total: number) => void;
};

declare const telegram: {
    /** mtcute 新增 high-level method 的动态入口：telegram.methodName(...args)。会话生命周期和裸 call 等危险入口会被 host policy 拦截。 */
    [mtcuteMethod: string]: any;

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
    /** 加载媒体下载指南。包含：1) 用 fs.writeFileBinary() 正确保存 base64 buffer 的方法；2) GIF/短视频抽帧分析时避免 60s 超时的策略（默认 4-6 帧、复用已有文件、先发进度）。遇到 downloadMedia 或 GIF 分析相关问题时调用。 */
    useMediaDownload(): Promise<string>;
    // ─── 发送与交互 ───
    /** mtcute 原生 sendText(chatId, text, params?)。text 支持 string 或 { text, entities }，params 保留 mtcute CommonSendParams 及新增字段。 */
    sendText(chatId: number | string, text: TelegramInputText, params?: TelegramSendTextParams): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 发送媒体消息。支持 URL 和本地文件路径（支持绝对路径或基于 cwd 工作区的相对路径）。
     * @example sendMedia(chatId, { type: 'photo', file: 'https://example.com/img.jpg', caption: '看看这个' })
     * @example sendMedia(chatId, { type: 'photo', file: 'ip_skk_moe.png' }) // 自动基于 process.cwd() 解析
     */
    sendMedia(chatId: number | string, media: string | { type?: string; file?: string; media?: unknown; caption?: TelegramInputText; fileName?: string; [key: string]: unknown }, params?: TelegramSendMediaParams): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /** 发送磁盘文件到聊天。支持绝对路径或基于 cwd 的相对路径。host 侧读取文件并上传。始终作为文件/文档发送。 */
    sendFile(chatId: number | string, filePath: string, opts?: { replyTo?: number; caption?: string; fileName?: string; mimeType?: string }): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 发送贴纸。通过 uniqueFileId 引用本地已缓存的贴纸文件。
     * 受 vision.sticker_sending_mode 策略约束：allow_listed 模式下仅允许发送允许列表（Dashboard 已启用）中的贴纸，
     * 被拦截时应改用 searchStickers 查找可发送的贴纸。
     * @example sendSticker(chatId, 'AgADAgATxxxxxx')
     */
    sendSticker(chatId: number | string, uniqueFileId: string, opts?: { replyTo?: number }): Promise<{ id: number; text: string; date: Date; chat: { id: number; title?: string; username?: string; type: "private" | "group" | "supergroup" | "channel"; }; sender: { id: number; displayName?: string; title?: string; username?: string; }; isMention: boolean; replyToMessage?: { id: number } | null; media?: unknown; mediaInfo?: { type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other"; rawType?: string; fileId?: string; uniqueFileId?: string; emoji?: string; mimeType?: string; fileName?: string; width?: number; height?: number; fileSize?: number; filePath?: string; downloadStatus?: "downloaded" | "cached" | "too_large" | "failed"; downloadError?: string; }; }>;
    /**
     * 搜索贴纸库中当前策略允许发送的贴纸（allow_listed 模式仅返回已启用的贴纸；disallow_all 返回空）。
     * 按贴纸关联 emoji 或描述关键词过滤（多个关键词为 AND 关系）；不传条件时返回最新的可发送贴纸。
     * 返回的 uniqueFileId 可直接用于 sendSticker。
     * @example searchStickers({ emoji: '😂', limit: 8 })
     * @example searchStickers({ keywords: '猫 开心' })
     */
    searchStickers(query?: { emoji?: string | string[]; keywords?: string | string[]; limit?: number }): Promise<Array<{ uniqueFileId: string; description: string; emojis: string[]; enabled: boolean }>>;
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
     * 优先传入 msg.mediaInfo.fileId，不要把整个 msg.mediaInfo 当作 location 传入；也可以直接传 mtcute 返回的 Photo/FileLocation 等带 __mtcuteRef 的对象。
     * @param location TDLib/Bot API 兼容 file_id、mtcute FileDownloadLocation、或带 __mtcuteRef 的 mtcute 对象。通常使用 msg.mediaInfo.fileId。
     * @param chatId  可选，用于 file reference 过期时自动 refetch
     * @param messageId 可选，同上
     * @param uniqueFileId 可选，用于缓存命中
     *
     * ⚠️ **保存到磁盘必须用 `fs.writeFileBinary()`，不能用 `fs.writeFile()`。**
     * `data.buffer` 是 base64 字符串；`fs.writeFile` 会把它当 UTF-8 文本写入导致文件损坏。
     *
     * @example
     * // ✅ 正确：下载并保存为可用的图片文件
     * const msg = messages[0];
     * if (msg.mediaInfo?.fileId) {
     *   const data = await telegram.downloadMedia(msg.mediaInfo.fileId, chatId, msg.id, msg.mediaInfo.uniqueFileId);
     *   fs.writeFileBinary("workspace/Downloads/photo.jpg", data.buffer);
     *   // 之后可以 vision.see("workspace/Downloads/photo.jpg") 或 sendMedia(chatId, { type: 'photo', file: 'workspace/Downloads/photo.jpg' })
     * }
     * @example
     * // ❌ 错误：writeFile 写入 base64 字符串，文件损坏
     * // fs.writeFile("photo.jpg", data.buffer);
     * @example
     * // 错误：await telegram.downloadMedia(msg.mediaInfo)
     * // 正确：await telegram.downloadMedia(msg.mediaInfo.fileId, msg.chat.id, msg.id, msg.mediaInfo.uniqueFileId)
     */
    downloadMedia(location: string | TelegramMtcuteRef | Record<string, unknown>, chatId?: number | string, messageId?: number, uniqueFileId?: string): Promise<{ buffer: string; size: number; }>;
    /**
     * mtcute 原生 downloadAsBuffer 透传。返回值在 sandbox 中表示为 base64 buffer。
     *
     * ⚠️ **重要**：此方法对 `location` 类型容错较低。
     * - ✅ 接受：fileId 字符串、带 `__mtcuteRef` 的 mtcute 原生对象（如 `getProfilePhotos` 返回的 photo 对象）
     * - ❌ 不接受：`msg.mediaInfo`（普通 plain object，没有 `__mtcuteRef`）——会报 "Unknown object undefined"
     *
     * 大多数场景建议优先用 `downloadMedia`（容错更好），仅在需要 mtcute 原生对象时用此方法。
     *
     * @example
     * // ✅ 下载用户头像（getProfilePhotos 返回 mtcute 原生对象，可直接传入）
     * const [photo] = await telegram.getProfilePhotos(userId, { limit: 1 });
     * const data = await telegram.downloadAsBuffer(photo);
     *
     * @example
     * // ❌ 不要传 mediaInfo（会报错）
     * // const data = await telegram.downloadAsBuffer(msg.mediaInfo); // Error!
     * // ✅ 改用 downloadMedia，或先取 fileId 字符串
     * const data = await telegram.downloadMedia(msg.mediaInfo.fileId, chatId, msg.id, msg.mediaInfo.uniqueFileId);
     */
    downloadAsBuffer(location: string | TelegramMtcuteRef, params?: { fileSize?: number; partSize?: number; dcId?: number; offset?: number; limit?: number }): Promise<{ buffer: string; size: number; }>;

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
