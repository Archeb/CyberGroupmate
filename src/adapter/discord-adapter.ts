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

const log = createLogger("discord-adapter");

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

        switch (method) {
            case "discord.sendText": {
                // args: [chatId, text, opts?]
                const channelId = this.extractChannelId(String(args[0] ?? ""));
                const channel = await this.client.channels.fetch(channelId);
                if (!channel?.isTextBased?.()) {
                    throw new Error(`sendText: channel ${channelId} is not text-based`);
                }
                const text = String(args[1] ?? "");
                const opts = (args[2] ?? {}) as Record<string, unknown>;

                const sendOpts: Record<string, unknown> = { content: text };
                // Support replyTo
                if (opts.replyTo) {
                    sendOpts.reply = { messageReference: String(opts.replyTo) };
                }

                const sent = await channel.send(sendOpts);
                return this.normalizeOutgoingMessage(sent);
            }
            case "discord.sendMedia": {
                // args: [chatId, media, opts?]
                const channelId = this.extractChannelId(String(args[0] ?? ""));
                const channel = await this.client.channels.fetch(channelId);
                if (!channel?.isTextBased?.()) {
                    throw new Error(`sendMedia: channel ${channelId} is not text-based`);
                }
                const media = (args[1] ?? {}) as Record<string, unknown>;
                const opts = (args[2] ?? {}) as Record<string, unknown>;

                const sendOpts: Record<string, unknown> = {};
                if (typeof media.caption === "string") {
                    sendOpts.content = media.caption;
                }
                if (opts.replyTo) {
                    sendOpts.reply = { messageReference: String(opts.replyTo) };
                }

                // Attach file
                const files: Array<Record<string, unknown>> = [];
                if (media.file) {
                    const attachment: Record<string, unknown> = {};
                    if (Buffer.isBuffer(media.file) || media.file instanceof Uint8Array) {
                        attachment.attachment = Buffer.from(media.file as Buffer);
                    } else if (typeof media.file === "string") {
                        attachment.attachment = media.file; // URL or file path
                    }
                    if (typeof media.fileName === "string") {
                        attachment.name = media.fileName;
                    }
                    files.push(attachment);
                } else if (typeof media.url === "string") {
                    files.push({ attachment: media.url });
                }
                if (files.length > 0) {
                    sendOpts.files = files;
                }

                const sent = await channel.send(sendOpts);
                return this.normalizeOutgoingMessage(sent);
            }
            case "discord.sendTyping": {
                const channelId = this.extractChannelId(String(args[0] ?? ""));
                const channel = await this.client.channels.fetch(channelId);
                if (channel?.isTextBased?.() && typeof channel.sendTyping === "function") {
                    await channel.sendTyping();
                }
                return null;
            }
            case "discord.downloadMedia": {
                // args: [fileId (=URL for Discord), chatId?, messageId?, uniqueFileId?]
                const url = String(args[0] ?? "");
                if (!url) throw new Error("discord.downloadMedia: URL is required");
                const buf = await this.downloadMedia(null, url);
                return { buffer: buf.toString("base64"), size: buf.length };
            }
            default:
                throw new Error(`Unsupported DiscordAdapter call: ${method}`);
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

    // ─── Internal ───

    /**
     * Extract the Discord channel ID from a composite chatId.
     * For guild channels: discord:guildId:channelId → channelId
     * For DMs: discord:channelId → channelId
     */
    private extractChannelId(chatId: string): string {
        // Strip "discord:" prefix
        let rest = chatId;
        if (rest.startsWith("discord:")) {
            rest = rest.slice("discord:".length);
        }
        // Three-part: guildId:channelId → channelId
        const colonIdx = rest.indexOf(":");
        if (colonIdx !== -1) {
            return rest.slice(colonIdx + 1);
        }
        // Two-part (DM): just the channelId
        return rest;
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
