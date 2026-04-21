/**
 * onebot-adapter.ts — OneBot v11 / NapCat 平台 adapter
 *
 * 通过 WebSocket 连接 NapCat / OneBot 服务，
 * 监听消息并标准化后推入 NotificationCenter。
 */

import type { NotificationCenter } from "../event/notification-center.js";
import type { OneBotConfig } from "../core/config.js";
import type { PlatformAdapter } from "./platform-adapter.js";
import { composeChatId, ensureCompositeId, parseChatId } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { WebSocket } from "ws";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const log = createLogger("onebot-adapter");

type OneBotMessageSegment = {
    type: string;
    data?: Record<string, unknown>;
};

type OneBotIncomingEvent = {
    post_type?: string;
    message_type?: "private" | "group";
    sub_type?: string;
    self_id?: number | string;
    user_id?: number | string;
    group_id?: number | string;
    message_id?: number | string;
    raw_message?: string;
    message?: string | OneBotMessageSegment[];
    sender?: {
        user_id?: number | string;
        nickname?: string;
        card?: string;
    };
    time?: number;
    reply?: {
        message_id?: number | string;
    };
};

type OneBotActionResponse = {
    status?: string;
    retcode?: number;
    data?: unknown;
    message?: string;
    echo?: string;
};

type OneBotMediaInfo = {
    type: "photo" | "video" | "document" | "other";
    url?: string;
    fileId: string;
    uniqueFileId: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
};

export class OneBotAdapter implements PlatformAdapter {
    readonly platform = "onebot";

    private ws: WebSocket | null = null;
    private started = false;
    private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();

    constructor(
        private config: OneBotConfig,
        private nc: NotificationCenter,
    ) {}

