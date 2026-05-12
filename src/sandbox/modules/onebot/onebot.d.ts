/**
 * onebot.d.ts — QQ / OneBot 平台 API
 *
 * 系统注入的 OneBot host proxy 接口。
 * 也会以 `qq` 别名暴露给 sandbox。
 */

interface OneBotMessageAck {
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
    [key: string]: unknown;
}

declare const onebot: {
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
     * 发送文本消息。
     * @example
     * await onebot.sendText(chatId, "你好");
     */
    sendText(chatId: string | number, text: string, opts?: { replyTo?: string | number }): Promise<OneBotMessageAck | null>;

    /**
        * 发送媒体消息。支持本地文件路径或 URL。
        * 当 `type` 为 `audio` / `voice` 时，QQ/NapCat 不支持 `replyTo`，该参数会被忽略。
     * @example
     * await onebot.sendMedia(chatId, { type: "image", file: "Downloads/a.png", caption: "图" });
     */
    sendMedia(chatId: string | number, media: string | OneBotMediaPayload, opts?: { replyTo?: string | number; caption?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送文件。
     * @example
     * await onebot.sendFile(chatId, "Downloads/report.pdf", { caption: "日报" });
     */
    sendFile(chatId: string | number, filePath: string, opts?: { replyTo?: string | number; caption?: string; fileName?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送贴纸或图片表情。
     * @example
     * await onebot.sendSticker(chatId, "Downloads/sticker.png");
     */
    sendSticker(chatId: string | number, sticker: string | Record<string, unknown>, opts?: { replyTo?: string | number; caption?: string }): Promise<OneBotMessageAck | null>;

    /**
     * 发送 QQ 系统表情（CQ face）。
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
