export interface FeishuSendOptions {
    replyToMessageId?: string;
    replyInThread?: boolean;
    uuid?: string;
}

export interface FeishuTextOptions extends FeishuSendOptions {
    mentions?: Array<{ userId: string; displayName?: string }>;
}

export interface FeishuMedia {
    type: "photo" | "document" | "audio" | "video";
    path: string;
    fileName?: string;
    caption?: string;
    duration?: number;
}

export type FeishuNativeAction =
    | "message.delete" | "message.patch" | "message.update" | "message.forward" | "message.mergeForward" | "message.readUsers"
    | "messageReaction.create" | "messageReaction.delete" | "messageReaction.list" | "messageReaction.batchQuery"
    | "pin.create" | "pin.delete" | "pin.list"
    | "chat.update" | "chat.delete" | "chat.link"
    | "chatMembers.create" | "chatMembers.delete" | "chatMembers.meJoin" | "chatMembers.get" | "chatMembers.isInChat"
    | "chatManagers.addManagers" | "chatManagers.deleteManagers"
    | "chatMenuTree.create" | "chatMenuTree.delete" | "chatMenuTree.sort"
    | "chatMenuItem.patch";

export interface FeishuMessageAck {
    messageId: string;
    chatId: string;
    text?: string;
    senderUserId?: string;
    mentions?: Array<{ userId: string; displayName?: string }>;
    replyToMessageId?: string;
    parentId?: string;
    rootId?: string;
    threadId?: string;
    mediaInfo?: unknown;
    additionalMessages?: FeishuMessageAck[];
    captionError?: string;
    [key: string]: unknown;
}

export interface FeishuCardUpdateOptions {
    /** CardKit updates must use a monotonically increasing sequence. Defaults to the current timestamp. */
    sequence?: number;
    uuid?: string;
}

export interface FeishuClient {
    sendText(chatId: string, text: string, options?: FeishuTextOptions): Promise<FeishuMessageAck | null>;
    /** 发送飞书原生 text/post/interactive/share_chat/share_user 消息。 */
    sendMessage(chatId: string, type: "text" | "post" | "interactive" | "share_chat" | "share_user", content: Record<string, unknown>, options?: FeishuSendOptions): Promise<FeishuMessageAck | null>;
    sendMedia(chatId: string, media: FeishuMedia, options?: FeishuSendOptions): Promise<FeishuMessageAck | null>;
    /** 复用机器人收到过的飞书表情包。fileId 使用入站 sticker 的 mediaInfo.sendableFileId/fileId。 */
    sendSticker(chatId: string, fileId: string, options?: FeishuSendOptions): Promise<FeishuMessageAck | null>;
    /** 使用卡片搭建工具的模板 ID 发送或回复模板卡片。 */
    sendTemplateCard(chatId: string, templateId: string, variables?: Record<string, unknown>, options?: FeishuSendOptions): Promise<FeishuMessageAck | null>;
    /** 创建 CardKit 卡片实体并发送；适用于后续局部或流式更新。 */
    sendCard(chatId: string, card: Record<string, unknown>, options?: FeishuSendOptions): Promise<FeishuMessageAck | null>;
    updateTemplateCard(chatId: string, messageId: string, templateId: string, variables?: Record<string, unknown>): Promise<unknown>;
    updateCard(chatId: string, messageId: string, card: Record<string, unknown>, options?: FeishuCardUpdateOptions): Promise<unknown>;
    patchCard(chatId: string, messageId: string, actions: unknown, options?: FeishuCardUpdateOptions): Promise<unknown>;
    streamCardText(chatId: string, messageId: string, elementId: string, content: string, options?: FeishuCardUpdateOptions): Promise<unknown>;
    getMessage(chatId: string, messageId: string): Promise<unknown>;
    /** 获取当前会话历史消息，支持飞书 page token 分页。 */
    getHistory(chatId: string, options?: { pageSize?: number; pageToken?: string; startTime?: string | number; endTime?: string | number; sortType?: "asc" | "desc" }): Promise<{ items: unknown[]; hasMore: boolean; pageToken?: string }>;
    getChat(chatId: string): Promise<unknown>;
    downloadMedia(fileId: string, chatId?: string, messageId?: string, uniqueFileId?: string): Promise<string>;
    /**
     * 调用受控的飞书 IM 原生 API。chatId 是安全归属上下文；payload 保持 SDK 的 { path, params, data } 形状。
     * 消息、表情、Pin、群资料、成员、管理员和群菜单能力均通过此入口开放。
     * 转发仅支持 receive_id_type: "chat_id"，收件人与所有源消息必须属于 chatId；不开放全局群聊发现。
     */
    callApi(chatId: string, action: FeishuNativeAction, payload?: { path?: Record<string, unknown>; params?: Record<string, unknown>; data?: Record<string, unknown> }): Promise<unknown>;
}

declare const feishu: FeishuClient;
