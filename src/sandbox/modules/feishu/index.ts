import { randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CapabilityRegistryEnv } from "../../capability-registry.js";
import type { FeishuClient, FeishuMedia, FeishuMessageAck, FeishuSendOptions, FeishuTextOptions } from "./feishu.js";
import { DEFAULT_BANNED_WORDS, findBannedWords, buildBannedWordWarning } from "../../../core/banned-words.js";

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
type SendMethod = "sendText" | "sendMessage" | "sendMedia" | "sendSticker" | "sendTemplateCard" | "sendCard";
type SendPayload = string | FeishuMedia | { type: string; content: Record<string, unknown> }
    | { templateId: string; variables: Record<string, unknown> } | { card: Record<string, unknown> };
type HostCall = { method: string; args: unknown[] };

function canonicalChatId(chatId: string): string {
    if (typeof chatId !== "string" || !/^(?:feishu:)?oc_[A-Za-z0-9_-]+$/.test(chatId)) {
        throw new Error("Feishu chatId must be feishu:oc_x");
    }
    return chatId.startsWith("feishu:") ? chatId : `feishu:${chatId}`;
}

function canonicalSenderUserId(userId: unknown): string | undefined {
    if (typeof userId !== "string" || !/^(?:feishu:)?ou_[A-Za-z0-9_-]+$/.test(userId)) return undefined;
    return userId.startsWith("feishu:") ? userId : `feishu:${userId}`;
}

function payloadText(method: SendMethod, payload: SendPayload): string {
    if (method === "sendSticker") return "[sticker]";
    if (typeof payload === "string") return payload;
    if ("content" in payload) return JSON.stringify(payload.content);
    if ("templateId" in payload) return JSON.stringify(payload.variables);
    if ("card" in payload) return JSON.stringify(payload.card);
    return payload.caption ?? "";
}

function dedupPayload(payload: SendPayload): unknown {
    if (typeof payload === "string") return payload;
    if ("path" in payload) return [payload.type, payload.path, payload.caption ?? "", payload.fileName ?? null];
    if ("content" in payload) return [payload.type, payload.content];
    if ("templateId" in payload) return [payload.templateId, payload.variables];
    return payload.card;
}

function requireAck(result: unknown, method: SendMethod, chatId: string, requireText = false): FeishuMessageAck {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw new Error(`Feishu ${method} did not return a message acknowledgement`);
    }
    const raw = result as Record<string, unknown>;
    if (typeof raw.messageId !== "string" || !/^om_[A-Za-z0-9_-]+$/.test(raw.messageId)
        || requireText && typeof raw.text !== "string" || raw.ok === false || raw.success === false) {
        throw new Error(`Feishu ${method} did not return a successful messageId`);
    }
    if (raw.chatId !== undefined && canonicalChatId(raw.chatId as string) !== chatId) {
        throw new Error(`Feishu ${method} acknowledgement chat mismatch`);
    }
    return { ...raw, messageId: raw.messageId, chatId };
}

function sendHostCall(method: SendMethod, chatId: string, payload: SendPayload, options: FeishuSendOptions): HostCall {
    if (method === "sendMessage" && typeof payload !== "string" && "content" in payload) {
        return { method: "feishu.sendMessage", args: [chatId, payload.type, payload.content, options] };
    }
    if (method === "sendTemplateCard" && typeof payload !== "string" && "templateId" in payload) {
        return { method: "feishu.sendTemplateCard", args: [chatId, payload.templateId, payload.variables, options] };
    }
    if (method === "sendCard" && typeof payload !== "string" && "card" in payload) {
        return { method: "feishu.sendCard", args: [chatId, payload.card, options] };
    }
    return { method: `feishu.${method}`, args: [chatId, payload, options] };
}

