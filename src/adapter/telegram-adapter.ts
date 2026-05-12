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
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Long } from "@mtcute/node";
import { isAllowedTelegramMtcutePassthroughMethod } from "../core/telegram-mtcute-passthrough.js";

const log = createLogger("telegram-adapter");

/** 白名单条目：去掉 `telegram:` 前缀并 trim，便于与 composite chatId 比对 */
function normalizeWhitelistId(raw: string): string {
    let s = raw.trim();
    if (s.startsWith("telegram:")) s = s.slice("telegram:".length);
    return s;
}

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
    findDialogs?(peers: unknown): Promise<unknown[]>;
    _normalizeInputFile?(input: unknown, params: { fileName?: string; fileMime?: string; fileSize?: number }): Promise<unknown>;
    // ─── 扩展方法 ───
    getFullUser?(userId: unknown): Promise<unknown>;
    getFullChat?(chatId: unknown): Promise<unknown>;
    getForumTopics?(chatId: unknown, params?: unknown): Promise<unknown>;
    searchMessages?(params: unknown): Promise<unknown>;
    sendMediaGroup?(chatId: unknown, medias: unknown[], opts?: unknown): Promise<unknown[]>;
    forwardMessagesById?(params: unknown): Promise<unknown[]>;
    sendReaction?(params: unknown): Promise<unknown>;
    editMessage?(params: unknown): Promise<unknown>;
    deleteMessagesById?(chatId: unknown, ids: number[], params?: unknown): Promise<void>;
    pinMessage?(params: unknown): Promise<unknown>;
    unpinMessage?(params: unknown): Promise<void>;
    getMessageReactionsById?(chatId: unknown, messageIds: number[]): Promise<unknown[]>;
    closePoll?(params: unknown): Promise<unknown>;
    resolvePeer?(peer: unknown): Promise<unknown>;
    resolvePhoneNumber?(phone: string, force?: boolean): Promise<unknown>;
    getInputEntity?(peer: unknown): Promise<unknown>;
    joinChannel?(peer: unknown): Promise<unknown>;
    leaveChannel?(peer: unknown): Promise<unknown>;
    resolveUser?(peer: unknown, force?: boolean): Promise<unknown>;
    call?(request: unknown, params?: unknown): Promise<unknown>;
    canSendStory?(peer: unknown): Promise<unknown>;
    sendStory?(params: unknown): Promise<unknown>;
    sendStoryReaction?(params: unknown): Promise<unknown>;
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
    /** 入站时自动下载到本地后的绝对路径（20MB 内） */
    filePath?: string;
    /** 下载状态。too_large 时需要 sandbox 手动调用 downloadMedia/getMessage 再自行处理。 */
    downloadStatus?: "downloaded" | "cached" | "too_large" | "failed";
    downloadError?: string;
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
    forwardFrom?: string;
    forwardFromUrl?: string;
}

interface PlainDialog {
    peer: PlainUser | PlainChat;
    lastMessage?: PlainMessage;
    unreadCount: number;
}

interface MeetPeerOptions {
    kind?: "id" | "username" | "phone";
    /** Optional source chat + message IDs to fetch first, so mtcute can cache sender access hashes. */
    chatId?: unknown;
    messageIds?: number[];
    dialogsLimit?: number;
    force?: boolean;
}

type NormalizedIncomingMessage = {
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
};

