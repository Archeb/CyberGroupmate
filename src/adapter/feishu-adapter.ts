import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Client, HttpInstance, HttpRequestOptions, WSClient, defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { FEISHU_APP_ID_PATTERN, type FeishuConfig } from "../core/config.js";
import type { NotificationCenter, NotificationInput } from "../event/notification-center.js";
import type { AdapterConnectionStatus, BackfillOptions, BackfillResult, PlatformAdapter } from "./platform-adapter.js";
import { isNewerThanWatermark, summarizeBackfillNotes } from "./backfill.js";
import { ConnectionTracker } from "./connection-tracker.js";

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 20 * 1024;
const TIMEOUT_MS = 30_000;
const DEDUP_LIMIT = 10_000;
const silentLogger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
type RecordValue = Record<string, unknown>;
type MessageApi = Client["im"]["v1"]["message"];
type ApiCall = (payload?: any) => Promise<any>;

export interface FeishuApi {
    request: Client["request"];
    im: {
        v1: {
            message: Pick<MessageApi, "create" | "reply" | "get"> & Partial<Pick<MessageApi, "delete" | "patch" | "list" | "mergeForward" | "forward" | "update" | "readUsers" | "createByCard" | "replyByCard" | "updateByCard">>;
            chat: Pick<Client["im"]["v1"]["chat"], "get"> & Partial<Pick<Client["im"]["v1"]["chat"], "create" | "update" | "delete" | "list" | "search" | "link">>;
            chatMembers?: Partial<Pick<Client["im"]["v1"]["chatMembers"], "create" | "delete" | "meJoin" | "get" | "isInChat">>;
            chatManagers?: Record<string, ApiCall>;
            chatMenuTree?: Record<string, ApiCall>;
            chatMenuItem?: Record<string, ApiCall>;
            messageReaction?: Partial<Pick<Client["im"]["v1"]["messageReaction"], "create" | "delete" | "list" | "batchQuery">>;
            pin?: Partial<Pick<Client["im"]["v1"]["pin"], "create" | "delete" | "list">>;
            image: Pick<Client["im"]["v1"]["image"], "create">;
            file: Pick<Client["im"]["v1"]["file"], "create">;
            messageResource: Pick<Client["im"]["v1"]["messageResource"], "get">;
        };
    };
    contact?: {
        v3?: {
            user?: Partial<Pick<Client["contact"]["v3"]["user"], "get">>;
        };
    };
    cardkit?: {
        v1?: {
            card?: Partial<Pick<Client["cardkit"]["v1"]["card"], "create" | "update" | "idConvert" | "batchUpdate">>;
            cardElement?: Partial<Pick<Client["cardkit"]["v1"]["cardElement"], "content">>;
        };
    };
}

export interface FeishuConnection {
    start(): Promise<void>;
    close(): void;
    getConnectionStatus: WSClient["getConnectionStatus"];
}

export interface FeishuConnectionCallbacks {
    onReady(): void;
    onError(error: Error): void;
    onReconnecting(): void;
    onReconnected(): void;
}

export type FeishuEventHandlers = Record<string, (event: unknown) => Promise<unknown>>;

export interface FeishuAdapterDependencies {
    createClient?: () => FeishuApi | Promise<FeishuApi>;
    createConnection?: (callbacks: FeishuConnectionCallbacks, receive: (event: unknown) => Promise<void>, handlers: FeishuEventHandlers) => FeishuConnection | Promise<FeishuConnection>;
    hasMessage?: (chatId: string, messageId: string) => boolean | Promise<boolean>;
    readinessTimeoutMs?: number;
    requestTimeoutMs?: number;
    dedupLimit?: number;
}

export interface FeishuSendOptions {
    replyToMessageId?: string;
    replyInThread?: boolean;
    uuid?: string;
}

export interface FeishuTextOptions extends FeishuSendOptions {
    mentions?: Array<{ userId: string; displayName?: string }>;
}

export interface FeishuMediaPayload {
    type: "photo" | "document" | "audio" | "video";
    path: string;
    fileName?: string;
    caption?: string;
    duration?: number;
}

type MediaReference = { chatId: string; messageId: string; key: string; type: "image" | "file" };
type MediaInfo = { type: "photo" | "document" | "audio" | "video" | "sticker"; fileId: string; uniqueFileId: string; sendableFileId?: string; fileName?: string; fileSize?: number };
type Mention = { userId: string; rawUserId: string; displayName: string; isSelf: boolean; isAll: boolean };
type IdPrefix = "oc_" | "ou_" | "om_";
type SyntheticMessage = {
    chatId: string;
    userId: string;
    displayName: string;
    messageId: string;
    text: string;
    timestamp: string;
    chatType: "private" | "group";
    mentionsAgent: boolean;
    replyToMessageId: string;
    platformData: RecordValue;
    urgent: boolean;
};

const FEISHU_NATIVE_ACTIONS = new Set([
    "message.delete", "message.patch", "message.update", "message.forward", "message.mergeForward", "message.readUsers",
    "messageReaction.create", "messageReaction.delete", "messageReaction.list", "messageReaction.batchQuery",
    "pin.create", "pin.delete", "pin.list",
    "chat.update", "chat.delete", "chat.link",
    "chatMembers.create", "chatMembers.delete", "chatMembers.meJoin", "chatMembers.get", "chatMembers.isInChat",
    "chatManagers.addManagers", "chatManagers.deleteManagers",
    "chatMenuTree.create", "chatMenuTree.delete", "chatMenuTree.sort",
    "chatMenuItem.patch",
]);
const FEISHU_NATIVE_READ_ACTIONS = new Set([
    "message.readUsers", "messageReaction.list", "messageReaction.batchQuery", "pin.list",
    "chat.link", "chatMembers.get", "chatMembers.isInChat",
]);
const MESSAGE_TYPES = new Set(["text", "post", "interactive", "share_chat", "share_user"]);
const MEDIA_TYPES = new Set(["photo", "document", "audio", "video"]);
const FEISHU_WRITE_METHODS = [
    "feishu.sendText", "feishu.sendMessage", "feishu.sendMedia", "feishu.sendSticker",
    "feishu.sendTemplateCard", "feishu.sendCard", "feishu.updateTemplateCard", "feishu.updateCard", "feishu.patchCard", "feishu.streamCardText",
] as const;
const FEISHU_METHODS = [
    ...FEISHU_WRITE_METHODS,
    "feishu.getMessage", "feishu.getHistory", "feishu.getChat", "feishu.downloadMedia", "feishu.callApi",
] as const;
const ID_PATTERNS: Record<IdPrefix, RegExp> = {
    oc_: /^oc_[A-Za-z0-9_-]{1,200}$/,
    ou_: /^ou_[A-Za-z0-9_-]{1,200}$/,
    om_: /^om_[A-Za-z0-9_-]{1,200}$/,
};

