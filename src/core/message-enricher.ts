/**
 * message-enricher.ts — 通用消息富化管线
 *
 * 从 code-act-executor.ts 提取的消息处理逻辑，通用化为独立管线。
 * 负责：
 * - 从 raw messages 中解析媒体附件
 * - 调用 Vision 管线处理图片/贴纸
 * - 格式化消息文本（含 reply-to、媒体描述）
 * - 收集 base64 图片用于多模态 LLM
 *
 * 后续扩展点：语音转写、视频帧提取、Poll 格式化等
 */

import { processMediaBatch, type MediaAttachment, type ProcessedMedia, type DownloadFn, type StickerCache } from "./vision-processor.js";
import type { LLMConfig, VisionConfig } from "./config.js";
import type { MediaDownloader } from "./media-downloader.js";
import { formatTsForDisplay } from "./timezone.js";
import { createLogger } from "./logger.js";

const log = createLogger("message-enricher");

// ─── 输入/输出类型 ───

/** 从 recentMessages 传入的原始消息 */
export interface RawMessage {
    id?: string;
    sender?: string;
    text?: string;
    timestamp?: string;
    replyTo?: string;
    /** 被回复消息的原始 message ID（用于在 reply tag 中标注 #msgId） */
    replyToMsgId?: string;
    /** 被回复消息的原文摘要（当被回复消息不在上下文中时填充） */
    replyToText?: string;
    mediaType?: string;
    /** JSON string from memory（含 fileId, uniqueFileId, type, emoji 等） */
    mediaInfo?: string;
    /** 所属群组 ID（用于 file reference refetch） */
    chatId?: string;
    /** 任意已处理的媒体结果（由 enrichMessages 写入） */
    processedMedia?: ProcessedMedia[];
}

/** 富化选项 */
export interface EnrichOptions {
    /** Vision 配置 */
    visionConfig?: VisionConfig;
    /** 主模型 LLM 配置（检查 vision:true） */
    llmConfig: LLMConfig;
    /** 独立 Vision tier LLM 配置 */
    visionLlmConfig?: LLMConfig;
    /** 媒体下载函数（委托给 adapter） */
    downloadFn?: DownloadFn;
    /** Sticker 缓存 */
    stickerCache?: StickerCache;
    /** 所属群组 chatId（fallback，当 message 自身无 chatId 时使用） */
    chatId?: string;
    /** 媒体下载管理器（可选，启用后保存文件到磁盘） */
    mediaDownloader?: MediaDownloader;
    /** 仅处理指定类型的媒体（如 ["sticker"]），未指定时处理所有类型 */
    mediaTypes?: Array<"photo" | "sticker" | "video" | "document" | "animation" | "other">;
}

/** 富化结果 */
export interface EnrichedResult {
    /** 格式化后的消息文本（多行，每条一行） */
    formattedText: string;
    /** 路径 A: 收集到的 base64 图片 data URI（用于多模态 LLM） */
    imageParts: Array<{ url: string }>;
}

// ─── 核心函数 ───

/**
 * 富化一组原始消息：解析媒体 → Vision 处理 → 格式化文本
 *
 * @param messages  从 memory/recentMessages 获取的原始消息列表
 * @param options   富化选项（Vision 配置、下载函数等）
 * @returns         格式化后的文本 + base64 图片列表
 */
