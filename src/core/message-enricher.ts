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
    const attachments = parseMediaAttachments(messages, options.chatId);

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
 * 格式：[时间] [msgId:xxx] 发送者 (↩ reply to xxx): 消息文本 + 媒体标签
 */
export function formatMessageLine(
    m: RawMessage,
    options?: { includeMediaTags?: boolean },
): string {
    const replyTag = m.replyTo ? ` (↩ reply to ${m.replyTo})` : "";
    let textPart = m.text ?? "";

    // 如果没有 processedMedia（未经 vision 处理）但有 mediaType，追加媒体标签
    if (options?.includeMediaTags && (!m.processedMedia || m.processedMedia.length === 0) && m.mediaType) {
        const tag = mediaTagFromType(m.mediaType, m.mediaInfo);
        if (tag) textPart = textPart ? `${textPart} ${tag}` : tag;
    }

    return `[${formatTsForDisplay(m.timestamp) ?? ""}] [msgId:${m.id ?? "?"}] ${m.sender ?? "?"}${replyTag}: ${textPart}`;
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
    const lines = messages.map((m) => {
        let textPart = m.text ?? "";

        // 注入媒体描述（从 processedMedia）
        if (m.processedMedia && m.processedMedia.length > 0) {
            for (const pm of m.processedMedia) {
                if (pm.base64Data && pm.mimeType) {
                    // 路径 A: 收集 base64 图片，追加带序号的标签
                    imageParts.push({
                        url: `data:${pm.mimeType};base64,${pm.base64Data}`,
                    });
                    textPart = textPart ? `${textPart} [📷 图片${imageParts.length}]` : `[📷 图片${imageParts.length}]`;
                } else if (pm.description) {
                    // 路径 B/C: 文本描述
                    textPart = textPart ? `${textPart} [📷 图片描述: ${pm.description}]` : `[📷 图片描述: ${pm.description}]`;
                }
            }
        }

        // 使用共享的 formatMessageLine，但 textPart 已处理过，直接构建
        // 如果有 processedMedia 就不再追加 mediaTag（已处理），否则追加 mediaTag 作兜底
        const hasProcessedMedia = m.processedMedia && m.processedMedia.length > 0;
        if (!hasProcessedMedia && m.mediaType) {
            const tag = mediaTagFromType(m.mediaType, m.mediaInfo);
            if (tag) textPart = textPart ? `${textPart} ${tag}` : tag;
        }

        const replyTag = m.replyTo ? ` (↩ reply to ${m.replyTo})` : "";
        return `[${formatTsForDisplay(m.timestamp) ?? ""}] [msgId:${m.id ?? "?"}] ${m.sender ?? "?"}${replyTag}: ${textPart}`;
    });

    return lines.join("\n") || "(无目标消息原文)";
}
