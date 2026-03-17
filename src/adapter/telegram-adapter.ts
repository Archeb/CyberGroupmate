/**
 * telegram-adapter.ts — 官方 Telegram ingress adapter
 *
 * 宿主侧负责：
 * - 建立 mtcute 连接
 * - 监听 Telegram 消息并标准化后推入 NotificationCenter
 * - 通过 host-call 为 sandbox 提供 ctx.tg 代码接口
 */

import type { NotificationCenter } from "../event/notification-center.js";
import type { TelegramConfig } from "../core/config.js";
import type { PlatformAdapter } from "./platform-adapter.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("telegram-adapter");

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
    downloadBuffer?(media: unknown): Promise<Buffer>;
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

    constructor(
        private config: TelegramConfig,
        private nc: NotificationCenter,
        private promptUser: PromptHandler,
        private print: PrintHandler = console.log,
        private createClient: TelegramClientFactory = defaultTelegramClientFactory,
    ) {}

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
                text: normalized.text,
                timestamp: normalized.timestamp,
                messageId: normalized.messageId,
                replyToMessageId: normalized.replyToMessageId,
                chatTitle: normalized.chatTitle,
                chatType: normalized.chatType,
                isDirectMessage: normalized.isDirectMessage,
                mentionsAgent: normalized.mentionsAgent,
                payload: {
                    scene: "telegram",
                    chatId: normalized.chatId,
                    userId: normalized.userId,
                    displayName: normalized.displayName,
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

        switch (method) {
            case "telegram.getMe":
                return this.selfUser ?? this.normalizeUser(await this.client.getMe());
            case "telegram.sendText": {
                const peer = await this.ensurePeerCached(args[0]);
                const opts = this.normalizeReplyOpts(args[2]);
                return this.normalizeMessage(
                    await this.client.sendText(peer, args[1], opts),
                );
            }
            case "telegram.sendMedia": {
                const peer = await this.ensurePeerCached(args[0]);
                const opts = this.normalizeReplyOpts(args[2]);
                return this.normalizeMessage(
                    await this.client.sendMedia(peer, args[1], opts),
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
                            `请直接使用 ctx.tg.sendText(chatId, text) 发送消息，不需要先获取历史消息。`
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
                // args[0] = fileId string (mtcute file ID)
                const fileIdOrMedia = args[0];
                if (!fileIdOrMedia) throw new Error("downloadMedia: fileId is required");
                if (typeof this.client.downloadBuffer !== "function") {
                    throw new Error("downloadMedia: client.downloadBuffer not available");
                }
                const buffer = await this.client.downloadBuffer(fileIdOrMedia);
                return { buffer: buffer.toString("base64"), size: buffer.length };
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

    private readLimit(value: unknown, fallback: number): number {
        if (typeof value === "object" && value && "limit" in value) {
            const limit = Number((value as { limit?: unknown }).limit);
            return Number.isNaN(limit) ? fallback : limit;
        }
        return fallback;
    }

    private normalizePeerArg(value: unknown): unknown {
        if (typeof value !== "string") return value;
        const trimmed = value.trim();
        if (/^-?\d+$/.test(trimmed)) {
            const asNumber = Number(trimmed);
            if (Number.isSafeInteger(asNumber)) return asNumber;
        }
        return value;
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
            chatId: plain.chat.id,
            userId: senderId,
            displayName: plain.sender?.displayName ?? plain.sender?.firstName ?? "Unknown",
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
}

async function defaultTelegramClientFactory(config: TelegramConfig): Promise<TelegramClientLike> {
    const { TelegramClient } = await import("@mtcute/node");
    return new TelegramClient({
        apiId: Number(config.apiId),
        apiHash: config.apiHash,
        storage: "workspace/tg-session/account",
    }) as TelegramClientLike;
}