type PreparedTelegramSticker =
    | { kind: "static"; path: string; buffer: Buffer; fileName: string; mimeType: "image/webp" }
    | { kind: "video"; path: string; fileName: string; mimeType: "video/webm" };

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

    /** 白名单 ID 集合（配置加载时构建，与 rawId 比对） */
    private readonly whitelistGroupIds: Set<string>;
    private readonly whitelistUserIds: Set<string>;

    constructor(
        private config: TelegramConfig,
        private nc: NotificationCenter,
        private promptUser: PromptHandler,
        private print: PrintHandler = console.log,
        private createClient: TelegramClientFactory = defaultTelegramClientFactory,
        private mediaDownloader?: MediaDownloader,
    ) {
        const wl = config.whitelist;
        this.whitelistGroupIds = new Set((wl?.groups ?? []).map(normalizeWhitelistId));
        this.whitelistUserIds = new Set((wl?.users ?? []).map(normalizeWhitelistId));
    }

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
        this.rememberPeerObject(self);

        this.messageHandler = async (msg: any) => {
            const normalized = await this.normalizeIncomingMessage(msg);
            if (!normalized || !normalized.messageId || !normalized.text) return;

            // ─── 入站白名单（开启时仅处理列出的群组或私聊） ───
            if (!this.passesTelegramWhitelist(normalized)) {
                log.debug("白名单拒绝", { chatId: normalized.chatId, isDirectMessage: normalized.isDirectMessage });
                return;
            }

            // ─── /invisible & /mute 命令拦截 ───
            const cmdHandled = await this.handleBotCommand(normalized, msg);
            if (cmdHandled) return;  // 命令消息不进入 NC

            // ─── invisible 用户消息静默丢弃 ───
            if (this.invisibleUsers.has(normalized.userId)) {
                log.debug("invisible 用户消息已丢弃", { userId: normalized.userId, chatId: normalized.chatId });
                return;
            }

            if (normalized.mediaInfo && normalized.messageId) {
                await this.downloadIncomingMedia(normalized.mediaInfo, normalized.chatId, normalized.messageId);
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
            "telegram.forwardMessage",
            "telegram.sendPoll",
            "telegram.sendInlineBotResult",
            "telegram.sendReaction",
            "telegram.editMessage",
            "telegram.deleteMessages",
            "telegram.pinMessage",
            "telegram.unpinMessage",
            "telegram.sendStory",
            "telegram.sendStoryReaction",
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
        const MUTE_BLOCKED_METHODS = ["telegram.sendText", "telegram.sendMedia", "telegram.sendFile", "telegram.sendSticker", "telegram.sendTyping", "telegram.sendInlineBotResult", "telegram.forwardMessage"];
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
                        // 相对路径基于 workspace 目录解析（与 sandbox worker CWD 一致）
                        const workspaceDir = pathMod.join(process.cwd(), "workspace");
                        const resolvedPath = fileStr.startsWith("/") ? pathMod.resolve(fileStr) : pathMod.resolve(workspaceDir, fileStr);
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
                // 相对路径基于 workspace 目录解析（与 sandbox worker CWD 一致）
                const workspaceDir = pathMod.join(process.cwd(), "workspace");
                const resolvedPath = filePath.startsWith("/") ? pathMod.resolve(filePath) : pathMod.resolve(workspaceDir, filePath);

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
            case "telegram.getUser": {
                const peer = await this.ensurePeerCached(args[0]);
                return this.normalizeUser(await this.client.getUser(peer));
            }
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
            case "telegram.findDialogs": {
                const limit = this.readLimit(args[1], 200);
                const dialogs = await this.findDialogsForPeers(args[0], limit);
                return dialogs.map((dialog: any) => this.normalizeDialog(dialog));
            }
            case "telegram.meetPeer":
            case "telegram.resolvePeer":
                return this.meetPeerForAgent(args[0], args[1]);
            case "telegram.queryInlineBot": {
                if (typeof this.client.call !== "function") {
                    throw new Error("queryInlineBot requires mtcute client.call support");
                }
                const inlineBot = await this.resolveInputUser(args[0]);
                const query = String(args[1] ?? "");
                const inlineOpts = (args[2] ?? {}) as Record<string, unknown>;
                const inlinePeer = await this.ensurePeerCached(inlineOpts.peer ?? "me");
                const raw = await this.client.call({
                    _: "messages.getInlineBotResults",
                    bot: inlineBot,
                    peer: inlinePeer,
                    query,
                    offset: typeof inlineOpts.offset === "string" ? inlineOpts.offset : "",
                });
                return this.normalizeInlineBotResults(raw);
            }
            case "telegram.sendInlineBotResult": {
                if (typeof this.client.call !== "function") {
                    throw new Error("sendInlineBotResult requires mtcute client.call support");
                }
                const peer = await this.ensurePeerCached(args[0]);
                const queryId = this.toTelegramLong(args[1], "queryId");
                const resultId = String(args[2] ?? "");
                if (!resultId) throw new Error("sendInlineBotResult: resultId is required");
                const inlineSendOpts = (args[3] ?? {}) as Record<string, unknown>;
                const replyTo = this.buildInputReplyTo(inlineSendOpts);
                await this.applyHumanizedDelay(String(args[0] ?? ""), 0);
                const result = await this.client.call({
                    _: "messages.sendInlineBotResult",
                    peer,
                    queryId,
                    id: resultId,
                    randomId: this.randomLong(),
                    silent: inlineSendOpts.silent === true,
                    hideVia: inlineSendOpts.hideVia === true,
                    clearDraft: inlineSendOpts.clearDraft === true,
                    replyTo,
                });
                return this.toPlainTelegramValue(result);
            }
            case "telegram.mtcute":
                return this.handleMtcutePassthrough(args);
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
                const buffer = await this.downloadMediaBuffer(fileIdOrMedia, args[1], args[2], uniqueFileId);
                return { buffer: buffer.toString("base64"), size: buffer.length };
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
                const preparedSticker = this.prepareOutgoingStickerForTelegram(stickerPath);
                const stickerOpts = args[2] ?? undefined;
                if (preparedSticker.kind === "video") {
                    const videoStickerMedia = await this.buildTelegramVideoStickerMedia(preparedSticker);
                    return this.handleCall("telegram.sendMedia", [
                        stickerTarget,
                        videoStickerMedia,
                        stickerOpts,
                    ]);
                }
                return this.handleCall("telegram.sendMedia", [
                    stickerTarget,
                    {
                        type: "sticker",
                        file: preparedSticker.buffer,
                        fileName: preparedSticker.fileName,
                        fileMime: preparedSticker.mimeType,
                    },
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
                            // 相对路径基于 workspace 目录解析（与 sandbox worker CWD 一致）
                            const workspaceDir = pathMod.join(process.cwd(), "workspace");
                            const resolvedPath = fileStr.startsWith("/") ? pathMod.resolve(fileStr) : pathMod.resolve(workspaceDir, fileStr);
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
            case "telegram.forwardMessage": {
                if (typeof this.client.forwardMessagesById !== "function") {
                    throw new Error("forwardMessage is not supported by the current Telegram client");
                }
                const toChatId = await this.ensurePeerCached(args[0]);
                const fromChatId = await this.ensurePeerCached(args[1]);
                const messageIds = this.normalizeMessageIds(args[2]);
                const forwardOpts = await this.normalizeForwardMessageOpts(args[3]);
                await this.applyHumanizedDelay(String(args[0] ?? ""), 0);
                const sentMsgs = await this.client.forwardMessagesById({
                    ...forwardOpts,
                    toChatId,
                    fromChatId,
                    messages: messageIds,
                });
                const normalized = Array.isArray(sentMsgs)
                    ? sentMsgs.map((m: any) => this.normalizeMessage(m))
                    : [];
                return Array.isArray(args[2]) ? normalized : normalized[0] ?? null;
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
            case "telegram.canSendStory": {
                if (typeof this.client.canSendStory !== "function") {
                    throw new Error("canSendStory is not supported by the current Telegram client");
                }
                const storyPeer = await this.resolveStoryPeer(args[0] ?? "me");
                return this.toPlainTelegramValue(await this.client.canSendStory(storyPeer));
            }
            case "telegram.sendStory": {
                if (typeof this.client.sendStory !== "function") {
                    throw new Error("sendStory is not supported by the current Telegram client");
                }
                const rawStoryParams = args.length > 1 && args[1] && typeof args[1] === "object"
                    ? { ...(args[1] as Record<string, unknown>), peer: args[0] }
                    : args[0];
                const storyParams = await this.prepareSendStoryParams(rawStoryParams);
                const story = await this.client.sendStory(storyParams);
                return this.toPlainTelegramValue(story);
            }
            case "telegram.sendStoryReaction": {
                if (typeof this.client.sendStoryReaction !== "function") {
                    throw new Error("sendStoryReaction is not supported by the current Telegram client");
                }
                const storyPeer = await this.resolveStoryPeer(args[0]);
                const storyId = Number(args[1]);
                if (!Number.isFinite(storyId)) throw new Error("sendStoryReaction: storyId must be a number");
                const reaction = this.normalizeStoryReaction(args[2]);
                const storyReactionOpts = (args[3] ?? {}) as Record<string, unknown>;
                await this.client.sendStoryReaction({
                    peerId: storyPeer,
                    storyId,
                    reaction,
                    addToRecent: storyReactionOpts.addToRecent === true,
                });
                return null;
            }
            default:
                throw new Error(`Unsupported TelegramAdapter call: ${method}`);
        }
    }

    private async resolveInputUser(peer: unknown): Promise<unknown> {
        if (peer && typeof peer === "object") {
            const raw = peer as Record<string, unknown>;
            if (typeof raw._ === "string" && raw._.startsWith("inputUser")) return peer;
        }
        if (typeof this.client.resolveUser !== "function") {
            throw new Error("resolveInputUser requires mtcute client.resolveUser support");
        }
        return this.client.resolveUser(this.normalizePeerArg(peer));
    }

    private async handleMtcutePassthrough(args: unknown[]): Promise<unknown> {
        const methodName = String(args[0] ?? "");
        if (!isAllowedTelegramMtcutePassthroughMethod(methodName)) {
            throw new Error(`telegram.${methodName || "(empty)"} is not exposed through built-in guides`);
        }

        const fn = (this.client as Record<string, unknown>)[methodName];
        if (typeof fn !== "function") {
            throw new Error(`mtcute client does not support ${methodName}`);
        }

        const callArgs = await Promise.all(
            args.slice(1).map(arg => this.prepareMtcutePassthroughArg(arg)),
        );
        const result = (fn as (...callArgs: unknown[]) => unknown).apply(this.client, callArgs);
        return this.toPlainTelegramValue(await this.materializeMtcutePassthroughResult(result));
    }

    private async materializeMtcutePassthroughResult(result: unknown): Promise<unknown> {
        const awaited = await result;
        if (!awaited || typeof awaited !== "object") return awaited;
        const maybeAsyncIterable = awaited as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };
        if (typeof maybeAsyncIterable[Symbol.asyncIterator] !== "function") return awaited;

        const items: unknown[] = [];
        for await (const item of awaited as AsyncIterable<unknown>) {
            items.push(item);
            if (items.length >= 500) break;
        }
        return items;
    }

    private async prepareMtcutePassthroughArg(value: unknown, key?: string): Promise<unknown> {
        if (typeof value === "string") {
            const normalized = this.normalizeMtcuteStringArg(value, key);
            return this.isFileLikeKey(key) ? this.prepareMtcuteFileLike(normalized) : normalized;
        }
        if (Array.isArray(value)) {
            return Promise.all(value.map(item => this.prepareMtcutePassthroughArg(item, key)));
        }
        if (!value || typeof value !== "object") return value;
        if (value instanceof Date || Buffer.isBuffer(value) || value instanceof Uint8Array || Long.isLong(value)) {
            return value;
        }
        const raw = value as Record<string, unknown>;
        if (typeof raw.low === "number" && typeof raw.high === "number" && Object.keys(raw).every(k => k === "low" || k === "high" || k === "unsigned")) {
            return Long.fromBits(raw.low, raw.high, raw.unsigned === true);
        }

        const output: Record<string, unknown> = {};
        for (const [childKey, childValue] of Object.entries(raw)) {
            output[childKey] = await this.prepareMtcutePassthroughArg(childValue, childKey);
        }
        return output;
    }

    private normalizeMtcuteStringArg(value: string, key?: string): string | number {
        const trimmed = value.trim();
        const stripped = trimmed.startsWith("telegram:") ? trimmed.slice("telegram:".length) : trimmed;
        if (this.isPeerLikeKey(key) && /^-?\d+$/.test(stripped)) {
            const asNumber = Number(stripped);
            if (Number.isSafeInteger(asNumber)) return asNumber;
        }
        return stripped;
    }

    private isPeerLikeKey(key?: string): boolean {
        if (!key) return false;
        return /^(chat|chatId|peer|peerId|user|userId|fromChatId|toChatId|participantId|owner|asPeer|sendAs)$/i.test(key);
    }

    private isFileLikeKey(key?: string): boolean {
        if (!key) return false;
        return /^(file|thumb|thumbnail|videoCover|sticker|photo)$/i.test(key);
    }

    private normalizeInlineBotResults(raw: unknown): Record<string, unknown> {
        const source = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const rawResults = Array.isArray(source.results) ? source.results : [];
        return {
            queryId: this.longToString(source.queryId),
            nextOffset: typeof source.nextOffset === "string" ? source.nextOffset : undefined,
            results: rawResults.map((item) => this.normalizeInlineBotResult(item)),
            raw: this.toPlainTelegramValue(raw),
        };
    }

    private normalizeInlineBotResult(raw: unknown): Record<string, unknown> {
        const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const title = typeof item.title === "string" ? item.title : undefined;
        const description = typeof item.description === "string" ? item.description : undefined;
        return {
            id: String(item.id ?? ""),
            type: typeof item.type === "string" ? item.type : typeof item._ === "string" ? item._ : undefined,
            title,
            description,
            sendMessage: this.toPlainTelegramValue(item.sendMessage),
            raw: this.toPlainTelegramValue(raw),
        };
    }

    private buildInputReplyTo(opts: Record<string, unknown>): unknown {
        if (!("replyTo" in opts) || opts.replyTo == null) return undefined;
        const replyToMsgId = Number(opts.replyTo);
        if (!Number.isFinite(replyToMsgId)) return undefined;
        const topMsgId = Number(opts.topMsgId);
        return {
            _: "inputReplyToMessage",
            replyToMsgId,
            ...(Number.isFinite(topMsgId) ? { topMsgId } : {}),
        };
    }

    private toTelegramLong(value: unknown, label: string): Long {
        if (Long.isLong(value)) return value;
        if (typeof value === "number" && Number.isFinite(value)) {
            return Long.fromNumber(value);
        }
        if (typeof value === "string" && value.trim()) {
            return Long.fromString(value.trim(), false, 10);
        }
        if (value && typeof value === "object") {
            const raw = value as Record<string, unknown>;
            if (typeof raw.low === "number" && typeof raw.high === "number") {
                return Long.fromBits(raw.low, raw.high, raw.unsigned === true);
            }
        }
        throw new Error(`${label} must be a Telegram Long-compatible string, number, or { low, high } object`);
    }

    private randomLong(): Long {
        const buf = randomBytes(8);
        return Long.fromBits(buf.readInt32LE(0), buf.readInt32LE(4), false);
    }

    private longToString(value: unknown): string {
        if (Long.isLong(value)) return value.toString();
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "number" || typeof value === "string") return String(value);
        if (value && typeof value === "object") {
            const raw = value as Record<string, unknown>;
            if (typeof raw.low === "number" && typeof raw.high === "number") {
                return Long.fromBits(raw.low, raw.high, raw.unsigned === true).toString();
            }
        }
        return "";
    }

    private async resolveStoryPeer(peer: unknown): Promise<unknown> {
        if (peer == null) return "me";
        if (typeof peer === "string") {
            const trimmed = peer.trim();
            if (!trimmed || trimmed === "me" || trimmed === "self") return "me";
        }
        return this.ensurePeerCached(peer);
    }

    private async prepareSendStoryParams(rawParams: unknown): Promise<Record<string, unknown>> {
        if (!rawParams || typeof rawParams !== "object" || Array.isArray(rawParams)) {
            throw new Error("sendStory: params object is required");
        }
        const params = rawParams as Record<string, unknown>;
        if (!("media" in params)) throw new Error("sendStory: media is required");
        return {
            ...params,
            peer: await this.resolveStoryPeer(params.peer ?? "me"),
            media: this.prepareMtcuteMediaLike(params.media),
        };
    }

    private prepareMtcuteMediaLike(media: unknown): unknown {
        if (typeof media === "string") {
            return this.prepareMtcuteFileLike(media);
        }
        if (media && typeof media === "object" && !Array.isArray(media)) {
            const input = media as Record<string, unknown>;
            return {
                ...input,
                file: this.prepareMtcuteFileLike(input.file),
                thumb: this.prepareMtcuteFileLike(input.thumb),
                videoCover: this.prepareMtcuteFileLike(input.videoCover),
            };
        }
        return media;
    }

    private prepareMtcuteFileLike(file: unknown): unknown {
        if (typeof file !== "string") return file;
        const trimmed = file.trim();
        if (!trimmed) return file;
        if (/^(https?:|data:|file:)/i.test(trimmed)) return trimmed;

        const candidates = [
            path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed),
            path.resolve(process.cwd(), "workspace", trimmed),
        ];
        const existing = candidates.find(candidate => fs.existsSync(candidate));
        return existing ? `file:${existing}` : file;
    }

    private normalizeStoryReaction(reaction: unknown): unknown {
        if (reaction && typeof reaction === "object" && !Array.isArray(reaction)) {
            const raw = reaction as Record<string, unknown>;
            if (typeof raw.emoji === "string") return raw.emoji;
            if (typeof raw.emoticon === "string") return raw.emoticon;
        }
        return reaction;
    }

    private toPlainTelegramValue(value: unknown, seen = new WeakSet<object>()): unknown {
        if (value == null) return value;
        if (Long.isLong(value)) return value.toString();
        if (typeof value === "bigint") return value.toString();
        if (typeof value !== "object") return value;
        if (value instanceof Date) return value.toISOString();
        if (Buffer.isBuffer(value)) {
            return { buffer: value.toString("base64"), size: value.length };
        }
        if (value instanceof Uint8Array) {
            return { buffer: Buffer.from(value).toString("base64"), size: value.byteLength };
        }
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
        if (Array.isArray(value)) {
            return value.map(item => this.toPlainTelegramValue(item, seen));
        }

        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            if (typeof item === "function" || typeof item === "symbol") continue;
            output[key] = this.toPlainTelegramValue(item, seen);
        }
        return output;
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

    private prepareOutgoingStickerForTelegram(sourcePath: string): PreparedTelegramSticker {
        const lowerPath = sourcePath.toLowerCase();
        if (lowerPath.endsWith(".tgs")) {
            throw new Error(`sendSticker: 暂不支持发送 TGS 动态贴纸 (${path.basename(sourcePath)})`);
        }
        if (lowerPath.endsWith(".webm")) {
            return {
                kind: "video",
                path: sourcePath,
                fileName: this.ensureFileNameExtension(path.basename(sourcePath), ".webm"),
                mimeType: "video/webm",
            };
        }
        if (lowerPath.endsWith(".webp")) {
            return {
                kind: "static",
                path: sourcePath,
                buffer: fs.readFileSync(sourcePath),
                fileName: this.ensureFileNameExtension(path.basename(sourcePath), ".webp"),
                mimeType: "image/webp",
            };
        }

        if (this.isAnimatedStickerSource(sourcePath)) {
            try {
                const webmPath = this.convertStickerAnimationToTelegramWebm(sourcePath);
                return {
                    kind: "video",
                    path: webmPath,
                    fileName: path.basename(webmPath),
                    mimeType: "video/webm",
                };
            } catch (err) {
                log.warn("sendSticker: GIF 转 webm 失败，降级为静态 webp", {
                    sourcePath,
                    error: String(err).slice(0, 200),
                });
            }
        }

        const webpPath = this.convertStickerImageToTelegramWebp(sourcePath);
        return {
            kind: "static",
            path: webpPath,
            buffer: fs.readFileSync(webpPath),
            fileName: path.basename(webpPath),
            mimeType: "image/webp",
        };
    }

    private convertStickerImageToTelegramWebp(sourcePath: string): string {
        const outPath = this.outgoingTelegramStickerPath(sourcePath, "static-webp-v1", ".webp");
        if (this.hasUsableFile(outPath)) return outPath;

        const attempts = [
            { size: 512, quality: 90 },
            { size: 512, quality: 80 },
            { size: 384, quality: 80 },
            { size: 320, quality: 75 },
        ];
        let lastError: unknown;
        for (const attempt of attempts) {
            try {
                execFileSync("ffmpeg", [
                    "-hide_banner", "-loglevel", "error",
                    "-y",
                    "-i", sourcePath,
                    "-vf", `scale=${attempt.size}:${attempt.size}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba`,
                    "-frames:v", "1",
                    "-an",
                    "-c:v", "libwebp",
                    "-quality", String(attempt.quality),
                    "-compression_level", "6",
                    outPath,
                ], {
                    timeout: 15000,
                    maxBuffer: 20 * 1024 * 1024,
                });
                if (this.hasUsableFile(outPath)) {
                    if (fs.statSync(outPath).size <= 512 * 1024 || attempt === attempts.at(-1)) {
                        return outPath;
                    }
                }
            } catch (err) {
                lastError = err;
            }
        }
        throw new Error(`sendSticker: 贴纸转 WebP 失败: ${String(lastError ?? "unknown error").slice(0, 200)}`);
    }

    private convertStickerAnimationToTelegramWebm(sourcePath: string): string {
        const outPath = this.outgoingTelegramStickerPath(sourcePath, "animated-webm-v1", ".webm");
        if (this.hasUsableFile(outPath)) return outPath;

        const attempts = [
            { size: 512, fps: 30, crf: 34 },
            { size: 384, fps: 24, crf: 40 },
            { size: 320, fps: 20, crf: 46 },
        ];
        let lastError: unknown;
        for (const attempt of attempts) {
            try {
                const filter = [
                    `fps=${attempt.fps}`,
                    `scale=${attempt.size}:${attempt.size}:force_original_aspect_ratio=decrease:flags=lanczos`,
                    "scale=max(2\\,trunc(iw/2)*2):max(2\\,trunc(ih/2)*2)",
                    "format=yuva420p",
                ].join(",");
                execFileSync("ffmpeg", [
                    "-hide_banner", "-loglevel", "error",
                    "-y",
                    "-t", "3",
                    "-i", sourcePath,
                    "-an",
                    "-vf", filter,
                    "-c:v", "libvpx-vp9",
                    "-pix_fmt", "yuva420p",
                    "-b:v", "0",
                    "-crf", String(attempt.crf),
                    "-deadline", "good",
                    "-cpu-used", "4",
                    outPath,
                ], {
                    timeout: 20000,
                    maxBuffer: 20 * 1024 * 1024,
                });
                if (this.hasUsableFile(outPath)) {
                    if (fs.statSync(outPath).size <= 512 * 1024 || attempt === attempts.at(-1)) {
                        return outPath;
                    }
                }
            } catch (err) {
                lastError = err;
            }
        }
        throw new Error(`sendSticker: GIF 贴纸转 WebM 失败: ${String(lastError ?? "unknown error").slice(0, 200)}`);
    }

    private async buildTelegramVideoStickerMedia(sticker: Extract<PreparedTelegramSticker, { kind: "video" }>): Promise<Record<string, unknown>> {
        const normalizeInputFile = this.client?._normalizeInputFile?.bind(this.client);
        if (typeof normalizeInputFile !== "function") {
            throw new Error("sendSticker: 当前 Telegram client 不支持上传 video sticker");
        }

        const stat = fs.statSync(sticker.path);
        const inputFile = await normalizeInputFile(sticker.path, {
            fileName: sticker.fileName,
            fileMime: sticker.mimeType,
            fileSize: stat.size,
        });
        const metadata = this.probeVideoMetadata(sticker.path);
        return {
            _: "inputMediaUploadedDocument",
            file: inputFile,
            mimeType: sticker.mimeType,
            nosoundVideo: true,
            attributes: [
                { _: "documentAttributeFilename", fileName: sticker.fileName },
                {
                    _: "documentAttributeSticker",
                    stickerset: { _: "inputStickerSetEmpty" },
                    alt: "",
                },
                {
                    _: "documentAttributeVideo",
                    duration: metadata.duration ?? 0,
                    w: metadata.width ?? 512,
                    h: metadata.height ?? 512,
                    supportsStreaming: true,
                },
            ],
        };
    }

    private outgoingTelegramStickerPath(sourcePath: string, variant: string, ext: ".webp" | ".webm"): string {
        const stat = fs.statSync(sourcePath);
        const hash = createHash("sha1")
            .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}:${variant}`)
            .digest("hex")
            .slice(0, 16);
        const outDir = path.resolve(process.cwd(), "workspace", "Downloads", "other", "tg-converted");
        fs.mkdirSync(outDir, { recursive: true });
        const rawBase = path.basename(sourcePath, path.extname(sourcePath));
        const safeBase = rawBase.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "sticker";
        return path.join(outDir, `${safeBase}_${hash}${ext}`);
    }

    private isAnimatedStickerSource(sourcePath: string): boolean {
        try {
            const raw = execFileSync("ffprobe", [
                "-v", "error",
                "-select_streams", "v:0",
                "-count_frames",
                "-show_entries", "stream=nb_read_frames",
                "-of", "default=nokey=1:noprint_wrappers=1",
                sourcePath,
            ], {
                timeout: 5000,
                maxBuffer: 1024 * 1024,
            }).toString().trim();
            const frames = Number(raw.split(/\s+/)[0]);
            return Number.isFinite(frames) ? frames > 1 : sourcePath.toLowerCase().endsWith(".gif");
        } catch {
            return sourcePath.toLowerCase().endsWith(".gif");
        }
    }

    private probeVideoMetadata(filePath: string): { width?: number; height?: number; duration?: number } {
        try {
            const raw = execFileSync("ffprobe", [
                "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height,duration",
                "-of", "json",
                filePath,
            ], {
                timeout: 5000,
                maxBuffer: 1024 * 1024,
            }).toString();
            const parsed = JSON.parse(raw) as { streams?: Array<{ width?: number; height?: number; duration?: string | number }> };
            const stream = parsed.streams?.[0];
            if (!stream) return {};
            const duration = Number(stream.duration);
            return {
                width: typeof stream.width === "number" ? stream.width : undefined,
                height: typeof stream.height === "number" ? stream.height : undefined,
                duration: Number.isFinite(duration) ? Math.ceil(duration) : undefined,
            };
        } catch {
            return {};
        }
    }

    private ensureFileNameExtension(fileName: string, ext: ".webp" | ".webm"): string {
        return fileName.toLowerCase().endsWith(ext) ? fileName : `${fileName}${ext}`;
    }

    private hasUsableFile(filePath: string): boolean {
        try {
            return fs.existsSync(filePath) && fs.statSync(filePath).isFile() && fs.statSync(filePath).size > 0;
        } catch {
            return false;
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

    /**
     * 入站白名单：enabled 时，群组消息仅当 chat rawId 在 groups 中通过；
     * 私聊仅当 rawId 在 users 中通过。
     */
    private passesTelegramWhitelist(
        normalized: NormalizedIncomingMessage,
    ): boolean {
        const wl = this.config.whitelist;
        if (!wl?.enabled) return true;
        let rawId: string;
        try {
            rawId = parseChatId(normalized.chatId).rawId;
        } catch {
            rawId = normalizeWhitelistId(normalized.chatId);
        }
        if (normalized.isDirectMessage) {
            return this.whitelistUserIds.has(rawId);
        }
        return this.whitelistGroupIds.has(rawId);
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
        normalized: NormalizedIncomingMessage,
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

    private normalizePeerArg(value: unknown, kind?: MeetPeerOptions["kind"]): unknown {
        if (typeof value !== "string") return value;
        let trimmed = value.trim();
        // Strip composite key prefix: "telegram:-1001234567" → "-1001234567"
        if (trimmed.startsWith("telegram:")) {
            trimmed = trimmed.slice("telegram:".length);
        }
        if (kind === "phone") return trimmed;
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

    private normalizeMessageIds(value: unknown): number[] {
        const rawIds = Array.isArray(value) ? value : [value];
        const ids = rawIds.map((raw) => Number(raw));
        if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
            throw new Error("forwardMessage: messageIds must be a positive message id or id array");
        }
        if (ids.length > 100) {
            throw new Error("forwardMessage: Telegram only allows forwarding up to 100 messages at once");
        }
        return ids;
    }

    private async normalizeForwardMessageOpts(opts: unknown): Promise<Record<string, unknown> | undefined> {
        if (!opts || typeof opts !== "object") return undefined;
        const out: Record<string, unknown> = { ...(opts as Record<string, unknown>) };

        for (const key of ["toThreadId", "videoTimestamp"]) {
            if (typeof out[key] === "string") {
                const num = Number(out[key]);
                if (!Number.isNaN(num) && Number.isFinite(num)) out[key] = num;
            }
        }
        if (typeof out.schedule === "string") {
            const timestamp = Date.parse(out.schedule);
            if (!Number.isNaN(timestamp)) out.schedule = new Date(timestamp);
        }
        if (out.sendAs != null) {
            out.sendAs = await this.ensurePeerCached(out.sendAs);
        }
        if (out.toMonoforumPeer != null) {
            out.toMonoforumPeer = await this.ensurePeerCached(out.toMonoforumPeer);
        }

        return out;
    }

    /** 已解析的 peer 缓存（避免重复解析）。key 带类型前缀，避免手机号/数字 ID 混淆。 */
    private resolvedPeers = new Map<string, unknown>();

    /**
     * 确保 peer 在 mtcute 内部缓存中已解析。
     *
     * mtcute 的某些方法（如 getHistory）需要已缓存的 InputPeer，
     * 而 sendText 可以直接用 numeric ID。当 InputPeer 未缓存时
     * 会报 "Cannot read properties of undefined (reading 'inputPeer')"。
     *
     * 解决方案：先尝试 resolvePeer，失败则 findDialogs/iterDialogs 预热缓存。
     */
    private async ensurePeerCached(
        rawPeer: unknown,
        options: { failOnUnresolved?: boolean; kind?: MeetPeerOptions["kind"]; dialogsLimit?: number; force?: boolean } = {},
    ): Promise<unknown> {
        const peer = this.normalizePeerArg(rawPeer, options.kind);
        this.rememberPeerObject(rawPeer);

        // 检查本地缓存
        const cacheKey = this.peerCacheKey(peer, options.kind);
        if (cacheKey && this.resolvedPeers.has(cacheKey)) {
            return this.resolvedPeers.get(cacheKey)!;
        }

        const isPhone = this.isPhonePeer(peer, options.kind);
        if (isPhone) {
            try {
                if (typeof this.client.resolvePhoneNumber === "function") {
                    const resolved = await this.client.resolvePhoneNumber(String(peer), options.force === true);
                    this.rememberResolvedPeer(peer, resolved, "phone");
                    return resolved;
                }
            } catch (e) {
                log.debug("ensurePeerCached: resolvePhoneNumber 失败", { peer: String(peer), error: String(e) });
            }
        }

        // 尝试 resolvePeer（mtcute 内部方法，解析 peer 并缓存）
        if (!isPhone) {
            try {
                if (typeof this.client.resolvePeer === "function") {
                    const resolved = await this.client.resolvePeer(peer);
                    this.rememberResolvedPeer(peer, resolved, options.kind);
                    return resolved;
                }
            } catch (e) {
                log.debug("ensurePeerCached: resolvePeer 失败", { peer: String(peer), error: String(e) });
            }
        }

        // fallback: 尝试 getInputEntity（某些 mtcute 版本使用此方法）
        try {
            if (typeof this.client.getInputEntity === "function") {
                const resolved = await this.client.getInputEntity(peer);
                this.rememberResolvedPeer(peer, resolved, options.kind);
                return resolved;
            }
        } catch (e) {
            log.debug("ensurePeerCached: getInputEntity 失败", { peer: String(peer), error: String(e) });
        }

        // fallback: 遍历 dialogs 预热 mtcute 内部缓存。私聊正 ID 同样需要 access hash。
        try {
            const dialogs = await this.findDialogsForPeers(peer, options.dialogsLimit ?? 200);
            const first = dialogs[0] as any;
            if (first) {
                this.rememberDialog(first);
                const dialogPeer = first?.peer ?? first?.chat;
                const inputPeer = dialogPeer?.inputPeer ?? first?.inputPeer;
                if (inputPeer) {
                    this.rememberResolvedPeer(peer, inputPeer, options.kind);
                    return inputPeer;
                }
            }

            // dialogs 遍历后再试一次 resolvePeer
            if (!isPhone && typeof this.client.resolvePeer === "function") {
                const resolved = await this.client.resolvePeer(peer);
                this.rememberResolvedPeer(peer, resolved, options.kind);
                return resolved;
            }
        } catch (e) {
            const errText = String(e);
            const logFn = errText.includes("not supported") ? log.debug.bind(log) : log.warn.bind(log);
            logFn("ensurePeerCached: dialogs 预热失败", { peer: String(peer), error: errText });
        }

        // 所有解析方式均失败 — 返回原始 ID，让调用方自行处理错误
        log.warn("ensurePeerCached: 所有解析方式均失败，返回原始 ID", { peer: String(peer) });
        if (options.failOnUnresolved) {
            throw new Error(this.peerResolutionGuidance(rawPeer));
        }
        return peer;
    }

    private async meetPeerForAgent(rawPeer: unknown, rawOptions?: unknown): Promise<Record<string, unknown>> {
        const opts = this.normalizeMeetPeerOptions(rawOptions);
        if (rawPeer == null || String(rawPeer).trim() === "") {
            throw new Error("telegram.meetPeer: peer 不能为空");
        }

        await this.warmPeerFromMessages(opts);
        const resolved = await this.ensurePeerCached(rawPeer, {
            failOnUnresolved: true,
            kind: opts.kind,
            dialogsLimit: opts.dialogsLimit,
            force: opts.force,
        });

        return {
            ok: true,
            input: String(rawPeer),
            source: this.describeResolvedPeer(resolved),
        };
    }

    private normalizeMeetPeerOptions(rawOptions?: unknown): MeetPeerOptions {
        if (!rawOptions || typeof rawOptions !== "object") return {};
        const input = rawOptions as Record<string, unknown>;
        const kind = input.kind === "id" || input.kind === "username" || input.kind === "phone"
            ? input.kind
            : undefined;
        const messageIds = Array.isArray(input.messageIds)
            ? input.messageIds.map(Number).filter(Number.isFinite)
            : undefined;
        const dialogsLimit = Number(input.dialogsLimit);
        return {
            kind,
            chatId: input.chatId,
            messageIds,
            dialogsLimit: Number.isFinite(dialogsLimit) && dialogsLimit > 0 ? Math.floor(dialogsLimit) : undefined,
            force: input.force === true,
        };
    }

    private async warmPeerFromMessages(opts: MeetPeerOptions): Promise<void> {
        if (!opts.chatId || !opts.messageIds?.length || typeof this.client.getMessages !== "function") return;
        try {
            const chatPeer = await this.ensurePeerCached(opts.chatId, { dialogsLimit: opts.dialogsLimit });
            const messages = await this.client.getMessages(chatPeer, opts.messageIds);
            for (const message of messages ?? []) {
                if (message) this.normalizeMessage(message);
            }
        } catch (err) {
            log.debug("meetPeer: getMessages 预热失败", {
                chatId: String(opts.chatId),
                messageIds: opts.messageIds,
                error: String(err),
            });
        }
    }

    private async findDialogsForPeers(peersArg: unknown, limit: number): Promise<unknown[]> {
        const peers = Array.isArray(peersArg) ? peersArg : [peersArg];
        const normalizedPeers = peers.map((peer) => this.normalizePeerArg(peer));

        if (typeof this.client.findDialogs === "function") {
            const dialogs = await this.client.findDialogs(Array.isArray(peersArg) ? normalizedPeers : normalizedPeers[0]);
            const arr = Array.isArray(dialogs) ? dialogs : [dialogs];
            arr.forEach((dialog) => this.rememberDialog(dialog));
            return arr;
        }

        if (typeof this.client.iterDialogs !== "function") {
            throw new Error("findDialogs is not supported by the current Telegram client");
        }

        const found: unknown[] = [];
        const remaining = new Set(normalizedPeers.map((_, idx) => idx));
        for await (const dialog of this.client.iterDialogs({ limit })) {
            this.rememberDialog(dialog);
            for (const idx of [...remaining]) {
                if (this.dialogMatchesPeer(dialog, normalizedPeers[idx])) {
                    found[idx] = dialog;
                    remaining.delete(idx);
                }
            }
            if (remaining.size === 0) break;
        }

        if (remaining.size > 0) {
            const missing = [...remaining].map((idx) => String(peers[idx])).join(", ");
            throw new Error(`findDialogs: 未找到 peer: ${missing}`);
        }

        return found;
    }

    private dialogMatchesPeer(dialog: any, peer: unknown): boolean {
        const dialogPeer = dialog?.peer ?? dialog?.chat;
        if (!dialogPeer) return false;
        const id = dialogPeer.id;
        if (typeof peer === "number") {
            return Number(id) === peer || String(id) === String(peer);
        }
        const text = String(peer ?? "").replace(/^@/, "").toLowerCase();
        if (!text) return false;
        if (String(id).toLowerCase() === text) return true;
        const username = typeof dialogPeer.username === "string" ? dialogPeer.username.replace(/^@/, "").toLowerCase() : "";
        return username === text;
    }

    private peerCacheKey(peer: unknown, kind?: MeetPeerOptions["kind"]): string | undefined {
        if (typeof peer === "number") return `id:${peer}`;
        if (typeof peer === "string") {
            const text = peer.trim();
            if (!text) return undefined;
            if (kind === "phone" || text.startsWith("+")) return `phone:${text.replace(/[@+\s()]/g, "")}`;
            return `text:${text.replace(/^@/, "").toLowerCase()}`;
        }
        return undefined;
    }

    private isPhonePeer(peer: unknown, kind?: MeetPeerOptions["kind"]): boolean {
        return kind === "phone" || (typeof peer === "string" && peer.trim().startsWith("+"));
    }

    private rememberResolvedPeer(peerId: unknown, resolved: unknown, kind?: MeetPeerOptions["kind"]): void {
        const key = this.peerCacheKey(this.normalizePeerArg(peerId, kind), kind);
        if (key) this.resolvedPeers.set(key, resolved);
    }

    private rememberPeerObject(peer: any): void {
        if (!peer || typeof peer !== "object") return;
        const inputPeer = peer.inputPeer ?? peer.peer?.inputPeer;
        if (!inputPeer) return;

        const id = peer.id ?? peer.userId ?? peer.chatId ?? peer.channelId;
        if (id !== undefined && id !== null) {
            this.rememberResolvedPeer(id, inputPeer);
        }
        if (typeof peer.username === "string" && peer.username) {
            this.rememberResolvedPeer(peer.username, inputPeer, "username");
        }
        if (typeof peer.phone === "string" && peer.phone) {
            this.rememberResolvedPeer(peer.phone, inputPeer, "phone");
        }
    }

    private rememberDialog(dialog: any): void {
        if (!dialog || typeof dialog !== "object") return;
        this.rememberPeerObject(dialog.peer ?? dialog.chat);
        if (dialog.lastMessage) this.normalizeMessage(dialog.lastMessage);
    }

    private describeResolvedPeer(peer: unknown): Record<string, unknown> {
        if (!peer || typeof peer !== "object") {
            return { type: typeof peer, value: String(peer) };
        }
        const raw = peer as Record<string, unknown>;
        const id = raw.userId ?? raw.chatId ?? raw.channelId ?? raw.id;
        return {
            type: String(raw._ ?? raw.type ?? "peer"),
            id: id != null ? String(id) : undefined,
        };
    }

    private peerResolutionGuidance(rawPeer: unknown): string {
        return [
            `telegram peer 未解析: ${String(rawPeer)}`,
            "原因通常是当前 mtcute session 还没有遇见这个私聊/用户，只有裸 ID，没有 Telegram access hash。",
            "可操作修复：",
            "- 如果有 username 或手机号，改用 username，或先调用 telegram.meetPeer('@username') / telegram.meetPeer('+8613...', { kind: 'phone' })。",
            "- 如果这是已有对话，先调用 telegram.findDialogs(userIdOrUsername) 或 telegram.getDialogs({ limit: 200 }) 让 session 遇见它，再重试发送。",
            "- 如果手上有该用户发来的消息 ID，先调用 telegram.meetPeer(userId, { chatId, messageIds: [messageId] }) 或 telegram.getMessages(chatId, [messageId]) 预热缓存。",
            "- 不要反复用同一个裸数字 userId 重试；如果仍失败，需要用户先发起私聊/提供 username/phone，或从 dialogs/messages/members 中遇见该 peer。",
        ].join("\n");
    }

    private async downloadMediaBuffer(
        fileIdOrMedia: unknown,
        chatId?: unknown,
        messageId?: unknown,
        uniqueFileId?: string,
    ): Promise<Buffer> {
        if (!this.client?.downloadAsBuffer) {
            throw new Error("downloadMedia: current Telegram client does not support downloadAsBuffer");
        }

        // ── 缓存命中 → 直接返回 ──
        if (uniqueFileId) {
            const cached = this.mediaCache.get(uniqueFileId);
            if (cached) {
                log.debug("downloadMedia: 缓存命中", { uniqueFileId });
                return cached;
            }
        }

        try {
            const uint8 = await this.client.downloadAsBuffer(fileIdOrMedia);
            const buffer = Buffer.from(uint8);
            if (uniqueFileId) this.mediaCache.set(uniqueFileId, buffer);
            return buffer;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const isFileRefError = /file.?ref/i.test(errMsg) || /FILE_REFERENCE/i.test(errMsg);

            if (!isFileRefError) throw err;

            // File reference 过期 → 尝试 refetch 消息获取新的 fileId
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

                const freshFileId = this.extractFileIdFromMessage(msg);
                if (!freshFileId) throw new Error("refetch 消息中未找到 fileId");

                log.info("downloadMedia: refetch 成功，重试下载", { freshFileId: freshFileId.slice(0, 30) + "..." });
                const uint8 = await this.client.downloadAsBuffer(freshFileId);
                const buffer = Buffer.from(uint8);
                if (uniqueFileId) this.mediaCache.set(uniqueFileId, buffer);
                return buffer;
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

    private async downloadIncomingMedia(mediaInfo: MediaInfo, chatId: string, messageId: string): Promise<void> {
        if (!this.mediaDownloader || !mediaInfo.fileId) return;

        const uniqueFileId = mediaInfo.uniqueFileId ?? mediaInfo.fileId;
        const existing = this.mediaDownloader.getExistingPath(uniqueFileId);
        if (existing) {
            mediaInfo.uniqueFileId = uniqueFileId;
            mediaInfo.filePath = existing;
            mediaInfo.downloadStatus = "cached";
            return;
        }

        if (!this.mediaDownloader.isWithinSizeLimit(mediaInfo.fileSize)) {
            mediaInfo.downloadStatus = "too_large";
            return;
        }

        try {
            const buffer = await this.downloadMediaBuffer(mediaInfo.fileId, chatId, messageId, uniqueFileId);
            const saved = this.mediaDownloader.saveMedia(buffer, {
                chatId,
                messageId,
                uniqueFileId,
                mediaType: mediaInfo.type,
                mimeType: mediaInfo.mimeType,
                fileName: mediaInfo.fileName,
            });
            mediaInfo.uniqueFileId = uniqueFileId;
            mediaInfo.fileSize = mediaInfo.fileSize ?? buffer.length;
            if (saved) {
                mediaInfo.filePath = saved.path;
                mediaInfo.downloadStatus = "downloaded";
            } else {
                mediaInfo.downloadStatus = "too_large";
            }
        } catch (err) {
            mediaInfo.downloadStatus = "failed";
            mediaInfo.downloadError = String(err).slice(0, 300);
            log.warn("入站媒体自动下载失败", {
                chatId,
                messageId,
                type: mediaInfo.type,
                fileId: mediaInfo.fileId.slice(0, 30),
                error: String(err),
            });
        }
    }

    private async normalizeIncomingMessage(msg: any): Promise<NormalizedIncomingMessage | null> {
        const plain = this.normalizeMessage(msg);
        if (!plain.chat?.id) return null;

        const senderId = plain.sender?.id ?? "0";
        const chatId = composeChatId("telegram", plain.chat.id);
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
                case "audio":
                    text = "[🎙 语音/音频]";
                    break;
                case "document":
                    text = "[📎 文件]";
                    break;
                default:
                    text = "[📎 媒体]";
                    break;
            }
        }

        if (plain.forwardFrom) {
            const urlHint = plain.forwardFromUrl ? `(${plain.forwardFromUrl})` : "";
            text = `[转发自: ${plain.forwardFrom}${urlHint}]\n${text}`;
        }

        return {
            chatId,
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
        this.rememberPeerObject(dialog?.peer ?? dialog?.chat);
        return {
            peer: this.normalizePeer(dialog?.peer),
            lastMessage: dialog?.lastMessage ? this.normalizeMessage(dialog.lastMessage) : undefined,
            unreadCount: Number(dialog?.unreadCount ?? 0),
        };
    }

    private normalizeMessage(message: any): PlainMessage {
        this.rememberPeerObject(message?.chat);
        this.rememberPeerObject(message?.sender);
        let forwardFrom: string | undefined;
        let forwardFromUrl: string | undefined;
        if (message?.forward) {
            const fwd = message.forward;
            forwardFrom = fwd.senderName ?? fwd.sender?.displayName ?? fwd.sender?.title ?? fwd.sender?.firstName ?? fwd.chat?.title ?? "Unknown";
            if (fwd.chat?.username) {
                forwardFromUrl = `https://t.me/${fwd.chat.username}`;
            } else if (fwd.sender?.username) {
                forwardFromUrl = `https://t.me/${fwd.sender.username}`;
            }
        }

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
            forwardFrom,
            forwardFromUrl,
        };
    }

    /**
     * 从 mtcute msg.media 对象提取结构化媒体元数据。
     * mtcute media 对象有 .type 字段: "photo", "sticker", "video", "document", "animation" 等。
     */
    private extractMediaInfo(media: any): MediaInfo | undefined {
        if (!media) return undefined;

        const rawType = String(media.type ?? "");
        const mimeType = typeof media.mimeType === "string" ? media.mimeType : undefined;
        let type: MediaInfo["type"];
        switch (rawType) {
            case "photo": type = "photo"; break;
            case "sticker": type = "sticker"; break;
            case "video": type = "video"; break;
            case "document": type = "document"; break;
            case "animation": type = "animation"; break;
            case "audio":
            case "voice":
                type = "audio";
                break;
            default:
                // 未知类型但有 media 对象 → 标记为 other
                if (!rawType) return undefined;
                type = mimeType?.startsWith("audio/") ? "audio" : "other";
                break;
        }

        return {
            type,
            rawType: rawType || undefined,
            fileId: typeof media.fileId === "string" ? media.fileId : undefined,
            uniqueFileId: typeof media.uniqueFileId === "string" ? media.uniqueFileId : undefined,
            emoji: typeof media.emoji === "string" ? media.emoji : undefined,
            mimeType,
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
    const { TelegramClient, SocksProxyTcpTransport } = await import("@mtcute/node");
    const proxyUrl = process.env.TG_PROXY || process.env.HTTPS_PROXY || "";
    const clientOpts: Record<string, unknown> = {
        apiId: Number(config.apiId),
        apiHash: config.apiHash,
        storage: "workspace/tg-session/account",
    };
    if (proxyUrl) {
        const url = new URL(proxyUrl.replace(/^socks5:\/\//, "socks5h://").replace(/^socks:\/\//, "socks5h://"));
        clientOpts.transport = new SocksProxyTcpTransport({
            host: url.hostname,
            port: Number(url.port),
            version: 5,
            user: url.username || undefined,
            password: url.password || undefined,
        });
    }
    return new TelegramClient(clientOpts as any) as TelegramClientLike;
}