function record(value: unknown): RecordValue {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function rawId(value: unknown, prefix: IdPrefix): string {
    const id = string(value).replace(/^feishu:/, "");
    if (!ID_PATTERNS[prefix].test(id)) throw new Error("Feishu invalid identifier");
    return id;
}

function compositeId(value: unknown, prefix: IdPrefix): string {
    return `feishu:${rawId(value, prefix)}`;
}

function trimMap<K, V>(map: Map<K, V>, limit: number): void {
    while (map.size > limit) map.delete(map.keys().next().value!);
}

function normalizedChatType(chatType?: string): "private" | "group" | undefined {
    if (chatType === "p2p") return "private";
    if (chatType === "group") return "group";
    return undefined;
}

function mediaMessageType(type: FeishuMediaPayload["type"]): string {
    if (type === "photo") return "image";
    if (type === "video") return "media";
    if (type === "document") return "file";
    return "audio";
}

function uploadFileType(type: FeishuMediaPayload["type"]): "opus" | "mp4" | "stream" {
    if (type === "audio") return "opus";
    if (type === "video") return "mp4";
    return "stream";
}

function timestamp(value: unknown): string {
    const text = string(value);
    const ms = /^\d{1,16}$/.test(text) ? Number(text) : NaN;
    return new Date(Number.isSafeInteger(ms) && ms >= 0 && ms <= 8.64e15 ? ms : Date.now()).toISOString();
}

function content(value: unknown): RecordValue {
    const text = string(value);
    if (Buffer.byteLength(text) > MAX_CONTENT_BYTES) throw new Error("Feishu content too large");
    try {
        return record(JSON.parse(text));
    } catch {
        throw new Error("Feishu invalid message content");
    }
}

function encodeReference(ref: MediaReference): string {
    return `feishu-media:${Buffer.from(JSON.stringify(ref)).toString("base64url")}`;
}

function parseReference(fileId: string): MediaReference {
    if (!fileId.startsWith("feishu-media:") || fileId.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(fileId.slice(13))) throw new Error("Feishu invalid media reference");
    try {
        const parsed = record(JSON.parse(Buffer.from(fileId.slice(13), "base64url").toString("utf8")));
        const ref: MediaReference = {
            chatId: compositeId(parsed.chatId, "oc_"),
            messageId: rawId(parsed.messageId, "om_"),
            key: string(parsed.key),
            type: parsed.type as MediaReference["type"],
        };
        if (!["image", "file"].includes(ref.type) || !/^[A-Za-z0-9_-]{1,512}$/.test(ref.key)) throw new Error();
        return ref;
    } catch {
        throw new Error("Feishu invalid media reference");
    }
}

function uniqueId(ref: MediaReference): string {
    return `feishu:${createHash("sha256").update(JSON.stringify(ref)).digest("hex")}`;
}

function checkBusiness(value: unknown): RecordValue {
    const result = record(value);
    if (result.code !== undefined && result.code !== 0) {
        const code = typeof result.code === "number" && Number.isSafeInteger(result.code) ? ` (${result.code})` : "";
        throw new Error(`Feishu API business failure${code}`);
    }
    return result;
}

export function createFeishuHttpInstance(transport: typeof defaultHttpInstance): HttpInstance {
    const request = async <T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>): Promise<R> => {
        const response = await transport.request<T, unknown, D>({
            ...options,
            timeout: 15_000,
            maxContentLength: MAX_DOWNLOAD_BYTES,
            maxBodyLength: MAX_UPLOAD_BYTES + 1024 * 1024,
            maxRedirects: 0,
        });
        if (!options.$return_headers) checkBusiness(response);
        return response as R;
    };
    return {
        request,
        get: (url, options) => request({ ...options, url, method: "GET" }),
        delete: (url, options) => request({ ...options, url, method: "DELETE" }),
        head: (url, options) => request({ ...options, url, method: "HEAD" }),
        options: (url, options) => request({ ...options, url, method: "OPTIONS" }),
        post: (url, data, options) => request({ ...options, url, data, method: "POST" }),
        put: (url, data, options) => request({ ...options, url, data, method: "PUT" }),
        patch: (url, data, options) => request({ ...options, url, data, method: "PATCH" }),
    };
}