export async function enrichMessages(
    messages: RawMessage[],
    options: EnrichOptions,
): Promise<EnrichedResult> {
    // ─── 1. 从 mediaInfo 解析 MediaAttachment[] ───
    let attachments = parseMediaAttachments(messages, options.chatId);

    // mediaTypes 过滤：仅保留指定类型的媒体，其余走占位符标签
    if (options.mediaTypes) {
        const allowed = new Set(options.mediaTypes);
        attachments = attachments.filter(a => allowed.has(a.type));
    }

    // ─── 2. Vision 批量处理 ───
    if (attachments.length > 0) {
        log.info("媒体富化开始", { count: attachments.length, chatId: options.chatId });
        try {
            const processed = await processMediaBatch(
                attachments,
                options.visionConfig,
                options.llmConfig,
                options.visionLlmConfig,
                options.downloadFn,
                options.stickerCache,
                options.mediaDownloader,
            );
            // 将处理结果写回 messages
            for (const pm of processed) {
                if (pm.index >= 0 && pm.index < messages.length) {
                    const m = messages[pm.index];
                    if (!m.processedMedia) m.processedMedia = [];
                    m.processedMedia.push(pm);
                }
            }
            log.info("媒体富化完成", { processed: processed.length, chatId: options.chatId });
        } catch (err) {
            log.warn("媒体富化失败，继续使用占位符", { chatId: options.chatId, error: String(err) });
        }
    }

    // ─── 3. 格式化消息文本 ───
    const imageParts: Array<{ url: string }> = [];
    const formattedText = formatMessages(messages, imageParts);

    return { formattedText, imageParts };
}

// ─── 共享格式化函数 ───

/**
 * 根据 mediaType/mediaInfo 生成媒体类型标签（无 vision 处理，纯文本标记）
 *
 * 用于 attend-handler 等不做图片识别的场景，让 LLM 知道消息附带了什么类型的媒体。
 */
function mediaTagFromType(mediaType?: string, mediaInfo?: string): string {
    if (!mediaType) return "";
    let emoji = "";
    try {
        if (mediaInfo) {
            const info = JSON.parse(mediaInfo);
            emoji = info.emoji ?? "";
        }
    } catch { /* ignore */ }
    switch (mediaType) {
        case "photo": return "[📷 图片]";
        case "sticker": return emoji ? `[🎭 贴纸: ${emoji}]` : "[🎭 贴纸]";
        case "video": return "[📹 视频]";
        case "animation": return "[🎬 GIF]";
        case "document": return "[📎 文件]";
        default: return `[📎 ${mediaType}]`;
    }
}

/**
 * 格式化单条消息为文本行
 *
 * 统一的消息格式化入口，供 attend-handler 和 enrichMessages 共用。
 * - includeMediaTags: 当消息无 processedMedia 但有 mediaType 时，自动追加媒体标签
 *   （attend-handler 设 true；enrichMessages 流程中已有 processedMedia 处理，也设 true 作兜底）
 *
 * 格式：[时间] [msgId:xxx] 发送者 (↩ reply to xxx #msgId): 消息文本 + 媒体标签
 * 当被回复消息不在上下文中且有 replyToText 时，追加原文摘要
 */
export function formatMessageLine(
    m: RawMessage,
    options?: { includeMediaTags?: boolean },
): string {
    const replyTag = buildReplyTag(m);
    let textPart = m.text ?? "";

    // 如果没有 processedMedia（未经 vision 处理）但有 mediaType，追加媒体标签
    // 注意：Telegram adapter 可能已在 event.text 中设置了媒体标签（如 "[🎭 贴纸: 👀]"），
    // 此时不再重复追加
    if (options?.includeMediaTags && (!m.processedMedia || m.processedMedia.length === 0) && m.mediaType) {
        const tag = mediaTagFromType(m.mediaType, m.mediaInfo);
        if (tag && !textPart.includes(tag)) {
            textPart = textPart ? `${textPart} ${tag}` : tag;
        }
    }

    return `[${formatTsForDisplay(m.timestamp) ?? ""}] [msgId:${m.id ?? "?"}] ${m.sender ?? "?"}${replyTag}: ${textPart}`;
}

/**
 * 构建 reply tag 文本
 *
 * - 有 replyTo: (↩ reply to NAME #MSGID)
 * - 有 replyToText（不在上下文）: (↩ reply to NAME #MSGID: "原文摘要")
 * - 无 replyTo: 空字符串
 */
function buildReplyTag(m: RawMessage): string {
    if (!m.replyTo) return "";
    const msgIdSuffix = m.replyToMsgId ? ` #${m.replyToMsgId}` : "";
    const textSuffix = m.replyToText
        ? `: "${m.replyToText.length > 200 ? m.replyToText.slice(0, 200) + "…" : m.replyToText}"`
        : "";
    return ` (↩ reply to ${m.replyTo}${msgIdSuffix}${textSuffix})`;
}

