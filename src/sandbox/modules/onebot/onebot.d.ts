/**
 * onebot.d.ts — QQ / OneBot 平台 API
 *
 * 系统注入的 OneBot host proxy 接口。
 * 也会以 `qq` 别名暴露给 sandbox。
 */

interface OneBotMessageAck {
    /** 实际发送载荷中的真实 @ 目标；空数组表示没有 @。仅发送回执，不证明 bot 已回复。 */
    mentions?: Array<{ userId: string; isAll?: boolean }>;
    senderUserId?: string;
    message_id?: unknown;
    id?: unknown;
    chatId?: string | number;
    group_id?: string | number;
    user_id?: string | number;
}

interface OneBotMediaPayload {
    type?: string;
    file?: string;
    url?: string;
    caption?: string;
    fileName?: string;
}

interface OneBotRawMessage {
    message_id?: string | number;
    real_id?: string | number;
    time?: number;
    message_type?: "private" | "group" | string;
    sender?: Record<string, unknown>;
    message?: unknown;
    raw_message?: string;
    /** 解析后的 OneBot 消息段数组。 */
    messageSegments?: OneBotMessageSegment[];
    /** 从 text/at/face/mface 等段提取的人类可读文本。 */
    text?: string;
    /** 消息里出现的 @ 对象，含 "all" 和当前 bot 被 @ 的标记。 */
    mentions?: Array<{
        userId: string;
        rawUserId: string;
        displayName?: string;
        isAll?: boolean;
        isSelf?: boolean;
    }>;
    /** 是否 @ 了当前 bot 或 @ 全体成员。 */
    mentionsAgent?: boolean;
    replyToMessageId?: string;
    mediaInfo?: Record<string, unknown>;
    [key: string]: unknown;
}

interface OneBotMessageSegment {
    type: string;
    data?: Record<string, unknown>;
}

type OneBotMessage = string | OneBotMessageSegment[];

interface OneBotSendMessageOptions {
    /** 回复指定消息 ID。会在消息段数组前自动插入 OneBot reply 段。 */
    replyTo?: string | number;
    /** 发送前自动插入一个或多个 @ 段。支持 QQ 号、"all"、onebot:<qq>、onebot:private:<qq>、数组或逗号分隔字符串。 */
    mentions?: Array<string | number> | string | number;
}

type OneBotNativeParams = Record<string, unknown>;

