/**
 * onebot-adapter.ts — OneBot v11 / NapCat 平台 adapter
 *
 * 通过 WebSocket 连接 NapCat / OneBot 服务，
 * 监听消息并标准化后推入 NotificationCenter。
 */

import type { NotificationCenter } from "../event/notification-center.js";
import type { OneBotConfig } from "../core/config.js";
import type { PlatformAdapter } from "./platform-adapter.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import { ensureSupportedFormat } from "../core/vision-processor.js";
import { composeChatId, ensureCompositeId, parseChatId } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import {
    getOneBotNapCatGuideGroupForAction,
    getOneBotNapCatWriteTarget,
    isAllowedOneBotNapCatAction,
    normalizeOneBotNapCatAction,
} from "../core/onebot-napcat-passthrough.js";
import { WebSocket } from "ws";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
    type: "photo" | "sticker" | "video" | "document" | "audio" | "other";
    url?: string;
    fileId: string;
    uniqueFileId: string;
    fileName?: string;
    mimeType?: string;
    fileSize?: number;
    width?: number;
    height?: number;
    emoji?: string;
};

export class OneBotAdapter implements PlatformAdapter {
    readonly platform = "onebot";

    private ws: WebSocket | null = null;
    private started = false;
    private stopRequested = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectAttempts = 0;
    private static readonly RECONNECT_BASE_MS = 1000;
    private static readonly RECONNECT_MAX_MS = 30_000;
    private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
    private readonly mutedChats = new Map<string, number>();
    /** 缓存群名：groupId → group_name
    * OneBot get_group_info 返回 group_name 字段
    * 群管理员改名后通过 notice 事件更新
    */
    private readonly groupNameCache = new Map<string, string>();
    /** 缓存用户昵称：userId → nickname
    * OneBot get_stranger_info / get_friend_list 返回 nickname 字段
    */
    private readonly userNickCache = new Map<string, string>();

    constructor(
        private config: OneBotConfig,
        private nc: NotificationCenter,
        private mediaDownloader?: MediaDownloader,
    ) {}

    async start(): Promise<void> {
        if (this.started) return;
        if (!this.config.wsUrl) throw new Error("onebot.ws_url is required");
        if (!this.config.selfId) throw new Error("onebot.self_id is required");

        this.stopRequested = false;
        this.reconnectAttempts = 0;
        await this.connect();

        // 连接成功后预加载白名单群组的名称
        this.prefetchWhitelistedGroups();
    }

