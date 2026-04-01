/**
 * telegram-adapter.ts — 官方 Telegram ingress adapter
 *
 * 宿主侧负责：
 * - 建立 mtcute 连接
 * - 监听 Telegram 消息并标准化后推入 NotificationCenter
 * - 通过 host-call 为 sandbox 提供 telegram 代码接口
 */

import type { NotificationCenter } from "../event/notification-center.js";
import type { TelegramConfig } from "../core/config.js";
import type { PlatformAdapter } from "./platform-adapter.js";
import { composeChatId, parseChatId, isTelegram, isValidCompositeChatId, ensureCompositeId, getPlatform } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import * as fs from "node:fs";
import * as path from "node:path";

const log = createLogger("telegram-adapter");

// ─── 常量 ───

const DEFAULT_MEDIA_CACHE_DIR = "workspace/media-cache";
const INVISIBLE_USERS_PATH = "workspace/invisible-users.json";

// ─── Invisible Users 持久化 ───

function loadInvisibleUsers(): Set<string> {
    try {
        if (fs.existsSync(INVISIBLE_USERS_PATH)) {
            const data = JSON.parse(fs.readFileSync(INVISIBLE_USERS_PATH, "utf-8"));
            if (Array.isArray(data)) return new Set(data);
        }
    } catch { /* ignore corrupt file */ }
    return new Set();
}