declare const onebot: {
    /** NapCat/OneBot 新增 action 的动态入口：onebot.action_name(params)。敏感 action 会被 host policy 拦截。 */
    [nativeAction: string]: any;

    // ─── 按需能力指南 ───
    /** 加载 OneBot/NapCat 消息指南。用于消息检索、历史消息、已读、转发、合并转发和消息表情点赞等成组能力；调用本方法只披露指南。 */
    useMessages(): Promise<string>;
    /** 加载 OneBot/NapCat 群管理指南。用于群资料、成员列表、禁言、踢人、管理员、公告、精华消息和群待办等成组能力；调用本方法只披露指南。 */
    useGroupAdministration(): Promise<string>;
    /** 加载 OneBot/NapCat 文件指南。用于图片/语音/文件解析、群文件系统、文件 URL 和跨机器媒体处理注意事项；调用本方法只披露指南。 */
    useFiles(): Promise<string>;
    /** 加载 OneBot/NapCat 用户与资料指南。用于好友列表、陌生人资料、最近会话、点赞、好友请求和账号资料等成组能力；调用本方法只披露指南。 */
    useUsersAndProfile(): Promise<string>;
    /** 加载 OneBot/NapCat 工具指南。用于版本/状态探测、发送能力检查、OCR、URL 安全检查、频道资料和 AI 语音等低频能力；调用本方法只披露指南。 */
    useSystemUtilities(): Promise<string>;

    /**
     * 根据 OneBot 消息 ID 获取消息详情。
     * @example
     * const msg = await onebot.getMessage(794582600);
     */
    getMessage(messageId: string | number): Promise<OneBotRawMessage>;

    /**
     * 调用 OneBot/NapCat 原生 action，参数保持平台原始 params 对象。
     * 这是新增能力的首选入口；旧 sendText/sendMedia wrapper 只保留兼容，不再扩展新平台参数。
     * @example
     * await onebot.callApi("send_group_msg", {
     *   group_id: 979200391,
     *   message: [
     *     { type: "at", data: { qq: "123456" } },
     *     { type: "text", data: { text: " 来看这个" } },
     *   ],
     * });
     */
    callApi(action: string, params?: OneBotNativeParams): Promise<unknown>;

    /**
     * OneBot 原生 send_group_msg(params)。参数名和行为保持 OneBot/NapCat 原样。
     * @example
     * await onebot.send_group_msg({
     *   group_id: 979200391,
     *   message: [{ type: "text", data: { text: "你好" } }],
     * });
     */
    send_group_msg(params: { group_id: string | number; message: OneBotMessage; [key: string]: unknown }): Promise<OneBotMessageAck | null>;

    /**
     * OneBot 原生 send_private_msg(params)。参数名和行为保持 OneBot/NapCat 原样。
     * @example
     * await onebot.send_private_msg({ user_id: 123456, message: "你好" });
     */
    send_private_msg(params: { user_id: string | number; message: OneBotMessage; [key: string]: unknown }): Promise<OneBotMessageAck | null>;

    /**
     * OneBot 原生 send_msg(params)，可用 message_type/group_id/user_id 选择目标。
     * @example
     * await onebot.send_msg({ message_type: "group", group_id: 979200391, message: "你好" });
     */
    send_msg(params: { message_type?: "group" | "private" | string; group_id?: string | number; user_id?: string | number; message: OneBotMessage; [key: string]: unknown }): Promise<OneBotMessageAck | null>;

    /**
     * OneBot 原生 delete_msg(params)。
     * @example
     * await onebot.delete_msg({ message_id: 123456 });
     */
    delete_msg(params: { message_id: string | number; [key: string]: unknown }): Promise<unknown>;

    /**
     * OneBot 原生 get_msg(params)。
     * @example
     * const msg = await onebot.get_msg({ message_id: 123456 });
     */
    get_msg(params: { message_id: string | number; [key: string]: unknown }): Promise<OneBotRawMessage>;

    /**
     * 构造 OneBot 标准 @ 消息段。只构造 segment，不会发送。兼容辅助函数，冻结为兜底用法。
     * @example
     * await onebot.sendMessage(chatId, [onebot.mention("123456"), { type: "text", data: { text: " 你好" } }]);
     */
    mention(userId: string | number): OneBotMessageSegment;

    /**
     * 发送 OneBot 标准消息。message 可以是 CQ 字符串或消息段数组。兼容辅助函数，冻结为兜底用法。
     * 用于文本、@、回复、图片、语音、视频、文件、表情等混合消息。
     * @example
     * await onebot.sendMessage(chatId, [
     *   { type: "at", data: { qq: "123456" } },
     *   { type: "text", data: { text: " 来看这个" } },
     * ]);
     */
    sendMessage(chatId: string | number, message: OneBotMessage, opts?: OneBotSendMessageOptions): Promise<OneBotMessageAck | null>;

    /**
     * 在群聊里发送真实 @ 并追加文本。触发 bot 时优先使用，不能传昵称或群 chatId。
     * userId 支持裸 QQ 号、onebot:<qq>、onebot:private:<qq>、"all"、数组或逗号分隔字符串。
     * @example
     * await onebot.sendAt(chatId, "123456", "辛苦看下这个");
     * await onebot.sendAt(chatId, ["123456", "778899"], "村里发金条了");
     */
    sendAt(chatId: string | number, userId: string | number | Array<string | number>, text?: string, opts?: { replyTo?: string | number }): Promise<OneBotMessageAck | null>;

    /**
     * 发送文本消息。文字 @昵称 不是真实 @；提及或触发 bot 请使用 sendAt 或 opts.mentions。
     * 新平台参数优先用 send_group_msg/send_private_msg/callApi。
     * @example
     * await onebot.sendText(chatId, "你好");
     */
    sendText(chatId: string | number, text: string, opts?: OneBotSendMessageOptions): Promise<OneBotMessageAck | null>;

    /**
     * 发送媒体消息。兼容 wrapper，冻结为兜底用法；新参数优先用 OneBot 原生 action。
     * 支持本地文件路径或 URL。当 `type` 为 `audio` / `voice` 时，QQ/NapCat 不支持 `replyTo`，该参数会被忽略。
     * @example
     * await onebot.sendMedia(chatId, { type: "image", file: "Downloads/a.png", caption: "图" });
     */
    sendMedia(chatId: string | number, media: string | OneBotMediaPayload, opts?: { replyTo?: string | number; caption?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送文件。兼容 wrapper，冻结为兜底用法；新参数优先用 OneBot 原生 action。
     * @example
     * await onebot.sendFile(chatId, "Downloads/report.pdf", { caption: "日报" });
     */
    sendFile(chatId: string | number, filePath: string, opts?: { replyTo?: string | number; caption?: string; fileName?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送贴纸或图片表情。兼容 wrapper，冻结为兜底用法；新参数优先用 OneBot 原生 action。
     * @example
     * await onebot.sendSticker(chatId, "Downloads/sticker.png");
     */
    sendSticker(chatId: string | number, sticker: string | Record<string, unknown>, opts?: { replyTo?: string | number; caption?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送 QQ 系统表情（CQ face）。兼容 wrapper，冻结为兜底用法；新参数优先用 OneBot 原生 action。
     * @example
     * await onebot.sendFace(chatId, 21);
     */
    sendFace(chatId: string | number, faceId: string | number, opts?: { replyTo?: string | number; text?: string }): Promise<OneBotMessageAck | null>;

    /**
     * OneBot 无 typing 指示，此方法为 no-op。
     */
    sendTyping(chatId: string | number): Promise<void>;

    /**
     * 撤回消息。
     * @example
     * await onebot.deleteMessages(chatId, [messageId]);
     */
    deleteMessages(chatId: string | number, messageIds: Array<string | number>): Promise<void>;

    /**
     * 下载 QQ 媒体到 CyberGroupmate 本机 workspace/Downloads/。
     * mediaRef 可以是图片/媒体 file、URL、base64/data URL，也可以直接传 OneBot 消息 ID；
     * 传消息 ID 时会通过 NapCat get_msg 解析消息里的图片/媒体段。
     * @example
     * const localPath = await onebot.downloadMedia(794582600);
     */
    downloadMedia(mediaRef: string | number): Promise<string>;
};

declare const qq: typeof onebot;
