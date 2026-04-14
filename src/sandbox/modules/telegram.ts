/**
 * modules/telegram.ts — Telegram 客户端代理模块
 *
 * 包含 TelegramClient proxy 的完整实现：
 * - 重复消息拦截（per-session 去重）
 * - 消息水合（date → Date）
 * - ACK 格式化 & agent_message_sent 事件发射
 * - 所有 telegram.* 方法的 callHost 转发
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";
import { resolve as pathResolve } from "node:path";
import { existsSync } from "node:fs";

// ─── 工具函数 ───

export function hydrateTelegramMessage(message: unknown): unknown {
    if (!message || typeof message !== "object") return message;
    const raw = message as Record<string, unknown>;
    return {
        ...raw,
        date: raw.date ? new Date(String(raw.date)) : new Date(),
        replyToMessage: raw.replyToMessage && typeof raw.replyToMessage === "object"
            ? { ...(raw.replyToMessage as Record<string, unknown>) }
            : raw.replyToMessage,
    };
}

export function formatTelegramAck(prefix: string, payload: unknown): string {
    if (!payload || typeof payload !== "object") return prefix;
    const raw = payload as Record<string, unknown>;
    const chat = raw.chat && typeof raw.chat === "object" ? raw.chat as Record<string, unknown> : undefined;
    const chatId = chat?.id ?? raw.chatId;
    const msgId = raw.id ?? raw.messageId;
    const text = typeof raw.text === "string" ? raw.text : undefined;
    const parts = [prefix];
    if (chatId !== undefined) parts.push(`chat=${String(chatId)}`);
    if (msgId !== undefined) parts.push(`msg=${String(msgId)}`);
    if (text) parts.push(`text=${text}`);
    return parts.join(" ");
}

// ─── Telegram 客户端代理 ───

export function createTelegramClientProxy(env: CapabilityRegistryEnv, sentHistory: Map<string, Set<string>>) {
    /**
     * 将可能的工作区相对路径解析为绝对路径。
     * 如果解析后的路径对应的文件存在，则返回绝对路径；
     * 否则原样返回（可能是 URL、Telegram File ID 或是无效路径）。
     */
    function resolveLocalFile(file: unknown): unknown {
        if (typeof file !== "string") return file;
        if (file.startsWith("http://") || file.startsWith("https://") || file.startsWith("data:")) return file;
        const absPath = pathResolve(process.cwd(), file);
        if (existsSync(absPath)) {
            return absPath;
        }
        return file;
    }

    /**
     * 检查消息是否是重复发送。
     * 如果是新消息则记录并返回 false；如果已发送过则返回 true。
     */
    function isDuplicate(chatId: string, text: string): boolean {
        const key = String(chatId);
        const existing = sentHistory.get(key);
        if (existing && existing.has(text)) {
            return true;
        }
        if (!existing) {
            sentHistory.set(key, new Set([text]));
        } else {
            existing.add(text);
        }
        return false;
    }

    return {
        getMe: async () => env.callHost("telegram.getMe", []),
        sendText: async (chatId: number | string, text: string, opts?: { replyTo?: number }) => {
            // ── 重复消息拦截 ──
            if (isDuplicate(String(chatId), text)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的消息 "${text.length > 80 ? text.slice(0, 80) + '...' : text}" 与本次 session 中已发送的消息内容完全一致，已自动拦截，不会重复发送。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "telegram",
                    chatId: String(chatId),
                    text,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            const sent = hydrateTelegramMessage(await env.callHost("telegram.sendText", [chatId, text, opts]));
            env.emitOutput(formatTelegramAck("[Telegram] sendText ok", sent));
            // 发射 agent_message_sent 通知，供 SentMessageCollector 捕获
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text,
                replyToMessageId: opts?.replyTo,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendMedia: async (chatId: number | string, media: unknown, opts?: { replyTo?: number; caption?: string }) => {
            // ── 重复消息拦截（基于 caption + 媒体标识）──
            // 从 media 对象中提取可区分的标识（file/url/fileId/type），避免不同媒体被误判为重复
            let mediaIdentifier = "[media]";
            if (media && typeof media === "object") {
                const m = media as Record<string, unknown>;
                if (typeof m.file === "string") mediaIdentifier = `[media:file=${m.file}]`;
                else if (typeof m.url === "string") mediaIdentifier = `[media:url=${m.url}]`;
                else if (typeof m.fileId === "string") mediaIdentifier = `[media:fileId=${m.fileId}]`;
                else if (typeof m.id === "string") mediaIdentifier = `[media:id=${m.id}]`;
                else if (typeof m.type === "string") mediaIdentifier = `[media:type=${m.type}]`;
            }
            const mediaText = opts?.caption ? `${opts.caption}|${mediaIdentifier}` : mediaIdentifier;
            if (isDuplicate(String(chatId), mediaText)) {
                const preview = mediaText.length > 80 ? mediaText.slice(0, 80) + '...' : mediaText;
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的媒体消息 "${preview}" 与本次 session 中已发送的消息内容完全一致，已自动拦截，不会重复发送。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "telegram",
                    chatId: String(chatId),
                    text: mediaText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }

            // 处理 media 中的相对文件路径
            let processedMedia = media;
            if (typeof media === "string") {
                processedMedia = resolveLocalFile(media);
            } else if (media && typeof media === "object") {
                const m = media as Record<string, unknown>;
                processedMedia = {
                    ...m,
                    file: resolveLocalFile(m.file)
                };
            }

            const sent = hydrateTelegramMessage(await env.callHost("telegram.sendMedia", [chatId, processedMedia, opts]));
            env.emitOutput(formatTelegramAck("[Telegram] sendMedia ok", sent));
            // 发射 agent_message_sent 通知
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text: opts?.caption ?? "[media]",
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendFile: async (chatId: number | string, filePath: string, opts?: { replyTo?: number; caption?: string; fileName?: string; mimeType?: string }) => {
            // ── 重复消息拦截（基于 caption + filePath）──
            const fileText = opts?.caption ?? `[file:${filePath}]`;
            if (isDuplicate(String(chatId), fileText)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的文件消息 "${fileText.length > 80 ? fileText.slice(0, 80) + '...' : fileText}" 与本次 session 中已发送的消息内容完全一致，已自动拦截，不会重复发送。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "telegram",
                    chatId: String(chatId),
                    text: fileText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            
            // 解析可能的相对路径
            const absFilePath = typeof filePath === "string" ? String(resolveLocalFile(filePath)) : filePath;
            
            const sent = hydrateTelegramMessage(await env.callHost("telegram.sendFile", [chatId, absFilePath, opts]));
            env.emitOutput(formatTelegramAck("[Telegram] sendFile ok", sent));
            // 发射 agent_message_sent 通知
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text: opts?.caption ?? `[file:${filePath}]`,
                replyToMessageId: opts?.replyTo,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendSticker: async (chatId: number | string, uniqueFileId: string, opts?: { replyTo?: number }) => {
            // ── 贴纸重复发送很正常，不拦截 ──
            const sent = hydrateTelegramMessage(await env.callHost("telegram.sendSticker", [chatId, uniqueFileId, opts]));
            env.emitOutput(formatTelegramAck("[Telegram] sendSticker ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text: `[🎭 贴纸: ${uniqueFileId}]`,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        getChat: async (chatId: number | string) =>
            env.callHost("telegram.getChat", [chatId]),
        getUser: async (userId: number | string) =>
            env.callHost("telegram.getUser", [userId]),
        getChatMembers: async (chatId: number | string, opts?: { limit?: number }) =>
            env.callHost("telegram.getChatMembers", [chatId, opts]),
        getHistory: async (chatId: number | string, opts?: { limit?: number }) => {
            const messages = await env.callHost("telegram.getHistory", [chatId, opts]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        iterHistory: async function* (chatId: number | string, opts?: { limit?: number }) {
            const messages = await env.callHost("telegram.getHistory", [chatId, opts]);
            if (!Array.isArray(messages)) return;
            for (const message of messages) {
                yield hydrateTelegramMessage(message);
            }
        },
        iterDialogs: async function* (opts?: { limit?: number }) {
            const dialogs = await env.callHost("telegram.getDialogs", [opts]);
            if (!Array.isArray(dialogs)) return;
            for (const dialog of dialogs) {
                const raw = dialog as Record<string, unknown>;
                yield {
                    ...raw,
                    lastMessage: raw.lastMessage ? hydrateTelegramMessage(raw.lastMessage) : undefined,
                };
            }
        },
        readHistory: async (chatId: number | string) =>
            env.callHost("telegram.readHistory", [chatId]),
        sendTyping: async (chatId: number | string) => {
            await env.callHost("telegram.sendTyping", [chatId]);
            env.emitOutput(`[Telegram] sendTyping ok chat=${String(chatId)}`);
        },
        joinChat: async (chatId: number | string) => {
            await env.callHost("telegram.joinChat", [chatId]);
            env.emitOutput(`[Telegram] joinChat ok chat=${String(chatId)}`);
        },
        leaveChat: async (chatId: number | string) => {
            await env.callHost("telegram.leaveChat", [chatId]);
            env.emitOutput(`[Telegram] leaveChat ok chat=${String(chatId)}`);
        },
        getDialogs: async (opts?: { limit?: number }) => {
            const dialogs = await env.callHost("telegram.getDialogs", [opts]);
            return Array.isArray(dialogs) ? dialogs : [];
        },

        // ─── 扩展: 主动拉取 ───

        getFullUser: async (userId: number | string) =>
            env.callHost("telegram.getFullUser", [userId]),
        getFullChat: async (chatId: number | string) =>
            env.callHost("telegram.getFullChat", [chatId]),
        getForumTopics: async (chatId: number | string, opts?: { limit?: number }) =>
            env.callHost("telegram.getForumTopics", [chatId, opts]),
        getMessages: async (chatId: number | string, messageIds: number[]) => {
            const messages = await env.callHost("telegram.getMessages", [chatId, messageIds]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        searchMessages: async (chatId: number | string, query: string, opts?: { limit?: number }) => {
            const messages = await env.callHost("telegram.searchMessages", [chatId, query, opts]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        getPollResults: async (chatId: number | string, messageId: number) =>
            env.callHost("telegram.getPollResults", [chatId, messageId]),
        getMessageReactions: async (chatId: number | string, messageIds: number[]) =>
            env.callHost("telegram.getMessageReactions", [chatId, messageIds]),
        downloadMedia: async (fileId: string, chatId?: number | string, messageId?: number, uniqueFileId?: string) =>
            env.callHost("telegram.downloadMedia", [fileId, chatId, messageId, uniqueFileId]),

        // ─── 扩展: 发送与交互 ───

        sendMediaGroup: async (chatId: number | string, medias: unknown[], opts?: { replyTo?: number; silent?: boolean }) => {
            // ── 重复消息拦截（基于首项 caption 或类型摘要）──
            const firstMedia = medias[0] as Record<string, unknown> | undefined;
            const mediaGroupText = `[mediaGroup:${medias.length}items]${firstMedia?.caption ? `|${firstMedia.caption}` : ""}`;
            if (isDuplicate(String(chatId), mediaGroupText)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的媒体组与本次 session 中已发送的内容一致，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "telegram",
                    chatId: String(chatId),
                    text: mediaGroupText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }

            // 处理媒体组中的所有相对文件路径
            const processedMedias = (medias || []).map((m: unknown) => {
                if (m && typeof m === "object") {
                    const record = m as Record<string, unknown>;
                    return {
                        ...record,
                        file: resolveLocalFile(record.file)
                    };
                }
                return m;
            });

            const sent = await env.callHost("telegram.sendMediaGroup", [chatId, processedMedias, opts]);
            env.emitOutput(`[Telegram] sendMediaGroup ok chat=${String(chatId)} count=${medias.length}`);
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                text: mediaGroupText,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendPoll: async (chatId: number | string, question: string, options: string[], opts?: Record<string, unknown>) => {
            // ── 重复消息拦截（基于 question）──
            const pollText = `[poll:${question}]`;
            if (isDuplicate(String(chatId), pollText)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的投票 "${question}" 与本次 session 中已发送的内容一致，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "telegram",
                    chatId: String(chatId),
                    text: pollText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            const sent = hydrateTelegramMessage(await env.callHost("telegram.sendPoll", [chatId, question, options, opts]));
            env.emitOutput(formatTelegramAck("[Telegram] sendPoll ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                text: pollText,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendReaction: async (chatId: number | string, messageId: number, emoji: string | null) => {
            await env.callHost("telegram.sendReaction", [chatId, messageId, emoji]);
            env.emitOutput(`[Telegram] sendReaction ok chat=${String(chatId)} msg=${messageId} emoji=${emoji ?? "(removed)"}`);
        },
        editMessage: async (chatId: number | string, messageId: number, text: string) => {
            const edited = hydrateTelegramMessage(await env.callHost("telegram.editMessage", [chatId, messageId, text]));
            env.emitOutput(formatTelegramAck("[Telegram] editMessage ok", edited));
            return edited;
        },
        deleteMessages: async (chatId: number | string, messageIds: number[]) => {
            await env.callHost("telegram.deleteMessages", [chatId, messageIds]);
            env.emitOutput(`[Telegram] deleteMessages ok chat=${String(chatId)} ids=[${messageIds.join(",")}]`);
        },
        pinMessage: async (chatId: number | string, messageId: number, opts?: { silent?: boolean }) => {
            await env.callHost("telegram.pinMessage", [chatId, messageId, opts]);
            env.emitOutput(`[Telegram] pinMessage ok chat=${String(chatId)} msg=${messageId}`);
        },
        unpinMessage: async (chatId: number | string, messageId: number) => {
            await env.callHost("telegram.unpinMessage", [chatId, messageId]);
            env.emitOutput(`[Telegram] unpinMessage ok chat=${String(chatId)} msg=${messageId}`);
        },
    };
}
