/**
 * discord-adapter.ts — Discord 平台 adapter
 *
 * 使用 discord.js 库连接 Discord Gateway，
 * 监听消息并标准化后推入 NotificationCenter。
 * 通过 host-call 为 sandbox 提供 discord 代码接口。
 */

import type { NotificationCenter } from "../event/notification-center.js";
import type { DiscordConfig } from "../core/config.js";
import type { PlatformAdapter } from "./platform-adapter.js";
import { composeChatId } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("discord-adapter");

const MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;

type ParsedDiscordTarget = {
    raw: string;
    channelId: string;
    canFallbackToUser: boolean;
};

type NormalizedDiscordMedia = {
    caption?: string;
    file?: unknown;
    url?: unknown;
    fileName?: string;
};

/** 结构化媒体元数据 */
export interface DiscordMediaInfo {
    type: "photo" | "video" | "document" | "other";
    url: string;
    /** 用于 vision pipeline 下载（Discord 使用 CDN URL） */
    fileId: string;
    /** 用于缓存去重（Discord 使用 attachment ID） */
    uniqueFileId: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    width?: number;
    height?: number;
}

export class DiscordAdapter implements PlatformAdapter {
    readonly platform = "discord";

    private client: any | null = null;
    private selfUserId: string | null = null;

    constructor(
        private config: DiscordConfig,
        private nc: NotificationCenter,
    ) {}