/**
 * 解析不在上下文中的被回复消息的文本/媒体描述
 *
 * 优先级：
 * 1. 原消息文本（如有）
 * 2. 贴纸缓存描述（sticker_descriptions 表）
 * 3. Vision 处理（如有 vision 依赖，下载并识别图片/贴纸）
 * 4. 媒体类型标签 fallback（如 [📷 图片]）
 */
export async function resolveReplyText(
    origMsg: { text?: string; mediaType?: string; mediaInfo?: string },
    deps?: {
        stickerCache?: StickerCache;
        visionConfig?: VisionConfig;
        llmConfig?: LLMConfig;
        visionLlmConfig?: LLMConfig;
        downloadFn?: DownloadFn;
        chatId?: string;
    },
): Promise<string | undefined> {
    // 1. 有文本 → 直接返回
    if (origMsg.text) return origMsg.text;

    // 2. 无媒体 → 无内容
    if (!origMsg.mediaType) return undefined;
    if (!origMsg.mediaInfo) return mediaTagFromType(origMsg.mediaType);

    // 3. 解析 mediaInfo
    let info: Record<string, unknown>;
    try {
        info = JSON.parse(origMsg.mediaInfo);
    } catch {
        return mediaTagFromType(origMsg.mediaType, origMsg.mediaInfo);
    }

    // 4. 贴纸：优先查缓存
    if (origMsg.mediaType === "sticker" && deps?.stickerCache && info.uniqueFileId) {
        const cached = deps.stickerCache.getStickerDescription(info.uniqueFileId as string);
        if (cached) {
            const emoji = (info.emoji as string) ? `${info.emoji} ` : "";
            return `[🎭 贴纸: ${emoji}${cached.description}]`;
        }
    }

    // 5. Vision 处理（photo/sticker/animation 等有 fileId 的媒体）
    if (deps?.visionConfig && deps?.llmConfig && deps?.downloadFn && info.fileId) {
        try {
            const attachment: MediaAttachment = {
                type: ((info.type as string) ?? origMsg.mediaType) as MediaAttachment["type"],
                fileId: info.fileId as string,
                uniqueFileId: (info.uniqueFileId as string) ?? (info.fileId as string),
                emoji: info.emoji as string | undefined,
                mimeType: info.mimeType as string | undefined,
                fileName: info.fileName as string | undefined,
                width: info.width as number | undefined,
                height: info.height as number | undefined,
                fileSize: info.fileSize as number | undefined,
                messageIndex: 0,
                chatId: deps.chatId,
            };
            const processed = await processMediaBatch(
                [attachment],
                deps.visionConfig,
                deps.llmConfig,
                deps.visionLlmConfig,
                deps.downloadFn,
                deps.stickerCache,
            );
            if (processed.length > 0) {
                const pm = processed[0];
                if (pm.description) {
                    return `[📷 ${pm.description}]`;
                }
            }
        } catch (err) {
            log.debug("resolveReplyText: vision 处理失败", { error: String(err) });
        }
    }

    // 6. Fallback: 媒体类型标签
    return mediaTagFromType(origMsg.mediaType, origMsg.mediaInfo);
}

// ─── 内部函数 ───

/**
 * 从 rawMessages 的 mediaInfo JSON 中解析出 MediaAttachment 列表
 */
function parseMediaAttachments(messages: RawMessage[], fallbackChatId?: string): MediaAttachment[] {
    const attachments: MediaAttachment[] = [];

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m.mediaInfo) continue;

        try {
            const info = JSON.parse(m.mediaInfo);
            if (!info.fileId || !info.type) continue;

            attachments.push({
                type: info.type,
                fileId: info.fileId,
                uniqueFileId: info.uniqueFileId ?? info.fileId,
                emoji: info.emoji,
                mimeType: info.mimeType,
                fileName: info.fileName,
                width: info.width,
                height: info.height,
                fileSize: info.fileSize,
                messageIndex: i,
                // file reference refetch 所需的上下文
                chatId: m.chatId ?? fallbackChatId,
                messageId: m.id,
            });
        } catch {
            /* mediaInfo JSON 解析失败，跳过 */
        }
    }

    return attachments;
}

