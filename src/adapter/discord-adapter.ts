/**
 * discord-adapter.ts — Discord 平台 adapter
 *
 * 使用 discord.js 库连接 Discord Gateway，
 * 监听消息并标准化后推入 NotificationCenter。
 * 通过 host-call 为 sandbox 提供 discord 代码接口。
 */

import type { NotificationCenter } from "../event/notification-center.js";
import type { DiscordConfig } from "../core/config.js";
import type { AdapterConnectionStatus, BackfillOptions, BackfillResult, PlatformAdapter } from "./platform-adapter.js";
import { ConnectionTracker } from "./connection-tracker.js";
import { isNewerThanWatermark, summarizeBackfillNotes } from "./backfill.js";
import type { IMemoryStoreV2 } from "../memory-v2/types.js";
import { composeChatId } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("discord-adapter");

const MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;
const MEDIA_SEND_TIMEOUT_MS = 25_000;
const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_RECONNECT_BASE_MS = 1000;
const DISCORD_RECONNECT_MAX_MS = 60_000;
const DISCORD_GATEWAY_RECOVERY_TIMEOUT_MS = 60_000;

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

type PreparedDiscordAttachment = {
    data: Buffer;
    name: string;
    contentType?: string;
    sizeBytes: number;
};

type DiscordClientFactory = () => Promise<any>;

/** 标准化后的 Discord 入站消息 */
interface NormalizedDiscordMessage {
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
}

