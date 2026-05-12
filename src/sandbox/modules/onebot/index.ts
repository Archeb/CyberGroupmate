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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadBuiltinGuideContent } from "../../builtin-guides.js";

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

function bufferFromHostDownload(result: unknown): Buffer {
    if (Buffer.isBuffer(result)) return result;
    if (result && typeof result === "object") {
        const rec = result as Record<string, unknown>;
        if (typeof rec.buffer === "string") {
            return Buffer.from(rec.buffer, "base64");
        }
        if (rec.type === "Buffer" && Array.isArray(rec.data)) {
            return Buffer.from(rec.data as number[]);
        }
        if (Array.isArray(rec.data)) {
            return Buffer.from(rec.data as number[]);
        }
    }
    throw new Error(`onebot.downloadMedia: unexpected host result type ${typeof result}`);
}

function inferExt(buffer: Buffer): string {
    if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return ".webp";
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ".jpg";
    if (buffer.length >= 6 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")) return ".gif";
    if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "%PDF") return ".pdf";
    if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") return ".ogg";
    if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return ".mp4";
    return ".bin";
}

function saveDownloadedMedia(mediaRef: string, buffer: Buffer): string {
    const dir = pathResolve(process.cwd(), "Downloads");
    mkdirSync(dir, { recursive: true });
    const hash = createHash("sha1").update(mediaRef).update(buffer).digest("hex").slice(0, 16);
    const safeRef = mediaRef.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "media";
    const relPath = `Downloads/onebot_${safeRef}_${hash}${inferExt(buffer)}`;
    const absPath = pathResolve(process.cwd(), relPath);
    if (!existsSync(absPath)) {
        writeFileSync(absPath, buffer);
    }
    return relPath;
}

// ─── OneBot 客户端代理 ───

export function createOneBotClientProxy(
    env: CapabilityRegistryEnv,
    sentHistory: Map<string, Set<string>>,
    deduplicateSentMessages = true,
) {
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

    function useOneBotGuide(methodName: string): string {
        const content = loadBuiltinGuideContent("onebot", methodName);
        if (!content) throw new Error(`OneBot guide not found: ${methodName}`);
        const wrapped = `\n═══ [OneBotGuide: ${methodName}] ═══\n${content}\n═══ [/OneBotGuide: ${methodName}] ═══\n`;
        env.emitOutput(wrapped);
        return wrapped;
    }

    return {
        useMessages: async () => useOneBotGuide("useMessages"),
        useGroupAdministration: async () => useOneBotGuide("useGroupAdministration"),
        useFiles: async () => useOneBotGuide("useFiles"),
        useUsersAndProfile: async () => useOneBotGuide("useUsersAndProfile"),
        useSystemUtilities: async () => useOneBotGuide("useSystemUtilities"),

        getMessage: async (messageId: string | number) => {
            const id = String(messageId ?? "").trim();
            if (!id) throw new Error("onebot.getMessage: messageId is required");
            const result = await env.callHost("onebot.getMessage", [id]);
            env.emitOutput(`[QQ] getMessage ok msg=${id}`);
            return result;
        },

        sendText: async (chatId: string, text: string, opts?: { replyTo?: string | number }) => {
            if (shouldBlockDuplicate(String(chatId), text)) {
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
            recordSentIfDedupEnabled(String(chatId), text);
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
            if (shouldBlockDuplicate(String(chatId), mediaText)) {
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
            recordSentIfDedupEnabled(String(chatId), mediaText);
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
            if (shouldBlockDuplicate(String(chatId), fileText)) {
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
            recordSentIfDedupEnabled(String(chatId), fileText);
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
            const stickerText = opts?.caption ?? (
                typeof sticker === "string"
                    ? `[sticker:${sticker}]`
                    : `[sticker:${(sticker as Record<string, unknown>).uniqueFileId ?? (sticker as Record<string, unknown>).file ?? "unknown"}]`
            );
            if (shouldBlockDuplicate(String(chatId), stickerText)) {
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
            recordSentIfDedupEnabled(String(chatId), stickerText);
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
            if (shouldBlockDuplicate(String(chatId), text)) {
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
            recordSentIfDedupEnabled(String(chatId), text);
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
        downloadMedia: async (mediaRef: string | number) => {
            const ref = String(mediaRef ?? "").trim();
            if (!ref) throw new Error("onebot.downloadMedia: mediaRef is required");
            const result = await env.callHost("onebot.downloadMedia", [ref]);
            if (typeof result === "string") return result;
            const buffer = bufferFromHostDownload(result);
            const localPath = saveDownloadedMedia(ref, buffer);
            env.emitOutput(`[QQ] downloadMedia ok file=${localPath}`);
            return localPath;
        },
        callApi: async (action: string, params?: Record<string, unknown>) => {
            const normalizedAction = String(action ?? "").trim().replace(/^\/+/, "");
            if (!normalizedAction) throw new Error("onebot.callApi: action is required");
            const result = await env.callHost("onebot.callApi", [normalizedAction, params ?? {}]);
            env.emitOutput(`[QQ] callApi ok action=${normalizedAction}`);
            return result;
        },
    };
}
