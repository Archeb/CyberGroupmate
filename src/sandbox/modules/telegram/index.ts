/**
 * modules/telegram.ts — Telegram 客户端代理模块
 *
 * 包含 TelegramClient proxy 的完整实现：
 * - 重复消息拦截（per-session 去重）
 * - 消息水合（date → Date）
 * - ACK 格式化 & agent_message_sent 事件发射
 * - 所有 telegram.* 方法的 callHost 转发
 */

import type { CapabilityRegistryEnv } from "../../capability-registry.js";
import { resolve as pathResolve } from "node:path";
import { existsSync } from "node:fs";
import { loadBuiltinGuideContent } from "../../builtin-guides.js";
import { isAllowedTelegramMtcutePassthroughMethod } from "../../../core/telegram-mtcute-passthrough.js";

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

export function createTelegramClientProxy(
    env: CapabilityRegistryEnv,
    sentHistory: Map<string, Set<string>>,
    deduplicateSentMessages = true,
) {
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

    function buildTelegramMediaDedupKey(media: unknown, captionOverride?: string): string {
        const parts: string[] = [];

        if (typeof captionOverride === "string" && captionOverride.trim()) {
            parts.push(`caption=${captionOverride.trim()}`);
        }

        if (typeof media === "string") {
            parts.push(`file=${String(resolveLocalFile(media))}`);
            return `[media:${parts.join("|")}]`;
        }

        if (media && typeof media === "object") {
            const record = media as Record<string, unknown>;
            const type = typeof record.type === "string" ? record.type : "unknown";
            parts.push(`type=${type}`);

            const resolvedFile = resolveLocalFile(record.file);
            if (typeof resolvedFile === "string" && resolvedFile) parts.push(`file=${resolvedFile}`);
            if (typeof record.url === "string" && record.url) parts.push(`url=${record.url}`);
            if (typeof record.fileId === "string" && record.fileId) parts.push(`fileId=${record.fileId}`);
            if (typeof record.id === "string" && record.id) parts.push(`id=${record.id}`);
            if (typeof record.uniqueFileId === "string" && record.uniqueFileId) parts.push(`uniqueFileId=${record.uniqueFileId}`);
            if (typeof record.fileName === "string" && record.fileName) parts.push(`fileName=${record.fileName}`);
            if (!captionOverride && typeof record.caption === "string" && record.caption.trim()) {
                parts.push(`caption=${record.caption.trim()}`);
            }

            return `[media:${parts.join("|")}]`;
        }

        return "[media:unknown]";
    }

    function buildTelegramMediaGroupDedupKey(medias: unknown[]): string {
        const mediaKeys = (medias || []).map((media) => buildTelegramMediaDedupKey(media));
        return `[mediaGroup:${mediaKeys.join("||")}]`;
    }

    /** 检查消息是否是已成功发送过的重复消息。 */
    function isDuplicate(chatId: string, text: string): boolean {
        const key = String(chatId);
        const existing = sentHistory.get(key);
        return existing?.has(text) ?? false;
    }

    /** 仅在平台发送成功后记录，避免失败/拦截调用污染去重历史。 */
    function recordSent(chatId: string, text: string): void {
        const key = String(chatId);
        const existing = sentHistory.get(key);
        if (!existing) {
            sentHistory.set(key, new Set([text]));
        } else {
            existing.add(text);
        }
    }

    function shouldBlockDuplicate(chatId: string, text: string): boolean {
        return deduplicateSentMessages && isDuplicate(chatId, text);
    }

    function recordSentIfDedupEnabled(chatId: string, text: string): void {
        if (!deduplicateSentMessages) return;
        recordSent(chatId, text);
    }

    function isTelegramPeerResolutionError(err: unknown): boolean {
        const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
        return /PEER_ID_INVALID|MtPeerNotFoundError|peer .*not found|not found in local cache|reading 'inputPeer'|reading "inputPeer"|Invalid peer id/i.test(msg);
    }

    function buildTelegramPeerGuidance(method: string, args: unknown[]): string {
        const target = args.length > 0 ? String(args[0]) : "(unknown)";
        return [
            `[Telegram peer guardrail] ${method} 目标 peer=${target} 未解析。`,
            "这通常表示当前 mtcute session 还没遇见这个用户/私聊，缺少 access hash。下一步不要反复用裸数字 ID 重试。",
            "优先做法：",
            "- 有 username 时先 await telegram.meetPeer('@username')，或直接用 username 作为发送目标。",
            "- 有手机号时先 await telegram.meetPeer('+8613...', { kind: 'phone' })。",
            "- 已有对话时先 await telegram.findDialogs(userIdOrUsername) 或 await telegram.getDialogs({ limit: 200 }) 预热。",
            "- 有该用户消息 ID 时先 await telegram.meetPeer(userId, { chatId, messageIds: [messageId] }) 或 await telegram.getMessages(chatId, [messageId])。",
        ].join("\n");
    }

    async function callTelegramHost(method: string, args: unknown[] = []): Promise<unknown> {
        try {
            return await env.callHost(method, args);
        } catch (err) {
            if (!isTelegramPeerResolutionError(err)) throw err;
            const base = err instanceof Error ? err.message : String(err);
            const guidance = buildTelegramPeerGuidance(method, args);
            env.emitOutput(guidance);
            env.notifyHost({
                type: "system.telegram_peer_guardrail",
                scene: "telegram",
                method,
                chatId: args.length > 0 ? String(args[0]) : undefined,
                error: base,
                timestamp: new Date().toISOString(),
            });
            throw new Error(`${base}\n\n${guidance}`);
        }
    }

    function useTelegramGuide(methodName: string): string {
        const content = loadBuiltinGuideContent("telegram", methodName);
        if (!content) throw new Error(`Telegram guide not found: ${methodName}`);
        const wrapped = `\n═══ [TelegramGuide: ${methodName}] ═══\n${content}\n═══ [/TelegramGuide: ${methodName}] ═══\n`;
        env.emitOutput(wrapped);
        return wrapped;
    }

    function resolveStoryMedia(media: unknown): unknown {
        if (typeof media === "string") {
            return resolveLocalFile(media);
        }
        if (media && typeof media === "object") {
            const record = media as Record<string, unknown>;
            return {
                ...record,
                file: resolveLocalFile(record.file),
            };
        }
        return media;
    }

    const methods = {
        useInlineBot: async () => useTelegramGuide("useInlineBot"),
        useStories: async () => useTelegramGuide("useStories"),
        usePolls: async () => useTelegramGuide("usePolls"),
        usePeerResolution: async () => useTelegramGuide("usePeerResolution"),
        useMessageSearch: async () => useTelegramGuide("useMessageSearch"),
        useAccountProfile: async () => useTelegramGuide("useAccountProfile"),
        useAdvancedMessages: async () => useTelegramGuide("useAdvancedMessages"),
        useChatAdministration: async () => useTelegramGuide("useChatAdministration"),
        useInvites: async () => useTelegramGuide("useInvites"),
        useForumTopics: async () => useTelegramGuide("useForumTopics"),

        getMe: async () => callTelegramHost("telegram.getMe", []),
        sendText: async (chatId: number | string, text: string, opts?: { replyTo?: number }) => {
            // ── 重复消息拦截 ──
            if (shouldBlockDuplicate(String(chatId), text)) {
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
            const sent = hydrateTelegramMessage(await callTelegramHost("telegram.sendText", [chatId, text, opts]));
            recordSentIfDedupEnabled(String(chatId), text);
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
            const mediaText = buildTelegramMediaDedupKey(media, opts?.caption);
            if (shouldBlockDuplicate(String(chatId), mediaText)) {
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

            const sent = hydrateTelegramMessage(await callTelegramHost("telegram.sendMedia", [chatId, processedMedia, opts]));
            recordSentIfDedupEnabled(String(chatId), mediaText);
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
            const absFilePath = typeof filePath === "string" ? String(resolveLocalFile(filePath)) : filePath;
            const fileParts = [`file=${String(absFilePath)}`];
            if (opts?.caption) fileParts.push(`caption=${opts.caption}`);
            if (opts?.fileName) fileParts.push(`fileName=${opts.fileName}`);
            if (opts?.mimeType) fileParts.push(`mimeType=${opts.mimeType}`);
            const fileText = `[file:${fileParts.join("|")}]`;
            if (shouldBlockDuplicate(String(chatId), fileText)) {
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

            const sent = hydrateTelegramMessage(await callTelegramHost("telegram.sendFile", [chatId, absFilePath, opts]));
            recordSentIfDedupEnabled(String(chatId), fileText);
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
            const sent = hydrateTelegramMessage(await callTelegramHost("telegram.sendSticker", [chatId, uniqueFileId, opts]));
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
            callTelegramHost("telegram.getChat", [chatId]),
        getUser: async (userId: number | string) =>
            callTelegramHost("telegram.getUser", [userId]),
        getChatMembers: async (chatId: number | string, opts?: { limit?: number }) =>
            callTelegramHost("telegram.getChatMembers", [chatId, opts]),
        getHistory: async (chatId: number | string, opts?: { limit?: number }) => {
            const messages = await callTelegramHost("telegram.getHistory", [chatId, opts]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        iterHistory: async function* (chatId: number | string, opts?: { limit?: number }) {
            const messages = await callTelegramHost("telegram.getHistory", [chatId, opts]);
            if (!Array.isArray(messages)) return;
            for (const message of messages) {
                yield hydrateTelegramMessage(message);
            }
        },
        iterDialogs: async function* (opts?: { limit?: number }) {
            const dialogs = await callTelegramHost("telegram.getDialogs", [opts]);
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
            callTelegramHost("telegram.readHistory", [chatId]),
        sendTyping: async (chatId: number | string) => {
            await callTelegramHost("telegram.sendTyping", [chatId]);
            env.emitOutput(`[Telegram] sendTyping ok chat=${String(chatId)}`);
        },
        joinChat: async (chatId: number | string) => {
            await callTelegramHost("telegram.joinChat", [chatId]);
            env.emitOutput(`[Telegram] joinChat ok chat=${String(chatId)}`);
        },
        leaveChat: async (chatId: number | string) => {
            await callTelegramHost("telegram.leaveChat", [chatId]);
            env.emitOutput(`[Telegram] leaveChat ok chat=${String(chatId)}`);
        },
        getDialogs: async (opts?: { limit?: number }) => {
            const dialogs = await callTelegramHost("telegram.getDialogs", [opts]);
            return Array.isArray(dialogs) ? dialogs : [];
        },
        findDialogs: async (peers: number | string | Array<number | string>, opts?: { limit?: number }) => {
            const dialogs = await callTelegramHost("telegram.findDialogs", [peers, opts]);
            return Array.isArray(dialogs) ? dialogs : [];
        },
        meetPeer: async (peer: number | string, opts?: { kind?: "id" | "username" | "phone"; chatId?: number | string; messageIds?: number[]; dialogsLimit?: number; force?: boolean }) =>
            callTelegramHost("telegram.meetPeer", [peer, opts]),
        resolvePeer: async (peer: number | string, opts?: { kind?: "id" | "username" | "phone"; chatId?: number | string; messageIds?: number[]; dialogsLimit?: number; force?: boolean }) =>
            callTelegramHost("telegram.resolvePeer", [peer, opts]),

        // ─── Guide-only: inline bot consumer flow ───

        queryInlineBot: async (bot: number | string, query: string, opts?: { peer?: number | string; offset?: string }) =>
            callTelegramHost("telegram.queryInlineBot", [bot, query, opts]),
        sendInlineBotResult: async (chatId: number | string, queryId: number | string, resultId: string, opts?: { replyTo?: number; silent?: boolean; hideVia?: boolean; clearDraft?: boolean }) => {
            const sent = await callTelegramHost("telegram.sendInlineBotResult", [chatId, queryId, resultId, opts]);
            env.emitOutput(`[Telegram] sendInlineBotResult ok chat=${String(chatId)} result=${resultId}`);
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(chatId),
                text: `[inline-bot-result:${resultId}]`,
                replyToMessageId: opts?.replyTo,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },

        // ─── 扩展: 主动拉取 ───

        getFullUser: async (userId: number | string) =>
            callTelegramHost("telegram.getFullUser", [userId]),
        getFullChat: async (chatId: number | string) =>
            callTelegramHost("telegram.getFullChat", [chatId]),
        getForumTopics: async (chatId: number | string, opts?: { limit?: number }) =>
            callTelegramHost("telegram.getForumTopics", [chatId, opts]),
        getMessages: async (chatId: number | string, messageIds: number[]) => {
            const messages = await callTelegramHost("telegram.getMessages", [chatId, messageIds]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        searchMessages: async (chatId: number | string, query: string, opts?: { limit?: number }) => {
            const messages = await callTelegramHost("telegram.searchMessages", [chatId, query, opts]);
            return Array.isArray(messages) ? messages.map(hydrateTelegramMessage) : [];
        },
        getPollResults: async (chatId: number | string, messageId: number) =>
            callTelegramHost("telegram.getPollResults", [chatId, messageId]),
        getMessageReactions: async (chatId: number | string, messageIds: number[]) =>
            callTelegramHost("telegram.getMessageReactions", [chatId, messageIds]),
        downloadMedia: async (fileId: string, chatId?: number | string, messageId?: number, uniqueFileId?: string) =>
            callTelegramHost("telegram.downloadMedia", [fileId, chatId, messageId, uniqueFileId]),

        // ─── 扩展: 发送与交互 ───

        sendMediaGroup: async (chatId: number | string, medias: unknown[], opts?: { replyTo?: number; silent?: boolean }) => {
            const mediaGroupText = buildTelegramMediaGroupDedupKey(medias);
            if (shouldBlockDuplicate(String(chatId), mediaGroupText)) {
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

            const sent = await callTelegramHost("telegram.sendMediaGroup", [chatId, processedMedias, opts]);
            recordSentIfDedupEnabled(String(chatId), mediaGroupText);
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
        forwardMessage: async (
            toChatId: number | string,
            fromChatId: number | string,
            messageIds: number | number[],
            opts?: Record<string, unknown>,
        ) => {
            const sent = await callTelegramHost("telegram.forwardMessage", [toChatId, fromChatId, messageIds, opts]);
            const hydrated = Array.isArray(sent) ? sent.map(hydrateTelegramMessage) : hydrateTelegramMessage(sent);
            const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
            const sentMessageId = !Array.isArray(hydrated) && hydrated && typeof hydrated === "object" && "id" in hydrated
                ? (hydrated as { id?: unknown }).id
                : undefined;
            env.emitOutput(Array.isArray(hydrated)
                ? `[Telegram] forwardMessage ok chat=${String(toChatId)} count=${hydrated.length}`
                : formatTelegramAck("[Telegram] forwardMessage ok", hydrated));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "telegram",
                chatId: String(toChatId),
                messageId: sentMessageId,
                text: `[forward:${String(fromChatId)}:${ids.join(",")}]`,
                timestamp: new Date().toISOString(),
            });
            return hydrated;
        },
        sendPoll: async (chatId: number | string, question: string, options: string[], opts?: Record<string, unknown>) => {
            // ── 重复消息拦截（基于 question）──
            const pollText = `[poll:${question}]`;
            if (shouldBlockDuplicate(String(chatId), pollText)) {
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
            const sent = hydrateTelegramMessage(await callTelegramHost("telegram.sendPoll", [chatId, question, options, opts]));
            recordSentIfDedupEnabled(String(chatId), pollText);
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
            await callTelegramHost("telegram.sendReaction", [chatId, messageId, emoji]);
            env.emitOutput(`[Telegram] sendReaction ok chat=${String(chatId)} msg=${messageId} emoji=${emoji ?? "(removed)"}`);
        },
        editMessage: async (chatId: number | string, messageId: number, text: string) => {
            const edited = hydrateTelegramMessage(await callTelegramHost("telegram.editMessage", [chatId, messageId, text]));
            env.emitOutput(formatTelegramAck("[Telegram] editMessage ok", edited));
            return edited;
        },
        deleteMessages: async (chatId: number | string, messageIds: number[]) => {
            await callTelegramHost("telegram.deleteMessages", [chatId, messageIds]);
            env.emitOutput(`[Telegram] deleteMessages ok chat=${String(chatId)} ids=[${messageIds.join(",")}]`);
        },
        pinMessage: async (chatId: number | string, messageId: number, opts?: { silent?: boolean }) => {
            await callTelegramHost("telegram.pinMessage", [chatId, messageId, opts]);
            env.emitOutput(`[Telegram] pinMessage ok chat=${String(chatId)} msg=${messageId}`);
        },
        unpinMessage: async (chatId: number | string, messageId: number) => {
            await callTelegramHost("telegram.unpinMessage", [chatId, messageId]);
            env.emitOutput(`[Telegram] unpinMessage ok chat=${String(chatId)} msg=${messageId}`);
        },

    };

    return new Proxy(methods, {
        get(target, prop, receiver) {
            if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (!isAllowedTelegramMtcutePassthroughMethod(prop)) return undefined;
            if (prop.startsWith("iter")) {
                return async function* (...args: unknown[]) {
                    const result = await callTelegramHost("telegram.mtcute", [prop, ...args]);
                    if (!Array.isArray(result)) return;
                    for (const item of result) yield item;
                };
            }
            return async (...args: unknown[]) => callTelegramHost("telegram.mtcute", [prop, ...args]);
        },
    });
}