/** 构造与实时入站完全一致的 NC 消息载荷（补抓路径复用，避免两套字段漂移） */
function buildDiscordNcMessage(normalized: NormalizedDiscordMessage): Record<string, unknown> {
    const source = {
        scene: "discord",
        platform: "discord",
        chatId: normalized.chatId,
        userId: normalized.userId,
        chatType: normalized.chatType,
        messageId: normalized.messageId,
        replyToMessageId: normalized.replyToMessageId,
    };
    const core = {
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
    };

    return {
        type: "nc.message",
        scene: "discord",
        source,
        ...core,
        payload: {
            scene: "discord",
            ...core,
            source,
            platformData: {
                originalType: "discord.message",
            },
        },
        _urgent: normalized.isDirectMessage || normalized.mentionsAgent || normalized.replyToMessageId ? true : false,
    };
}

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
    private stopRequested = false;
    private connecting: Promise<void> | null = null;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private gatewayRecoveryTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private readonly connection = new ConnectionTracker("discord");

    constructor(
        private config: DiscordConfig,
        private nc: NotificationCenter,
        private memory?: Pick<IMemoryStoreV2, "getPersonIdentity">,
        private createClient: DiscordClientFactory = defaultDiscordClientFactory,
    ) {}

    async start(): Promise<void> {
        if (!this.config.botToken) {
            throw new Error("discord.bot_token is required");
        }

        if (this.client) return;
        if (this.connecting) return this.connecting;

        this.stopRequested = false;
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        this.clearGatewayRecoveryWatchdog();
        try {
            await this.connect(false);
        } catch (err) {
            // discord.js 只能在已建立 gateway session 后自行恢复；首次登录失败
            // 必须由 adapter 排程，否则主进程虽然继续运行，Discord 会永久离线。
            this.connection.markDisconnected(String(err));
            this.scheduleReconnect("initialConnectFailed", { error: String(err) });
            throw err;
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.clearReconnectTimer();
        this.clearGatewayRecoveryWatchdog();
        const client = this.client;
        this.client = null;
        this.selfUserId = null;
        this.connection.markStopped();
        if (client) await this.destroyClient(client, "stop");
    }

    getConnectionStatus(): AdapterConnectionStatus {
        return this.connection.snapshot();
    }

    /** 手动重连：销毁当前 client 并立即重建，重置退避计数 */
    async reconnect(): Promise<void> {
        log.info("DiscordAdapter 手动重连");
        this.stopRequested = false;
        this.clearReconnectTimer();
        this.clearGatewayRecoveryWatchdog();
        this.reconnectAttempts = 0;
        this.connection.resetAttempts();

        const oldClient = this.client;
        this.client = null;
        this.selfUserId = null;
        if (oldClient) await this.destroyClient(oldClient, "manual reconnect");

        // 等待可能在途的 connect 结束，避免两个 client 同时登录
        if (this.connecting) {
            await this.connecting.catch(() => undefined);
        }
        try {
            await this.connect(true);
        } catch (err) {
            this.connection.markDisconnected(String(err));
            this.scheduleReconnect("manualReconnectFailed", { error: String(err) });
            throw err;
        }
    }

    private connect(isReconnect: boolean): Promise<void> {
        if (this.connecting) return this.connecting;
        this.connecting = this.createAndLoginClient(isReconnect)
            .finally(() => {
                this.connecting = null;
            });
        return this.connecting;
    }

    private async createAndLoginClient(isReconnect: boolean): Promise<void> {
        this.connection.markConnecting();
        const client = await this.createClient();
        this.attachClientLifecycle(client);
        this.attachMessageListener(client);

        try {
            await this.loginAndWaitForReady(client);
        } catch (err) {
            await this.destroyClient(client, "failed login");
            this.connection.markDisconnected(String(err));
            throw err;
        }

        if (this.stopRequested) {
            await this.destroyClient(client, "stopped before ready");
            this.connection.markStopped();
            return;
        }

        this.client = client;
        this.selfUserId = client.user?.id ?? null;
        this.reconnectAttempts = 0;
        this.connection.markConnected(
            `${client.user?.username ?? "?"} (${this.selfUserId ?? "?"}), guilds ${client.guilds?.cache?.size ?? 0}`,
        );
        log.info(isReconnect ? "DiscordAdapter 重连成功" : "Discord client ready", {
            username: client.user?.username,
            id: this.selfUserId,
            guilds: client.guilds?.cache?.size ?? 0,
        });
        log.info(`✅ DiscordAdapter 已启动: ${client.user?.username ?? "?"} (${this.selfUserId})`);
    }

    private loginAndWaitForReady(client: any): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;

            const cleanup = () => {
                client.off?.("ready", onReady);
                client.off?.("clientReady", onReady);
                client.off?.("error", onError);
            };
            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                cleanup();
                fn();
            };
            const onReady = () => settle(resolve);
            const onError = (err: unknown) => settle(() => {
                reject(err instanceof Error ? err : new Error(String(err)));
            });

            client.once("ready", onReady);
            client.once("clientReady", onReady);
            client.once("error", onError);
            Promise.resolve(client.login(this.config.botToken)).catch(onError);
        });
    }

    private attachClientLifecycle(client: any): void {
        client.on("shardReconnecting", (shardId: number) => {
            log.warn("Discord shard 正在重连", { shardId });
            if (this.client === client) this.connection.markConnecting();
            this.armGatewayRecoveryWatchdog(client, shardId);
        });
        client.on("shardResume", (shardId: number, replayedEvents: number) => {
            this.clearGatewayRecoveryWatchdog();
            if (this.client === client) this.connection.markConnected();
            log.info("Discord shard 已恢复", { shardId, replayedEvents });
        });
        client.on("shardReady", (shardId: number) => {
            this.clearGatewayRecoveryWatchdog();
            if (this.client === client) this.connection.markConnected();
            log.info("Discord shard ready", { shardId });
        });
        client.on("shardError", (err: Error, shardId: number) => {
            if (this.client === client) {
                this.connection.noteError(String(err));
                this.armGatewayRecoveryWatchdog(client, shardId);
            }
            log.warn("Discord shard error", { shardId, error: String(err) });
        });
        client.on("error", (err: Error) => {
            if (this.client === client) this.connection.noteError(String(err));
            log.warn("Discord client error", { error: String(err) });
        });
        client.on("invalidated", () => {
            log.warn("Discord session invalidated，将重建 client 并重连");
            this.scheduleReconnect("invalidated", {}, client);
        });
        client.on("shardDisconnect", (event: { code?: number; reason?: string; wasClean?: boolean }, shardId: number) => {
            log.warn("Discord shard 已断开且 discord.js 不会继续恢复，将重建 client 并重连", {
                shardId,
                code: event?.code,
                reason: event?.reason,
                wasClean: event?.wasClean,
            });
            this.scheduleReconnect("shardDisconnect", {
                shardId,
                code: event?.code,
                reason: event?.reason,
            }, client);
        });
    }

    private attachMessageListener(client: any): void {
        client.on("messageCreate", async (message: any) => {
            if (this.client !== client) return;
            this.handleIncomingMessage(message);
        });
    }

    private handleIncomingMessage(message: any): void {
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

        this.nc.push(buildDiscordNcMessage(normalized) as never);
    }

    /**
     * 补抓离线期间漏掉的消息。
     *
     * Discord gateway 的 RESUME 只在很短窗口内 replay，重新 IDENTIFY 后漏掉的消息
     * 不会补发，所以只能自己按 snowflake 分页拉：`messages.fetch({ after, limit })`。
     * snowflake 单调递增，配合本地水位线可以做到精确补齐（不多不少）。
     *
     * 频道来源只用本地 message_log 里出现过的会话 —— 不主动扫全部 guild 频道，
     * 避免把 agent 从没参与过的频道也拉进来。
     */
    async fetchMissedMessages(options: BackfillOptions): Promise<BackfillResult> {
        const client = this.client;
        if (!client) {
            return { chats: 0, messages: 0, notes: ["discord adapter 未连接"] };
        }

        const notes: string[] = [];
        let chatsTouched = 0;
        let delivered = 0;
        const chatIds = options.knownChatIds.slice(0, options.maxChats);

        for (const chatId of chatIds) {
            const watermark = options.getWatermark(chatId);
            // 没有水位线说明本地没有该频道的历史，无从判断"漏了什么"，跳过以免拉全量
            if (!watermark) continue;

            // chatId 可能是 discord:<guild>:<channel> 或 discord:<dmChannel>，
            // 复用 parseTarget 取出真正的 channelId
            const channelId = this.parseTarget(chatId).channelId;
            if (!channelId) continue;
            let chatDelivered = 0;

            try {
                const channel = await client.channels?.fetch?.(channelId);
                if (!channel?.messages?.fetch) continue;

                // after=水位线 → 返回比它更新的消息（最多 100 条/次）
                const fetched = await channel.messages.fetch({
                    after: watermark.messageId,
                    limit: Math.min(options.maxMessagesPerChat, 100),
                });
                const messages: any[] = typeof fetched?.values === "function"
                    ? [...fetched.values()]
                    : Array.isArray(fetched) ? fetched : [];
                if (messages.length === 0) continue;

                // fetch 返回新→旧，反转成时间正序
                messages.sort((left, right) => Number(left.createdTimestamp ?? 0) - Number(right.createdTimestamp ?? 0));

                for (const message of messages) {
                    if (message.author?.id === this.selfUserId) continue;
                    if (message.system) continue;
                    const normalized = this.normalizeIncomingMessage(message);
                    if (!normalized) continue;
                    if (!isNewerThanWatermark(
                        { messageId: normalized.messageId, timestamp: normalized.timestamp },
                        watermark,
                        "numeric-id",
                        options.since,
                    )) continue;

                    options.deliver(buildDiscordNcMessage(normalized));
                    chatDelivered++;
                    if (chatDelivered >= options.maxMessagesPerChat) break;
                }
            } catch (err) {
                notes.push(`${chatId} fetch 失败: ${String(err).slice(0, 120)}`);
                continue;
            }

            if (chatDelivered > 0) {
                chatsTouched++;
                delivered += chatDelivered;
                log.info("Discord 补抓频道", { chatId, delivered: chatDelivered });
            }
        }

        return { chats: chatsTouched, messages: delivered, notes: summarizeBackfillNotes(notes) };
    }

    private scheduleReconnect(reason: string, details: Record<string, unknown> = {}, sourceClient?: any): void {
        if (this.stopRequested || this.reconnectTimer) return;
        if (sourceClient && this.client && sourceClient !== this.client) return;

        this.clearGatewayRecoveryWatchdog();
        const oldClient = sourceClient ?? this.client;
        this.client = null;
        this.selfUserId = null;
        void this.destroyClient(oldClient, reason);

        this.reconnectAttempts++;
        const delay = this.getReconnectDelayMs(this.reconnectAttempts);
        this.connection.markRetryScheduled(this.reconnectAttempts, delay);
        log.info(`DiscordAdapter 将在 ${delay}ms 后重连 (第 ${this.reconnectAttempts} 次)`, {
            reason,
            ...details,
        });
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.stopRequested) return;
            try {
                await this.connect(true);
            } catch (err) {
                log.warn("DiscordAdapter 重连失败", { error: String(err) });
                this.scheduleReconnect("connectFailed", { error: String(err) });
            }
        }, delay);
        if (this.reconnectTimer.unref) this.reconnectTimer.unref();
    }

    private getReconnectDelayMs(attempt: number): number {
        return Math.min(
            DISCORD_RECONNECT_BASE_MS * Math.pow(2, attempt - 1),
            DISCORD_RECONNECT_MAX_MS,
        );
    }

    private armGatewayRecoveryWatchdog(client: any, shardId: number): void {
        if (this.gatewayRecoveryTimer) return;
        this.gatewayRecoveryTimer = setTimeout(() => {
            this.gatewayRecoveryTimer = null;
            if (this.stopRequested || this.client !== client) return;
            log.warn("Discord gateway 重连超时，将强制重建 client", {
                shardId,
                timeoutMs: DISCORD_GATEWAY_RECOVERY_TIMEOUT_MS,
            });
            this.scheduleReconnect("gatewayRecoveryTimeout", {
                shardId,
                timeoutMs: DISCORD_GATEWAY_RECOVERY_TIMEOUT_MS,
            }, client);
        }, DISCORD_GATEWAY_RECOVERY_TIMEOUT_MS);
    }

    private clearGatewayRecoveryWatchdog(): void {
        if (!this.gatewayRecoveryTimer) return;
        clearTimeout(this.gatewayRecoveryTimer);
        this.gatewayRecoveryTimer = null;
    }

    private clearReconnectTimer(): void {
        if (!this.reconnectTimer) return;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
    }

    private async destroyClient(client: any | null, reason: string): Promise<void> {
        if (!client) return;
        try {
            client.removeAllListeners?.();
            await client.destroy?.();
        } catch (err) {
            log.warn("Discord client destroy error", { reason, error: String(err) });
        }
    }

    canHandle(method: string): boolean {
        return method.startsWith("discord.");
    }

    getWriteMethods(): string[] {
        return [
            "discord.send",
            "discord.createMessage",
            "discord.sendText",
            "discord.sendMedia",
            "discord.sendReaction",
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
            case "discord.send":
            case "discord.createMessage": {
                const target = this.parseTarget(this.stripDiscordMentionDisplayLabels(String(args[0] ?? "")));
                log.info("discord.nativeSend:start", { requestId, method, target: target.raw, channelId: target.channelId });
                const channel = await this.resolveTextChannel(target, method === "discord.send" ? "send" : "createMessage", requestId);
                const channelId = channel.id ?? target.channelId;
                const sendOpts = await this.normalizeDiscordNativeSendOptions(args[1], requestId, channelId);
                const textLength = typeof sendOpts === "string"
                    ? sendOpts.length
                    : typeof sendOpts.content === "string"
                        ? sendOpts.content.length
                        : 0;

                const sendStart = Date.now();
                const sent = await channel.send(sendOpts);
                log.info("discord.nativeSend:success", {
                    requestId,
                    method,
                    channelId,
                    durationMs: Date.now() - callStart,
                    sendDurationMs: Date.now() - sendStart,
                    messageId: sent?.id,
                    textLength,
                });
                return this.normalizeOutgoingMessage(sent);
            }
            case "discord.sendText": {
                // args: [chatId, text, opts?]
                const target = this.parseTarget(this.stripDiscordMentionDisplayLabels(String(args[0] ?? "")));
                log.info("discord.sendText:start", { requestId, target: target.raw, channelId: target.channelId });
                const channel = await this.resolveTextChannel(target, "sendText", requestId);
                const channelId = channel.id ?? target.channelId;
                const text = this.stripDiscordMentionDisplayLabels(String(args[1] ?? ""));
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
                const target = this.parseTarget(this.stripDiscordMentionDisplayLabels(String(args[0] ?? "")));
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
                    sendOpts.content = this.stripDiscordMentionDisplayLabels(media.caption);
                } else if (typeof opts.caption === "string") {
                    sendOpts.content = this.stripDiscordMentionDisplayLabels(opts.caption);
                }
                if (opts.replyTo) {
                    sendOpts.reply = { messageReference: String(opts.replyTo) };
                }

                // Attach file
                const files: PreparedDiscordAttachment[] = [];
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
                const sent = await this.sendDiscordMediaMessage(channelId, sendOpts, files, requestId);
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
            case "discord.sendReaction": {
                const target = this.parseTarget(this.stripDiscordMentionDisplayLabels(String(args[0] ?? "")));
                const messageId = String(args[1] ?? "").trim();
                const emoji = String(args[2] ?? "").trim();
                if (!messageId) {
                    throw new Error("sendReaction: messageId is required");
                }
                if (!emoji) {
                    throw new Error("sendReaction: emoji is required");
                }

                log.info("discord.sendReaction:start", {
                    requestId,
                    target: target.raw,
                    channelId: target.channelId,
                    messageId,
                    emoji,
                });

                const channel = await this.resolveTextChannel(target, "sendReaction", requestId);
                const channelId = channel.id ?? target.channelId;
                if (typeof channel?.messages?.fetch !== "function") {
                    throw new Error(`sendReaction: channel ${channelId} does not support message fetching`);
                }

                const fetchStart = Date.now();
                const message = await channel.messages.fetch(messageId);
                if (!message || typeof message.react !== "function") {
                    throw new Error(`sendReaction: message ${messageId} is not reactable`);
                }

                const reactStart = Date.now();
                await message.react(emoji);
                log.info("discord.sendReaction:success", {
                    requestId,
                    channelId,
                    messageId,
                    emoji,
                    durationMs: Date.now() - callStart,
                    fetchDurationMs: reactStart - fetchStart,
                    reactDurationMs: Date.now() - reactStart,
                });
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

    private async downloadMediaWithTimeout(url: string, timeoutMs: number): Promise<{ buffer: Buffer; contentType?: string }> {
        const signal = AbortSignal.timeout(timeoutMs);
        const response = await fetch(url, { signal });
        if (!response.ok) {
            throw new Error(`sendMedia download failed: HTTP ${response.status} for ${url}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        return {
            buffer: Buffer.from(arrayBuffer),
            contentType: response.headers.get("content-type") ?? undefined,
        };
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
        const directTargetMatch = rest.match(/^(?:dm|private|user):(.+)$/);
        if (directTargetMatch) {
            return { raw, channelId: directTargetMatch[1], canFallbackToUser: true };
        }

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

    private async normalizeDiscordNativeSendOptions(value: unknown, requestId: string, channelId: string): Promise<Record<string, unknown> | string> {
        if (typeof value === "string") {
            return this.stripDiscordMentionDisplayLabels(value);
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            return { content: String(value ?? "") };
        }

        const raw = value as Record<string, unknown>;
        const out: Record<string, unknown> = { ...raw };
        if (typeof out.content === "string") {
            out.content = this.stripDiscordMentionDisplayLabels(out.content);
        }

        if (Array.isArray(raw.files)) {
            const files = await Promise.all(raw.files.map(async (item, index) => {
                if (typeof item === "string" || Buffer.isBuffer(item) || item instanceof Uint8Array) {
                    const prepared = await this.buildAttachment(item, undefined, requestId, channelId);
                    return { attachment: prepared.data, name: prepared.name };
                }
                if (item && typeof item === "object") {
                    const rec = item as Record<string, unknown>;
                    const source = rec.attachment ?? rec.file ?? rec.data ?? rec.url;
                    if (source != null) {
                        const name = typeof rec.name === "string"
                            ? rec.name
                            : typeof rec.fileName === "string"
                                ? rec.fileName
                                : undefined;
                        const prepared = await this.buildAttachment(source, name, requestId, channelId);
                        return { ...rec, attachment: prepared.data, name: prepared.name };
                    }
                }
                throw new Error(`discord.send: unsupported files[${index}]`);
            }));
            out.files = files;
        }

        return out;
    }

    private enrichDiscordMentionDisplayNames(text: string, message?: any): string {
        if (!text.includes("<@")) return text;

        return text.replace(/<@!?(\d+)>/g, (mention: string, rawUserId: string, offset: number, fullText: string) => {
            if (this.hasMentionDisplayLabel(fullText, offset + mention.length)) return mention;

            const displayName = this.resolveMentionDisplayName(rawUserId, message);
            if (!displayName) return mention;

            return `${mention}(${displayName})`;
        });
    }

    private stripDiscordMentionDisplayLabels(text: string): string {
        if (!text.includes("<@")) return text;
        return text.replace(/(<@!?\d+>)\([^)\r\n]{1,120}\)/g, "$1");
    }

    private hasMentionDisplayLabel(text: string, start: number): boolean {
        return /^\([^)\r\n]{1,120}\)/.test(text.slice(start));
    }

    private resolveMentionDisplayName(rawUserId: string, message?: any): string | undefined {
        const compositeUserId = composeChatId("discord", rawUserId);
        try {
            const identityName = this.cleanMentionDisplayName(this.memory?.getPersonIdentity?.(compositeUserId)?.displayName);
            if (identityName) return identityName;
        } catch (err) {
            log.warn("discord.mentionEnrich:memoryLookupFailed", {
                userId: compositeUserId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        const member = message?.mentions?.members?.get?.(rawUserId);
        const memberName = this.cleanMentionDisplayName(member?.displayName);
        if (memberName) return memberName;

        const mentionedUser = message?.mentions?.users?.get?.(rawUserId);
        const mentionedUserName = this.cleanMentionDisplayName(
            mentionedUser?.displayName ?? mentionedUser?.globalName ?? mentionedUser?.username,
        );
        if (mentionedUserName) return mentionedUserName;

        if (this.selfUserId === rawUserId) {
            return this.cleanMentionDisplayName(this.client?.user?.displayName ?? this.client?.user?.globalName ?? this.client?.user?.username);
        }

        const cachedUser = this.client?.users?.cache?.get?.(rawUserId);
        return this.cleanMentionDisplayName(cachedUser?.displayName ?? cachedUser?.globalName ?? cachedUser?.username);
    }

    private cleanMentionDisplayName(value: unknown): string | undefined {
        if (typeof value !== "string") return undefined;
        const cleaned = value.replace(/[()\r\n]+/g, " ").replace(/\s+/g, " ").trim();
        if (!cleaned) return undefined;
        return cleaned.length > 80 ? `${cleaned.slice(0, 77)}...` : cleaned;
    }

    private async buildAttachment(source: unknown, fileName: string | undefined, requestId: string, channelId: string): Promise<PreparedDiscordAttachment> {
        if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
            const buffer = Buffer.from(source as Buffer | Uint8Array);
            log.info("discord.sendMedia:usingBuffer", {
                requestId,
                channelId,
                sizeBytes: buffer.byteLength,
            });
            return {
                data: buffer,
                name: fileName ?? "attachment.bin",
                sizeBytes: buffer.byteLength,
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
                sizeBytes: downloaded.buffer.byteLength,
            });
            const inferredName = this.fileNameFromUrl(source);
            return {
                data: downloaded.buffer,
                name: fileName ?? inferredName ?? "attachment.bin",
                contentType: downloaded.contentType,
                sizeBytes: downloaded.buffer.byteLength,
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
                data: parsed.buffer,
                name: fileName ?? this.defaultFileNameForMimeType(parsed.mimeType),
                contentType: parsed.mimeType,
                sizeBytes: parsed.buffer.byteLength,
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
            data: buffer,
            name: fileName ?? basename(resolved),
            sizeBytes: buffer.byteLength,
        };
    }

    private async sendDiscordMediaMessage(
        channelId: string,
        sendOpts: Record<string, unknown>,
        files: PreparedDiscordAttachment[],
        requestId: string,
    ): Promise<Record<string, unknown>> {
        const payload: Record<string, unknown> = {};
        if (typeof sendOpts.content === "string" && sendOpts.content.length > 0) {
            payload.content = sendOpts.content;
        }

        const reply = sendOpts.reply as { messageReference?: unknown } | undefined;
        if (reply?.messageReference) {
            payload.message_reference = {
                message_id: String(reply.messageReference),
                fail_if_not_exists: false,
            };
        }

        if (files.length > 0) {
            payload.attachments = files.map((file, index) => ({
                id: String(index),
                filename: file.name,
            }));
        }

        log.info("discord.sendMedia:uploadStart", {
            requestId,
            channelId,
            fileCount: files.length,
            totalSizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
            timeoutMs: MEDIA_SEND_TIMEOUT_MS,
        });

        const sent = await this.postDiscordMessage(channelId, payload, files, requestId);
        log.info("discord.sendMedia:uploadResponse", {
            requestId,
            channelId,
            messageId: sent.id,
        });
        return sent;
    }

    private async postDiscordMessage(
        channelId: string,
        payload: Record<string, unknown>,
        files: PreparedDiscordAttachment[],
        requestId: string,
    ): Promise<Record<string, unknown>> {
        const url = `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages`;
        const maxAttempts = 2;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const signal = AbortSignal.timeout(MEDIA_SEND_TIMEOUT_MS);
            const startedAt = Date.now();
            let response: Response;
            try {
                response = await fetch(url, {
                    method: "POST",
                    headers: this.buildDiscordRequestHeaders(files.length === 0),
                    body: files.length > 0 ? this.buildDiscordMultipartBody(payload, files) : JSON.stringify(payload),
                    signal,
                });
            } catch (err) {
                if (this.isAbortLikeError(err)) {
                    throw new Error(`sendMedia upload timeout after ${MEDIA_SEND_TIMEOUT_MS}ms`);
                }
                throw err;
            }

            const bodyText = await response.text();
            if (response.status === 429 && attempt < maxAttempts) {
                const retryAfterMs = this.parseRetryAfterMs(response, bodyText);
                if (retryAfterMs > 0 && retryAfterMs < MEDIA_SEND_TIMEOUT_MS) {
                    log.warn("discord.sendMedia:rateLimited", {
                        requestId,
                        channelId,
                        attempt,
                        retryAfterMs,
                    });
                    await this.sleep(retryAfterMs);
                    continue;
                }
            }

            if (!response.ok) {
                throw new Error(`sendMedia upload failed: HTTP ${response.status} ${this.describeDiscordErrorBody(bodyText)}`);
            }

            log.debug("discord.sendMedia:uploadHttpOk", {
                requestId,
                channelId,
                attempt,
                durationMs: Date.now() - startedAt,
                status: response.status,
            });
            return bodyText ? JSON.parse(bodyText) as Record<string, unknown> : {};
        }

        throw new Error("sendMedia upload failed after retry");
    }

    private buildDiscordRequestHeaders(isJson: boolean): HeadersInit {
        return {
            Authorization: `Bot ${this.config.botToken}`,
            "User-Agent": "CyberGroupmate DiscordAdapter",
            ...(isJson ? { "Content-Type": "application/json" } : {}),
        };
    }

    private buildDiscordMultipartBody(payload: Record<string, unknown>, files: PreparedDiscordAttachment[]): FormData {
        const body = new FormData();
        for (const [index, file] of files.entries()) {
            const bytes = Uint8Array.from(file.data);
            body.append(
                `files[${index}]`,
                new Blob([bytes], { type: file.contentType ?? "application/octet-stream" }),
                file.name,
            );
        }
        body.append("payload_json", JSON.stringify(payload));
        return body;
    }

    private parseRetryAfterMs(response: Response, bodyText: string): number {
        const headerValue = response.headers.get("retry-after");
        if (headerValue) {
            const seconds = Number(headerValue);
            if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
        }

        try {
            const parsed = JSON.parse(bodyText) as { retry_after?: unknown };
            const seconds = Number(parsed.retry_after);
            if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
        } catch {
            // Ignore malformed rate-limit bodies; the caller will surface the HTTP error.
        }
        return 0;
    }

    private describeDiscordErrorBody(bodyText: string): string {
        if (!bodyText) return "(empty response body)";
        try {
            const parsed = JSON.parse(bodyText) as { message?: unknown; code?: unknown };
            const message = typeof parsed.message === "string" ? parsed.message : bodyText;
            return parsed.code != null ? `${message} (code ${String(parsed.code)})` : message;
        } catch {
            return bodyText.slice(0, 500);
        }
    }

    private isAbortLikeError(err: unknown): boolean {
        return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
    }

    private async sleep(ms: number): Promise<void> {
        await new Promise<void>(resolve => setTimeout(resolve, ms));
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
    private normalizeIncomingMessage(message: any): NormalizedDiscordMessage | null {
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

        text = this.enrichDiscordMentionDisplayNames(text, message);

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
            channelId: message.channel?.id ?? message.channel_id,
            guildId: message.guild?.id ?? message.guild_id,
            timestamp: message.createdAt?.toISOString?.() ?? message.timestamp ?? new Date().toISOString(),
        };
    }
}

async function defaultDiscordClientFactory(): Promise<any> {
    // Dynamic import to avoid top-level dependency on discord.js.
    const { Client, GatewayIntentBits, Partials } = await import("discord.js");
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
        ],
        partials: [
            Partials.Channel,
            Partials.Message,
        ],
    });
}