    async start(): Promise<void> {
        if (this.started) return;
        if (!this.config.wsUrl) throw new Error("onebot.ws_url is required");
        if (!this.config.selfId) throw new Error("onebot.self_id is required");

        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(this.config.wsUrl);
            this.ws = ws;

            ws.once("open", () => {
                this.started = true;
                log.info("OneBotAdapter 已连接", { wsUrl: this.config.wsUrl, selfId: this.config.selfId });
                resolve();
            });

            ws.once("error", (err) => {
                reject(err instanceof Error ? err : new Error(String(err)));
            });

            ws.on("message", (data) => {
                try {
                    this.handleWsMessage(String(data));
                } catch (err) {
                    log.warn("处理 OneBot 消息失败", { error: String(err) });
                }
            });

            ws.on("close", () => {
                this.started = false;
                this.ws = null;
                for (const [echo, pending] of this.pending.entries()) {
                    clearTimeout(pending.timer);
                    pending.reject(new Error(`OneBot websocket closed before response: ${echo}`));
                    this.pending.delete(echo);
                }
                log.warn("OneBot websocket 已断开");
            });
        });
    }

    async stop(): Promise<void> {
        if (!this.ws) return;
        this.ws.close();
        this.ws = null;
        this.started = false;
    }

    canHandle(method: string): boolean {
        return method.startsWith("onebot.") || method.startsWith("qq.");
    }

    getWriteMethods(): string[] {
        return [
            "onebot.sendText",
            "onebot.sendMedia",
            "onebot.sendFile",
            "onebot.sendTyping",
            "qq.sendText",
            "qq.sendMedia",
            "qq.sendFile",
            "qq.sendTyping",
        ];
    }

    formatMention(rawUserId: string, _username?: string): string | undefined {
        return `[CQ:at,qq=${rawUserId}]`;
    }

    async markAsRead(_chatId: string): Promise<void> {
        // OneBot v11 / NapCat 通常没有统一的标记已读接口，静默忽略。
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("OneBotAdapter is not started");
        }

        switch (method) {
            case "onebot.sendText":
            case "qq.sendText": {
                const chatId = ensureCompositeId("onebot", String(args[0] ?? ""));
                const text = String(args[1] ?? "");
                const opts = (args[2] ?? {}) as Record<string, unknown>;
                await this.applyHumanizedDelay(chatId, text.length);
                return this.sendMessage(chatId, text, opts);
            }
            case "onebot.sendMedia":
            case "qq.sendMedia": {
                const chatId = ensureCompositeId("onebot", String(args[0] ?? ""));
                const media = (args[1] ?? {}) as Record<string, unknown>;
                const opts = (args[2] ?? {}) as Record<string, unknown>;
                const caption = typeof media.caption === "string" ? media.caption : "";
                await this.applyHumanizedDelay(chatId, caption.length);
                return this.sendMedia(chatId, media, opts);
            }
            case "onebot.sendFile":
            case "qq.sendFile": {
                const chatId = ensureCompositeId("onebot", String(args[0] ?? ""));
                const filePath = String(args[1] ?? "");
                const opts = (args[2] ?? {}) as Record<string, unknown>;
                const caption = typeof opts.caption === "string" ? opts.caption : "";
                await this.applyHumanizedDelay(chatId, caption.length);
                return this.sendFile(chatId, filePath, opts);
            }
            case "onebot.sendTyping":
            case "qq.sendTyping": {
                return null;
            }
            case "onebot.downloadMedia":
            case "qq.downloadMedia": {
                const mediaRef = String(args[0] ?? "");
                if (!mediaRef) throw new Error("onebot.downloadMedia: mediaRef is required");
                return this.downloadMedia(null, mediaRef);
            }
            default:
                throw new Error(`Unsupported OneBot method: ${method}`);
        }
    }

    async downloadMedia(_rawMessage: unknown, mediaRef: string): Promise<Buffer> {
        if (mediaRef.startsWith("http://") || mediaRef.startsWith("https://")) {
            const resp = await fetch(mediaRef);
            if (!resp.ok) throw new Error(`downloadMedia: HTTP ${resp.status} for ${mediaRef}`);
            return Buffer.from(await resp.arrayBuffer());
        }
        throw new Error(`downloadMedia: unsupported mediaRef ${mediaRef}`);
    }

    private async sendMessage(chatId: string, text: string, opts: Record<string, unknown>): Promise<unknown> {
        const parsed = parseChatId(chatId);
        const message = this.applyReplyTo(text, opts.replyTo);
        if (parsed.rawId.startsWith("group:")) {
            const groupId = parsed.rawId.slice("group:".length);
            return this.callAction("send_group_msg", {
                group_id: Number(groupId),
                message,
            });
        }
        if (parsed.rawId.startsWith("private:")) {
            const userId = parsed.rawId.slice("private:".length);
            return this.callAction("send_private_msg", {
                user_id: Number(userId),
                message,
            });
        }
        throw new Error(`Unsupported onebot chatId: ${chatId}`);
    }

    private async sendMedia(chatId: string, media: Record<string, unknown>, opts: Record<string, unknown>): Promise<unknown> {
        const parsed = parseChatId(chatId);
        const segments = await this.buildOutgoingSegments(media, opts);
        if (parsed.rawId.startsWith("group:")) {
            const groupId = parsed.rawId.slice("group:".length);
            return this.callAction("send_group_msg", {
                group_id: Number(groupId),
                message: segments,
            });
        }
        if (parsed.rawId.startsWith("private:")) {
            const userId = parsed.rawId.slice("private:".length);
            return this.callAction("send_private_msg", {
                user_id: Number(userId),
                message: segments,
            });
        }
        throw new Error(`Unsupported onebot chatId: ${chatId}`);
    }

    private async sendFile(chatId: string, filePath: string, opts: Record<string, unknown>): Promise<unknown> {
        const resolvedPath = this.resolveWorkspacePath(filePath);
        if (!existsSync(resolvedPath)) throw new Error(`sendFile: 文件不存在: ${resolvedPath}`);
        const fileUrl = `file://${resolvedPath}`;
        const payload: Record<string, unknown> = {
            type: "document",
            file: fileUrl,
            caption: typeof opts.caption === "string" ? opts.caption : undefined,
            fileName: typeof opts.fileName === "string" ? opts.fileName : path.basename(resolvedPath),
        };
        return this.sendMedia(chatId, payload, opts);
    }

    private async buildOutgoingSegments(media: Record<string, unknown>, opts: Record<string, unknown>): Promise<OneBotMessageSegment[]> {
        const segments: OneBotMessageSegment[] = [];
        if (opts.replyTo != null) {
            segments.push({ type: "reply", data: { id: String(opts.replyTo) } });
        }

        const type = String(media.type ?? "");
        let file = media.file;
        if (typeof file === "string") {
            if (!(file.startsWith("http://") || file.startsWith("https://") || file.startsWith("base64://") || file.startsWith("file://"))) {
                file = `file://${this.resolveWorkspacePath(file)}`;
            }
        } else if (Buffer.isBuffer(file)) {
            file = `base64://${file.toString("base64")}`;
        }

        switch (type) {
            case "photo":
            case "image":
                segments.push({ type: "image", data: { file: String(file ?? "") } });
                break;
            case "video":
                segments.push({ type: "video", data: { file: String(file ?? "") } });
                break;
            case "audio":
            case "voice":
                segments.push({ type: "record", data: { file: String(file ?? "") } });
                break;
            case "document":
            default:
                segments.push({ type: "file", data: { file: String(file ?? "") } });
                break;
        }

        const caption = typeof media.caption === "string" ? media.caption : undefined;
        if (caption) {
            segments.push({ type: "text", data: { text: caption } });
        }
        return segments;
    }

    private applyReplyTo(text: string, replyTo: unknown): string | OneBotMessageSegment[] {
        if (replyTo == null) return text;
        return [
            { type: "reply", data: { id: String(replyTo) } },
            { type: "text", data: { text } },
        ];
    }

    private handleWsMessage(raw: string): void {
        const payload = JSON.parse(raw) as OneBotIncomingEvent | OneBotActionResponse;

        if (typeof (payload as OneBotActionResponse).echo === "string") {
            const echo = (payload as OneBotActionResponse).echo as string;
            const pending = this.pending.get(echo);
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(echo);
            const resp = payload as OneBotActionResponse;
            if (resp.status === "failed" || (typeof resp.retcode === "number" && resp.retcode !== 0)) {
                pending.reject(new Error(resp.message ?? `OneBot action failed: ${resp.retcode}`));
            } else {
                pending.resolve(resp.data ?? resp);
            }
            return;
        }

        const event = payload as OneBotIncomingEvent;
        if (event.post_type !== "message") return;
        if (String(event.self_id ?? "") !== String(this.config.selfId)) return;

        const normalized = this.normalizeIncomingMessage(event);
        if (!normalized) return;

        this.nc.push({
            type: "nc.message",
            scene: "onebot",
            source: {
                scene: "onebot",
                platform: "onebot",
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
                scene: "onebot",
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
                    scene: "onebot",
                    platform: "onebot",
                    chatId: normalized.chatId,
                    userId: normalized.userId,
                    chatType: normalized.chatType,
                    messageId: normalized.messageId,
                    replyToMessageId: normalized.replyToMessageId,
                },
                platformData: {
                    originalType: "onebot.message",
                },
            },
            _urgent: normalized.isDirectMessage || normalized.mentionsAgent || normalized.replyToMessageId ? true : false,
        });
    }

    private normalizeIncomingMessage(event: OneBotIncomingEvent) {
        const messageType = event.message_type;
        const userId = String(event.user_id ?? event.sender?.user_id ?? "");
        if (!userId) return null;

        const chatId = messageType === "group"
            ? composeChatId("onebot", `group:${String(event.group_id ?? "")}`)
            : composeChatId("onebot", `private:${userId}`);

        if (!this.isWhitelisted(messageType, String(event.group_id ?? ""), userId)) {
            return null;
        }

        const displayName = event.sender?.card || event.sender?.nickname || userId;
        const text = this.extractText(event.message ?? event.raw_message ?? "");
        const messageId = String(event.message_id ?? "");
        const replyToMessageId = this.extractReplyTo(event.message) ?? (event.reply?.message_id != null ? String(event.reply.message_id) : undefined);
        const mentionsAgent = this.hasAtSelf(event.message) || text.includes(String(this.config.selfId));
        const mediaInfo = this.extractMediaInfo(event.message);

        const normalizedText = text || (mediaInfo ? this.mediaPlaceholder(mediaInfo.type) : "");

        return {
            chatId,
            userId,
            displayName,
            username: undefined,
            text: normalizedText,
            timestamp: new Date((event.time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
            messageId,
            replyToMessageId,
            chatTitle: messageType === "group" ? String(event.group_id ?? "") : undefined,
            chatType: messageType === "group" ? "group" : "private",
            isDirectMessage: messageType === "private",
            mentionsAgent,
            mediaInfo,
        };
    }

    private extractText(message: string | OneBotMessageSegment[]): string {
        if (typeof message === "string") return message.replace(/\[CQ:[^\]]+\]/g, "").trim();
        if (!Array.isArray(message)) return "";
        return message.map(seg => {
            if (seg.type === "text") return String(seg.data?.text ?? "");
            if (seg.type === "at") return `[CQ:at,qq=${String(seg.data?.qq ?? "")}]`;
            return "";
        }).join("").trim();
    }

    private extractReplyTo(message: string | OneBotMessageSegment[] | undefined): string | undefined {
        if (!Array.isArray(message)) {
            const match = typeof message === "string" ? message.match(/\[CQ:reply,id=(\d+)\]/) : null;
            return match?.[1];
        }
        const seg = message.find(seg => seg.type === "reply");
        if (!seg) return undefined;
        const id = seg.data?.id;
        return id == null ? undefined : String(id);
    }

    private extractMediaInfo(message: string | OneBotMessageSegment[] | undefined): OneBotMediaInfo | undefined {
        if (!Array.isArray(message)) return undefined;
        for (const seg of message) {
            const data = seg.data ?? {};
            if (seg.type === "image") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const file = String(data.file ?? url ?? "");
                return {
                    type: "photo",
                    url,
                    fileId: file,
                    uniqueFileId: String(data.file_unique ?? data.file_id ?? file),
                    fileName: typeof data.file === "string" ? path.basename(String(data.file)) : undefined,
                };
            }
            if (seg.type === "video") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const file = String(data.file ?? url ?? "");
                return {
                    type: "video",
                    url,
                    fileId: file,
                    uniqueFileId: String(data.file_unique ?? data.file_id ?? file),
                    fileName: typeof data.file === "string" ? path.basename(String(data.file)) : undefined,
                };
            }
            if (seg.type === "file" || seg.type === "record") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const file = String(data.file ?? url ?? "");
                return {
                    type: "document",
                    url,
                    fileId: file,
                    uniqueFileId: String(data.file_unique ?? data.file_id ?? file),
                    fileName: typeof data.name === "string" ? data.name : (typeof data.file === "string" ? path.basename(String(data.file)) : undefined),
                };
            }
        }
        return undefined;
    }

    private mediaPlaceholder(type: OneBotMediaInfo["type"]): string {
        switch (type) {
            case "photo":
                return "[📷 图片]";
            case "video":
                return "[🎬 视频]";
            case "document":
                return "[📎 文件]";
            default:
                return "[📎 媒体]";
        }
    }

    private hasAtSelf(message: string | OneBotMessageSegment[] | undefined): boolean {
        if (!Array.isArray(message)) {
            return typeof message === "string" && message.includes(`[CQ:at,qq=${this.config.selfId}]`);
        }
        return message.some(seg => seg.type === "at" && String(seg.data?.qq ?? "") === String(this.config.selfId));
    }

    private isWhitelisted(messageType: "private" | "group" | undefined, groupId: string, userId: string): boolean {
        const wl = this.config.whitelist;
        if (!wl?.enabled) return true;
        if (messageType === "group") return wl.groups.includes(groupId);
        return wl.users.includes(userId);
    }

    private async callAction(action: string, params: Record<string, unknown>): Promise<unknown> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("OneBot websocket is not connected");
        }

        const echo = `cgm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const payload = JSON.stringify({ action, params, echo });

        return await new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new Error(`OneBot action timeout: ${action}`));
            }, 15000);

            this.pending.set(echo, { resolve, reject, timer });
            this.ws!.send(payload, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pending.delete(echo);
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
        });
    }

    private resolveWorkspacePath(filePath: string): string {
        if (filePath.startsWith("/")) return path.resolve(filePath);
        const workspaceDir = path.join(process.cwd(), "workspace");
        return path.resolve(workspaceDir, filePath);
    }

    private async applyHumanizedDelay(_chatId: string, textLen: number): Promise<void> {
        const cfg = this.config.humanizedDelay;
        if (!cfg?.enabled) return;
        const delay = Math.max(cfg.minDelay, Math.min(cfg.maxDelay, textLen * cfg.msPerChar));
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}
