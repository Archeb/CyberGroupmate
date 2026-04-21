/**
 * modules/onebot/index.ts — OneBot (QQ) 客户端代理模块
 *
 * 包含 QQ 客户端 proxy 的完整实现：
 * - 重复消息拦截（per-session 去重）
 * - ACK 格式化 & agent_message_sent 事件发射
 * - 所有 onebot.* / qq.* 方法的 callHost 转发
 */

import type { CapabilityRegistryEnv } from "../../capability-registry.js";
import { resolve as pathResolve } from "node:path";
import { existsSync } from "node:fs";

// ─── 工具函数 ───

export function formatOneBotAck(prefix: string, payload: unknown): string {
    if (!payload || typeof payload !== "object") return prefix;
    const raw = payload as Record<string, unknown>;
    const chatId = raw.chatId ?? raw.group_id ?? raw.user_id;
    const msgId = raw.message_id ?? raw.id;
    const parts = [prefix];
    if (chatId !== undefined) parts.push(`chat=${String(chatId)}`);
    if (msgId !== undefined) parts.push(`msg=${String(msgId)}`);
    return parts.join(" ");
}

// ─── OneBot 客户端代理 ───

export function createOneBotClientProxy(env: CapabilityRegistryEnv, sentHistory: Map<string, Set<string>>) {
    /**
     * 将可能的工作区相对路径解析为绝对路径。
     */
    function resolveLocalFile(file: unknown): unknown {
        if (typeof file !== "string") return file;
        if (file.startsWith("http://") || file.startsWith("https://") || file.startsWith("data:")) return file;
        const absPath = pathResolve(process.cwd(), file);
        if (existsSync(absPath)) return absPath;
        return file;
    }

    /**
     * 检查消息是否是重复发送。
     */
    function isDuplicate(chatId: string, text: string): boolean {
        const key = String(chatId);
        const existing = sentHistory.get(key);
        if (existing && existing.has(text)) return true;
        if (!existing) {
            sentHistory.set(key, new Set([text]));
        } else {
            existing.add(text);
        }
        return false;
    }

    return {
        sendText: async (chatId: string, text: string, opts?: { replyTo?: string | number }) => {
            if (isDuplicate(String(chatId), text)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的消息 "${text.length > 80 ? text.slice(0, 80) + '...' : text}" 与本次 session 中已发送的消息内容完全一致，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "onebot",
                    chatId: String(chatId),
                    text,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            const sent = await env.callHost("onebot.sendText", [chatId, text, opts]);
            env.emitOutput(formatOneBotAck("[QQ] sendText ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "onebot",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "message_id" in sent ? (sent as { message_id?: unknown }).message_id : undefined,
                text,
                replyToMessageId: opts?.replyTo,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendMedia: async (chatId: string, media: unknown, opts?: { replyTo?: string | number; caption?: string }) => {
            let mediaIdentifier = "[media]";
            if (media && typeof media === "object") {
                const m = media as Record<string, unknown>;
                if (typeof m.file === "string") mediaIdentifier = `[media:file=${m.file}]`;
                else if (typeof m.url === "string") mediaIdentifier = `[media:url=${m.url}]`;
                else if (typeof m.type === "string") mediaIdentifier = `[media:type=${m.type}]`;
            }
            const mediaText = opts?.caption ? `${opts.caption}|${mediaIdentifier}` : mediaIdentifier;
            if (isDuplicate(String(chatId), mediaText)) {
                const preview = mediaText.length > 80 ? mediaText.slice(0, 80) + '...' : mediaText;
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的媒体消息 "${preview}" 与本次 session 中已发送的内容一致，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "onebot",
                    chatId: String(chatId),
                    text: mediaText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }

            let processedMedia = media;
            if (typeof media === "string") {
                processedMedia = resolveLocalFile(media);
            } else if (media && typeof media === "object") {
                const m = media as Record<string, unknown>;
                processedMedia = { ...m, file: resolveLocalFile(m.file) };
            }

            const sent = await env.callHost("onebot.sendMedia", [chatId, processedMedia, opts]);
            env.emitOutput(formatOneBotAck("[QQ] sendMedia ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "onebot",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "message_id" in sent ? (sent as { message_id?: unknown }).message_id : undefined,
                text: opts?.caption ?? "[media]",
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendFile: async (chatId: string, filePath: string, opts?: { replyTo?: string | number; caption?: string; fileName?: string }) => {
            const fileText = opts?.caption ?? `[file:${filePath}]`;
            if (isDuplicate(String(chatId), fileText)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的文件消息已重复，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "onebot",
                    chatId: String(chatId),
                    text: fileText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }

            const absFilePath = typeof filePath === "string" ? String(resolveLocalFile(filePath)) : filePath;
            const sent = await env.callHost("onebot.sendFile", [chatId, absFilePath, opts]);
            env.emitOutput(formatOneBotAck("[QQ] sendFile ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "onebot",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "message_id" in sent ? (sent as { message_id?: unknown }).message_id : undefined,
                text: opts?.caption ?? `[file:${filePath}]`,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendSticker: async (chatId: string, sticker: string | Record<string, unknown>, opts?: { replyTo?: string | number; caption?: string }) => {
            const stickerText = opts?.caption ?? (typeof sticker === "string" ? `[sticker:${sticker}]` : "[sticker]");
            if (isDuplicate(String(chatId), stickerText)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的表情包消息已重复，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "onebot",
                    chatId: String(chatId),
                    text: stickerText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            const processedSticker = typeof sticker === "string"
                ? sticker
                : { ...sticker, file: resolveLocalFile((sticker as Record<string, unknown>).file) };
            const sent = await env.callHost("onebot.sendSticker", [chatId, processedSticker, opts]);
            env.emitOutput(formatOneBotAck("[QQ] sendSticker ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "onebot",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "message_id" in sent ? (sent as { message_id?: unknown }).message_id : undefined,
                text: stickerText,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendFace: async (chatId: string, faceId: string | number, opts?: { replyTo?: string | number; text?: string }) => {
            const text = `[face:${String(faceId)}]${opts?.text ? ` ${opts.text}` : ""}`;
            if (isDuplicate(String(chatId), text)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 chat=${String(chatId)} 的 QQ 表情消息已重复，已自动拦截。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "onebot",
                    chatId: String(chatId),
                    text,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            const sent = await env.callHost("onebot.sendFace", [chatId, String(faceId), opts]);
            env.emitOutput(formatOneBotAck("[QQ] sendFace ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "onebot",
                chatId: String(chatId),
                messageId: typeof sent === "object" && sent && "message_id" in sent ? (sent as { message_id?: unknown }).message_id : undefined,
                text,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendTyping: async (_chatId: string) => {
            // OneBot 没有 typing 指示，静默忽略
        },
        deleteMessages: async (chatId: string, messageIds: (string | number)[]) => {
            await env.callHost("onebot.deleteMessages", [chatId, messageIds]);
            env.emitOutput(`[QQ] deleteMessages ok chat=${String(chatId)} ids=[${messageIds.join(",")}]`);
        },
        downloadMedia: async (mediaRef: string) => {
            return env.callHost("onebot.downloadMedia", [mediaRef]);
        },
    };
}
