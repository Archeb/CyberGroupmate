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
    | "chatMenuTree.get" | "chatMenuTree.create" | "chatMenuTree.delete" | "chatMenuTree.sort"
    | "chatMenuItem.patch"
    | "chatModeration.get" | "chatModeration.update"
    | "chatAnnouncement.get" | "chatAnnouncement.patch"
    | "chatAnnouncementBlock.list" | "chatAnnouncementBlock.batchUpdate"
    | "chatAnnouncementBlockChildren.create" | "chatAnnouncementBlockChildren.batchDelete"
    | "chatTopNotice.putTopNotice" | "chatTopNotice.deleteTopNotice";

export interface FeishuSearchOptions {
    filter?: {
        chat_ids?: string[];
        from_ids?: string[];
        at_chatter_ids?: string[];
        time_range?: { start_time?: string; end_time?: string };
        chat_type?: "group" | "p2p";
        is_at_me?: boolean;
        include_attachment_types?: Array<"image" | "video" | "file" | "link">;
        from_types?: Array<"user" | "bot">;
        exclude_from_types?: Array<"user" | "bot">;
    };
    pageSize?: number;
    pageToken?: string;
}

export interface FeishuSearchResult {
    items: Array<{
        messageId: string;
        chatId?: string;
        userId?: string;
        text?: string;
        messageType?: string;
        timestamp?: string;
        threadId?: string;
        isP2pChat?: boolean;
    }>;
    hasMore: boolean;
    pageToken?: string;
    total?: number;
    notice?: string;
}

export interface FeishuChatMember {
    userId: string;
    rawUserId: string;
    memberIdType: string;
    displayName?: string;
    tenantKey?: string;
}

export interface FeishuChatMembersResult {
    chatId: string;
    items: FeishuChatMember[];
    hasMore: boolean;
    pageToken?: string;
    memberTotal: number;
    /** 飞书在无法给出准确人数时返回 -1；此时 memberTotal 退化为已拉取条数。 */
    memberTotalIsExact: boolean;
    securityConfLimit?: number;
    triggerSecurityConfLimit: boolean;
    scannedPages: number;
}

export interface FeishuChatAnnouncement {
    chatId: string;
    announcementType: "doc" | "docx";
    revision?: string;
    /** 仅旧版 doc 公告有：旧版云文档格式的正文。 */
    content?: string;
    /** 仅新版 docx 公告有：纯文本摘要。 */
    text?: string;
    /** 仅新版 docx 公告有：块结构，便于按需渲染。 */
    blocks?: Array<Record<string, unknown>>;
    ownerId?: string;
    /** 公告所有者的 ID 类型；机器人创建时可能是 app_id。 */
    ownerIdType?: string;
    modifierId?: string;
    modifierIdType?: string;
    createTime?: string;
    updateTime?: string;
    hasMore?: boolean;
    pageToken?: string;
}

export interface FeishuChatMenuItem {
    name?: string;
    actionType?: string;
    redirectLink?: Record<string, unknown>;
    imageKey?: string;
    i18nNames?: Record<string, unknown>;
}

export interface FeishuBotInfo {
    userId: string;
    openId: string;
    appId: string;
    name?: string;
    avatar?: string;
    activateStatus?: number;
}

export interface FeishuChatMenu {
    chatId: string;
    items: Array<FeishuChatMenuItem & {
        topLevelId?: string;
        children: Array<FeishuChatMenuItem & { menuItemId?: string }>;
    }>;
}

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
    /**
     * 搜索消息。需要应用开通 `search:message` 权限，否则飞书返回 99991672 并附申请链接。
     * 未指定 filter.chat_ids 时按应用可见范围搜索。
     */
    searchMessages(query: string, options?: FeishuSearchOptions): Promise<FeishuSearchResult>;
    getChat(chatId: string): Promise<unknown>;
    /** 群成员列表。飞书该接口不返回机器人成员。 */
    getChatMembers(chatId: string, options?: { pageSize?: number; pageToken?: string; maxPages?: number; memberIdType?: "user_id" | "union_id" | "open_id" }): Promise<FeishuChatMembersResult>;
    /** 读取群菜单。飞书仅支持 chat_mode=group 的群。 */
    getChatMenu(chatId: string): Promise<FeishuChatMenu>;
    /**
     * 读取群公告，自动兼容两种形态：
     * - 旧版 doc：返回 content（旧版云文档格式）
     * - 新版 docx：im.v1 会报 232097，自动回退到 docx 接口并返回 text + blocks
     */
    getChatAnnouncement(chatId: string): Promise<FeishuChatAnnouncement>;
    /** 机器人自身信息（open_id、app_id、名称、头像、可用状态）。 */
    getBotInfo(): Promise<FeishuBotInfo>;
    /** 机器人主动退群（飞书允许机器人随时将自己移出群组）。 */
    leaveChat(chatId: string): Promise<{ chatId: string; left: boolean }>;
    downloadMedia(fileId: string, chatId?: string, messageId?: string, uniqueFileId?: string): Promise<string>;
    /**
     * 调用受控的飞书 IM 原生 API。chatId 是安全归属上下文；payload 保持 SDK 的 { path, params, data } 形状。
     * 消息、表情、Pin、群资料、成员、管理员、群菜单、群发言权限、群公告和群置顶能力均通过此入口开放。
     * 转发仅支持 receive_id_type: "chat_id"，收件人与所有源消息必须属于 chatId；不开放全局群聊发现。
     */
    callApi(chatId: string, action: FeishuNativeAction, payload?: { path?: Record<string, unknown>; params?: Record<string, unknown>; data?: Record<string, unknown> }): Promise<unknown>;
}

declare const feishu: FeishuClient;