function saveInvisibleUsers(users: Set<string>): void {
    try {
        const dir = path.dirname(INVISIBLE_USERS_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(INVISIBLE_USERS_PATH, JSON.stringify([...users]), "utf-8");
    } catch (err) {
        log.warn("saveInvisibleUsers: 写入失败", { error: String(err) });
    }
}

// ─── 媒体文件缓存 ───

class MediaFileCache {
    private readonly dir: string;

    constructor(cacheDir: string = DEFAULT_MEDIA_CACHE_DIR) {
        this.dir = cacheDir;
        try {
            fs.mkdirSync(this.dir, { recursive: true });
        } catch { /* ignore */ }
    }

    get(uniqueFileId: string): Buffer | null {
        try {
            const filePath = path.join(this.dir, uniqueFileId);
            if (fs.existsSync(filePath)) {
                return fs.readFileSync(filePath);
            }
        } catch { /* miss */ }
        return null;
    }

    set(uniqueFileId: string, buffer: Buffer): void {
        try {
            const filePath = path.join(this.dir, uniqueFileId);
            fs.writeFileSync(filePath, buffer);
        } catch (err) {
            log.warn("MediaFileCache: 写入缓存失败", { uniqueFileId, error: String(err) });
        }
    }
}

interface PromptHandler {
    (prompt: string): Promise<string>;
}

interface PrintHandler {
    (message: string): void;
}

interface TelegramClientLike {
    start(params: Record<string, unknown>): Promise<unknown>;
    onNewMessage: {
        add(handler: (msg: unknown) => void | Promise<void>): void;
        remove(handler: (msg: unknown) => void | Promise<void>): void;
    };
    destroy?(): Promise<void>;
    getMe?(): Promise<unknown>;
    sendText?(chatId: unknown, text: unknown, opts?: unknown): Promise<unknown>;
    sendMedia?(chatId: unknown, media: unknown, opts?: unknown): Promise<unknown>;
    getChat?(chatId: unknown): Promise<unknown>;
    getUser?(userId: unknown): Promise<unknown>;
    getChatMembers?(chatId: unknown, params?: unknown): Promise<unknown[]>;
    getHistory?(chatId: unknown, params?: unknown): Promise<unknown[]>;
    iterDialogs?(params?: unknown): AsyncIterable<unknown>;
    readHistory?(chatId: unknown): Promise<void>;
    sendTyping?(chatId: unknown): Promise<void>;
    joinChat?(chatId: unknown): Promise<unknown>;
    leaveChat?(chatId: unknown): Promise<unknown>;
    downloadAsBuffer?(location: unknown): Promise<Uint8Array>;
    getMessages?(chatId: unknown, messageIds: number[]): Promise<unknown[]>;
    // ─── 扩展方法 ───
    getFullUser?(userId: unknown): Promise<unknown>;
    getFullChat?(chatId: unknown): Promise<unknown>;
    getForumTopics?(chatId: unknown, params?: unknown): Promise<unknown>;
    searchMessages?(params: unknown): Promise<unknown>;
    sendMediaGroup?(chatId: unknown, medias: unknown[], opts?: unknown): Promise<unknown[]>;
    sendReaction?(params: unknown): Promise<unknown>;
    editMessage?(params: unknown): Promise<unknown>;
    deleteMessagesById?(chatId: unknown, ids: number[], params?: unknown): Promise<void>;
    pinMessage?(params: unknown): Promise<unknown>;
    unpinMessage?(params: unknown): Promise<void>;
    getMessageReactionsById?(chatId: unknown, messageIds: number[]): Promise<unknown[]>;
    closePoll?(params: unknown): Promise<unknown>;
    resolvePeer?(peer: unknown): Promise<unknown>;
    getInputEntity?(peer: unknown): Promise<unknown>;
    joinChannel?(peer: unknown): Promise<unknown>;
    leaveChannel?(peer: unknown): Promise<unknown>;
}

type TelegramClientFactory = (config: TelegramConfig) => Promise<TelegramClientLike>;

interface PlainUser {
    id: string;
    displayName?: string;
    title?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    isBot: boolean;
}

interface PlainChat {
    id: string;
    title?: string;
    username?: string;
    type: "private" | "group" | "supergroup" | "channel";
}

/** 结构化媒体元数据（从 mtcute msg.media 提取） */
export interface MediaInfo {
    type: "photo" | "sticker" | "video" | "document" | "animation" | "other";
    fileId?: string;
    uniqueFileId?: string;
    emoji?: string;
    mimeType?: string;
    fileName?: string;
    width?: number;
    height?: number;
    fileSize?: number;
}

interface PlainMessage {
    id: string;
    text: string;
    date: string;
    chat: PlainChat;
    sender: PlainUser | null;
    isMention: boolean;
    replyToMessage?: { id: string } | null;
    media?: unknown;
    mediaInfo?: MediaInfo;
}

interface PlainDialog {
    peer: PlainUser | PlainChat;
    lastMessage?: PlainMessage;
    unreadCount: number;
}

export class TelegramAdapter implements PlatformAdapter {
    readonly platform = "telegram";

    private client: any | null = null;
    private selfUser: PlainUser | null = null;
    private messageHandler: ((msg: any) => Promise<void>) | null = null;
    private mediaCache = new MediaFileCache();

    // ─── 拟人化延迟状态 ───
    private lastSendTimes = new Map<string, number>();

    // ─── /invisible & /mute 状态 ───
    private invisibleUsers: Set<string> = loadInvisibleUsers();
    private mutedChats: Map<string, number> = new Map();  // chatId → expiry timestamp (ms)

    constructor(
        private config: TelegramConfig,
        private nc: NotificationCenter,
        private promptUser: PromptHandler,
        private print: PrintHandler = console.log,
        private createClient: TelegramClientFactory = defaultTelegramClientFactory,
        private mediaDownloader?: MediaDownloader,
    ) { }

    async start(): Promise<void> {
        if (this.client) return;

        this.validateConfig();

        const client = await this.createClient(this.config);

        const self = this.config.mode === "bot"
            ? await client.start({ botToken: this.config.botToken })
            : await client.start({
                phone: () => this.config.phone,
                code: async () => this.promptUser("请输入 Telegram 验证码: "),
                password: async () => this.promptUser("请输入 Telegram 两步验证密码: "),
                codeSentCallback: (sentCode: { type?: string }) => {
                    this.print(`📱 Telegram 验证码已发送 (${sentCode?.type ?? "unknown"})`);
                },
            });

        this.client = client;
        this.selfUser = this.normalizeUser(self);

        this.messageHandler = async (msg: any) => {
            const normalized = this.normalizeIncomingMessage(msg);
            if (!normalized || !normalized.messageId || !normalized.text) return;

            // ─── /invisible & /mute 命令拦截 ───
            const cmdHandled = await this.handleBotCommand(normalized, msg);
            if (cmdHandled) return;  // 命令消息不进入 NC

            // ─── invisible 用户消息静默丢弃 ───
            if (this.invisibleUsers.has(normalized.userId)) {
                log.debug("invisible 用户消息已丢弃", { userId: normalized.userId, chatId: normalized.chatId });
                return;
            }

            log.debug("接收 Telegram 消息", {
                messageId: normalized.messageId,
                chatId: normalized.chatId,
                userId: normalized.userId,
                chatType: normalized.chatType,
                isDirectMessage: normalized.isDirectMessage,
                mentionsAgent: normalized.mentionsAgent,
                textPreview: normalized.text.slice(0, 80),
                mediaType: normalized.mediaInfo?.type,
            });

            this.nc.push({
                type: "nc.message",
                scene: "telegram",
                source: {
                    scene: "telegram",
                    platform: "telegram",
                    chatId: normalized.chatId,
                    userId: normalized.userId,
                    chatType: normalized.chatType,
                    messageId: normalized.messageId,
                    replyToMessageId: normalized.replyToMessageId,
                },
                chatId: normalized.chatId,
                userId: normalized.userId,
                displayName: normalized.displayName,
                username: normalized.username,
                text: normalized.text,
                timestamp: normalized.timestamp,
                messageId: normalized.messageId,
                replyToMessageId: normalized.replyToMessageId,
                chatTitle: normalized.chatTitle,
                chatType: normalized.chatType,
                isDirectMessage: normalized.isDirectMessage,
                mentionsAgent: normalized.mentionsAgent,
                mediaInfo: normalized.mediaInfo,
                payload: {
                    scene: "telegram",
                    chatId: normalized.chatId,
                    userId: normalized.userId,
                    displayName: normalized.displayName,
                    username: normalized.username,
                    text: normalized.text,
                    timestamp: normalized.timestamp,
                    messageId: normalized.messageId,
                    replyToMessageId: normalized.replyToMessageId,
                    chatTitle: normalized.chatTitle,
                    chatType: normalized.chatType,
                    isDirectMessage: normalized.isDirectMessage,
                    mentionsAgent: normalized.mentionsAgent,
                    mediaInfo: normalized.mediaInfo,
                    source: {
                        scene: "telegram",
                        platform: "telegram",
                        chatId: normalized.chatId,
                        userId: normalized.userId,
                        chatType: normalized.chatType,
                        messageId: normalized.messageId,
                        replyToMessageId: normalized.replyToMessageId,
                    },
                    platformData: {
                        originalType: "telegram.message",
                    },
                },
                _urgent: normalized.isDirectMessage || normalized.mentionsAgent || normalized.replyToMessageId ? true : false,
            });
        };

        client.onNewMessage.add(this.messageHandler);
        this.print(`✅ TelegramAdapter 已启动: ${this.selfUser.displayName ?? this.selfUser.firstName ?? this.selfUser.id} (${this.selfUser.id})`);
    }

    async stop(): Promise<void> {
        if (!this.client) return;

        if (this.messageHandler) {
            this.client.onNewMessage.remove(this.messageHandler);
            this.messageHandler = null;
        }

        if (typeof this.client.destroy === "function") {
            await this.client.destroy();
        }

        this.client = null;
        this.selfUser = null;
    }

    canHandle(method: string): boolean {
        return method.startsWith("telegram.");
    }

    getWriteMethods(): string[] {
        return [
            "telegram.sendText",
            "telegram.sendMedia",
            "telegram.sendFile",
            "telegram.sendSticker",
            "telegram.sendTyping",
            "telegram.sendMediaGroup",
            "telegram.sendPoll",
            "telegram.sendReaction",
            "telegram.editMessage",
            "telegram.deleteMessages",
            "telegram.pinMessage",
            "telegram.unpinMessage",
        ];
    }

    formatMention(_rawUserId: string, username?: string): string | undefined {
        return username ? `@${username}` : undefined;
    }

    getSceneTypeDefs(scene: string, baseTypeDefs: string): string | undefined {
        if (scene !== "telegram") return undefined;

        const filtered = this.config.mode === "userbot"
            ? baseTypeDefs.replace(/^\s*\/\/ \[USERBOT_ONLY_BEGIN\]\s*$/gm, "").replace(/^\s*\/\/ \[USERBOT_ONLY_END\]\s*$/gm, "")
            : baseTypeDefs.replace(/^\s*\/\/ \[USERBOT_ONLY_BEGIN\]\s*$[\s\S]*?^\s*\/\/ \[USERBOT_ONLY_END\]\s*$/gm, "");

        const modeNote = this.config.mode === "bot"
            ? "// 当前 Telegram adapter 模式: bot\n// 注意: bot mode 下不应使用历史读取、对话遍历、读回执、成员枚举等受限 API。\n"
            : "// 当前 Telegram adapter 模式: userbot\n// 可使用完整的 Telegram host proxy 能力面。\n";

        return `${modeNote}\n${filtered}`.trim();
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (!this.client) {
            throw new Error("TelegramAdapter is not started");
        }

        // ─── /mute 写操作拦截 ───
        const MUTE_BLOCKED_METHODS = ["telegram.sendText", "telegram.sendMedia", "telegram.sendFile", "telegram.sendSticker", "telegram.sendTyping"];
        if (MUTE_BLOCKED_METHODS.includes(method)) {
            // args[0] 可能是 raw ID（来自 sandbox）或 composite key，统一为 composite key 再查 mute 状态
            const chatId = ensureCompositeId("telegram", String(args[0] ?? ""));
            if (this.isChatMuted(chatId)) {
                const remaining = this.getMuteRemainingHours(chatId);
                const msg = `[禁言中] 你在该聊天已被 /mute，剩余 ${remaining}。所有发送操作已被抑制。`;
                log.info("mute 拦截写操作", { method, chatId, remaining });
                throw new Error(msg);
            }
        }

        switch (method) {
            case "telegram.getMe":
                return this.selfUser ?? this.normalizeUser(await this.client.getMe());
            case "telegram.sendText": {
                const peer = await this.ensurePeerCached(args[0]);
                const opts = this.normalizeReplyOpts(args[2]);
                const textLen = typeof args[1] === "string" ? args[1].length : 0;
                await this.applyHumanizedDelay(String(args[0] ?? ""), textLen);
                return this.normalizeMessage(
                    await this.client.sendText(peer, args[1], opts),
                );
            }
            case "telegram.sendMedia": {
                const peer = await this.ensurePeerCached(args[0]);
                const opts = this.normalizeReplyOpts(args[2]);
                let mediaArg = args[1] as any;

                // 支持本地文件路径：当 media.file 是本地路径时，从磁盘读取
                if (mediaArg && typeof mediaArg === "object" && typeof mediaArg.file === "string") {
                    const fileStr = mediaArg.file as string;
                    const isLocalPath = fileStr.startsWith("/") || fileStr.startsWith("./") || fileStr.startsWith("../");
                    if (isLocalPath) {
                        const { readFileSync, existsSync } = await import("node:fs");
                        const pathMod = await import("node:path");
                        const resolvedPath = pathMod.resolve(fileStr);
                        if (!existsSync(resolvedPath)) {
                            throw new Error(`sendMedia: 文件不存在: ${resolvedPath}`);
                        }
                        const buffer = readFileSync(resolvedPath);
                        mediaArg = {
                            ...mediaArg,
                            file: buffer,
                            fileName: mediaArg.fileName ?? pathMod.basename(resolvedPath),
                        };
                    }
                }

                const captionLen = typeof mediaArg?.caption === "string" ? mediaArg.caption.length : 0;
                await this.applyHumanizedDelay(String(args[0] ?? ""), captionLen);
                return this.normalizeMessage(
                    await this.client.sendMedia(peer, mediaArg, opts),
                );
            }
            case "telegram.sendFile": {
                // args: [chatId, filePath, opts?]
                // opts: { caption?, replyTo?, fileName?, mimeType? }
                const peer = await this.ensurePeerCached(args[0]);
                const filePath = String(args[1] ?? "");
                const fileOpts = (args[2] ?? {}) as Record<string, unknown>;
                const sendOpts = this.normalizeReplyOpts(fileOpts);

                // 读取文件到 Buffer（host 侧完成，避免 IPC 序列化问题）
                const { readFileSync, existsSync, statSync } = await import("node:fs");
                const pathMod = await import("node:path");
                const resolvedPath = pathMod.resolve(filePath);

                if (!existsSync(resolvedPath)) {
                    throw new Error(`sendFile: 文件不存在: ${resolvedPath}`);
                }
                const stat = statSync(resolvedPath);
                if (!stat.isFile()) {
                    throw new Error(`sendFile: 路径不是文件: ${resolvedPath}`);
                }

                const buffer = readFileSync(resolvedPath);
                const fileName = typeof fileOpts.fileName === "string"
                    ? fileOpts.fileName
                    : pathMod.basename(resolvedPath);

                const media: Record<string, unknown> = {
                    type: "document",
                    file: buffer,
                    fileName,
                };
                if (typeof fileOpts.mimeType === "string") {
                    media.fileMime = fileOpts.mimeType;
                }
                if (typeof fileOpts.caption === "string") {
                    media.caption = fileOpts.caption;
                }

                const fileCaptionLen = typeof fileOpts.caption === "string" ? (fileOpts.caption as string).length : 0;
                await this.applyHumanizedDelay(String(args[0] ?? ""), fileCaptionLen);
                return this.normalizeMessage(
                    await this.client.sendMedia(peer, media, sendOpts),
                );
            }
            case "telegram.getChat": {
                const peer = await this.ensurePeerCached(args[0]);
                return this.normalizeChat(await this.client.getChat(peer));
            }
            case "telegram.getUser":
                return this.normalizeUser(await this.client.getUser(this.normalizePeerArg(args[0])));
            case "telegram.getChatMembers": {
                const peer = await this.ensurePeerCached(args[0]);
                const peers = await this.client.getChatMembers(peer, args[1]);
                return peers.map((p: any) => this.normalizePeer(p));
            }
            case "telegram.getHistory": {
                try {
                    const peer = await this.ensurePeerCached(args[0]);
                    const messages = await this.client.getHistory(peer, args[1]);
                    return messages.map((message: any) => this.normalizeMessage(message));
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    // 提供可操作的错误信息，让 agent 不要反复重试 getHistory
                    if (errMsg.includes("inputPeer") || errMsg.includes("PEER") || errMsg.includes("resolve")) {
                        throw new Error(
                            `getHistory 失败 (peer 未解析): ${errMsg}. ` +
                            `请直接使用 telegram.sendText(chatId, text) 发送消息，不需要先获取历史消息。`
                        );
                    }
                    throw err;
                }
            }
            case "telegram.getDialogs": {
                const limit = this.readLimit(args[0], 20);
                const dialogs: PlainDialog[] = [];
                for await (const dialog of this.client.iterDialogs({ limit })) {
                    dialogs.push(this.normalizeDialog(dialog));
                }
                return dialogs;
            }
            case "telegram.readHistory": {
                const peer = await this.ensurePeerCached(args[0]);
                await this.client.readHistory(peer);
                return null;
            }
            case "telegram.sendTyping": {
                const peer = await this.ensurePeerCached(args[0]);
                await this.client.sendTyping(peer);
                return null;
            }
            case "telegram.joinChat": {
                const peer = await this.ensurePeerCached(args[0]);
                if (typeof this.client.joinChannel === "function") {
                    await this.client.joinChannel(peer);
                } else if (typeof this.client.joinChat === "function") {
                    await this.client.joinChat(peer);
                } else {
                    throw new Error("joinChat is not supported by the current Telegram client");
                }
                return null;
            }
            case "telegram.leaveChat": {
                const peer = await this.ensurePeerCached(args[0]);
                if (typeof this.client.leaveChannel === "function") {
                    await this.client.leaveChannel(peer);
                } else if (typeof this.client.leaveChat === "function") {
                    await this.client.leaveChat(peer);
                } else {
                    throw new Error("leaveChat is not supported by the current Telegram client");
                }
                return null;
            }
            case "telegram.downloadMedia": {
                // args[0] = fileId, args[1] = chatId, args[2] = messageId, args[3] = uniqueFileId
                const fileIdOrMedia = args[0];
                if (!fileIdOrMedia) throw new Error("downloadMedia: fileId is required");
                const uniqueFileId = typeof args[3] === "string" ? args[3] : undefined;

                // ── 缓存命中 → 直接返回 ──
                if (uniqueFileId) {
                    const cached = this.mediaCache.get(uniqueFileId);
                    if (cached) {
                        log.debug("downloadMedia: 缓存命中", { uniqueFileId });
                        return { buffer: cached.toString("base64"), size: cached.length };
                    }
                }

                try {
                    const uint8 = await this.client.downloadAsBuffer(fileIdOrMedia);
                    const buffer = Buffer.from(uint8);
                    if (uniqueFileId) this.mediaCache.set(uniqueFileId, buffer);
                    return { buffer: buffer.toString("base64"), size: buffer.length };
                } catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    const isFileRefError = /file.?ref/i.test(errMsg) || /FILE_REFERENCE/i.test(errMsg);

                    if (!isFileRefError) throw err;

                    // File reference 过期 → 尝试 refetch 消息获取新的 fileId
                    const chatId = args[1];
                    const messageId = args[2];
                    if (!chatId || !messageId) {
                        log.warn("downloadMedia: file reference 过期但缺少 chatId/messageId，无法 refetch", { fileId: String(fileIdOrMedia) });
                        throw err;
                    }

                    log.info("downloadMedia: file reference 过期，尝试 refetch", {
                        chatId: String(chatId),
                        messageId: String(messageId),
                    });

                    try {
                        const peer = await this.ensurePeerCached(chatId);
                        const msgIdNum = Number(messageId);
                        if (!Number.isFinite(msgIdNum)) throw new Error("messageId 不是有效数字");

                        const messages = await this.client.getMessages(peer, [msgIdNum]);
                        const msg = messages?.[0];
                        if (!msg) throw new Error("refetch 返回空消息");

                        // 从刷新后的消息中提取新的 fileId
                        const freshFileId = this.extractFileIdFromMessage(msg);
                        if (!freshFileId) throw new Error("refetch 消息中未找到 fileId");

                        log.info("downloadMedia: refetch 成功，重试下载", { freshFileId: freshFileId.slice(0, 30) + "..." });
                        const uint8 = await this.client.downloadAsBuffer(freshFileId);
                        const buffer = Buffer.from(uint8);
                        if (uniqueFileId) this.mediaCache.set(uniqueFileId, buffer);
                        return { buffer: buffer.toString("base64"), size: buffer.length };
                    } catch (refetchErr) {
                        log.warn("downloadMedia: refetch 重试也失败", {
                            chatId: String(chatId),
                            messageId: String(messageId),
                            error: String(refetchErr),
                        });
                        throw err; // 抛出原始错误
                    }
                }
            }
            case "telegram.sendSticker": {
                // args: [chatId, uniqueFileId, opts?]
                // Sticker file lookup + buffer read + sendMedia
                if (!this.mediaDownloader) {
                    throw new Error("sendSticker: mediaDownloader not injected into TelegramAdapter");
                }
                const stickerTarget = String(args[0] ?? "");
                const uniqueFileId = String(args[1] ?? "");
                if (!uniqueFileId) throw new Error("sendSticker: uniqueFileId 为空");
                const stickerPath = this.mediaDownloader.getExistingPath(uniqueFileId);
                if (!stickerPath) throw new Error(`sendSticker: 未找到贴纸文件 uniqueFileId=${uniqueFileId}`);
                if (!fs.existsSync(stickerPath)) throw new Error(`sendSticker: 文件不存在 ${stickerPath}`);
                if (stickerPath.toLowerCase().endsWith(".webm")) {
                    throw new Error("sendSticker: 禁止发送 webm 格式贴纸 (通常为视频贴纸)");
                }
                const stickerBuffer = fs.readFileSync(stickerPath);
                const stickerOpts = args[2] ?? undefined;
                return this.handleCall("telegram.sendMedia", [
                    stickerTarget,
                    { type: "sticker", file: stickerBuffer },
                    stickerOpts,
                ]);
            }
            // ─── 扩展: 主动拉取 ───
            case "telegram.getFullUser": {
                if (typeof this.client.getFullUser !== "function") {
                    throw new Error("getFullUser is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const fullUser = await this.client.getFullUser(peer);
                return this.normalizeFullUser(fullUser);
            }
            case "telegram.getFullChat": {
                if (typeof this.client.getFullChat !== "function") {
                    throw new Error("getFullChat is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const fullChat = await this.client.getFullChat(peer);
                return this.normalizeFullChat(fullChat);
            }
            case "telegram.getForumTopics": {
                if (typeof this.client.getForumTopics !== "function") {
                    throw new Error("getForumTopics is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const topicOpts = (args[1] ?? {}) as Record<string, unknown>;
                const limit = typeof topicOpts.limit === "number" ? topicOpts.limit : 100;
                const topics = await this.client.getForumTopics(peer, { limit });
                // getForumTopics returns ArrayPaginated which is array-like
                const topicArr = Array.isArray(topics) ? topics : (topics as any);
                return Array.isArray(topicArr) ? topicArr.map((t: any) => this.normalizeForumTopic(t)) : [];
            }
            case "telegram.getMessages": {
                if (typeof this.client.getMessages !== "function") {
                    throw new Error("getMessages is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const msgIds = args[1] as number[];
                const msgs = await this.client.getMessages(peer, msgIds);
                return msgs.map((m: any) => m ? this.normalizeMessage(m) : null);
            }
            case "telegram.searchMessages": {
                if (typeof this.client.searchMessages !== "function") {
                    throw new Error("searchMessages is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const query = String(args[1] ?? "");
                const searchOpts = (args[2] ?? {}) as Record<string, unknown>;
                const searchLimit = typeof searchOpts.limit === "number" ? searchOpts.limit : 50;
                const result = await this.client.searchMessages({ chatId: peer, query, limit: searchLimit });
                // searchMessages returns ArrayPaginated which is array-like
                const resultArr = Array.isArray(result) ? result : (result as any);
                return Array.isArray(resultArr) ? resultArr.map((m: any) => this.normalizeMessage(m)) : [];
            }
            case "telegram.getPollResults": {
                // 获取投票结果: 通过重新获取包含投票的消息来提取 poll media
                if (typeof this.client.getMessages !== "function") {
                    throw new Error("getPollResults requires getMessages support");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const pollMsgId = Number(args[1]);
                const msgs = await this.client.getMessages(peer, [pollMsgId]);
                const pollMsg = msgs?.[0];
                if (!pollMsg) return null;
                const media = (pollMsg as any)?.media;
                if (!media || media.type !== "poll") return null;
                return this.normalizePoll(media);
            }
            case "telegram.getMessageReactions": {
                if (typeof this.client.getMessageReactionsById !== "function") {
                    throw new Error("getMessageReactions is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const reactionMsgIds = args[1] as number[];
                const reactionsArr = await this.client.getMessageReactionsById(peer, reactionMsgIds);
                // Flatten all MessageReactions into a simple Reaction[] summary
                const result: Array<{ emoji: string; count: number }> = [];
                for (const mr of reactionsArr) {
                    if (!mr) continue;
                    const reactions = (mr as any)?.reactions ?? [];
                    for (const rc of reactions) {
                        const emoji = typeof rc?.emoji === "string" ? rc.emoji
                            : typeof rc?.emoji?.emoji === "string" ? rc.emoji.emoji
                            : String(rc?.emoji ?? "?");
                        result.push({ emoji, count: Number(rc?.count ?? 0) });
                    }
                }
                return result;
            }

            // ─── 扩展: 发送与交互 ───
            case "telegram.sendMediaGroup": {
                if (typeof this.client.sendMediaGroup !== "function") {
                    throw new Error("sendMediaGroup is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                let medias = args[1] as any[];
                const sendOpts = this.normalizeReplyOpts(args[2]);

                // 处理本地文件路径
                const { readFileSync, existsSync } = await import("node:fs");
                const pathMod = await import("node:path");
                medias = medias.map((m: any) => {
                    if (m && typeof m === "object" && typeof m.file === "string") {
                        const fileStr = m.file as string;
                        const isLocalPath = fileStr.startsWith("/") || fileStr.startsWith("./") || fileStr.startsWith("../");
                        if (isLocalPath) {
                            const resolvedPath = pathMod.resolve(fileStr);
                            if (!existsSync(resolvedPath)) {
                                throw new Error(`sendMediaGroup: 文件不存在: ${resolvedPath}`);
                            }
                            const buffer = readFileSync(resolvedPath);
                            return { ...m, file: buffer, fileName: m.fileName ?? pathMod.basename(resolvedPath) };
                        }
                    }
                    return m;
                });

                await this.applyHumanizedDelay(String(args[0] ?? ""), 0);
                const sentMsgs = await this.client.sendMediaGroup(peer, medias, sendOpts);
                return sentMsgs.map((m: any) => this.normalizeMessage(m));
            }
            case "telegram.sendPoll": {
                // sendPoll 通过 sendMedia + InputMedia.poll 实现
                const peer = await this.ensurePeerCached(args[0]);
                const question = String(args[1] ?? "");
                const options = args[2] as string[];
                const pollOpts = (args[3] ?? {}) as Record<string, unknown>;
                const sendOpts = this.normalizeReplyOpts(pollOpts);

                // 构造 InputMedia.poll 参数
                const pollMedia: Record<string, unknown> = {
                    type: "poll",
                    question,
                    answers: options.map(opt => ({ text: opt })),
                };
                if (typeof pollOpts.isAnonymous === "boolean") pollMedia.isAnonymous = pollOpts.isAnonymous;
                if (pollOpts.type === "quiz") {
                    pollMedia.quiz = true;
                    if (typeof pollOpts.correctOptionId === "number") pollMedia.correctOptionId = pollOpts.correctOptionId;
                    if (typeof pollOpts.explanation === "string") pollMedia.solution = pollOpts.explanation;
                }
                if (pollOpts.allowsMultipleAnswers === true) pollMedia.allowMultipleAnswers = true;

                await this.applyHumanizedDelay(String(args[0] ?? ""), question.length);
                return this.normalizeMessage(
                    await this.client.sendMedia(peer, pollMedia, sendOpts),
                );
            }
            case "telegram.sendReaction": {
                if (typeof this.client.sendReaction !== "function") {
                    throw new Error("sendReaction is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const reactionMsgId = Number(args[1]);
                const emoji = args[2];
                await this.client.sendReaction({
                    chatId: peer,
                    message: reactionMsgId,
                    emoji: emoji === null ? null : emoji,
                });
                return null;
            }
            case "telegram.editMessage": {
                if (typeof this.client.editMessage !== "function") {
                    throw new Error("editMessage is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const editMsgId = Number(args[1]);
                const newText = String(args[2] ?? "");
                const edited = await this.client.editMessage({
                    chatId: peer,
                    message: editMsgId,
                    text: newText,
                });
                return this.normalizeMessage(edited);
            }
            case "telegram.deleteMessages": {
                if (typeof this.client.deleteMessagesById !== "function") {
                    throw new Error("deleteMessages is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const deleteIds = args[1] as number[];
                await this.client.deleteMessagesById(peer, deleteIds, { revoke: true });
                return null;
            }
            case "telegram.pinMessage": {
                if (typeof this.client.pinMessage !== "function") {
                    throw new Error("pinMessage is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const pinMsgId = Number(args[1]);
                const pinOpts = (args[2] ?? {}) as Record<string, unknown>;
                await this.client.pinMessage({
                    chatId: peer,
                    message: pinMsgId,
                    notify: pinOpts.silent !== true,
                });
                return null;
            }
            case "telegram.unpinMessage": {
                if (typeof this.client.unpinMessage !== "function") {
                    throw new Error("unpinMessage is not supported by the current Telegram client");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const unpinMsgId = Number(args[1]);
                await this.client.unpinMessage({
                    chatId: peer,
                    message: unpinMsgId,
                });
                return null;
            }
            default:
                throw new Error(`Unsupported TelegramAdapter call: ${method}`);
        }
    }

    private validateConfig(): void {
        if (!this.config.apiId || !this.config.apiHash) {
            throw new Error("Telegram API credentials are missing in config.yaml (telegram.api_id / telegram.api_hash)");
        }

        if (this.config.mode === "bot" && !this.config.botToken) {
            throw new Error("telegram.bot_token is required in bot mode");
        }

        if (this.config.mode === "userbot" && !this.config.phone) {
            throw new Error("telegram.phone is required in userbot mode");
        }
    }

    // ─── /invisible & /mute 公开查询方法 ───

    /** 检查用户是否处于 invisible 状态 */
    isUserInvisible(userId: string): boolean {
        return this.invisibleUsers.has(userId);
    }

    /** 检查聊天是否被 mute（未过期） */
    isChatMuted(chatId: string): boolean {
        const expiry = this.mutedChats.get(chatId);
        if (expiry === undefined) return false;
        if (Date.now() >= expiry) {
            this.mutedChats.delete(chatId);
            return false;
        }
        return true;
    }

    /** 获取 mute 剩余时间的可读字符串 */
    private getMuteRemainingHours(chatId: string): string {
        const expiry = this.mutedChats.get(chatId);
        if (!expiry) return "0 小时";
        const remainMs = Math.max(0, expiry - Date.now());
        const remainMin = Math.ceil(remainMs / 60_000);
        if (remainMin < 60) return `${remainMin} 分钟`;
        const remainH = (remainMs / 3_600_000).toFixed(1);
        return `${remainH} 小时`;
    }

    /** 外部设置 mute（Dashboard 用） */
    muteChat(chatId: string, hours: number): void {
        const h = Math.max(0.1, Math.min(24, hours));
        const expiryMs = Date.now() + h * 3_600_000;
        this.mutedChats.set(chatId, expiryMs);
        log.info("muteChat (external)", { chatId, hours: h, expiryMs });
    }

    /** 外部解除 mute（Dashboard 用） */
    unmuteChat(chatId: string): void {
        this.mutedChats.delete(chatId);
        log.info("unmuteChat (external)", { chatId });
    }

    /** 获取所有被禁言的聊天 */
    getMutedChats(): Array<{ chatId: string; expiry: number; remaining: string }> {
        const result: Array<{ chatId: string; expiry: number; remaining: string }> = [];
        for (const [chatId, expiry] of this.mutedChats) {
            if (Date.now() >= expiry) {
                this.mutedChats.delete(chatId);
                continue;
            }
            result.push({ chatId, expiry, remaining: this.getMuteRemainingHours(chatId) });
        }
        return result;
    }

    /** 将指定聊天标记为已读（通过 Telegram readHistory） */
    async markAsRead(chatId: string): Promise<void> {
        try {
            await this.handleCall("telegram.readHistory", [chatId]);
        } catch (e) {
            log.debug("markAsRead 失败（非关键）", { chatId, error: String(e).slice(0, 100) });
        }
    }

    // ─── /invisible & /mute 命令处理 ───

    /**
     * 处理 /invisible 和 /mute 命令。
     * 返回 true 表示消息是命令且已处理，调用者应跳过 NC push。
     */
    private async handleBotCommand(
        normalized: NonNullable<ReturnType<TelegramAdapter["normalizeIncomingMessage"]>>,
        _rawMsg: any,
    ): Promise<boolean> {
        const text = normalized.text.trim();

        // ── /invisible ──
        if (/^\/invisible(?:@\S+)?$/i.test(text)) {
            const userId = normalized.userId;
            if (this.invisibleUsers.has(userId)) {
                this.invisibleUsers.delete(userId);
                saveInvisibleUsers(this.invisibleUsers);
                log.info("/invisible OFF", { userId, chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, `👁 你已取消隐身。Bot 将正常处理你的消息。`);
            } else {
                this.invisibleUsers.add(userId);
                saveInvisibleUsers(this.invisibleUsers);
                log.info("/invisible ON", { userId, chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, `🫥 你已开启隐身。你的所有消息将对 Bot 完全不可见（不处理、不记录）。再次发送 /invisible 可取消。`);
            }
            return true;
        }

        // ── /mute [hours] （toggle：无参数时切换；有参数时设置/重置时长） ──
        const muteMatch = text.match(/^\/mute(?:@\S+)?(?:\s+(\d+(?:\.\d+)?))?$/i);
        if (muteMatch) {
            // 无参数 + 已在 mute 中 → 解除禁言（toggle）
            if (!muteMatch[1] && this.isChatMuted(normalized.chatId)) {
                this.mutedChats.delete(normalized.chatId);
                log.info("/mute OFF (toggle)", { chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, `🔊 Bot 禁言已解除。`);
                return true;
            }
            let hours = muteMatch[1] ? parseFloat(muteMatch[1]) : 1;
            hours = Math.max(1, Math.min(24, hours));  // clamp [1, 24]
            const expiryMs = Date.now() + hours * 3_600_000;
            this.mutedChats.set(normalized.chatId, expiryMs);
            log.info("/mute ON", { chatId: normalized.chatId, hours, expiryMs });
            await this.replySafe(normalized.chatId, `🔇 Bot 已在本聊天禁言 ${hours} 小时。期间消息仍会被记录和处理，但 Bot 不会发送任何消息。再次发送 /mute 可解除。`);
            return true;
        }

        // ── /unmute ──
        if (/^\/unmute(?:@\S+)?$/i.test(text)) {
            if (this.mutedChats.has(normalized.chatId)) {
                this.mutedChats.delete(normalized.chatId);
                log.info("/unmute", { chatId: normalized.chatId });
                await this.replySafe(normalized.chatId, `🔊 Bot 禁言已解除。`);
            } else {
                await this.replySafe(normalized.chatId, `ℹ️ Bot 当前未被禁言。`);
            }
            return true;
        }

        return false;
    }

    /**
     * 安全回复：尝试用 client.sendText 发送确认消息，失败时只记日志不抛异常。
     */
    private async replySafe(chatId: string, text: string): Promise<void> {
        try {
            if (this.client?.sendText) {
                const peer = await this.ensurePeerCached(chatId);
                await this.client.sendText(peer, text);
            }
        } catch (err) {
            log.warn("replySafe 发送失败", { chatId, error: String(err) });
        }
    }

    // ─── 拟人化延迟 ───

    /**
     * 根据文字长度计算延迟并 sleep，模拟打字速度。
     * 仅当 humanizedDelay.enabled 且距上次发送时间不足时生效。
     */
    private async applyHumanizedDelay(chatId: string, textLength: number): Promise<void> {
        const hd = this.config.humanizedDelay;
        if (!hd?.enabled) return;

        const { msPerChar, minDelay, maxDelay } = hd;
        const targetDelay = Math.max(minDelay, Math.min(maxDelay, textLength * msPerChar));

        const lastSend = this.lastSendTimes.get(chatId) ?? 0;
        const elapsed = Date.now() - lastSend;

        if (elapsed < targetDelay) {
            const waitMs = targetDelay - elapsed;
            log.debug("applyHumanizedDelay: 等待", { chatId, waitMs, textLength, targetDelay });
            await new Promise(resolve => setTimeout(resolve, waitMs));
        }

        this.lastSendTimes.set(chatId, Date.now());
    }

    private readLimit(value: unknown, fallback: number): number {
        if (typeof value === "object" && value && "limit" in value) {
            const limit = Number((value as { limit?: unknown }).limit);
            return Number.isNaN(limit) ? fallback : limit;
        }
        return fallback;
    }

    private normalizePeerArg(value: unknown): unknown {
        if (typeof value !== "string") return value;
        let trimmed = value.trim();
        // Strip composite key prefix: "telegram:-1001234567" → "-1001234567"
        if (trimmed.startsWith("telegram:")) {
            trimmed = trimmed.slice("telegram:".length);
        }
        if (/^-?\d+$/.test(trimmed)) {
            const asNumber = Number(trimmed);
            if (Number.isSafeInteger(asNumber)) return asNumber;
        }
        return trimmed;
    }

    /**
     * mtcute expects replyTo to be a number (message ID), not a string.
     * Our normalizeMessage() stringifies all IDs, so sandbox code will
     * pass string replyTo values back. Convert them here to avoid
     * "Cannot read properties of undefined (reading 'inputPeer')" crash.
     */
    private normalizeReplyOpts(opts: unknown): unknown {
        if (!opts || typeof opts !== "object") return opts;
        const o = opts as Record<string, unknown>;
        if ("replyTo" in o && typeof o.replyTo === "string") {
            const num = Number(o.replyTo);
            if (!Number.isNaN(num) && Number.isFinite(num)) {
                return { ...o, replyTo: num };
            }
        }
        return opts;
    }

    /**
     * 已解析的 peer 缓存（避免重复解析）
     */
    private resolvedPeers = new Map<number, unknown>();

    /**
     * 确保 peer 在 mtcute 内部缓存中已解析。
     *
     * mtcute 的某些方法（如 getHistory）需要已缓存的 InputPeer，
     * 而 sendText 可以直接用 numeric ID。当 InputPeer 未缓存时
     * 会报 "Cannot read properties of undefined (reading 'inputPeer')"。
     *
     * 解决方案：先尝试 resolvePeer，失败则 getDialogs 预热缓存。
     */
    private async ensurePeerCached(rawPeer: unknown): Promise<unknown> {
        const peer = this.normalizePeerArg(rawPeer);

        // 非 numeric peer（username 等）直接返回，mtcute 可自行解析
        if (typeof peer !== "number") return peer;

        // 检查本地缓存
        if (this.resolvedPeers.has(peer)) {
            return this.resolvedPeers.get(peer)!;
        }

        // 尝试 resolvePeer（mtcute 内部方法，解析 peer 并缓存）
        try {
            if (typeof this.client.resolvePeer === "function") {
                const resolved = await this.client.resolvePeer(peer);
                this.resolvedPeers.set(peer, resolved);
                return resolved;
            }
        } catch (e) {
            log.debug("ensurePeerCached: resolvePeer 失败", { peer, error: String(e) });
        }

        // fallback: 尝试 getInputEntity（某些 mtcute 版本使用此方法）
        try {
            if (typeof this.client.getInputEntity === "function") {
                const resolved = await this.client.getInputEntity(peer);
                this.resolvedPeers.set(peer, resolved);
                return resolved;
            }
        } catch (e) {
            log.debug("ensurePeerCached: getInputEntity 失败", { peer, error: String(e) });
        }

        // fallback: 对负 ID（群组/频道），尝试遍历 dialogs 预热 mtcute 内部缓存
        if (peer < 0) {
            try {
                log.info("ensurePeerCached: 尝试 getDialogs 预热缓存", { peer });
                if (typeof this.client.iterDialogs === "function") {
                    for await (const dialog of this.client.iterDialogs({ limit: 100 })) {
                        // 遍历 dialogs 会让 mtcute 内部缓存所有遇到的 peer
                        const dialogPeer = dialog?.chat ?? dialog?.peer;
                        if (dialogPeer && (dialogPeer.id === peer || String(dialogPeer.id) === String(peer))) {
                            log.info("ensurePeerCached: 在 dialogs 中找到目标 peer", { peer });
                            break;
                        }
                    }
                }

                // dialogs 遍历后再试一次 resolvePeer
                if (typeof this.client.resolvePeer === "function") {
                    const resolved = await this.client.resolvePeer(peer);
                    this.resolvedPeers.set(peer, resolved);
                    return resolved;
                }
            } catch (e) {
                log.warn("ensurePeerCached: getDialogs 预热失败", { peer, error: String(e) });
            }
        }

        // 所有解析方式均失败 — 返回原始 ID，让调用方自行处理错误
        log.warn("ensurePeerCached: 所有解析方式均失败，返回原始 ID", { peer });
        return peer;
    }

    private normalizeIncomingMessage(msg: any): {
        chatId: string;
        userId: string;
        displayName: string;
        username?: string;
        text: string;
        timestamp: string;
        messageId?: string;
        replyToMessageId?: string;
        chatTitle?: string;
        chatType?: string;
        isDirectMessage?: boolean;
        mentionsAgent?: boolean;
        mediaInfo?: MediaInfo;
    } | null {
        const plain = this.normalizeMessage(msg);
        if (!plain.chat?.id) return null;

        const senderId = plain.sender?.id ?? "0";
        const numericChatId = Number(plain.chat.id);
        const isDirectMessage = plain.chat.type === "private" || (!Number.isNaN(numericChatId) && numericChatId > 0);
        const mentionsAgent = Boolean(plain.isMention);

        // ── 媒体元数据提取 ──
        const mediaInfo = plain.mediaInfo;

        // 对纯 media 消息生成占位文本，确保 text 非空
        let text = plain.text ?? "";
        if (!text && mediaInfo) {
            switch (mediaInfo.type) {
                case "photo":
                    text = "[📷 图片]";
                    break;
                case "sticker":
                    text = mediaInfo.emoji ? `[🎭 贴纸: ${mediaInfo.emoji}]` : "[🎭 贴纸]";
                    break;
                case "video":
                    text = "[🎬 视频]";
                    break;
                case "animation":
                    text = "[🎞 GIF]";
                    break;
                case "document":
                    text = "[📎 文件]";
                    break;
                default:
                    text = "[📎 媒体]";
                    break;
            }
        }

        return {
            chatId: composeChatId("telegram", plain.chat.id),
            userId: /^-?\d+$/.test(senderId) ? composeChatId("telegram", senderId) : senderId,
            displayName: plain.sender?.displayName ?? plain.sender?.firstName ?? "Unknown",
            username: plain.sender?.username ?? undefined,
            text,
            timestamp: plain.date,
            messageId: plain.id,
            replyToMessageId: plain.replyToMessage?.id ?? undefined,
            chatTitle: plain.chat.title,
            chatType: plain.chat.type,
            isDirectMessage,
            mentionsAgent,
            mediaInfo,
        };
    }

    private normalizeDialog(dialog: any): PlainDialog {
        return {
            peer: this.normalizePeer(dialog?.peer),
            lastMessage: dialog?.lastMessage ? this.normalizeMessage(dialog.lastMessage) : undefined,
            unreadCount: Number(dialog?.unreadCount ?? 0),
        };
    }

    private normalizeMessage(message: any): PlainMessage {
        return {
            id: String(message?.id ?? ""),
            text: String(message?.text ?? ""),
            date: this.normalizeDate(message?.date),
            chat: this.normalizeChat(message?.chat),
            sender: message?.sender ? this.normalizeUser(message.sender) : null,
            isMention: Boolean(message?.isMention),
            replyToMessage: message?.replyToMessage ? { id: String(message.replyToMessage.id ?? "") } : undefined,
            media: message?.media,
            mediaInfo: this.extractMediaInfo(message?.media),
        };
    }

    /**
     * 从 mtcute msg.media 对象提取结构化媒体元数据。
     * mtcute media 对象有 .type 字段: "photo", "sticker", "video", "document", "animation" 等。
     */
    private extractMediaInfo(media: any): MediaInfo | undefined {
        if (!media) return undefined;

        const rawType = String(media.type ?? "");
        let type: MediaInfo["type"];
        switch (rawType) {
            case "photo": type = "photo"; break;
            case "sticker": type = "sticker"; break;
            case "video": type = "video"; break;
            case "document": type = "document"; break;
            case "animation": type = "animation"; break;
            default:
                // 未知类型但有 media 对象 → 标记为 other
                if (!rawType) return undefined;
                type = "other";
                break;
        }

        return {
            type,
            fileId: typeof media.fileId === "string" ? media.fileId : undefined,
            uniqueFileId: typeof media.uniqueFileId === "string" ? media.uniqueFileId : undefined,
            emoji: typeof media.emoji === "string" ? media.emoji : undefined,
            mimeType: typeof media.mimeType === "string" ? media.mimeType : undefined,
            fileName: typeof media.fileName === "string" ? media.fileName : undefined,
            width: typeof media.width === "number" ? media.width : undefined,
            height: typeof media.height === "number" ? media.height : undefined,
            fileSize: typeof media.fileSize === "number" ? media.fileSize
                : typeof media.size === "number" ? media.size : undefined,
        };
    }

    private normalizePeer(peer: any): PlainUser | PlainChat {
        const type = this.normalizeChatType(peer?.type);
        if (type === "private" || typeof peer?.firstName === "string" || typeof peer?.isBot === "boolean") {
            return this.normalizeUser(peer);
        }
        return this.normalizeChat(peer);
    }

    private normalizeUser(user: any): PlainUser {
        return {
            id: String(user?.id ?? ""),
            displayName: this.pickDisplayName(user),
            title: typeof user?.title === "string" ? user.title : undefined,
            username: typeof user?.username === "string" ? user.username : undefined,
            firstName: typeof user?.firstName === "string" ? user.firstName : undefined,
            lastName: typeof user?.lastName === "string" ? user.lastName : undefined,
            isBot: Boolean(user?.isBot),
        };
    }

    private normalizeChat(chat: any): PlainChat {
        return {
            id: String(chat?.id ?? ""),
            title: typeof chat?.title === "string" ? chat.title : this.pickDisplayName(chat),
            username: typeof chat?.username === "string" ? chat.username : undefined,
            type: this.normalizeChatType(chat?.type),
        };
    }

    private normalizeChatType(value: unknown): PlainChat["type"] {
        if (value === "private" || value === "group" || value === "supergroup" || value === "channel") {
            return value;
        }
        if (value === "user") {
            return "private";
        }
        return "group";
    }

    private normalizeDate(value: unknown): string {
        if (value instanceof Date) return value.toISOString();
        if (typeof value === "number") return new Date(value).toISOString();
        if (typeof value === "string") {
            const parsed = Date.parse(value);
            return Number.isNaN(parsed) ? new Date().toISOString() : new Date(parsed).toISOString();
        }
        return new Date().toISOString();
    }

    private pickDisplayName(value: any): string | undefined {
        if (typeof value?.displayName === "string" && value.displayName.length > 0) return value.displayName;
        if (typeof value?.title === "string" && value.title.length > 0) return value.title;
        if (typeof value?.firstName === "string" && value.firstName.length > 0) {
            const last = typeof value?.lastName === "string" && value.lastName.length > 0 ? ` ${value.lastName}` : "";
            return `${value.firstName}${last}`;
        }
        if (typeof value?.username === "string" && value.username.length > 0) return value.username;
        return undefined;
    }

    /**
     * 从 mtcute 消息对象中提取 media.fileId
     * 用于 file reference refetch 后获取新的 fileId
     */
    private extractFileIdFromMessage(msg: any): string | undefined {
        const media = msg?.media;
        if (!media) return undefined;
        if (typeof media.fileId === "string") return media.fileId;
        return undefined;
    }

    // ─── 扩展 Normalizer ───

    private normalizeFullUser(user: any): Record<string, unknown> {
        const base = this.normalizeUser(user);
        return {
            ...base,
            bio: typeof user?.bio === "string" ? user.bio : undefined,
            commonChatsCount: typeof user?.commonChatsCount === "number" ? user.commonChatsCount : undefined,
        };
    }

    private normalizeFullChat(chat: any): Record<string, unknown> {
        const base = this.normalizeChat(chat);
        return {
            ...base,
            about: typeof chat?.bio === "string" ? chat.bio : undefined,
            membersCount: typeof chat?.membersCount === "number" ? chat.membersCount : undefined,
            onlineCount: typeof chat?.onlineCount === "number" ? chat.onlineCount : undefined,
            isForum: Boolean(chat?.isForum),
        };
    }

    private normalizeForumTopic(topic: any): Record<string, unknown> {
        return {
            id: Number(topic?.id ?? 0),
            title: String(topic?.title ?? ""),
            isClosed: Boolean(topic?.isClosed),
            isPinned: Boolean(topic?.isPinned),
            creatorId: Number(topic?.creator?.id ?? topic?.creatorId ?? 0),
            unreadCount: Number(topic?.unreadCount ?? 0),
        };
    }

    private normalizePoll(media: any): Record<string, unknown> | null {
        if (!media || media.type !== "poll") return null;
        const answers = Array.isArray(media.answers)
            ? media.answers.map((a: any) => ({
                text: typeof a?.text === "string" ? a.text : String(a?.text ?? ""),
                voterCount: Number(a?.voters ?? a?.voterCount ?? 0),
                chosen: Boolean(a?.chosen),
                correct: Boolean(a?.correct),
            }))
            : [];
        return {
            type: "poll",
            id: String(media.id ?? ""),
            question: typeof media.question === "string" ? media.question : String(media.question ?? ""),
            answers,
            totalVoters: Number(media.voters ?? media.totalVoters ?? 0),
            isClosed: Boolean(media.isClosed),
            isPublic: Boolean(media.isPublic),
            isQuiz: Boolean(media.isQuiz),
            isMultiple: Boolean(media.isMultiple),
            solution: typeof media.solution === "string" ? media.solution : undefined,
        };
    }
}

async function defaultTelegramClientFactory(config: TelegramConfig): Promise<TelegramClientLike> {
    const { TelegramClient } = await import("@mtcute/node");
    return new TelegramClient({
        apiId: Number(config.apiId),
        apiHash: config.apiHash,
        storage: "workspace/tg-session/account",
    }) as TelegramClientLike;
}