export function createFeishuClientProxy(
    env: CapabilityRegistryEnv,
    sentHistory: Map<string, Set<string>>,
    deduplicateSentMessages = true,
    bannedWords: string[] = DEFAULT_BANNED_WORDS,
): FeishuClient {
    const workspace = resolve(env.workspace ?? process.cwd());
    const pending = new Map<string, Promise<unknown>>();

    function blockBannedText(chatId: string, text: string): boolean {
        const foundWords = findBannedWords(text, bannedWords);
        if (foundWords.length === 0) return false;
        env.emitOutput(buildBannedWordWarning(foundWords, text));
        env.notifyHost({
            type: "system.banned_word_blocked",
            scene: "feishu",
            chatId,
            text,
            foundWords,
            timestamp: Date.now(),
        });
        return true;
    }

    function callMutation(method: string, chatId: string, text: string, args: unknown[]): Promise<unknown> | null {
        chatId = canonicalChatId(chatId);
        if (blockBannedText(chatId, text)) return null;
        return env.callHost(method, [chatId, ...args]);
    }

    async function send(
        method: SendMethod,
        chatId: string,
        payload: SendPayload,
        options?: FeishuTextOptions,
    ): Promise<FeishuMessageAck | null> {
        chatId = canonicalChatId(chatId);
        const text = payloadText(method, payload);
        if (blockBannedText(chatId, text)) return null;

        const key = JSON.stringify([
            method,
            options?.replyToMessageId ?? null,
            options?.replyInThread ?? false,
            dedupPayload(payload),
            options?.mentions?.map(mention => [mention.userId, mention.displayName ?? null]) ?? [],
        ]);
        const pendingKey = JSON.stringify([chatId, key]);
        if (deduplicateSentMessages) {
            while (pending.has(pendingKey)) {
                await pending.get(pendingKey)!.catch(() => undefined);
            }
            if (sentHistory.get(chatId)?.has(key)) {
                env.emitOutput(`[Feishu] Duplicate message blocked chat=${chatId}`);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "feishu",
                    chatId,
                    text,
                    timestamp: Date.now(),
                });
                return null;
            }
        }

        const operation = (async (): Promise<FeishuMessageAck> => {
            const requestOptions = { ...options, uuid: options?.uuid ?? randomUUID() };
            const call = sendHostCall(method, chatId, payload, requestOptions);
            const result = await env.callHost(call.method, call.args);
            const ack = requireAck(result, method, chatId);
            const raw = result as Record<string, unknown>;
            if (deduplicateSentMessages) {
                const history = sentHistory.get(chatId) ?? new Set<string>();
                history.add(key);
                sentHistory.set(chatId, history);
            }
            const emitSent = (message: FeishuMessageAck, sentText: string, replyToMessageId?: string, mediaInfo?: unknown) => {
                env.emitOutput(`[Feishu] ${method} ok chat=${chatId} msg=${message.messageId}`);
                env.notifyHost({
                    type: "system.agent_message_sent",
                    scene: "feishu",
                    chatId,
                    messageId: message.messageId,
                    text: sentText,
                    senderUserId: message.senderUserId,
                    mentions: message.mentions,
                    replyToMessageId: message.replyToMessageId ?? replyToMessageId,
                    parentId: message.parentId,
                    rootId: message.rootId,
                    threadId: message.threadId,
                    mediaInfo: message.mediaInfo ?? mediaInfo,
                    timestamp: Date.now(),
                });
            };
            const mediaPayload = typeof payload !== "string" && "path" in payload ? payload : undefined;
            emitSent(ack, typeof payload === "string" || !mediaPayload ? text : "", options?.replyToMessageId, mediaPayload ? {
                type: mediaPayload.type,
                fileName: mediaPayload.fileName ?? basename(mediaPayload.path),
            } : undefined);
            if (method === "sendMedia" && raw.additionalMessages !== undefined) {
                const seen = new Set([ack.messageId]);
                const additionalMessages: FeishuMessageAck[] = [];
                for (const value of Array.isArray(raw.additionalMessages) ? raw.additionalMessages : [null]) {
                    try {
                        const message = requireAck(value, method, chatId, true);
                        if ((value as Record<string, unknown>).chatId === undefined) throw new Error("invalid acknowledgement");
                        if (seen.has(message.messageId)) continue;
                        seen.add(message.messageId);
                        additionalMessages.push(message);
                        emitSent(message, message.text!);
                    } catch {
                        env.emitOutput("[Feishu] Invalid additional message acknowledgement ignored");
                    }
                }
                ack.additionalMessages = additionalMessages;
            }
            if (raw.captionError !== undefined) {
                env.emitOutput(`[Feishu] Media sent; caption failed chat=${chatId} msg=${ack.messageId}`);
            }
            return ack;
        })();
        if (deduplicateSentMessages) pending.set(pendingKey, operation);
        try {
            return await operation;
        } finally {
            if (pending.get(pendingKey) === operation) pending.delete(pendingKey);
        }
    }

    return {
        sendText: async (chatId, text, options) => send("sendText", chatId, text, options),
        sendMessage: async (chatId, type, content, options) => send("sendMessage", chatId, { type, content }, options),
        sendMedia: async (chatId, media, options) => send("sendMedia", chatId, {
            ...media,
            path: resolve(workspace, media.path),
        }, options),
        sendSticker: async (chatId, fileId, options) => send("sendSticker", chatId, fileId, options),
        sendTemplateCard: async (chatId, templateId, variables = {}, options) => send("sendTemplateCard", chatId, { templateId, variables }, options),
        sendCard: async (chatId, card, options) => send("sendCard", chatId, { card }, options),
        updateTemplateCard: async (chatId, messageId, templateId, variables = {}) => callMutation("feishu.updateTemplateCard", chatId, JSON.stringify(variables), [messageId, templateId, variables]),
        updateCard: async (chatId, messageId, card, options) => callMutation("feishu.updateCard", chatId, JSON.stringify(card), [messageId, card, options]),
        patchCard: async (chatId, messageId, actions, options) => callMutation("feishu.patchCard", chatId, JSON.stringify(actions), [messageId, actions, options]),
        streamCardText: async (chatId, messageId, elementId, content, options) => callMutation("feishu.streamCardText", chatId, content, [messageId, elementId, content, options]),
        getMessage: async (chatId, messageId) => env.callHost("feishu.getMessage", [canonicalChatId(chatId), messageId]),
        getHistory: async (chatId, options) => env.callHost("feishu.getHistory", [canonicalChatId(chatId), options]) as Promise<{ items: unknown[]; hasMore: boolean; pageToken?: string }>,
        getChat: async chatId => env.callHost("feishu.getChat", [canonicalChatId(chatId)]),
        callApi: async (chatId, action, payload = {}) => {
            chatId = canonicalChatId(chatId);
            if (action !== "message.forward" && action !== "message.mergeForward") {
                if (blockBannedText(chatId, JSON.stringify(payload))) return null;
                return env.callHost("feishu.callApi", [chatId, action, payload]);
            }
            const key = JSON.stringify(["callApi", action, payload]);
            const pendingKey = JSON.stringify([chatId, key]);
            if (deduplicateSentMessages) {
                while (pending.has(pendingKey)) await pending.get(pendingKey)!.catch(() => undefined);
                if (sentHistory.get(chatId)?.has(key)) {
                    env.emitOutput(`[Feishu] Duplicate message blocked chat=${chatId}`);
                    env.notifyHost({
                        type: "system.duplicate_message_blocked",
                        scene: "feishu",
                        chatId,
                        text: `[${action}]`,
                        timestamp: Date.now(),
                    });
                    return null;
                }
            }
            const operation = (async () => {
                const result = await env.callHost("feishu.callApi", [chatId, action, payload]);
                const raw = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
                const data = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data as Record<string, unknown> : {};
                const message = action === "message.mergeForward" && data.message && typeof data.message === "object" && !Array.isArray(data.message)
                    ? data.message as Record<string, unknown>
                    : data;
                const ack = requireAck({
                    messageId: message.message_id,
                    chatId: message.chat_id ?? chatId,
                    senderUserId: message.sender && typeof message.sender === "object"
                        ? canonicalSenderUserId((message.sender as Record<string, unknown>).id)
                        : undefined,
                    parentId: message.parent_id,
                    rootId: message.root_id,
                    threadId: message.thread_id,
                }, "sendMessage", chatId);
                if (deduplicateSentMessages) {
                    const history = sentHistory.get(chatId) ?? new Set<string>();
                    history.add(key);
                    sentHistory.set(chatId, history);
                }
                env.emitOutput(`[Feishu] ${action} ok chat=${chatId} msg=${ack.messageId}`);
                env.notifyHost({
                    type: "system.agent_message_sent",
                    scene: "feishu",
                    chatId,
                    messageId: ack.messageId,
                    text: `[${action}]`,
                    senderUserId: ack.senderUserId,
                    parentId: ack.parentId,
                    rootId: ack.rootId,
                    threadId: ack.threadId,
                    timestamp: Date.now(),
                });
                return result;
            })();
            if (deduplicateSentMessages) pending.set(pendingKey, operation);
            try {
                return await operation;
            } finally {
                if (pending.get(pendingKey) === operation) pending.delete(pendingKey);
            }
        },
        downloadMedia: async (fileId, chatId, messageId, uniqueFileId) => {
            const result = await env.callHost("feishu.downloadMedia", [
                fileId,
                chatId === undefined ? undefined : canonicalChatId(chatId),
                messageId,
                uniqueFileId,
            ]);
            if (!result || typeof result !== "object") throw new Error("Feishu downloadMedia: invalid envelope");
            const raw = result as Record<string, unknown>;
            if (typeof raw.buffer !== "string" || raw.buffer.length > Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4) {
                throw new Error("Feishu downloadMedia: missing buffer or download exceeds 100 MiB");
            }
            const buffer = Buffer.from(raw.buffer, "base64");
            if (buffer.length > MAX_DOWNLOAD_BYTES || buffer.toString("base64") !== raw.buffer
                || (raw.size !== undefined && raw.size !== buffer.length)) {
                throw new Error("Feishu downloadMedia: invalid base64 buffer or size");
            }
            const extensions: Record<string, string> = {
                "image/jpeg": ".jpg",
                "image/png": ".png",
                "image/webp": ".webp",
                "image/gif": ".gif",
                "application/pdf": ".pdf",
            };
            const fallback = `download${extensions[String(raw.mimeType)] ?? ".bin"}`;
            const name = typeof raw.fileName === "string" ? basename(raw.fileName.replace(/\\/g, "/")) : fallback;
            const safeName = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(-120) || fallback;
            const root = await realpath(workspace);
            const downloads = join(root, "Downloads");
            await mkdir(downloads, { recursive: true });
            if (await realpath(downloads) !== downloads) throw new Error("Feishu downloadMedia: Downloads must be inside workspace");
            const path = join(downloads, `${randomUUID()}-${safeName}`);
            await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
            return path;
        },
    };
}