function escapeMention(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** 读取响应头里的真实媒体 content-type（小写、去参数），octet-stream 视为不可用。 */
function usableContentType(headers: RecordValue): string | undefined {
    const mime = string(headers["content-type"] ?? headers["Content-Type"]).split(";")[0]!.trim().toLowerCase();
    return mime !== "application/octet-stream" && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : undefined;
}

/** 仅对图片做最小 magic-byte 嗅探，用于无 content-type/文件名时补全扩展名；不猜测文档类型。 */
function sniffImageMime(buffer: Buffer): string | undefined {
    const ascii = (start: number, length: number) => buffer.subarray(start, start + length).toString("latin1");
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (buffer.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
    if (buffer.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
    if (buffer.length >= 8 && ascii(0, 4) === "\x89PNG" && buffer[4] === 0x0d && buffer[5] === 0x0a) return "image/png";
    return undefined;
}

async function bounded<T>(operation: Promise<T>, ms: number, signal?: AbortSignal, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_, reject) => {
                abort = () => reject(new Error("Feishu operation cancelled"));
                if (signal?.aborted) return abort();
                signal?.addEventListener("abort", abort, { once: true });
                timer = setTimeout(() => {
                    onTimeout?.();
                    reject(new Error("Feishu operation timed out"));
                }, ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
        if (abort) signal?.removeEventListener("abort", abort);
    }
}

export class FeishuAdapter implements PlatformAdapter {
    readonly platform = "feishu";
    private readonly connection = new ConnectionTracker("feishu");
    private client?: FeishuApi;
    private ws?: FeishuConnection;
    private startPromise?: Promise<void>;
    private session?: AbortController;
    private botOpenId = "";
    private readonly seen = new Map<string, number>();
    private readonly pending = new Set<string>();
    private readonly muted = new Map<string, number>();
    private readonly chatNames = new Map<string, string>();
    private readonly chatTypes = new Map<string, "p2p" | "group">();
    private readonly userNames = new Map<string, { name?: string; expiresAt: number }>();
    private readonly cardSequences = new Map<string, number>();
    private readonly requestTimeoutMs: number;
    private readonly readinessTimeoutMs: number;
    private readonly dedupLimit: number;

    constructor(
        private readonly config: FeishuConfig,
        private readonly nc: Pick<NotificationCenter, "push">,
        private readonly workspacePath: string,
        private readonly dependencies: FeishuAdapterDependencies = {},
    ) {
        this.requestTimeoutMs = this.limit(dependencies.requestTimeoutMs, TIMEOUT_MS, TIMEOUT_MS);
        this.readinessTimeoutMs = this.limit(dependencies.readinessTimeoutMs, TIMEOUT_MS, 120_000);
        this.dedupLimit = this.limit(dependencies.dedupLimit, DEDUP_LIMIT, DEDUP_LIMIT);
    }

    private limit(value: number | undefined, fallback: number, max: number): number {
        return value !== undefined && Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
    }

    start(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        if (this.session && !this.session.signal.aborted) return Promise.resolve();
        const session = new AbortController();
        this.session = session;
        this.connection.markConnecting();
        const promise = this.connect(session).finally(() => {
            if (this.startPromise === promise) this.startPromise = undefined;
        });
        this.startPromise = promise;
        return promise;
    }

    private async connect(session: AbortController): Promise<void> {
        let socket: FeishuConnection | undefined;
        const current = () => this.session === session && !session.signal.aborted;
        try {
            if (!FEISHU_APP_ID_PATTERN.test(this.config.appId) || !this.config.appSecret || (this.config.domain !== undefined && !["feishu", "lark"].includes(this.config.domain))) {
                throw new Error("Feishu invalid configuration");
            }
            const sdk = this.dependencies.createClient && this.dependencies.createConnection ? undefined : await import("@larksuiteoapi/node-sdk");
            if (!current()) throw new Error("Feishu operation cancelled");
            const options = sdk ? {
                appId: this.config.appId,
                appSecret: this.config.appSecret,
                domain: this.config.domain === "lark" ? sdk.Domain.Lark : sdk.Domain.Feishu,
                logger: silentLogger,
                httpInstance: createFeishuHttpInstance(sdk.defaultHttpInstance),
            } : undefined;
            const client = await bounded(Promise.resolve(this.dependencies.createClient?.() ?? new sdk!.Client(options!)), this.requestTimeoutMs, session.signal);
            if (!current()) throw new Error("Feishu operation cancelled");
            this.client = client;
            const identity = await bounded(this.api(() => client.request({ url: "/open-apis/bot/v3/info", method: "GET" })), this.requestTimeoutMs, session.signal);
            const botOpenId = rawId(record(identity.bot).open_id, "ou_");
            if (!current()) throw new Error("Feishu operation cancelled");
            this.botOpenId = botOpenId;
            let ready!: () => void;
            let failed!: (error: Error) => void;
            const readiness = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
            const callbacks: FeishuConnectionCallbacks = {
                onReady: () => {
                    if (!current()) return;
                    this.connection.markConnected();
                    ready();
                },
                onError: () => {
                    if (!current()) return;
                    this.connection.markError("Feishu WebSocket connection failed");
                    failed(new Error("Feishu WebSocket connection failed"));
                },
                onReconnecting: () => { if (current()) this.connection.markConnecting(); },
                onReconnected: () => { if (current()) this.connection.markConnected(); },
            };
            const receive = async (event: unknown) => {
                if (current()) await this.receive(event, session);
            };
            const informationalEvents = [
                "im.message.message_read_v1",
                "im.message.recalled_v1",
                "im.chat.updated_v1",
                "im.chat.member.user.added_v1",
                "im.chat.member.user.deleted_v1",
                "im.chat.member.bot.added_v1",
                "im.chat.member.bot.deleted_v1",
                "im.chat.disbanded_v1",
            ];
            const handlers: FeishuEventHandlers = {
                "im.message.receive_v1": receive,
                "card.action.trigger": async event => current() ? this.receiveCardAction(event, session) : {},
                "im.message.reaction.created_v1": async event => { if (current()) await this.receiveReaction(event, "added", session); },
                "im.message.reaction.deleted_v1": async event => { if (current()) await this.receiveReaction(event, "removed", session); },
            };
            for (const eventType of informationalEvents) {
                handlers[eventType] = async event => {
                    if (current()) this.receiveInformationalEvent(eventType, event);
                };
            }
            const creating = this.dependencies.createConnection ? Promise.resolve(this.dependencies.createConnection(callbacks, receive, handlers)) : Promise.resolve().then(() => {
                const dispatcher = new sdk!.EventDispatcher({ logger: silentLogger }).register(handlers);
                const ws = new sdk!.WSClient({ ...options!, ...callbacks, autoReconnect: true, handshakeTimeoutMs: 15_000, wsConfig: { pingTimeout: 30 } });
                return { start: () => ws.start({ eventDispatcher: dispatcher }), close: () => ws.close({ force: true }), getConnectionStatus: () => ws.getConnectionStatus() };
            });
            void readiness.catch(() => {});
            void creating.then(value => { if (!current()) value.close(); }, () => {});
            socket = await bounded(creating, this.readinessTimeoutMs, session.signal);
            if (!current()) { socket.close(); throw new Error("Feishu operation cancelled"); }
            this.ws = socket;
            await bounded(Promise.all([socket.start(), readiness]), this.readinessTimeoutMs, session.signal);
            if (!current()) throw new Error("Feishu operation cancelled");
            if (socket.getConnectionStatus().state !== "connected") throw new Error("Feishu WebSocket not ready");
        } catch {
            socket?.close();
            if (this.session === session) {
                session.abort();
                this.ws = undefined;
                this.client = undefined;
                this.connection.markError("Feishu startup failed or timed out");
            }
            throw new Error("Feishu startup failed or cancelled");
        }
    }

    async stop(): Promise<void> {
        const session = this.session;
        this.session = undefined;
        this.startPromise = undefined;
        session?.abort();
        const ws = this.ws;
        this.ws = undefined;
        this.client = undefined;
        this.botOpenId = "";
        ws?.close();
        this.connection.markStopped();
    }

    reconnect(): Promise<void> {
        void this.stop();
        return this.start();
    }

    getConnectionStatus(): AdapterConnectionStatus {
        const status = this.ws?.getConnectionStatus();
        if (status && this.session && !this.session.signal.aborted) {
            if (status.state === "connected" && this.connection.currentState !== "connected") this.connection.markConnected();
            else if (status.state === "failed") this.connection.markError("Feishu WebSocket connection failed");
            else if (status.state === "connecting" || status.state === "reconnecting") this.connection.markConnecting();
            else if (status.state === "idle") this.connection.markDisconnected();
        }
        const result = this.connection.snapshot();
        return { ...result, reconnectAttempts: status?.reconnectAttempts ?? 0, nextRetryAt: status?.state === "reconnecting" && status.nextConnectTime ? timestamp(String(status.nextConnectTime)) : null, supportsReconnect: true };
    }

    private async api<T>(call: () => Promise<T>): Promise<T & RecordValue> {
        let result: T;
        try {
            result = await bounded(Promise.resolve().then(call), this.requestTimeoutMs);
        } catch {
            throw new Error("Feishu API request failed or timed out");
        }
        checkBusiness(result);
        return result as T & RecordValue;
    }

    private requireClient(): FeishuApi {
        if (!this.client || !this.session || this.session.signal.aborted) throw new Error("Feishu adapter is not started");
        return this.client;
    }

    private receiveInformationalEvent(eventType: string, value: unknown): void {
        const outer = record(value);
        const event = outer.event ? record(outer.event) : outer;
        const messageId = string(event.message_id);
        const chatId = string(event.chat_id);
        this.nc.push({
            type: `feishu.${eventType.replace(/^im\./, "").replaceAll(".", "_")}`,
            scene: "feishu",
            ...(ID_PATTERNS.oc_.test(chatId) ? { chatId: `feishu:${chatId}` } : {}),
            ...(ID_PATTERNS.om_.test(messageId) ? { messageId } : {}),
            payload: event,
        });
    }

    private async resolveUserName(openId: string): Promise<string | undefined> {
        const cached = this.userNames.get(openId);
        if (cached && cached.expiresAt > Date.now()) return cached.name;
        let name: string | undefined;
        try {
            const get = this.requireClient().contact?.v3?.user?.get;
            if (get) {
                const response = await this.api(() => get({ path: { user_id: openId }, params: { user_id_type: "open_id" } }));
                const data = record(response.data);
                const user = record(data.user ?? data);
                name = string(user.name) || string(user.en_name) || undefined;
            }
        } catch {
            name = undefined;
        }
        this.userNames.set(openId, { name, expiresAt: Date.now() + (name ? 60 * 60_000 : 5 * 60_000) });
        trimMap(this.userNames, 5000);
        return name;
    }

    private async senderWithName(sender: RecordValue): Promise<RecordValue> {
        if (string(sender.sender_name) || string(sender.name)) return sender;
        const id = string(record(sender.sender_id).open_id) || (sender.id_type === "open_id" ? string(sender.id) : "");
        if (!ID_PATTERNS.ou_.test(id)) return sender;
        const name = await this.resolveUserName(id);
        return name ? { ...sender, sender_name: name } : sender;
    }

    private async ensureChatMetadata(chatId: string): Promise<void> {
        if (this.chatTypes.has(chatId)) return;
        try {
            await this.getChat(chatId);
        } catch {
            // Event delivery must not depend on optional chat-profile permission.
        }
    }

    private async deliverSynthetic(eventId: string, chatId: string, input: NotificationInput, session: AbortController): Promise<void> {
        if (session.signal.aborted || this.session !== session || this.seen.has(eventId) || this.pending.has(eventId)) return;
        this.pending.add(eventId);
        try {
            const exists = this.dependencies.hasMessage ? await this.dependencies.hasMessage(chatId, eventId) : false;
            if (session.signal.aborted || this.session !== session) return;
            if (!exists) this.nc.push(input);
            this.seen.set(eventId, Date.now());
            trimMap(this.seen, this.dedupLimit);
        } finally {
            this.pending.delete(eventId);
        }
    }

    private syntheticNotification(message: SyntheticMessage): NotificationInput {
        const { platformData, urgent, ...core } = message;
        const source = {
            scene: "feishu",
            platform: "feishu",
            chatId: core.chatId,
            userId: core.userId,
            messageId: core.messageId,
            chatType: core.chatType,
            replyToMessageId: core.replyToMessageId,
        };
        const payload = {
            scene: "feishu",
            chatId: core.chatId,
            userId: core.userId,
            displayName: core.displayName,
            messageId: core.messageId,
            text: core.text,
            replyToMessageId: core.replyToMessageId,
            source,
            platformData,
        };
        return {
            type: "nc.message",
            scene: "feishu",
            ...core,
            chatTitle: this.chatNames.get(core.chatId) ?? core.chatId,
            isDirectMessage: core.chatType === "private",
            mentions: [],
            source,
            payload,
            _urgent: urgent,
        };
    }

    private async receiveCardAction(value: unknown, session: AbortController): Promise<RecordValue> {
        const outer = record(value);
        const event = outer.event ? record(outer.event) : outer;
        const context = record(event.context);
        const chatRaw = string(context.open_chat_id ?? event.open_chat_id);
        const messageId = string(context.open_message_id ?? event.open_message_id);
        const operator = record(event.operator);
        const userRaw = string(operator.open_id);
        if (!ID_PATTERNS.oc_.test(chatRaw) || !ID_PATTERNS.om_.test(messageId) || !ID_PATTERNS.ou_.test(userRaw)) return {};
        const chatId = compositeId(chatRaw, "oc_");
        const userId = compositeId(userRaw, "ou_");
        const action = record(event.action);
        const detail = action.value === undefined ? {} : action.value;
        const eventId = `feishu-card:${string(outer.event_id ?? event.event_id ?? outer.uuid ?? event.uuid ?? event.token)
            || createHash("sha256").update(JSON.stringify([messageId, userRaw, action])).digest("hex")}`;
        const text = `[Card action${string(action.name) ? `: ${string(action.name)}` : ""}] ${JSON.stringify(detail)}`.slice(0, MAX_TEXT_BYTES);
        const displayName = string(operator.name) || await this.resolveUserName(userRaw) || userId;
        if (session.signal.aborted || this.session !== session) return {};
        await this.ensureChatMetadata(chatId);
        if (session.signal.aborted || this.session !== session) return {};
        await this.deliverSynthetic(eventId, chatId, this.syntheticNotification({
            chatId, userId, displayName, messageId: eventId, text,
            timestamp: timestamp(outer.create_time ?? event.create_time),
            chatType: this.chatTypes.get(chatId) === "p2p" ? "private" : "group",
            mentionsAgent: true, replyToMessageId: messageId,
            platformData: { originalType: "card.action.trigger", action, context },
            urgent: true,
        }), session);
        return {};
    }

    private async receiveReaction(value: unknown, action: "added" | "removed", session: AbortController): Promise<void> {
        const outer = record(value);
        const event = outer.event ? record(outer.event) : outer;
        const messageId = string(event.message_id);
        const userRaw = string(record(event.user_id).open_id);
        const emoji = string(record(event.reaction_type).emoji_type);
        if (!ID_PATTERNS.om_.test(messageId) || !ID_PATTERNS.ou_.test(userRaw) || !emoji) return;
        const response = await bounded(this.api(() => this.requireClient().im.v1.message.get({ path: { message_id: messageId }, params: { user_id_type: "open_id", with_sender_name: true } })), this.requestTimeoutMs, session.signal);
        if (session.signal.aborted || this.session !== session) return;
        const items = Array.isArray(record(response.data).items) ? record(response.data).items as unknown[] : [];
        const original = items.map(record).find(item => item.message_id === messageId);
        if (!original || original.deleted) return;
        const chatRaw = string(original.chat_id);
        if (!ID_PATTERNS.oc_.test(chatRaw)) return;
        const chatId = compositeId(chatRaw, "oc_");
        const userId = compositeId(userRaw, "ou_");
        const eventId = `feishu-reaction:${string(outer.event_id ?? event.event_id ?? outer.uuid ?? event.uuid) || `${messageId}:${userRaw}:${emoji}:${action}:${string(event.action_time)}`}`;
        const displayName = await this.resolveUserName(userRaw) ?? userId;
        if (session.signal.aborted || this.session !== session) return;
        await this.ensureChatMetadata(chatId);
        if (session.signal.aborted || this.session !== session) return;
        const chatType = string(original.chat_type) || this.chatTypes.get(chatId);
        const text = `[Reaction ${action}: ${emoji}]`;
        const originalSender = record(original.sender);
        const reactedToBot = (originalSender.id_type === "open_id" && originalSender.id === this.botOpenId) || originalSender.open_bot_id === this.botOpenId;
        const normalizedType = chatType === "p2p" ? "private" : "group";
        await this.deliverSynthetic(eventId, chatId, this.syntheticNotification({
            chatId, userId, displayName, messageId: eventId, text, timestamp: timestamp(event.action_time),
            chatType: normalizedType, mentionsAgent: reactedToBot, replyToMessageId: messageId,
            platformData: { originalType: `im.message.reaction.${action === "added" ? "created" : "deleted"}_v1`, reactionAction: action, emoji },
            urgent: reactedToBot || normalizedType === "private",
        }), session);
    }

    private normalize(message: RecordValue, sender: RecordValue, chatType?: string): RecordValue {
        const messageId = rawId(message.message_id, "om_");
        const chatId = compositeId(message.chat_id, "oc_");
        const senderId = record(sender.sender_id).open_id ?? sender.open_bot_id ?? (sender.id_type === "open_id" ? sender.id : undefined);
        const userId = senderId ? compositeId(senderId, "ou_") : "feishu:unknown";
        const mentions: Mention[] = [];
        const labels = new Map<string, string>();
        for (const item of Array.isArray(message.mentions) ? message.mentions : []) {
            const mention = record(item);
            const id = typeof mention.id === "string" ? (mention.id_type === "open_id" ? mention.id : "") : string(record(mention.id).open_id);
            if (id !== "all" && !ID_PATTERNS.ou_.test(id)) continue;
            const displayName = string(mention.name) || id;
            mentions.push({ userId: `feishu:${id}`, rawUserId: id, displayName, isSelf: id === this.botOpenId, isAll: id === "all" });
            if (string(mention.key)) labels.set(string(mention.key), `@${displayName}`);
            labels.set(id, `@${displayName}`);
        }
        const type = string(message.message_type ?? message.msg_type);
        const rawBody = message.content ?? record(message.body).content;
        const body = type === "merge_forward" && typeof rawBody === "string" && !rawBody.trim().startsWith("{")
            ? { title: rawBody }
            : content(rawBody);
        const media: MediaInfo[] = [];
        const addMedia = (key: unknown, resourceType: "image" | "file", name?: unknown, size?: unknown, mediaType?: MediaInfo["type"]) => {
            if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(key)) return;
            const ref: MediaReference = { chatId, messageId, key, type: resourceType };
            const fileId = encodeReference(ref);
            media.push({ type: mediaType ?? (resourceType === "image" ? "photo" : "document"), fileId, uniqueFileId: uniqueId(ref), ...(mediaType === "sticker" ? { sendableFileId: fileId } : {}), fileName: string(name) || undefined, fileSize: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : undefined });
        };
        let text: string;
        switch (type) {
            case "text":
                text = string(body.text);
                break;
            case "image":
                addMedia(body.image_key, "image");
                text = "[Image]";
                break;
            case "file":
                addMedia(body.file_key, "file", body.file_name, body.file_size);
                text = `[File: ${string(body.file_name) || "attachment"}]`;
                break;
            case "audio":
                addMedia(body.file_key, "file", body.file_name, body.file_size, "audio");
                text = "[Audio]";
                break;
            case "media":
            case "video":
                addMedia(body.file_key, "file", body.file_name, body.file_size, "video");
                if (body.image_key) addMedia(body.image_key, "image");
                text = "[Video]";
                break;
            case "sticker":
                addMedia(body.file_key, "file", undefined, undefined, "sticker");
                text = `[Sticker: ${string(body.file_key) || string(body.sticker_id) || "sticker"}]`;
                break;
            case "share_chat":
                text = `[Shared chat: ${string(body.chat_id)}]`;
                break;
            case "share_user":
                text = `[Shared user: ${string(body.user_id)}]`;
                break;
            case "merge_forward":
                text = string(body.title) || "[Merged forwarded messages]";
                break;
            case "interactive":
            case "card":
                text = this.cardText(body) || "[Interactive card]";
                break;
            case "post": {
                const post = Array.isArray(body.content) ? body : record(body.zh_cn ?? body.en_us ?? Object.values(body)[0]);
                const rows = Array.isArray(post.content) ? post.content : [];
                text = [string(post.title), ...rows.map(row => (Array.isArray(row) ? row : []).map(item => {
                    const node = record(item);
                    if (node.tag === "text" || node.tag === "md" || node.tag === "code_block") return string(node.text);
                    if (node.tag === "a") return string(node.text) || string(node.href);
                    if (node.tag === "at") {
                        const id = string(node.user_id);
                        if ((id === "all" || ID_PATTERNS.ou_.test(id)) && !mentions.some(mention => mention.rawUserId === id)) {
                            const displayName = string(node.user_name) || id;
                            mentions.push({ userId: `feishu:${id}`, rawUserId: id, displayName, isSelf: id === this.botOpenId, isAll: id === "all" });
                        }
                        return labels.get(id) ?? `@${string(node.user_name) || id}`;
                    }
                    if (node.tag === "img") { addMedia(node.image_key, "image"); return "[Image]"; }
                    if (node.tag === "emotion") return `[${string(node.emoji_type)}]`;
                    return "";
                }).join(""))].filter(Boolean).join("\n");
                break;
            }
            default:
                text = `[${type || "unsupported message"}]`;
        }
        text = text.replace(/@_user_\d+\b|@_all\b/g, key => labels.get(key) ?? key);
        return {
            messageId, chatId, userId, displayName: string(sender.sender_name) || string(sender.name) || userId,
            text, timestamp: timestamp(message.create_time), chatType: normalizedChatType(chatType),
            chatTitle: this.chatNames.get(chatId) ?? chatId, isDirectMessage: chatType === "p2p", mentionsAgent: mentions.some(mention => mention.isSelf || mention.isAll), mentions,
            replyToMessageId: string(message.parent_id) || undefined, parentId: string(message.parent_id) || undefined,
            rootId: string(message.root_id) || undefined, threadId: string(message.thread_id) || undefined,
            mediaInfo: media.length > 1 ? { ...media[0], attachments: media } : media[0], mediaInfos: media,
        };
    }

    private expandMergedForward(parent: RecordValue, items: RecordValue[], chatType?: string): RecordValue {
        const childrenByParent = new Map<string, RecordValue[]>();
        for (const item of items) {
            const upperMessageId = string(item.upper_message_id);
            if (!upperMessageId || item.deleted) continue;
            const children = childrenByParent.get(upperMessageId) ?? [];
            children.push(item);
            childrenByParent.set(upperMessageId, children);
        }

        let remainingMessages = 100;
        const expand = (message: RecordValue, inheritedChatType: string | undefined, ancestors: ReadonlySet<string>): RecordValue => {
            const { mediaInfo: _mediaInfo, mediaInfos: _mediaInfos, ...base } = this.normalize(
                message,
                record(message.sender),
                string(message.chat_type) || inheritedChatType,
            );
            const messageId = string(message.message_id);
            if (!messageId || ancestors.has(messageId)) return base;

            const nextAncestors = new Set(ancestors);
            nextAncestors.add(messageId);
            const children: RecordValue[] = [];
            for (const item of childrenByParent.get(messageId) ?? []) {
                if (remainingMessages <= 0) break;
                const childId = string(item.message_id);
                if (childId && nextAncestors.has(childId)) continue;
                remainingMessages--;
                children.push(expand(item, string(message.chat_type) || inheritedChatType, nextAncestors));
            }
            if (children.length === 0) return base;

            const text = ["[Merged forwarded messages]", ...children.map(child => {
                const author = string(child.displayName) || string(child.userId);
                return `- ${author}: ${string(child.text).replace(/\n/g, "\n  ")}`;
            })].join("\n").slice(0, MAX_TEXT_BYTES);
            return { ...base, text, forwardedMessages: children };
        };

        return expand(parent, chatType, new Set());
    }

    private async normalizeMessage(message: RecordValue, sender: RecordValue, chatType?: string): Promise<RecordValue> {
        const namedSender = await this.senderWithName(sender);
        if (string(message.message_type ?? message.msg_type) !== "merge_forward") return this.normalize(message, namedSender, chatType);
        const response = await this.api(() => this.requireClient().im.v1.message.get({ path: { message_id: rawId(message.message_id, "om_") }, params: { user_id_type: "open_id", with_sender_name: true } }));
        const items = (Array.isArray(record(response.data).items) ? record(response.data).items as unknown[] : []).map(record);
        const parent = items.find(item => item.message_id === message.message_id) ?? { ...message, sender: namedSender };
        return this.expandMergedForward({ ...parent, sender: await this.senderWithName(record(parent.sender)) }, items, chatType);
    }

    private cardText(value: unknown): string {
        const parts: string[] = [];
        const visit = (node: unknown): void => {
            if (typeof node === "string") return;
            if (Array.isArray(node)) { for (const child of node) visit(child); return; }
            const item = record(node);
            for (const key of ["title", "content", "text", "value"]) {
                if (typeof item[key] === "string" && item[key]) parts.push(item[key] as string);
            }
            for (const child of Object.values(item)) {
                if (child && typeof child === "object") visit(child);
            }
        };
        visit(value);
        return [...new Set(parts)].join("\n").slice(0, MAX_TEXT_BYTES);
    }

    private async receive(value: unknown, session: AbortController): Promise<void> {
        const outer = record(value);
        const event = outer.event ? record(outer.event) : outer;
        const message = record(event.message);
        const sender = record(event.sender);
        let id: string;
        let chatId: string;
        try {
            id = rawId(message.message_id, "om_");
            chatId = compositeId(message.chat_id, "oc_");
            if (!["p2p", "group"].includes(string(message.chat_type))) return;
            const senderId = rawId(record(sender.sender_id).open_id, "ou_");
            if (senderId === this.botOpenId || sender.sender_type === "app" && senderId === this.config.appId) return;
        } catch { return; }
        if (this.seen.has(id) || this.pending.has(id)) return;
        if (this.pending.size >= this.dedupLimit) throw new Error("Feishu ingress capacity exceeded");
        this.pending.add(id);
        try {
            const exists = this.dependencies.hasMessage ? await bounded(Promise.resolve(this.dependencies.hasMessage(chatId, id)), this.requestTimeoutMs, session.signal) : false;
            if (session.signal.aborted || this.session !== session) return;
            if (!exists) {
                await this.ensureChatMetadata(chatId);
                if (session.signal.aborted || this.session !== session) return;
                const core = await this.normalizeMessage(message, sender, string(message.chat_type));
                const source = { scene: "feishu", platform: "feishu", chatId, userId: core.userId, messageId: id, chatType: core.chatType, replyToMessageId: core.replyToMessageId, parentId: core.parentId, rootId: core.rootId, threadId: core.threadId };
                const event: NotificationInput = { type: "nc.message", scene: "feishu", ...core, source, payload: { scene: "feishu", ...core, source, platformData: { originalType: "im.message.receive_v1" } }, _urgent: core.isDirectMessage === true || core.mentionsAgent === true };
                this.nc.push(event);
            }
            this.seen.set(id, Date.now());
            trimMap(this.seen, this.dedupLimit);
        } catch {
            throw new Error("Feishu incoming message processing failed");
        } finally { this.pending.delete(id); }
    }

    canHandle(method: string): boolean {
        return (FEISHU_METHODS as readonly string[]).includes(method);
    }

    getWriteMethods(): string[] {
        return [...FEISHU_WRITE_METHODS];
    }

    async handleCall(method: string, args: unknown[]): Promise<unknown> {
        switch (method) {
            case "feishu.sendText": return this.sendText(string(args[0]), string(args[1]), record(args[2]) as FeishuTextOptions);
            case "feishu.sendMessage": return this.sendMessage(string(args[0]), string(args[1]), args[2], record(args[3]) as FeishuSendOptions);
            case "feishu.sendMedia": return this.sendMedia(string(args[0]), record(args[1]) as unknown as FeishuMediaPayload, record(args[2]) as FeishuSendOptions);
            case "feishu.sendSticker": return this.sendSticker(string(args[0]), string(args[1]), record(args[2]) as FeishuSendOptions);
            case "feishu.sendTemplateCard": return this.sendTemplateCard(string(args[0]), string(args[1]), record(args[2]), record(args[3]) as FeishuSendOptions);
            case "feishu.sendCard": return this.sendCard(string(args[0]), record(args[1]), record(args[2]) as FeishuSendOptions);
            case "feishu.updateTemplateCard": return this.updateTemplateCard(string(args[0]), string(args[1]), string(args[2]), record(args[3]));
            case "feishu.updateCard": return this.updateCard(string(args[0]), string(args[1]), record(args[2]), record(args[3]));
            case "feishu.patchCard": return this.patchCard(string(args[0]), string(args[1]), args[2], record(args[3]));
            case "feishu.streamCardText": return this.streamCardText(string(args[0]), string(args[1]), string(args[2]), string(args[3]), record(args[4]));
            case "feishu.getMessage": return this.getMessage(string(args[0]), string(args[1]));
            case "feishu.getHistory": return this.getHistory(string(args[0]), record(args[1]));
            case "feishu.getChat": return this.getChat(string(args[0]));
            case "feishu.callApi": return this.callApi(string(args[0]), string(args[1]), record(args[2]));
            case "feishu.downloadMedia": {
                const meta = await this.downloadMediaWithMeta(string(args[0]), args[1] === undefined ? undefined : string(args[1]), args[2] === undefined ? undefined : string(args[2]), args[3] === undefined ? undefined : string(args[3]));
                return {
                    buffer: meta.buffer.toString("base64"),
                    size: meta.buffer.length,
                    ...(meta.fileName !== undefined ? { fileName: meta.fileName } : {}),
                    ...(meta.mimeType !== undefined ? { mimeType: meta.mimeType } : {}),
                };
            }
            default: throw new Error("Unsupported Feishu method");
        }
    }

    formatMention(userId: string, displayName?: string): string {
        const id = rawId(userId, "ou_");
        return `<at user_id="${id}">${escapeMention(displayName || id)}</at>`;
    }

    private assertWritable(chatId: string): void {
        rawId(chatId, "oc_");
        this.requireClient();
        if (this.isChatMuted(chatId)) throw new Error("Feishu chat is muted; outbound suppressed");
    }

    private validateOptions(options: FeishuSendOptions): void {
        if (options.replyToMessageId !== undefined) rawId(options.replyToMessageId, "om_");
        if (options.replyInThread !== undefined && typeof options.replyInThread !== "boolean") throw new Error("Feishu invalid replyInThread");
        if (options.replyInThread && !options.replyToMessageId) throw new Error("Feishu thread reply requires a parent message");
        if (options.uuid !== undefined && (typeof options.uuid !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(options.uuid))) throw new Error("Feishu invalid uuid");
    }

    async sendText(chatId: string, text: string, options: FeishuTextOptions = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        this.validateOptions(options);
        if (typeof text !== "string" || !text.trim()) throw new Error("Feishu text is empty");
        if (options.mentions !== undefined && (!Array.isArray(options.mentions) || options.mentions.length > 100)) throw new Error("Feishu invalid mentions");
        const mentions = (options.mentions ?? []).map(value => ({ userId: compositeId(value.userId, "ou_"), displayName: string(value.displayName) || undefined }));
        const prepared = [...mentions.map(value => this.formatMention(value.userId, value.displayName)), text].join(" ");
        if (Buffer.byteLength(prepared) > MAX_TEXT_BYTES) throw new Error("Feishu text too large");
        const ack = await this.send(chatId, "text", { text: prepared }, options);
        return { ...ack, mentions: mentions.map(({ userId }) => ({ userId })) };
    }

    async sendMessage(chatId: string, type: string, body: unknown, options: FeishuSendOptions = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        this.validateOptions(options);
        if (!MESSAGE_TYPES.has(type)) {
            throw new Error("Feishu unsupported message type");
        }
        const value = record(body);
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) > MAX_CONTENT_BYTES) throw new Error("Feishu content too large");
        return this.send(chatId, type, value, options);
    }

    private async send(chatId: string, type: string, body: RecordValue, options: FeishuSendOptions): Promise<RecordValue> {
        const client = this.requireClient();
        const session = this.session;
        if (options.replyToMessageId) await this.getMessage(chatId, options.replyToMessageId);
        if (this.session !== session) throw new Error("Feishu operation cancelled");
        this.assertWritable(chatId);
        const data = { msg_type: type, content: JSON.stringify(body), uuid: options.uuid };
        const response = options.replyToMessageId
            ? await this.api(() => client.im.v1.message.reply({ path: { message_id: rawId(options.replyToMessageId, "om_") }, data: { ...data, reply_in_thread: options.replyInThread } }))
            : await this.api(() => client.im.v1.message.create({ params: { receive_id_type: "chat_id" }, data: { ...data, receive_id: rawId(chatId, "oc_") } }));
        return this.messageAck(chatId, record(response.data), options);
    }

    private messageAck(chatId: string, result: RecordValue, options: FeishuSendOptions, extra: RecordValue = {}): RecordValue {
        const messageId = rawId(result.message_id, "om_");
        if (result.chat_id !== undefined && rawId(result.chat_id, "oc_") !== rawId(chatId, "oc_")) throw new Error("Feishu response chat mismatch");
        return {
            messageId,
            chatId: compositeId(chatId, "oc_"),
            senderUserId: `feishu:${this.botOpenId}`,
            replyToMessageId: string(result.parent_id) || options.replyToMessageId,
            rootId: string(result.root_id) || undefined,
            threadId: string(result.thread_id) || undefined,
            ...extra,
        };
    }

    async sendTemplateCard(chatId: string, templateId: string, variables: RecordValue = {}, options: FeishuSendOptions = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        this.validateOptions(options);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(templateId)) throw new Error("Feishu invalid card template ID");
        if (Buffer.byteLength(JSON.stringify(variables)) > MAX_CONTENT_BYTES) throw new Error("Feishu card variables too large");
        const message = this.requireClient().im.v1.message;
        if (options.replyToMessageId) {
            await this.getMessage(chatId, options.replyToMessageId);
            if (!message.replyByCard) throw new Error("Feishu template card reply API unavailable");
            const response = await this.api(() => message.replyByCard!({
                path: { message_id: rawId(options.replyToMessageId, "om_") },
                data: { template_id: templateId, template_variable: variables, reply_in_thread: options.replyInThread, uuid: options.uuid },
            }));
            return this.messageAck(chatId, record(response.data), options, { templateId });
        }
        if (!message.createByCard) throw new Error("Feishu template card send API unavailable");
        const response = await this.api(() => message.createByCard!({
            params: { receive_id_type: "chat_id" },
            data: { receive_id: rawId(chatId, "oc_"), template_id: templateId, template_variable: variables, uuid: options.uuid },
        }));
        return this.messageAck(chatId, record(response.data), options, { templateId });
    }

    async sendCard(chatId: string, card: RecordValue, options: FeishuSendOptions = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        this.validateOptions(options);
        const encoded = JSON.stringify(card);
        if (Buffer.byteLength(encoded) > MAX_CONTENT_BYTES) throw new Error("Feishu card too large");
        const create = this.requireClient().cardkit?.v1?.card?.create;
        if (!create) throw new Error("Feishu CardKit create API unavailable");
        const created = await this.api(() => create({ data: { type: "card_json", data: encoded } }));
        const cardId = string(record(created.data).card_id);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(cardId)) throw new Error("Feishu CardKit create failed");
        const ack = await this.send(chatId, "interactive", { type: "card", data: { card_id: cardId } }, options);
        return { ...ack, cardId };
    }

    private cardUpdateOptions(cardId: string, options: RecordValue): { sequence: number; uuid?: string } {
        const previous = this.cardSequences.get(cardId) ?? -1;
        const sequence = options.sequence === undefined ? Math.max(Date.now(), previous + 1) : Number(options.sequence);
        if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence <= previous) throw new Error("Feishu card update sequence must increase");
        const uuid = options.uuid === undefined ? undefined : string(options.uuid);
        if (uuid !== undefined && !/^[A-Za-z0-9_-]{1,50}$/.test(uuid)) throw new Error("Feishu invalid uuid");
        this.cardSequences.set(cardId, sequence);
        trimMap(this.cardSequences, 5000);
        return { sequence, uuid };
    }

    private async cardIdForMessage(chatId: string, messageId: string): Promise<string> {
        await this.getMessage(chatId, messageId);
        const convert = this.requireClient().cardkit?.v1?.card?.idConvert;
        if (!convert) throw new Error("Feishu CardKit ID conversion API unavailable");
        const response = await this.api(() => convert({ data: { message_id: rawId(messageId, "om_") } }));
        const cardId = string(record(response.data).card_id);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(cardId)) throw new Error("Feishu message is not an updatable card");
        return cardId;
    }

    async updateTemplateCard(chatId: string, messageId: string, templateId: string, variables: RecordValue = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        await this.getMessage(chatId, messageId);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(templateId)) throw new Error("Feishu invalid card template ID");
        if (Buffer.byteLength(JSON.stringify(variables)) > MAX_CONTENT_BYTES) throw new Error("Feishu card variables too large");
        const update = this.requireClient().im.v1.message.updateByCard;
        if (!update) throw new Error("Feishu template card update API unavailable");
        this.assertWritable(chatId);
        await this.api(() => update({ path: { message_id: rawId(messageId, "om_") }, data: { template_id: templateId, template_variable: variables } }));
        return { chatId: compositeId(chatId, "oc_"), messageId: rawId(messageId, "om_"), templateId, updated: true };
    }

    async updateCard(chatId: string, messageId: string, card: RecordValue, options: RecordValue = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        const encoded = JSON.stringify(card);
        if (Buffer.byteLength(encoded) > MAX_CONTENT_BYTES) throw new Error("Feishu card too large");
        const cardId = await this.cardIdForMessage(chatId, messageId);
        const update = this.requireClient().cardkit?.v1?.card?.update;
        if (!update) throw new Error("Feishu CardKit update API unavailable");
        this.assertWritable(chatId);
        const updateOptions = this.cardUpdateOptions(cardId, options);
        await this.api(() => update({ path: { card_id: cardId }, data: { card: { type: "card_json", data: encoded }, ...updateOptions } }));
        return { chatId: compositeId(chatId, "oc_"), messageId: rawId(messageId, "om_"), cardId, updated: true };
    }

    async patchCard(chatId: string, messageId: string, actions: unknown, options: RecordValue = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        const encoded = JSON.stringify(actions);
        if (Buffer.byteLength(encoded) > MAX_CONTENT_BYTES) throw new Error("Feishu card patch too large");
        const cardId = await this.cardIdForMessage(chatId, messageId);
        const update = this.requireClient().cardkit?.v1?.card?.batchUpdate;
        if (!update) throw new Error("Feishu CardKit patch API unavailable");
        this.assertWritable(chatId);
        const updateOptions = this.cardUpdateOptions(cardId, options);
        await this.api(() => update({ path: { card_id: cardId }, data: { actions: encoded, ...updateOptions } }));
        return { chatId: compositeId(chatId, "oc_"), messageId: rawId(messageId, "om_"), cardId, updated: true };
    }

    async streamCardText(chatId: string, messageId: string, elementId: string, contentValue: string, options: RecordValue = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(elementId)) throw new Error("Feishu invalid card element ID");
        if (!contentValue || Buffer.byteLength(contentValue) > MAX_CONTENT_BYTES) throw new Error("Feishu invalid card stream content");
        const cardId = await this.cardIdForMessage(chatId, messageId);
        const update = this.requireClient().cardkit?.v1?.cardElement?.content;
        if (!update) throw new Error("Feishu CardKit stream API unavailable");
        this.assertWritable(chatId);
        const updateOptions = this.cardUpdateOptions(cardId, options);
        await this.api(() => update({ path: { card_id: cardId, element_id: elementId }, data: { content: contentValue, ...updateOptions } }));
        return { chatId: compositeId(chatId, "oc_"), messageId: rawId(messageId, "om_"), cardId, elementId, updated: true };
    }

    async sendMedia(chatId: string, media: FeishuMediaPayload, options: FeishuSendOptions = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        this.validateOptions(options);
        if (!MEDIA_TYPES.has(media.type)) throw new Error("Feishu unsupported media type");
        if (media.caption !== undefined && (typeof media.caption !== "string" || Buffer.byteLength(media.caption) > MAX_TEXT_BYTES)) throw new Error("Feishu invalid caption");
        const client = this.requireClient();
        const session = this.session;
        if (options.replyToMessageId) await this.getMessage(chatId, options.replyToMessageId);
        const bytes = await this.readUpload(media.path, media.type === "photo" ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES);
        const fileName = media.fileName ?? path.basename(media.path);
        if (!fileName || fileName.length > 255 || /[\x00-\x1f/\\]/.test(fileName)) throw new Error("Feishu invalid file name");
        if (this.session !== session) throw new Error("Feishu operation cancelled");
        this.assertWritable(chatId);
        const isImage = media.type === "photo";
        const result = isImage
            ? await this.api(() => client.im.v1.image.create({ data: { image_type: "message", image: bytes } }))
            : await this.api(() => client.im.v1.file.create({ data: {
                file_type: uploadFileType(media.type),
                file_name: fileName,
                file: bytes,
                ...(media.duration !== undefined ? { duration: media.duration } : {}),
            } }));
        const key = string(isImage ? result?.image_key : result?.file_key);
        if (!key || !/^[A-Za-z0-9_-]{1,512}$/.test(key)) throw new Error("Feishu upload failed");
        if (this.session !== session) throw new Error("Feishu operation cancelled");
        const sent = await this.send(chatId, mediaMessageType(media.type), isImage ? { image_key: key } : { file_key: key }, options);
        const ref: MediaReference = { chatId: string(sent.chatId), messageId: string(sent.messageId), key, type: isImage ? "image" : "file" };
        const mediaInfo: MediaInfo = { type: media.type, fileId: encodeReference(ref), uniqueFileId: uniqueId(ref), fileName, fileSize: bytes.length };
        const ack = { ...sent, text: "", mediaInfo };
        if (media.caption) {
            try {
                if (this.session !== session) throw new Error("Feishu operation cancelled");
                const caption = await this.sendText(chatId, media.caption, { replyToMessageId: ref.messageId, replyInThread: options.replyInThread, uuid: options.uuid ? createHash("sha256").update(`${options.uuid}:caption`).digest("hex").slice(0, 40) : undefined });
                return { ...ack, additionalMessages: [{ ...caption, text: media.caption }] };
            } catch { return { ...ack, captionError: "Feishu caption send failed" }; }
        }
        return ack;
    }

    async sendSticker(chatId: string, fileId: string, options: FeishuSendOptions = {}): Promise<RecordValue> {
        this.assertWritable(chatId);
        this.validateOptions(options);
        const ref = parseReference(fileId);
        const source = await this.getMessage(ref.chatId, ref.messageId);
        const sticker = (Array.isArray(source.mediaInfos) ? source.mediaInfos as MediaInfo[] : [])
            .find(item => item.type === "sticker" && item.fileId === encodeReference(ref));
        if (!sticker || ref.type !== "file") throw new Error("Feishu sticker reference must come from a received sticker");
        const sent = await this.send(chatId, "sticker", { file_key: ref.key }, options);
        const sentRef: MediaReference = { chatId: string(sent.chatId), messageId: string(sent.messageId), key: ref.key, type: "file" };
        return {
            ...sent,
            text: "",
            mediaInfo: { type: "sticker", fileId: encodeReference(sentRef), uniqueFileId: uniqueId(ref), sendableFileId: fileId },
        };
    }

    private async readUpload(filePath: string, maxBytes: number): Promise<Buffer> {
        if (typeof filePath !== "string" || !filePath || /^[A-Za-z][A-Za-z\d+.-]*:/.test(filePath)) throw new Error("Feishu media requires a workspace file");
        try {
            const root = await realpath(this.workspacePath);
            const target = await realpath(path.resolve(root, filePath));
            const relative = path.relative(root, target);
            if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("outside workspace");
            const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const stat = await handle.stat();
                if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) throw new Error("invalid size");
                const buffer = Buffer.alloc(stat.size + 1);
                let length = 0;
                while (length < buffer.length) {
                    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
                    if (!bytesRead) break;
                    length += bytesRead;
                }
                if (length !== stat.size) throw new Error("file changed");
                return buffer.subarray(0, length);
            } finally { await handle.close(); }
        } catch { throw new Error("Feishu media must be a nonempty, size-limited file inside workspace"); }
    }

    async getMessage(chatId: string, messageId: string): Promise<RecordValue> {
        const chat = rawId(chatId, "oc_");
        const id = rawId(messageId, "om_");
        const client = this.requireClient();
        const response = await this.api(() => client.im.v1.message.get({ path: { message_id: id }, params: { user_id_type: "open_id", with_sender_name: true } }));
        const items = record(response.data).items;
        const records = (Array.isArray(items) ? items : []).map(record);
        const message = records.find(item => item.message_id === id);
        if (!message || message.deleted || rawId(message.chat_id, "oc_") !== chat) throw new Error("Feishu message chat mismatch or message unavailable");
        if (string(message.msg_type ?? message.message_type) === "merge_forward") return this.expandMergedForward(message, records, string(message.chat_type));
        return this.normalize(message, await this.senderWithName(record(message.sender)), string(message.chat_type));
    }

    async getHistory(chatId: string, options: RecordValue = {}): Promise<RecordValue> {
        const id = rawId(chatId, "oc_");
        const composite = compositeId(id, "oc_");
        if (!this.chatTypes.has(composite)) await this.getChat(composite);
        const chatType = this.chatTypes.get(composite);
        const pageSize = Math.max(1, Math.min(50, Number(options.pageSize) || 50));
        const client = this.requireClient();
        const list = client.im.v1.message.list;
        if (!list) throw new Error("Feishu history API unavailable");
        const response = await this.api(() => list({ params: {
            container_id_type: "chat",
            container_id: id,
            sort_type: options.sortType === "desc" ? "ByCreateTimeDesc" : "ByCreateTimeAsc",
            page_size: pageSize,
            ...(typeof options.pageToken === "string" ? { page_token: options.pageToken } : {}),
            ...(options.startTime !== undefined ? { start_time: String(options.startTime) } : {}),
            ...(options.endTime !== undefined ? { end_time: String(options.endTime) } : {}),
            with_sender_name: true,
        } }));
        const data = record(response.data);
        const rawItems = (Array.isArray(data.items) ? data.items : []).map(record).filter(item => !item.deleted && item.chat_id === id);
        const items = await Promise.all(rawItems.map(item => this.normalizeMessage(item, record(item.sender), string(item.chat_type) || chatType)));
        return { items, hasMore: data.has_more === true, pageToken: string(data.page_token) || undefined };
    }

    async callApi(chatId: string, action: string, payload: RecordValue = {}): Promise<unknown> {
        const expectedChatId = rawId(chatId, "oc_");
        if (!FEISHU_NATIVE_ACTIONS.has(action)) throw new Error("Unsupported Feishu native action");
        if (!FEISHU_NATIVE_READ_ACTIONS.has(action)) this.assertWritable(chatId);
        const [resourceName, methodName] = action.split(".");
        const path = record(payload.path);
        const params = record(payload.params);
        const data = record(payload.data);
        for (const candidate of [path.chat_id, params.chat_id, params.container_id]) {
            if (candidate !== undefined && rawId(candidate, "oc_") !== expectedChatId) throw new Error("Feishu native action chat mismatch");
        }
        if (action === "message.forward" || action === "message.mergeForward") {
            if (params.receive_id_type !== "chat_id") throw new Error("Feishu native forwarding requires receive_id_type chat_id");
            if (rawId(data.receive_id, "oc_") !== expectedChatId) throw new Error("Feishu native action chat mismatch");
        }
        // Check the actual scope fields used by each SDK action, including body IDs.
        let messageIds: unknown[] = [];
        if (action === "message.mergeForward") {
            if (!Array.isArray(data.message_id_list) || data.message_id_list.length === 0) throw new Error("Feishu native action requires message_id_list");
            messageIds = data.message_id_list;
        } else if (action === "messageReaction.batchQuery") {
            if (!Array.isArray(data.queries) || data.queries.length === 0) throw new Error("Feishu native action requires queries");
            messageIds = data.queries.map(query => record(query).message_id);
        } else if (action === "pin.create") {
            messageIds = [data.message_id];
        } else if (resourceName === "message" || resourceName === "messageReaction" || action === "pin.delete") {
            messageIds = [path.message_id];
        } else {
            const scopedChatId = action === "pin.list" ? params.chat_id : path.chat_id;
            if (rawId(scopedChatId, "oc_") !== expectedChatId) throw new Error("Feishu native action chat mismatch");
        }
        for (const messageId of new Set(messageIds)) await this.getMessage(chatId, rawId(messageId, "om_"));
        const api = record(record(this.requireClient().im.v1)[resourceName])[methodName];
        if (typeof api !== "function") throw new Error("Feishu native action unavailable in SDK");
        return this.api(() => (api as ApiCall)(payload));
    }

    async getChat(chatId: string): Promise<RecordValue> {
        const id = rawId(chatId, "oc_");
        const client = this.requireClient();
        const response = await this.api(() => client.im.v1.chat.get({ path: { chat_id: id }, params: { user_id_type: "open_id" } }));
        const data = record(response.data);
        const name = string(data.name) || id;
        const composite = compositeId(id, "oc_");
        this.chatNames.set(composite, name);
        this.chatTypes.set(composite, data.chat_mode === "p2p" ? "p2p" : "group");
        trimMap(this.chatNames, 1000);
        trimMap(this.chatTypes, 1000);
        return { chatId: composite, title: name, name, chatType: data.chat_mode === "p2p" ? "private" : "group", description: string(data.description) };
    }

    async fetchMissedMessages(options: BackfillOptions): Promise<BackfillResult> {
        const notes: string[] = [];
        let chats = 0;
        let messages = 0;
        for (const composite of options.knownChatIds.filter(id => id.startsWith("feishu:")).slice(0, options.maxChats)) {
            try {
                const watermark = options.getWatermark(composite);
                const watermarkTime = Date.parse(watermark?.timestamp ?? "");
                const startTime = Math.floor(Math.max(options.since.getTime(), Number.isFinite(watermarkTime) ? watermarkTime : 0) / 1000);
                const deliveredIds = new Set<string>();
                const pageTokens = new Set<string>();
                let pageToken: string | undefined;
                while (deliveredIds.size < options.maxMessagesPerChat) {
                    const history = await this.getHistory(composite, {
                        pageSize: Math.min(50, options.maxMessagesPerChat - deliveredIds.size),
                        sortType: "asc",
                        startTime,
                        pageToken,
                    });
                    const fresh = (Array.isArray(history.items) ? history.items : [])
                        .map(record)
                        .filter(item => item.userId !== `feishu:${this.botOpenId}`)
                        .filter(item => isNewerThanWatermark({ messageId: string(item.messageId), timestamp: string(item.timestamp) }, watermark, "timestamp", options.since));
                    for (const core of fresh) {
                        const messageId = string(core.messageId);
                        if (deliveredIds.has(messageId)) continue;
                        const source = { scene: "feishu", platform: "feishu", chatId: composite, userId: core.userId, messageId: core.messageId, chatType: core.chatType, replyToMessageId: core.replyToMessageId, threadId: core.threadId };
                        options.deliver({
                            type: "nc.message", scene: "feishu", ...core, source,
                            payload: { scene: "feishu", ...core, source, platformData: { originalType: "im.message.list" } },
                            _urgent: core.isDirectMessage === true || core.mentionsAgent === true,
                        });
                        if (deliveredIds.size === 0) chats++;
                        deliveredIds.add(messageId);
                        messages++;
                        if (deliveredIds.size >= options.maxMessagesPerChat) break;
                    }
                    if (!history.hasMore || deliveredIds.size >= options.maxMessagesPerChat) break;
                    const nextToken = string(history.pageToken);
                    if (!nextToken || pageTokens.has(nextToken)) throw new Error("Feishu backfill pagination did not advance");
                    pageTokens.add(nextToken);
                    pageToken = nextToken;
                }
            } catch (error) {
                notes.push(`${composite}: ${String(error)}`);
            }
        }
        return { chats, messages, notes: summarizeBackfillNotes(notes) };
    }

    async downloadMedia(fileId: string, chatId?: string, messageId?: string, uniqueFileId?: string): Promise<Buffer>;
    async downloadMedia(rawMessage: unknown, mediaRef: string): Promise<Buffer>;
    async downloadMedia(value: unknown, chatOrRef?: string, messageId?: string, uniqueFileId?: string): Promise<Buffer> {
        return (await this.downloadMediaWithMeta(value, chatOrRef, messageId, uniqueFileId)).buffer;
    }

    private async downloadMediaWithMeta(value: unknown, chatOrRef?: string, messageId?: string, uniqueFileId?: string): Promise<{ buffer: Buffer; fileName?: string; mimeType?: string }> {
        const internal = typeof value !== "string";
        const fileId = internal ? string(chatOrRef) : value;
        const chatId = internal ? string(record(value).chatId) || undefined : chatOrRef;
        const ref = parseReference(fileId);
        if (chatId !== undefined && compositeId(chatId, "oc_") !== ref.chatId || messageId !== undefined && rawId(messageId, "om_") !== ref.messageId || uniqueFileId !== undefined && uniqueFileId !== uniqueId(ref)) throw new Error("Feishu media ownership mismatch");
        const message = await this.getMessage(ref.chatId, ref.messageId);
        const media = (message.mediaInfos as MediaInfo[]).find(item => item.fileId === encodeReference(ref));
        if (!media) throw new Error("Feishu resource does not belong to message");
        if (media.fileSize !== undefined && media.fileSize > MAX_DOWNLOAD_BYTES) throw new Error("Feishu media too large");
        const fileName = typeof media.fileName === "string" && media.fileName ? media.fileName : undefined;
        const client = this.requireClient();
        let stream: Readable | undefined;
        const request = client.im.v1.messageResource.get({ path: { message_id: ref.messageId, file_key: ref.key }, params: { type: ref.type } });
        let expired = false;
        void request.then(response => { if (expired) response.getReadableStream().destroy(); }, () => {});
        try {
            const response = await bounded(request, this.requestTimeoutMs, undefined, () => { expired = true; });
            checkBusiness(response);
            stream = response.getReadableStream();
            const headers = record(response.headers);
            const length = Number(headers["content-length"]);
            if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) throw new Error("size limit");
            let mimeType = usableContentType(headers);
            const collect = async () => {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of stream!) {
                    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    size += bytes.length;
                    if (size > MAX_DOWNLOAD_BYTES) throw new Error("size limit");
                    chunks.push(bytes);
                }
                return Buffer.concat(chunks, size);
            };
            const buffer = await bounded(collect(), this.requestTimeoutMs, undefined, () => stream?.destroy());
            if (ref.type === "image" && mimeType === undefined && fileName === undefined) {
                mimeType = sniffImageMime(buffer);
            }
            const result: { buffer: Buffer; fileName?: string; mimeType?: string } = { buffer };
            if (fileName !== undefined) result.fileName = fileName;
            if (mimeType !== undefined) result.mimeType = mimeType;
            return result;
        } catch { throw new Error("Feishu media download failed or exceeded limits"); }
        finally { stream?.destroy(); }
    }

    muteChat(chatId: string, hours: number): void {
        const expiry = Date.now() + (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 8760) : 1) * 3600_000;
        this.muted.set(compositeId(chatId, "oc_"), expiry);
    }

    unmuteChat(chatId: string): void { this.muted.delete(compositeId(chatId, "oc_")); }

    isChatMuted(chatId: string): boolean {
        const id = compositeId(chatId, "oc_");
        const expiry = this.muted.get(id) ?? 0;
        if (expiry <= Date.now()) { this.muted.delete(id); return false; }
        return true;
    }

    getMutedChats(): Array<{ chatId: string; expiry: number; remaining: string }> {
        return [...this.muted].filter(([chatId]) => this.isChatMuted(chatId)).map(([chatId, expiry]) => ({ chatId, expiry, remaining: `${Math.ceil((expiry - Date.now()) / 60_000)}m` }));
    }
}