    private connect(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const isReconnect = this.reconnectAttempts > 0;
            let settled = false;
            const ws = new WebSocket(this.config.wsUrl);
            this.ws = ws;

            ws.once("open", () => {
                settled = true;
                this.started = true;
                this.reconnectAttempts = 0;
                if (isReconnect) {
                    log.info("OneBotAdapter 重连成功", { wsUrl: this.config.wsUrl });
                } else {
                    log.info("OneBotAdapter 已连接", { wsUrl: this.config.wsUrl, selfId: this.config.selfId });
                }
                resolve();
            });

            ws.once("error", (err) => {
                if (isReconnect) {
                    log.warn("OneBotAdapter 重连失败", { error: String(err) });
                } else if (!settled) {
                    settled = true;
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
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
                this.drainPending();
                if (this.stopRequested) {
                    log.info("OneBot websocket 已关闭");
                    return;
                }
                log.warn("OneBot websocket 已断开，将自动重连");
                this.scheduleReconnect();
            });
        });
    }

    private drainPending(): void {
        for (const [echo, pending] of this.pending.entries()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(`OneBot websocket closed before response: ${echo}`));
            this.pending.delete(echo);
        }
    }

    private scheduleReconnect(): void {
        if (this.stopRequested || this.reconnectTimer) return;
        this.reconnectAttempts++;
        const delay = Math.min(
            OneBotAdapter.RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
            OneBotAdapter.RECONNECT_MAX_MS,
        );
        log.info(`OneBotAdapter 将在 ${delay}ms 后重连 (第 ${this.reconnectAttempts} 次)`);
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.stopRequested) return;
            try {
                await this.connect();
            } catch {
                // connect() rejects only on first call; reconnect failures
                // are handled by the close handler which re-schedules.
            }
        }, delay);
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (!this.ws) return;
        this.ws.close();
        this.ws = null;
        this.started = false;
    }

    /**
     * 连接成功后预加载白名单群组名称和私聊用户昵称。
     * 调用 get_group_list 和 get_friend_list 批量获取，
     * 填充缓存使快照立即显示群名而非群号。
     */
    private prefetchWhitelistedGroups(): void {
        // 异步执行，不阻塞 start()
        (async () => {
            try {
                // 1. 获取群列表
                const groupListResult = await this.callAction("get_group_list", {}) as Record<string, unknown>;
                const groupListData = groupListResult?.data ?? groupListResult;
                if (Array.isArray(groupListData)) {
                    for (const g of groupListData) {
                        const gid = String(g.group_id ?? "");
                        const gname = String(g.group_name ?? "");
                        if (gid && gname) {
                            this.groupNameCache.set(gid, gname);
                        }
                    }
                    log.info("预加载群列表成功", { count: groupListData.length, cached: this.groupNameCache.size });
                }
            } catch (err) {
                log.warn("预加载群列表失败", { error: String(err) });
            }

            try {
                // 2. 获取好友列表（私聊用户昵称）
                const friendListResult = await this.callAction("get_friend_list", {}) as Record<string, unknown>;
                const friendListData = friendListResult?.data ?? friendListResult;
                if (Array.isArray(friendListData)) {
                    for (const f of friendListData) {
                        const uid = String(f.user_id ?? "");
                        const nick = String(f.nickname ?? "");
                        if (uid && nick) {
                            this.userNickCache.set(uid, nick);
                        }
                    }
                    log.info("预加载好友列表成功", { count: friendListData.length, cached: this.userNickCache.size });
                }
            } catch (err) {
                log.warn("预加载好友列表失败", { error: String(err) });
            }
        })();
    }

    /**
     * 获取所有已缓存的群名和用户昵称，供外部批量更新 GroupModel。
     */
    getCachedNames(): { groupNames: ReadonlyMap<string, string>; userNicks: ReadonlyMap<string, string> } {
        return { groupNames: this.groupNameCache, userNicks: this.userNickCache };
    }

    canHandle(method: string): boolean {
        return method.startsWith("onebot.") || method.startsWith("qq.");
    }

    getWriteMethods(): string[] {
        return [
            "onebot.sendText",
            "onebot.sendMedia",
            "onebot.sendFile",
            "onebot.sendSticker",
            "onebot.sendFace",
            "onebot.sendTyping",
            "onebot.deleteMessages",
            "qq.sendText",
            "qq.sendMedia",
            "qq.sendFile",
            "qq.sendSticker",
            "qq.sendFace",
            "qq.sendTyping",
            "qq.deleteMessages",
        ];
    }

    formatMention(rawUserId: string, _username?: string): string | undefined {
        return `[CQ:at,qq=${rawUserId}]`;
    }

    async markAsRead(_chatId: string): Promise<void> {
        // OneBot v11 / NapCat 通常没有统一的标记已读接口，静默忽略。
    }

    muteChat(chatId: string, hours: number): void {
        const h = Number.isFinite(hours) && hours > 0 ? hours : 1;
        const expiryMs = Date.now() + h * 3600_000;
        this.mutedChats.set(chatId, expiryMs);
        log.info("muteChat (onebot)", { chatId, hours: h, expiryMs });
    }

    unmuteChat(chatId: string): void {
        this.mutedChats.delete(chatId);
        log.info("unmuteChat (onebot)", { chatId });
    }

    getMutedChats(): Array<{ chatId: string; expiry: number; remaining: string }> {
        const now = Date.now();
        const result: Array<{ chatId: string; expiry: number; remaining: string }> = [];
        for (const [chatId, expiry] of this.mutedChats.entries()) {
            if (expiry <= now) {
                this.mutedChats.delete(chatId);
                continue;
            }
            const mins = Math.max(1, Math.ceil((expiry - now) / 60000));
            result.push({ chatId, expiry, remaining: `${mins}m` });
        }
        return result;
    }

    isChatMuted(chatId: string): boolean {
        const expiry = this.mutedChats.get(chatId);
        if (!expiry) return false;
        if (expiry <= Date.now()) {
            this.mutedChats.delete(chatId);
            return false;
        }
        return true;
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("OneBotAdapter is not started");
        }

        const writeMethods = new Set(this.getWriteMethods());
        if (writeMethods.has(method)) {
            const chatId = ensureCompositeId("onebot", String(args[0] ?? ""));
            if (this.isChatMuted(chatId)) {
                throw new Error(`[禁言中] 你在该聊天已被 /mute，所有发送操作已被抑制。`);
            }
        }

        switch (method) {
            case "onebot.getMessage":
            case "qq.getMessage": {
                const messageId = String(args[0] ?? "").trim();
                if (!messageId) throw new Error("onebot.getMessage: messageId is required");
                return this.getMessage(messageId);
            }
            case "onebot.callApi":
            case "qq.callApi": {
                const action = String(args[0] ?? "").trim();
                const rawParams = args[1];
                const params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
                    ? rawParams as Record<string, unknown>
                    : {};
                return this.callNapCatGuideAction(action, params);
            }
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
            case "onebot.sendSticker":
            case "qq.sendSticker": {
                const chatId = ensureCompositeId("onebot", String(args[0] ?? ""));
                const sticker = args[1];
                const opts = (args[2] ?? {}) as Record<string, unknown>;
                const caption = typeof opts.caption === "string" ? opts.caption : "";
                await this.applyHumanizedDelay(chatId, caption.length);
                return this.sendSticker(chatId, sticker, opts);
            }
            case "onebot.sendFace":
            case "qq.sendFace": {
                const chatId = ensureCompositeId("onebot", String(args[0] ?? ""));
                const faceId = String(args[1] ?? "").trim();
                const opts = (args[2] ?? {}) as Record<string, unknown>;
                await this.applyHumanizedDelay(chatId, 0);
                return this.sendFace(chatId, faceId, opts);
            }
            case "onebot.deleteMessages":
            case "qq.deleteMessages": {
                const chatId = ensureCompositeId("onebot", String(args[0] ?? ""));
                const ids = Array.isArray(args[1]) ? args[1].map(id => String(id)).filter(Boolean) : [];
                return this.deleteMessages(chatId, ids);
            }
            case "onebot.sendTyping":
            case "qq.sendTyping": {
                return null;
            }
            case "onebot.downloadMedia":
            case "qq.downloadMedia": {
                const mediaRef = String(args[0] ?? "");
                if (!mediaRef) throw new Error("onebot.downloadMedia: mediaRef is required");
                const buffer = await this.downloadMedia(null, mediaRef);
                return {
                    buffer: buffer.toString("base64"),
                    size: buffer.length,
                };
            }
            default:
                throw new Error(`Unsupported OneBot method: ${method}`);
        }
    }

    private async getMessage(messageId: string): Promise<unknown> {
        const id = /^-?\d+$/.test(messageId) ? Number(messageId) : messageId;
        const result = await this.callAction("get_msg", { message_id: id }) as Record<string, unknown>;
        return result?.data ?? result;
    }

    private async callNapCatGuideAction(action: string, params: Record<string, unknown>): Promise<unknown> {
        const normalizedAction = normalizeOneBotNapCatAction(action);
        if (!normalizedAction) throw new Error("onebot.callApi: action is required");
        if (!isAllowedOneBotNapCatAction(normalizedAction)) {
            throw new Error(`onebot.callApi: NapCat action '${normalizedAction}' is not exposed through built-in guides`);
        }

        const targetChatId = getOneBotNapCatWriteTarget(normalizedAction, params);
        if (targetChatId && this.isChatMuted(targetChatId)) {
            throw new Error(`[禁言中] 你在该聊天已被 /mute，OneBot/NapCat 写操作 ${normalizedAction} 已被抑制。`);
        }

        const preparedParams = this.prepareNapCatGuideParams(normalizedAction, params);
        const group = getOneBotNapCatGuideGroupForAction(normalizedAction);
        log.debug("OneBot NapCat passthrough", { action: normalizedAction, guide: group });
        return this.callAction(normalizedAction, preparedParams);
    }

    private prepareNapCatGuideParams(action: string, params: Record<string, unknown>): Record<string, unknown> {
        const prepared = { ...params };
        const localFileParamActions = new Set(["get_image", "get_record", "ocr_image", "set_qq_avatar"]);
        if (!localFileParamActions.has(action)) return prepared;

        for (const key of ["file", "image"]) {
            const value = prepared[key];
            if (typeof value !== "string") continue;
            const dataUrl = this.toDataUrlIfLocalFile(value);
            if (dataUrl) prepared[key] = dataUrl;
        }
        return prepared;
    }

    async downloadMedia(_rawMessage: unknown, mediaRef: string): Promise<Buffer> {
        const ref = mediaRef.trim();
        if (!ref) throw new Error("downloadMedia: mediaRef is required");

        let messageLookupError: unknown;
        if (this.looksLikeMessageId(ref)) {
            try {
                return await this.downloadMediaFromMessage(ref);
            } catch (err) {
                messageLookupError = err;
                log.debug("按消息 ID 下载媒体失败，继续按媒体引用解析", {
                    mediaRef: ref,
                    error: String(err),
                });
            }
        }

        try {
            return await this.downloadDirectMediaRef(ref);
        } catch (err) {
            if (messageLookupError) {
                throw new Error(`downloadMedia: cannot resolve mediaRef ${ref}; get_msg failed: ${String(messageLookupError)}; direct lookup failed: ${String(err)}`);
            }
            throw err;
        }
    }

    private looksLikeMessageId(mediaRef: string): boolean {
        return /^-?\d+$/.test(mediaRef.trim());
    }

    private async downloadMediaFromMessage(messageId: string): Promise<Buffer> {
        const data = await this.getMessage(messageId) as Record<string, unknown> | undefined;
        const message = data?.message ?? data?.raw_message ?? "";
        const segments = this.normalizeMessageSegments(message);
        const mediaInfo = this.extractMediaInfo(segments);
        if (!mediaInfo) {
            throw new Error(`消息 ${messageId} 中没有可下载媒体`);
        }
        return this.downloadMediaInfo(mediaInfo);
    }

    private async downloadMediaInfo(mediaInfo: OneBotMediaInfo): Promise<Buffer> {
        if (mediaInfo.url) {
            return this.downloadDirectMediaRef(mediaInfo.url);
        }
        return this.downloadDirectMediaRef(mediaInfo.fileId);
    }

    private async downloadDirectMediaRef(mediaRef: string): Promise<Buffer> {
        if (mediaRef.startsWith("face:")) {
            throw new Error(`downloadMedia: QQ内置表情无法下载 (${mediaRef})`);
        }
        if (mediaRef.startsWith("mface:")) {
            throw new Error(`downloadMedia: QQ商城表情需通过URL下载 (${mediaRef})`);
        }
        const inlineBuffer = this.decodeInlineMedia(mediaRef);
        if (inlineBuffer) return inlineBuffer;
        if (mediaRef.startsWith("http://") || mediaRef.startsWith("https://")) {
            return this.fetchRemoteMedia(mediaRef);
        }
        // Fallback: try get_image OneBot API to resolve a downloadable URL
        const attempts = [
            { file: mediaRef },
            { file_id: mediaRef },
        ];
        let lastError: unknown;
        for (const params of attempts) {
            try {
                const result = await this.callAction("get_image", params) as Record<string, unknown>;
                const imgData = (result?.data ?? result) as Record<string, unknown>;
                const buffer = await this.bufferFromOneBotFileData(imgData);
                if (buffer) return buffer;
                lastError = new Error("get_image 未返回可下载 URL/base64，且本地路径不可读");
            } catch (e) {
                lastError = e;
                log.debug("get_image 回退失败", { mediaRef, params, error: String(e) });
            }
        }
        throw new Error(`downloadMedia: cannot resolve mediaRef ${mediaRef}${lastError ? ` (${String(lastError)})` : ""}`);
    }

    private async fetchRemoteMedia(url: string): Promise<Buffer> {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`downloadMedia: HTTP ${resp.status} for ${url}`);
        return Buffer.from(await resp.arrayBuffer());
    }

    private decodeInlineMedia(value: string): Buffer | null {
        const trimmed = value.trim();
        const dataUrlMatch = /^data:[^;]+;base64,(.+)$/i.exec(trimmed);
        const base64Payload = dataUrlMatch?.[1]
            ?? (trimmed.startsWith("base64://") ? trimmed.slice("base64://".length) : undefined);
        if (!base64Payload) return null;
        try {
            return Buffer.from(base64Payload, "base64");
        } catch {
            return null;
        }
    }

    private async bufferFromOneBotFileData(data: Record<string, unknown>): Promise<Buffer | null> {
        const base64 = typeof data.base64 === "string" ? data.base64 : undefined;
        if (base64) {
            const buffer = this.decodeInlineMedia(base64) ?? Buffer.from(base64, "base64");
            if (buffer.length > 0) return buffer;
        }

        const candidates = [
            typeof data.url === "string" ? data.url : undefined,
            typeof data.file === "string" ? data.file : undefined,
            typeof data.path === "string" ? data.path : undefined,
        ].filter((item): item is string => !!item && item.trim().length > 0);

        for (const candidate of candidates) {
            const inline = this.decodeInlineMedia(candidate);
            if (inline) return inline;
            if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
                return this.fetchRemoteMedia(candidate);
            }

            const localPath = candidate.startsWith("file://")
                ? path.resolve(candidate.slice("file://".length))
                : path.resolve(candidate);
            if (existsSync(localPath)) {
                return readFileSync(localPath);
            }
        }

        return null;
    }

    private async sendMessage(chatId: string, text: string, opts: Record<string, unknown>): Promise<unknown> {
        const parsed = parseChatId(chatId);
        const message = this.applyReplyTo(text, opts.replyTo);
        if (parsed.groupId != null) {
            return this.callAction("send_group_msg", {
                group_id: Number(parsed.groupId),
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
        const sanitizedOpts = this.sanitizeOutgoingMediaOptions(chatId, media, opts);
        const segments = await this.buildOutgoingSegments(media, sanitizedOpts);
        if (parsed.groupId != null) {
            return this.callAction("send_group_msg", {
                group_id: Number(parsed.groupId),
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

    private async sendSticker(chatId: string, sticker: unknown, opts: Record<string, unknown>): Promise<unknown> {
        let file: unknown = sticker;

        if (typeof sticker === "string") {
            const trimmed = sticker.trim();
            const looksLikeDirectFile = trimmed.startsWith("http://")
                || trimmed.startsWith("https://")
                || trimmed.startsWith("file://")
                || trimmed.startsWith("base64://")
                || trimmed.includes("/")
                || trimmed.includes("\\")
                || /\.[a-zA-Z0-9]{2,5}$/.test(trimmed);

            if (!looksLikeDirectFile && this.mediaDownloader) {
                const cachedPath = this.mediaDownloader.getExistingPath(trimmed);
                if (cachedPath) {
                    file = cachedPath;
                }
            }
            file = await this.normalizeOutgoingImageFile(file, {
                preserveAnimation: true,
                resizeForQqSticker: true,
            });
        } else if (sticker && typeof sticker === "object") {
            const rec = sticker as Record<string, unknown>;
            let resolvedFile = rec.file;
            // 兜底：如果没有 file，尝试通过 uniqueFileId 从媒体缓存查找本地文件（TG 贴纸转发 QQ 场景）
            if (!resolvedFile && typeof rec.uniqueFileId === "string" && this.mediaDownloader) {
                const cachedPath = this.mediaDownloader.getExistingPath(rec.uniqueFileId);
                if (cachedPath) resolvedFile = cachedPath;
            }
            if (typeof resolvedFile === "string") {
                resolvedFile = this.mediaDownloader?.getExistingPath(resolvedFile) ?? resolvedFile;
            }
            resolvedFile = await this.normalizeOutgoingImageFile(resolvedFile, {
                preserveAnimation: true,
                resizeForQqSticker: true,
            });
            file = { ...rec, file: resolvedFile };
        }

        const payload: Record<string, unknown> = typeof file === "string"
            ? {
                type: "photo",
                file,
                isSticker: true,
                caption: typeof opts.caption === "string" ? opts.caption : undefined,
            }
            : {
                ...(file as Record<string, unknown>),
                type: "photo",
                isSticker: true,
            };
        return this.sendMedia(chatId, payload, opts);
    }

    private async normalizeOutgoingImageFile(file: unknown, options?: { preserveAnimation?: boolean; resizeForQqSticker?: boolean }): Promise<unknown> {
        if (typeof file !== "string") return file;

        const resolvedPath = this.resolveFileReferenceToPath(file);
        if (!resolvedPath) return file;

        const lowerPath = resolvedPath.toLowerCase();
        const isAnimated = this.isAnimatedImagePath(resolvedPath);

        if (options?.preserveAnimation && isAnimated) {
            // 动图路径：webm/tgs → GIF，GIF 直接保留
            let normalizedPath = resolvedPath;
            if (lowerPath.endsWith(".webm") || lowerPath.endsWith(".tgs")) {
                normalizedPath = this.convertToAnimatedGif(resolvedPath);
            } else if (lowerPath.endsWith(".webp")) {
                // .webp 后缀但实际是 GIF 的文件，重命名为 .gif 确保 NapCat 正确识别
                const head = readFileSync(resolvedPath).subarray(0, 4);
                if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) {
                    // 实际是 GIF，复制为 .gif 扩展名
                    const stat = statSync(resolvedPath);
                    const hash = createHash("sha1").update(`${resolvedPath}:${stat.size}:${stat.mtimeMs}:rename-gif`).digest("hex").slice(0, 16);
                    const outDir = path.resolve(process.cwd(), "workspace", "Downloads", "other", "qq-converted");
                    mkdirSync(outDir, { recursive: true });
                    const outPath = path.join(outDir, `${path.basename(resolvedPath, path.extname(resolvedPath))}_${hash}.gif`);
                    if (!existsSync(outPath)) {
                        writeFileSync(outPath, readFileSync(resolvedPath));
                    }
                    normalizedPath = outPath;
                } else {
                    // 真正的 animated webp，转 GIF
                    normalizedPath = this.convertToAnimatedGif(resolvedPath);
                }
            }
            if (options?.resizeForQqSticker) {
                normalizedPath = this.resizeStickerImageForQq(normalizedPath);
            }
            return normalizedPath;
        }

        // 非动图路径（或未请求保留动画）：原逻辑
        const mimeType = this.inferImageMimeType(resolvedPath);
        let normalizedPath = resolvedPath;
        if (mimeType && mimeType !== "image/jpeg" && mimeType !== "image/png") {
            const rawBuffer = readFileSync(resolvedPath);
            const { buffer: convertedBuffer, mimeType: convertedMimeType } = await ensureSupportedFormat(rawBuffer, mimeType);
            if (convertedMimeType !== mimeType) {
                normalizedPath = this.writeOutgoingConvertedImage(resolvedPath, convertedBuffer, convertedMimeType);
            }
        }
        if (options?.resizeForQqSticker) {
            normalizedPath = this.resizeStickerImageForQq(normalizedPath);
        }
        return normalizedPath;
    }

    /** 判断文件是否为动图格式（GIF / webm / tgs / 扩展名不匹配但实际为 GIF 的 webp） */
    private isAnimatedImagePath(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".gif" || ext === ".webm" || ext === ".tgs") return true;
        // .webp 文件可能实际是 GIF（QQ/NapCat 有时用 .webp 扩展名存 GIF）
        // 或者是 animated webp（含 ANMF chunk）
        if (ext === ".webp" && existsSync(filePath)) {
            try {
                const buf = readFileSync(filePath);
                // 实际内容是 GIF？
                if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true; // "GIF"
                // Animated WebP: RIFF header + WEBP + 检查 ANMF chunk
                if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
                    return buf.includes(Buffer.from("ANMF"));
                }
            } catch { /* ignore */ }
        }
        return false;
    }

    /** 将 webm/tgs/animated-webp 动图转为 GIF（带调色板优化） */
    private convertToAnimatedGif(sourcePath: string): string {
        const stat = statSync(sourcePath);
        const hash = createHash("sha1")
            .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}:anim-gif`)
            .digest("hex")
            .slice(0, 16);
        const outDir = path.resolve(process.cwd(), "workspace", "Downloads", "other", "qq-converted");
        mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `${path.basename(sourcePath, path.extname(sourcePath))}_${hash}.gif`);
        if (existsSync(outPath)) {
            return outPath;
        }
        try {
            execFileSync("ffmpeg", [
                "-hide_banner", "-loglevel", "error",
                "-i", sourcePath,
                "-vf", "scale=200:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                outPath,
            ], {
                timeout: 15000,
                maxBuffer: 30 * 1024 * 1024,
            });
            return outPath;
        } catch (err) {
            log.warn("动图转 GIF 失败，回退原图", {
                sourcePath,
                error: String(err).slice(0, 200),
            });
            return sourcePath;
        }
    }

    private resolveFileReferenceToPath(file: string): string | null {
        if (file.startsWith("http://") || file.startsWith("https://") || file.startsWith("base64://")) {
            return null;
        }
        if (file.startsWith("file://")) {
            return path.resolve(file.slice("file://".length));
        }
        const normalized = path.isAbsolute(file) ? path.resolve(file) : this.resolveWorkspacePath(file);
        return existsSync(normalized) ? normalized : null;
    }

    private inferImageMimeType(filePath: string): string | null {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case ".jpg":
            case ".jpeg":
                return "image/jpeg";
            case ".png":
                return "image/png";
            case ".webp":
                return "image/webp";
            case ".bmp":
                return "image/bmp";
            case ".gif":
                return "image/gif";
            case ".tif":
            case ".tiff":
                return "image/tiff";
            case ".avif":
                return "image/avif";
            default:
                return null;
        }
    }

    private inferMimeTypeFromPath(filePath: string): string {
        const imageMime = this.inferImageMimeType(filePath);
        if (imageMime) return imageMime;
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case ".mp4": return "video/mp4";
            case ".mp3": return "audio/mpeg";
            case ".wav": return "audio/wav";
            case ".ogg": return "audio/ogg";
            case ".pdf": return "application/pdf";
            case ".txt": return "text/plain";
            case ".json": return "application/json";
            default: return "application/octet-stream";
        }
    }

    private toDataUrlIfLocalFile(file: string): string | null {
        const localPath = this.resolveFileReferenceToPath(file);
        if (!localPath) return null;
        const mimeType = this.inferMimeTypeFromPath(localPath);
        const buf = readFileSync(localPath);
        return `data:${mimeType};base64,${buf.toString("base64")}`;
    }

    private writeOutgoingConvertedImage(sourcePath: string, buffer: Buffer, mimeType: string): string {
        const stat = statSync(sourcePath);
        const ext = mimeType === "image/jpeg" ? ".jpg" : ".png";
        const hash = createHash("sha1")
            .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}:${mimeType}`)
            .digest("hex")
            .slice(0, 16);
        const outDir = path.resolve(process.cwd(), "workspace", "Downloads", "other", "qq-converted");
        mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, `${path.basename(sourcePath, path.extname(sourcePath))}_${hash}${ext}`);
        if (!existsSync(outPath)) {
            writeFileSync(outPath, buffer);
        }
        return outPath;
    }

    private resizeStickerImageForQq(sourcePath: string): string {
        const stat = statSync(sourcePath);
        const isGif = sourcePath.toLowerCase().endsWith(".gif");
        const suffix = isGif ? "sticker-anim-w200" : "sticker-w200";
        const hash = createHash("sha1")
            .update(`${sourcePath}:${stat.size}:${stat.mtimeMs}:${suffix}`)
            .digest("hex")
            .slice(0, 16);
        const outDir = path.resolve(process.cwd(), "workspace", "Downloads", "other", "qq-converted");
        mkdirSync(outDir, { recursive: true });
        const outExt = isGif ? ".gif" : ".png";
        const outPath = path.join(outDir, `${path.basename(sourcePath, path.extname(sourcePath))}_${hash}_w200${outExt}`);
        if (existsSync(outPath)) {
            return outPath;
        }
        try {
            if (isGif) {
                // 动画 GIF 缩放：保持帧，使用调色板优化
                execFileSync("ffmpeg", [
                    "-hide_banner", "-loglevel", "error",
                    "-i", sourcePath,
                    "-vf", "scale=200:-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
                    outPath,
                ], {
                    timeout: 15000,
                    maxBuffer: 30 * 1024 * 1024,
                });
            } else {
                // 静态图片缩放
                execFileSync("ffmpeg", [
                    "-hide_banner", "-loglevel", "error",
                    "-i", sourcePath,
                    "-vf", "scale=200:-2",
                    "-frames:v", "1",
                    outPath,
                ], {
                    timeout: 10000,
                    maxBuffer: 20 * 1024 * 1024,
                });
            }
            return outPath;
        } catch (err) {
            log.warn("贴纸缩放失败，回退原图", {
                sourcePath,
                error: String(err).slice(0, 200),
            });
            return sourcePath;
        }
    }

    private async sendFace(chatId: string, faceId: string, opts: Record<string, unknown>): Promise<unknown> {
        if (!faceId) throw new Error("sendFace: faceId 为空");
        const parsed = parseChatId(chatId);
        const segments: OneBotMessageSegment[] = [];
        if (opts.replyTo != null && opts.replyTo !== "") {
            segments.push({ type: "reply", data: { id: String(opts.replyTo) } });
        }
        segments.push({ type: "face", data: { id: faceId } });
        if (typeof opts.text === "string" && opts.text.trim()) {
            segments.push({ type: "text", data: { text: opts.text } });
        }
        if (parsed.groupId != null) {
            return this.callAction("send_group_msg", {
                group_id: Number(parsed.groupId),
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

    private async deleteMessages(chatId: string, messageIds: string[]): Promise<void> {
        if (messageIds.length === 0) return;
        const parsed = parseChatId(chatId);
        if (parsed.groupId == null) {
            throw new Error("deleteMessages: OneBot 目前仅支持群消息撤回");
        }
        for (const id of messageIds) {
            await this.callAction("delete_msg", { message_id: Number(id) });
        }
    }

    private async buildOutgoingSegments(media: Record<string, unknown>, opts: Record<string, unknown>): Promise<OneBotMessageSegment[]> {
        const segments: OneBotMessageSegment[] = [];
        if (opts.replyTo != null) {
            segments.push({ type: "reply", data: { id: String(opts.replyTo) } });
        }

        const type = String(media.type ?? "");
        let file = media.file;
        if ((type === "photo" || type === "image") && typeof file === "string") {
            // isSticker 时 sendSticker 已做过 normalize（含 preserveAnimation），跳过二次处理
            // 非 sticker 发送也保留动图（QQ 原生支持 GIF）
            if (!media.isSticker) {
                file = await this.normalizeOutgoingImageFile(file, { preserveAnimation: true });
            }
        }
        if (this.config.sendFileAsDataUrl === true && typeof file === "string") {
            const dataUrl = this.toDataUrlIfLocalFile(file);
            if (dataUrl) file = dataUrl;
        }
        if (typeof file === "string") {
            if (!(file.startsWith("http://") || file.startsWith("https://") || file.startsWith("base64://") || file.startsWith("file://") || file.startsWith("data:"))) {
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

    private sanitizeOutgoingMediaOptions(chatId: string, media: Record<string, unknown>, opts: Record<string, unknown>): Record<string, unknown> {
        const mediaType = String(media.type ?? "");
        if ((mediaType !== "audio" && mediaType !== "voice") || opts.replyTo == null) {
            return opts;
        }

        log.warn("OneBot 语音暂不支持 replyTo，已忽略该参数", {
            chatId,
            replyTo: String(opts.replyTo),
        });

        const nextOpts = { ...opts };
        delete nextOpts.replyTo;
        return nextOpts;
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

        // 处理 notice 事件（群名变更等）
        if (event.post_type === "notice") {
            this.handleNoticeEvent(event);
            return;
        }

        if (event.post_type !== "message") return;
        if (String(event.self_id ?? "") !== String(this.config.selfId)) return;

        // normalizeIncomingMessage 是异步的（需要调用 OneBot API 获取群名/昵称）
        this.normalizeIncomingMessage(event).then(normalized => {
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
        }).catch(err => {
            log.warn("异步处理 OneBot 消息失败", { error: String(err) });
        });
    }


    /**
     * 处理 OneBot notice 事件：群名变更、群成员昵称变更等。
     * 这些事件用于实时更新缓存，确保 chatTitle 始终反映最新状态。
     */
    private handleNoticeEvent(event: OneBotIncomingEvent): void {
        const noticeType = (event as Record<string, unknown>).notice_type;

        if (noticeType === "group_name_change") {
            // 群名变更事件（NapCat 扩展）
            const groupId = String(event.group_id ?? "");
            const newName = String((event as Record<string, unknown>).group_name ?? "");
            if (groupId && newName) {
                const oldName = this.groupNameCache.get(groupId);
                this.groupNameCache.set(groupId, newName);
                log.info("群名变更", { groupId, oldName, newName });
            }
            return;
        }

        if (noticeType === "group_card" || noticeType === "group_card_change") {
            // 群成员昵称变更（部分实现支持的扩展事件）
            const userId = String(event.user_id ?? "");
            const card = String(event.sender?.card ?? (event as Record<string, unknown>).card ?? "");
            if (userId && card) {
                this.userNickCache.set(userId, card);
                log.debug("群名片变更", { userId, card });
            }
            return;
        }
    }

    /**
     * 异步获取群名称，带缓存。
     * 调用 OneBot get_group_info API，成功后缓存结果。
     */
    private async fetchGroupName(groupId: string): Promise<string | undefined> {
        if (this.groupNameCache.has(groupId)) {
            return this.groupNameCache.get(groupId)!;
        }
        try {
            const result = await this.callAction("get_group_info", { group_id: Number(groupId) }) as Record<string, unknown>;
            const data = (result?.data ?? result) as Record<string, unknown> | undefined;
            const name = typeof data?.group_name === "string" ? data.group_name : undefined;
            if (name) {
                this.groupNameCache.set(groupId, name);
                log.debug("获取群名成功", { groupId, groupName: name });
            }
            return name;
        } catch (err) {
            log.warn("获取群名失败", { groupId, error: String(err) });
            return undefined;
        }
    }

    /**
     * 异步获取用户昵称，带缓存。
     * 调用 OneBot get_stranger_info API，成功后缓存结果。
     */
    private async fetchUserNickname(userId: string): Promise<string | undefined> {
        if (this.userNickCache.has(userId)) {
            return this.userNickCache.get(userId)!;
        }
        try {
            const result = await this.callAction("get_stranger_info", { user_id: Number(userId) }) as Record<string, unknown>;
            const data = (result?.data ?? result) as Record<string, unknown> | undefined;
            const nickname = typeof data?.nickname === "string" ? data.nickname : undefined;
            if (nickname) {
                this.userNickCache.set(userId, nickname);
                log.debug("获取用户昵称成功", { userId, nickname });
            }
            return nickname;
        } catch (err) {
            log.warn("获取用户昵称失败", { userId, error: String(err) });
            return undefined;
        }
    }

    private async normalizeIncomingMessage(event: OneBotIncomingEvent) {
        const messageType = event.message_type;
        const userId = String(event.user_id ?? event.sender?.user_id ?? "");
        if (!userId) return null;

        const chatId = messageType === "group"
            ? composeChatId("onebot", `group:${String(event.group_id ?? "")}`)
            : composeChatId("onebot", `private:${userId}`);

        if (!this.isWhitelisted(messageType, String(event.group_id ?? ""), userId)) {
            return null;
        }

        const normalizedMessage = this.normalizeMessageSegments(event.message ?? event.raw_message ?? "");
        const displayName = event.sender?.card || event.sender?.nickname || userId;
        const messageId = String(event.message_id ?? "");
        const mentionsAgent = this.hasAtSelf(normalizedMessage);
        const mediaInfo = this.extractMediaInfo(normalizedMessage);
        const text = this.extractText(normalizedMessage);
        const replyToMessageId = this.extractReplyTo(normalizedMessage) ?? (event.reply?.message_id != null ? String(event.reply.message_id) : undefined);
        const normalizedText = text || (mediaInfo ? this.mediaPlaceholder(mediaInfo.type) : "");

        // 异步获取群名或用户昵称作为 chatTitle
        let chatTitle: string | undefined;
        if (messageType === "group") {
            const groupId = String(event.group_id ?? "");
            chatTitle = await this.fetchGroupName(groupId);
            // 回退：缓存未命中时先用群号，后台获取成功后会在下条消息更新
            if (!chatTitle) chatTitle = groupId;
        } else {
            // 私聊：用对方昵称作为 chatTitle
            const nickname = await this.fetchUserNickname(userId);
            chatTitle = nickname || displayName;
        }

        // 缓存发送者昵称（群聊时也缓存群成员昵称）
        if (event.sender?.nickname && userId) {
            this.userNickCache.set(userId, event.sender.nickname);
        }

        return {
            chatId,
            userId,
            displayName,
            username: undefined,
            text: normalizedText,
            timestamp: new Date((event.time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
            messageId,
            replyToMessageId,
            chatTitle,
            chatType: messageType === "group" ? "group" : "private",
            isDirectMessage: messageType === "private",
            mentionsAgent,
            mediaInfo,
        };
    }

    private normalizeMessageSegments(message: unknown): OneBotMessageSegment[] {
        if (Array.isArray(message)) {
            return message
                .map(seg => this.normalizeMessageSegment(seg))
                .filter((seg): seg is OneBotMessageSegment => !!seg);
        }
        const single = this.normalizeMessageSegment(message);
        if (single) return [single];
        if (typeof message === "string") return this.parseCqString(message);
        return [];
    }

    private normalizeMessageSegment(seg: unknown): OneBotMessageSegment | null {
        if (!seg || typeof seg !== "object") return null;
        const rec = seg as Record<string, unknown>;
        if (typeof rec.type !== "string") return null;
        const data = rec.data && typeof rec.data === "object"
            ? rec.data as Record<string, unknown>
            : {};
        return { type: rec.type, data };
    }

    private parseCqString(input: string): OneBotMessageSegment[] {
        const segments: OneBotMessageSegment[] = [];
        const regex = /\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = regex.exec(input)) !== null) {
            const before = input.slice(lastIndex, match.index);
            if (before) segments.push({ type: "text", data: { text: before } });

            const type = match[1];
            const rawAttrs = match[2] ?? "";
            const data: Record<string, unknown> = {};
            if (rawAttrs) {
                for (const pair of rawAttrs.slice(1).split(",")) {
                    const eqIdx = pair.indexOf("=");
                    if (eqIdx === -1) continue;
                    const key = pair.slice(0, eqIdx);
                    const value = pair.slice(eqIdx + 1)
                        .replaceAll("&#44;", ",")
                        .replaceAll("&#91;", "[")
                        .replaceAll("&#93;", "]")
                        .replaceAll("&amp;", "&");
                    data[key] = value;
                }
            }
            segments.push({ type, data });
            lastIndex = regex.lastIndex;
        }

        const rest = input.slice(lastIndex);
        if (rest) segments.push({ type: "text", data: { text: rest } });
        return segments;
    }

    private extractText(message: OneBotMessageSegment[]): string {
        return message.map(seg => {
            if (seg.type === "text") return String(seg.data?.text ?? "");
            if (seg.type === "at") return `[CQ:at,qq=${String(seg.data?.qq ?? "")}]`;
            if (seg.type === "face") {
                const id = String(seg.data?.id ?? "");
                const result = typeof seg.data?.result === "string" ? seg.data.result : "";
                return result ? `[🎭 QQ表情:${result}]` : `[🎭 QQ表情:${id}]`;
            }
            if (seg.type === "mface") {
                const summary = typeof seg.data?.summary === "string" ? seg.data.summary : "";
                return summary ? `[🎭 商城表情:${summary}]` : "[🎭 商城表情]";
            }
            return "";
        }).join("").trim();
    }

    private extractReplyTo(message: OneBotMessageSegment[]): string | undefined {
        const seg = message.find(seg => seg.type === "reply");
        if (!seg) return undefined;
        const id = seg.data?.id;
        return id == null ? undefined : String(id);
    }

    private extractMediaInfo(message: OneBotMessageSegment[]): OneBotMediaInfo | undefined {
        for (const seg of message) {
            const data = seg.data ?? {};
            if (seg.type === "image") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const file = String(data.file ?? data.path ?? "");
                const fileId = String(data.file_id ?? file);
                const subType = typeof data.sub_type === "number" ? data.sub_type
                    : typeof data.sub_type === "string" ? Number(data.sub_type) : undefined;
                const isSticker = subType === 1;
                return {
                    type: isSticker ? "sticker" : "photo",
                    url,
                    fileId: url || fileId,
                    uniqueFileId: String(data.file_unique ?? data.file_id ?? (file || url || fileId)),
                    fileName: typeof data.name === "string" ? data.name : (file ? path.basename(file) : undefined),
                    width: typeof data.width === "number" ? data.width : (typeof data.width === "string" ? Number(data.width) || undefined : undefined),
                    height: typeof data.height === "number" ? data.height : (typeof data.height === "string" ? Number(data.height) || undefined : undefined),
                    mimeType: typeof data.mime_type === "string" ? data.mime_type : undefined,
                    fileSize: typeof data.file_size === "number" ? data.file_size : (typeof data.file_size === "string" ? Number(data.file_size) || undefined : undefined),
                };
            }
            if (seg.type === "face") {
                const faceId = String(data.id ?? "");
                return {
                    type: "sticker",
                    fileId: `face:${faceId}`,
                    uniqueFileId: `face:${faceId}`,
                    emoji: typeof data.result === "string" ? data.result : undefined,
                };
            }
            if (seg.type === "mface") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const emojiPackageId = String(data.emoji_package_id ?? "");
                const emojiId = String(data.emoji_id ?? "");
                return {
                    type: "sticker",
                    url,
                    fileId: url ?? `mface:${emojiPackageId}_${emojiId}`,
                    uniqueFileId: `mface:${emojiPackageId}_${emojiId}`,
                    emoji: typeof data.summary === "string" ? data.summary : undefined,
                };
            }
            if (seg.type === "video") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const file = String(data.file ?? data.path ?? "");
                const fileId = String(data.file_id ?? file);
                return {
                    type: "video",
                    url,
                    fileId: url || fileId,
                    uniqueFileId: String(data.file_unique ?? data.file_id ?? (file || url || fileId)),
                    fileName: typeof data.name === "string" ? data.name : (file ? path.basename(file) : undefined),
                };
            }
            if (seg.type === "record") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const file = String(data.file ?? data.path ?? "");
                const fileId = String(data.file_id ?? file);
                return {
                    type: "audio",
                    url,
                    fileId: url || fileId,
                    uniqueFileId: String(data.file_unique ?? data.file_id ?? (file || url || fileId)),
                    fileName: typeof data.name === "string" ? data.name : (file ? path.basename(file) : undefined),
                };
            }
            if (seg.type === "file") {
                const url = typeof data.url === "string" ? data.url : undefined;
                const file = String(data.file ?? data.path ?? "");
                const fileId = String(data.file_id ?? file);
                return {
                    type: "document",
                    url,
                    fileId: url || fileId,
                    uniqueFileId: String(data.file_unique ?? data.file_id ?? (file || url || fileId)),
                    fileName: typeof data.name === "string" ? data.name : (file ? path.basename(file) : undefined),
                };
            }
        }
        return undefined;
    }

    private mediaPlaceholder(type: OneBotMediaInfo["type"]): string {
        switch (type) {
            case "photo":
                return "[📷 图片]";
            case "sticker":
                return "[🎭 表情包]";
            case "video":
                return "[🎬 视频]";
            case "audio":
                return "[🎤 语音]";
            case "document":
                return "[📎 文件]";
            default:
                return "[📎 媒体]";
        }
    }

    private hasAtSelf(message: OneBotMessageSegment[]): boolean {
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