/**
 * 格式化消息列表为文本，同时收集 base64 imageParts
 *
 * 每条消息格式：[时间] [msgId:xxx] 发送者 (↩ reply to xxx): 消息文本 + 媒体描述
 */
function formatMessages(
    messages: RawMessage[],
    imageParts: Array<{ url: string }>,
): string {
    const lines: string[] = [];
    let prevTimestamp: number | undefined;

    for (const m of messages) {
        // ─── 时间间隔感知：间隔超过 30 分钟时插入分隔行 ───
        if (m.timestamp) {
            const curTs = new Date(m.timestamp).getTime();
            if (!isNaN(curTs)) {
                if (prevTimestamp !== undefined) {
                    const gapMs = curTs - prevTimestamp;
                    const gapMin = Math.round(gapMs / 60_000);
                    if (gapMin >= 30) {
                        const label = gapMin >= 60
                            ? `${Math.floor(gapMin / 60)} 小时${gapMin % 60 > 0 ? ` ${gapMin % 60} 分钟` : ""}后`
                            : `${gapMin} 分钟后`;
                        lines.push(`--- (${label}) ---`);
                    }
                }
                prevTimestamp = curTs;
            }
        }

        let textPart = m.text ?? "";

        // 注入媒体描述（从 processedMedia）
        if (m.processedMedia && m.processedMedia.length > 0) {
            // 移除 adapter 层写入的媒体占位标签（如 [📷 图片]、[🎭 贴纸: 💛]、[🎬 视频] 等），
            // 避免和 vision/download 产生的更丰富描述重复
            textPart = textPart.replace(/\[(?:📷 图片|🎭 贴纸[^\]]*|📹 视频|🎬 (?:视频|GIF)|🎞 GIF|📎 (?:文件|媒体))\]\s*/g, "").trim();

            for (const pm of m.processedMedia) {
                if (pm.base64Data && pm.mimeType) {
                    // 路径 A: 收集 base64 图片，追加带序号的标签
                    imageParts.push({
                        url: `data:${pm.mimeType};base64,${pm.base64Data}`,
                    });
                    const fileHint = pm.filePath ? ` 文件: ${pm.filePath}` : "";
                    textPart = textPart ? `${textPart} [📷 图片${imageParts.length}]${fileHint}` : `[📷 图片${imageParts.length}]${fileHint}`;
                } else if (pm.filePath && pm.description) {
                    // 有文件路径 + 描述（video/document/animation 或 vision 描述的图片）
                    textPart = textPart ? `${textPart} ${pm.description} 文件: ${pm.filePath}` : `${pm.description} 文件: ${pm.filePath}`;
                } else if (pm.filePath) {
                    // 仅有文件路径
                    textPart = textPart ? `${textPart} [📎 文件: ${pm.filePath}]` : `[📎 文件: ${pm.filePath}]`;
                } else if (pm.description) {
                    // 路径 B/C: 文本描述
                    textPart = textPart ? `${textPart} [📷 图片描述: ${pm.description}]` : `[📷 图片描述: ${pm.description}]`;
                }
            }
        }

        // 如果有 processedMedia 就不再追加 mediaTag（已处理），否则追加 mediaTag 作兜底
        const hasProcessedMedia = m.processedMedia && m.processedMedia.length > 0;
        if (!hasProcessedMedia && m.mediaType) {
            const tag = mediaTagFromType(m.mediaType, m.mediaInfo);
            if (tag && !textPart.includes(tag)) {
                textPart = textPart ? `${textPart} ${tag}` : tag;
            }
        }

        const replyTag = buildReplyTag(m);
        lines.push(`[${formatTsForDisplay(m.timestamp) ?? ""}] [msgId:${m.id ?? "?"}] ${m.sender ?? "?"}${replyTag}: ${textPart}`);
    }

    return lines.join("\n") || "(无目标消息原文)";
}