    async start(): Promise<void> {
        if (this.client) return;

        if (!this.config.botToken) {
            throw new Error("discord.bot_token is required");
        }

        // Dynamic import to avoid top-level dependency on discord.js
        const { Client, GatewayIntentBits, Partials } = await import("discord.js");

        const client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.DirectMessages,
            ],
            partials: [
                Partials.Channel, // Required for DM support
                Partials.Message,
            ],
        });

        // Wait for ready event
        await new Promise<void>((resolve, reject) => {
            client.once("ready", () => {
                this.selfUserId = client.user?.id ?? null;
                log.info("Discord client ready", {
                    username: client.user?.username,
                    id: this.selfUserId,
                    guilds: client.guilds.cache.size,
                });
                resolve();
            });
            client.once("error", reject);
            client.login(this.config.botToken).catch(reject);
        });

        // Listen for messages
        client.on("messageCreate", async (message: any) => {
            // Skip bot's own messages
            if (message.author?.id === this.selfUserId) return;
            // Skip system messages
            if (message.system) return;

            const normalized = this.normalizeIncomingMessage(message);
            if (!normalized) return;

            log.debug("接收 Discord 消息", {
                messageId: normalized.messageId,
                chatId: normalized.chatId,
                userId: normalized.userId,
                chatType: normalized.chatType,
                isDirectMessage: normalized.isDirectMessage,
                mentionsAgent: normalized.mentionsAgent,
                textPreview: normalized.text.slice(0, 80),
            });

            this.nc.push({
                type: "nc.message",
                scene: "discord",
                source: {
                    scene: "discord",
                    platform: "discord",
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
                    scene: "discord",
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
                        scene: "discord",
                        platform: "discord",
                        chatId: normalized.chatId,
                        userId: normalized.userId,
                        chatType: normalized.chatType,
                        messageId: normalized.messageId,
                        replyToMessageId: normalized.replyToMessageId,
                    },
                    platformData: {
                        originalType: "discord.message",
                    },
                },
                _urgent: normalized.isDirectMessage || normalized.mentionsAgent || normalized.replyToMessageId ? true : false,
            });
        });

        this.client = client;
        log.info(`✅ DiscordAdapter 已启动: ${client.user?.username ?? "?"} (${this.selfUserId})`);
    }

    async stop(): Promise<void> {
        if (!this.client) return;
        try {
            await this.client.destroy();
        } catch (err) {
            log.warn("Discord client destroy error", { error: String(err) });
        }
        this.client = null;
        this.selfUserId = null;
    }

    canHandle(method: string): boolean {
        return method.startsWith("discord.");
    }

    getWriteMethods(): string[] {
        return [
            "discord.sendText",
            "discord.sendMedia",
            "discord.sendTyping",
        ];
    }

    formatMention(rawUserId: string, _username?: string): string | undefined {
        return `<@${rawUserId}>`;
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (!this.client) {
            throw new Error("DiscordAdapter is not started");
        }

        const requestId = `dc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const callStart = Date.now();
        try {
            switch (method) {
            case "discord.sendText": {
                // args: [chatId, text, opts?]
                const target = this.parseTarget(String(args[0] ?? ""));
                log.info("discord.sendText:start", { requestId, target: target.raw, channelId: target.channelId });
                const channel = await this.resolveTextChannel(target, "sendText", requestId);
                const channelId = channel.id ?? target.channelId;
                const text = String(args[1] ?? "");
                const opts = (args[2] ?? {}) as Record<string, unknown>;

                const sendOpts: Record<string, unknown> = { content: text };
                // Support replyTo
                if (opts.replyTo) {
                    sendOpts.reply = { messageReference: String(opts.replyTo) };
                }

                const sendStart = Date.now();
                const sent = await channel.send(sendOpts);
                log.info("discord.sendText:success", {
                    requestId,
                    channelId,
                    durationMs: Date.now() - callStart,
                    sendDurationMs: Date.now() - sendStart,
                    messageId: sent?.id,
                    textLength: text.length,
                });
                return this.normalizeOutgoingMessage(sent);
            }
            case "discord.sendMedia": {
                // args: [chatId, media, opts?]
                const target = this.parseTarget(String(args[0] ?? ""));
                log.info("discord.sendMedia:start", { requestId, target: target.raw, channelId: target.channelId });

                const fetchChannelStart = Date.now();
                const channel = await this.resolveTextChannel(target, "sendMedia", requestId);
                const channelId = channel.id ?? target.channelId;
                log.info("discord.sendMedia:channelReady", {
                    requestId,
                    channelId,
                    durationMs: Date.now() - fetchChannelStart,
                });
                const media = this.normalizeMediaArg(args[1]);
                const opts = (args[2] ?? {}) as Record<string, unknown>;

                const sendOpts: Record<string, unknown> = {};
                if (typeof media.caption === "string") {
                    sendOpts.content = media.caption;
                } else if (typeof opts.caption === "string") {
                    sendOpts.content = opts.caption;
                }
                if (opts.replyTo) {
                    sendOpts.reply = { messageReference: String(opts.replyTo) };
                }

                // Attach file
                const files: Array<Record<string, unknown>> = [];
                const source = media.file ?? media.url;
                if (source != null) {
                    files.push(await this.buildAttachment(source, media.fileName, requestId, channelId));
                }
                if (!sendOpts.content && files.length === 0) {
                    throw new Error("sendMedia: media.file or media.url is required when caption is empty");
                }
                if (files.length > 0) {
                    sendOpts.files = files;
                }

                const sendStart = Date.now();
                const sent = await channel.send(sendOpts);
                log.info("discord.sendMedia:success", {
                    requestId,
                    channelId,
                    durationMs: Date.now() - callStart,
                    sendDurationMs: Date.now() - sendStart,
                    fileCount: files.length,
                    captionLength: typeof sendOpts.content === "string" ? sendOpts.content.length : 0,
                    messageId: sent?.id,
                });
                return this.normalizeOutgoingMessage(sent);
            }
            case "discord.sendTyping": {
                const target = this.parseTarget(String(args[0] ?? ""));
                log.info("discord.sendTyping:start", { requestId, target: target.raw, channelId: target.channelId });
                const channel = await this.resolveTextChannel(target, "sendTyping", requestId);
                const channelId = channel.id ?? target.channelId;
                if (channel?.isTextBased?.() && typeof channel.sendTyping === "function") {
                    await channel.sendTyping();
                }
                log.info("discord.sendTyping:success", { requestId, channelId, durationMs: Date.now() - callStart });
                return null;
            }
            case "discord.downloadMedia": {
                // args: [fileId (=URL for Discord), chatId?, messageId?, uniqueFileId?]
                const url = String(args[0] ?? "");
                if (!url) throw new Error("discord.downloadMedia: URL is required");
                log.info("discord.downloadMedia:start", { requestId, url });
                const downloadStart = Date.now();
                const buf = await this.downloadMedia(null, url);
                log.info("discord.downloadMedia:success", {
                    requestId,
                    url,
                    durationMs: Date.now() - downloadStart,
                    sizeBytes: buf.byteLength,
                });
                return { buffer: buf.toString("base64"), size: buf.length };
            }
            default:
                throw new Error(`Unsupported DiscordAdapter call: ${method}`);
            }
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const errorStack = err instanceof Error ? err.stack : undefined;
            log.error("discord.handleCall:failed", {
                requestId,
                method,
                durationMs: Date.now() - callStart,
                error: errorMessage,
                stack: errorStack,
            });
            throw err;
        }
    }

    async downloadMedia(_rawMessage: unknown, mediaRef: string): Promise<Buffer> {
        // Discord media is accessible via CDN URL — simple HTTP fetch
        const response = await fetch(mediaRef);
        if (!response.ok) {
            throw new Error(`downloadMedia: HTTP ${response.status} for ${mediaRef}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    private async downloadMediaWithTimeout(url: string, timeoutMs: number): Promise<Buffer> {
        const signal = AbortSignal.timeout(timeoutMs);
        const response = await fetch(url, { signal });
        if (!response.ok) {
            throw new Error(`sendMedia download failed: HTTP ${response.status} for ${url}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    // ─── Internal ───

    /**
     * Parse a Discord target from raw/composite IDs.
     * Guild channels: discord:guildId:channelId → channelId, no DM fallback.
     * DMs/users: discord:id or raw id → first try channel id, then user id DM.
     */
    private parseTarget(chatId: string): ParsedDiscordTarget {
        const raw = chatId.trim();
        const mentionMatch = raw.match(/^<@!?(\d+)>$/);
        if (mentionMatch) {
            return { raw, channelId: mentionMatch[1], canFallbackToUser: true };
        }

        let rest = raw;
        if (rest.startsWith("discord:")) rest = rest.slice("discord:".length);
        if (rest.startsWith("user:")) rest = rest.slice("user:".length);

        // Three-part: guildId:channelId → channelId
        const colonIdx = rest.indexOf(":");
        if (colonIdx !== -1) {
            return { raw, channelId: rest.slice(colonIdx + 1), canFallbackToUser: false };
        }
        // Two-part (DM): just the channelId
        return { raw, channelId: rest, canFallbackToUser: true };
    }

    private async resolveTextChannel(target: ParsedDiscordTarget, operation: string, requestId: string): Promise<any> {
        if (!target.channelId) {
            throw new Error(`${operation}: target channel/user id is required`);
        }

        let channelError: unknown;
        try {
            const channel = await this.client.channels.fetch(target.channelId);
            if (channel?.isTextBased?.()) {
                return channel;
            }
            channelError = new Error(`channel ${target.channelId} is not text-based`);
        } catch (err) {
            channelError = err;
        }

        if (!target.canFallbackToUser) {
            const detail = channelError instanceof Error ? channelError.message : String(channelError);
            throw new Error(`${operation}: channel ${target.channelId} is not available (${detail})`);
        }

        if (!/^\d{15,25}$/.test(target.channelId)) {
            const detail = channelError instanceof Error ? channelError.message : String(channelError);
            throw new Error(`${operation}: target ${target.raw} is neither a text channel nor a valid Discord user id (${detail})`);
        }

        try {
            log.info("discord.resolveTextChannel:fallingBackToDm", {
                requestId,
                operation,
                target: target.raw,
                userId: target.channelId,
            });
            const user = await this.client.users.fetch(target.channelId);
            if (typeof user?.createDM !== "function") {
                throw new Error("Discord user object does not support createDM()");
            }
            const dmChannel = await user.createDM();
            if (dmChannel?.isTextBased?.()) {
                log.info("discord.resolveTextChannel:dmReady", {
                    requestId,
                    operation,
                    target: target.raw,
                    channelId: dmChannel.id,
                });
                return dmChannel;
            }
            throw new Error("created DM channel is not text-based");
        } catch (dmErr) {
            const channelDetail = channelError instanceof Error ? channelError.message : String(channelError);
            const dmDetail = dmErr instanceof Error ? dmErr.message : String(dmErr);
            throw new Error(`${operation}: cannot resolve ${target.raw} as channel or DM user (channel: ${channelDetail}; dm: ${dmDetail})`);
        }
    }

    private normalizeMediaArg(mediaArg: unknown): NormalizedDiscordMedia {
        if (typeof mediaArg === "string" || Buffer.isBuffer(mediaArg) || mediaArg instanceof Uint8Array) {
            return { file: mediaArg };
        }
        if (mediaArg && typeof mediaArg === "object") {
            const record = mediaArg as Record<string, unknown>;
            return {
                caption: typeof record.caption === "string" ? record.caption : undefined,
                file: record.file,
                url: record.url,
                fileName: typeof record.fileName === "string" ? record.fileName : undefined,
            };
        }
        return {};
    }

    private async buildAttachment(source: unknown, fileName: string | undefined, requestId: string, channelId: string): Promise<Record<string, unknown>> {
        if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
            const buffer = Buffer.from(source as Buffer | Uint8Array);
            log.info("discord.sendMedia:usingBuffer", {
                requestId,
                channelId,
                sizeBytes: buffer.byteLength,
            });
            return {
                attachment: buffer,
                ...(fileName ? { name: fileName } : {}),
            };
        }

        if (typeof source !== "string") {
            throw new Error(`sendMedia: unsupported media source type ${typeof source}`);
        }

        if (source.startsWith("http://") || source.startsWith("https://")) {
            const downloadStart = Date.now();
            const downloaded = await this.downloadMediaWithTimeout(source, MEDIA_DOWNLOAD_TIMEOUT_MS);
            log.info("discord.sendMedia:downloadedMedia", {
                requestId,
                channelId,
                url: source,
                durationMs: Date.now() - downloadStart,
                sizeBytes: downloaded.byteLength,
            });
            const inferredName = this.fileNameFromUrl(source);
            return {
                attachment: downloaded,
                ...(fileName ? { name: fileName } : inferredName ? { name: inferredName } : {}),
            };
        }

        if (source.startsWith("data:")) {
            const parsed = this.parseDataUrl(source);
            log.info("discord.sendMedia:usingDataUrl", {
                requestId,
                channelId,
                mimeType: parsed.mimeType,
                sizeBytes: parsed.buffer.byteLength,
            });
            return {
                attachment: parsed.buffer,
                name: fileName ?? this.defaultFileNameForMimeType(parsed.mimeType),
            };
        }

        const resolved = this.resolveLocalFilePath(source);
        if (!resolved) {
            throw new Error(`sendMedia: file does not exist: ${source}`);
        }
        const stat = statSync(resolved);
        if (!stat.isFile()) {
            throw new Error(`sendMedia: not a file: ${resolved}`);
        }
        const buffer = readFileSync(resolved);
        log.info("discord.sendMedia:usingLocalFile", {
            requestId,
            channelId,
            file: resolved,
            sizeBytes: buffer.byteLength,
        });
        return {
            attachment: buffer,
            name: fileName ?? basename(resolved),
        };
    }

    private resolveLocalFilePath(file: string): string | null {
        let raw = file;
        if (raw.startsWith("file://")) {
            try {
                raw = fileURLToPath(raw);
            } catch {
                return null;
            }
        }

        const candidates = isAbsolute(raw)
            ? [pathResolve(raw)]
            : [
                pathResolve(process.cwd(), raw),
                pathResolve(process.cwd(), "workspace", raw),
            ];

        for (const candidate of candidates) {
            if (existsSync(candidate)) return candidate;
        }
        return null;
    }

    private parseDataUrl(dataUrl: string): { buffer: Buffer; mimeType: string } {
        const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
        if (!match) {
            throw new Error("sendMedia: invalid data URL");
        }
        const mimeType = match[1] || "application/octet-stream";
        const isBase64 = !!match[2];
        const payload = match[3] ?? "";
        const buffer = isBase64
            ? Buffer.from(payload, "base64")
            : Buffer.from(decodeURIComponent(payload), "utf-8");
        return { buffer, mimeType };
    }

    private defaultFileNameForMimeType(mimeType: string): string {
        switch (mimeType) {
            case "image/jpeg": return "image.jpg";
            case "image/png": return "image.png";
            case "image/webp": return "image.webp";
            case "image/gif": return "image.gif";
            case "video/mp4": return "video.mp4";
            case "audio/mpeg": return "audio.mp3";
            default: return "attachment.bin";
        }
    }

    private fileNameFromUrl(url: string): string | undefined {
        try {
            const name = basename(new URL(url).pathname);
            return name || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Normalize a discord.js Message into our standard NC event format.
     */
    private normalizeIncomingMessage(message: any): {
        messageId: string;
        chatId: string;
        userId: string;
        displayName: string;
        username?: string;
        text: string;
        timestamp: string;
        replyToMessageId?: string;
        chatTitle: string;
        chatType: string;
        isDirectMessage: boolean;
        mentionsAgent: boolean;
        mediaInfo?: DiscordMediaInfo;
    } | null {
        const isDM = message.channel?.isDMBased?.() ?? false;
        const guildId = message.guild?.id;
        const channelId = message.channel?.id;

        if (!channelId) return null;

        // Compose chatId
        let chatId: string;
        if (isDM) {
            chatId = composeChatId("discord", channelId);
        } else if (guildId) {
            chatId = composeChatId("discord", guildId, channelId);
        } else {
            chatId = composeChatId("discord", channelId);
        }

        // userId
        const rawUserId = message.author?.id ?? "";
        const userId = composeChatId("discord", rawUserId);

        // Display name: prefer guild nickname, then global display name, then username
        const displayName =
            message.member?.displayName ??
            message.author?.displayName ??
            message.author?.username ??
            rawUserId;

        // Username (Discord login name, without discriminator)
        const username = message.author?.username ?? undefined;

        // Text: include message content. If empty, check for stickers/embeds
        let text = message.content ?? "";
        if (!text && message.stickers?.size > 0) {
            const sticker = message.stickers.first();
            text = `[贴纸: ${sticker?.name ?? "unknown"}]`;
        }
        if (!text && message.embeds?.length > 0) {
            text = "[嵌入内容]";
        }

        // Skip messages with no text and no attachments
        if (!text && !message.attachments?.size) return null;

        // Chat title
        let chatTitle: string;
        if (isDM) {
            chatTitle = displayName;
        } else {
            const guildName = message.guild?.name ?? "";
            const channelName = message.channel?.name ?? "";
            chatTitle = guildName ? `${guildName} > #${channelName}` : `#${channelName}`;
        }

        // Chat type
        const chatType = isDM ? "private" : "group";

        // Mentions agent
        const mentionsAgent = !!(this.selfUserId && message.mentions?.has?.(this.selfUserId));

        // Reply
        const replyToMessageId = message.reference?.messageId ?? undefined;

        // Media info (first attachment)
        let mediaInfo: DiscordMediaInfo | undefined;
        if (message.attachments?.size > 0) {
            const att = message.attachments.first();
            if (att) {
                const contentType = att.contentType ?? "";
                let type: DiscordMediaInfo["type"] = "other";
                if (contentType.startsWith("image/")) type = "photo";
                else if (contentType.startsWith("video/")) type = "video";
                else type = "document";

                mediaInfo = {
                    type,
                    url: att.url,
                    fileId: att.url,
                    uniqueFileId: att.id ?? att.url,
                    fileName: att.name ?? undefined,
                    mimeType: contentType || undefined,
                    fileSize: att.size ?? undefined,
                    width: att.width ?? undefined,
                    height: att.height ?? undefined,
                };
            }
        }

        return {
            messageId: message.id,
            chatId,
            userId,
            displayName,
            username,
            text,
            timestamp: message.createdAt?.toISOString?.() ?? new Date().toISOString(),
            replyToMessageId,
            chatTitle,
            chatType,
            isDirectMessage: isDM,
            mentionsAgent,
            mediaInfo,
        };
    }

    /**
     * Normalize an outgoing message (sent by the bot) for return to the caller.
     */
    private normalizeOutgoingMessage(message: any): Record<string, unknown> {
        return {
            id: message.id,
            text: message.content ?? "",
            channelId: message.channel?.id,
            guildId: message.guild?.id,
            timestamp: message.createdAt?.toISOString?.() ?? new Date().toISOString(),
        };
    }
}
