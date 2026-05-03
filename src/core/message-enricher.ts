/**
 * message-enricher.ts — 通用消息富化管线
 *
 * 从 code-act-executor.ts 提取的消息处理逻辑，通用化为独立管线。
 * 负责：
 * - 从 raw messages 中解析媒体附件
 * - 调用 Vision 管线处理图片/贴纸
 * - 从消息 URL 抓取 OpenGraph 元数据 + Vision 描述封面图
 * - 格式化消息文本（含 reply-to、媒体描述、链接预览）
 * - 收集 base64 图片用于多模态 LLM
 *
 * 后续扩展点：语音转写、视频帧提取、Poll 格式化等
 */

import { processMediaBatch, type MediaAttachment, type ProcessedMedia, type DownloadFn, type StickerCache } from "./vision-processor.js";
import { resolveComponentTimeout, type LLMConfig, type VisionConfig } from "./config.js";
import type { MediaDownloader } from "./media-downloader.js";
import type { ImageCatalog } from "./image-catalog.js";
import { formatTsForDisplay } from "./timezone.js";
import { createLogger } from "./logger.js";
import { extractUrls, fetchOpenGraphBatch, downloadOgImage, type OGResult } from "./opengraph.js";
import { callLLMWithFallback, type ChatMessage } from "./llm.js";

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
    /** OpenGraph 链接预览结果（由 enrichMessages 写入） */
    ogPreviews?: OGPreview[];
}

/** 单条 URL 的 OpenGraph 预览信息 */
export interface OGPreview {
    url: string;
    title?: string;
    description?: string;
    siteName?: string;
    /** Vision 描述的封面图内容 */
    imageDescription?: string;
    /** 封面图 base64 数据（path A 时内联给 LLM） */
    imageBase64?: string;
    imageMimeType?: string;
}

/** 富化选项 */
export interface EnrichOptions {
    /** Vision 配置 */
    visionConfig?: VisionConfig;
    /** 主模型 LLM 配置（检查 vision:true） */
    llmConfig: LLMConfig;
    /** 独立 Vision tier LLM 配置 */
    visionLlmConfig?: LLMConfig | LLMConfig[];
    /** 媒体下载函数（委托给 adapter） */
    downloadFn?: DownloadFn;
    /** Sticker 缓存 */
    stickerCache?: StickerCache;
    /** 所属群组 chatId（fallback，当 message 自身无 chatId 时使用） */
    chatId?: string;
    /** 媒体下载管理器（可选，启用后保存文件到磁盘） */
    mediaDownloader?: MediaDownloader;
    /** 图片目录（可选，启用后追踪图片频率用于表情包检测） */
    imageCatalog?: ImageCatalog;
    /** 仅处理指定类型的媒体（如 ["sticker"]），未指定时处理所有类型 */
    mediaTypes?: Array<"photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other">;
    /** 是否启用 URL OpenGraph 预览（默认 true） */
    enableOgPreview?: boolean;
    /** 强制走文本描述路径，不内联图片到主 LLM（attend describe 模式使用） */
    forceTextDescriptions?: boolean;
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
                Array.isArray(options.visionLlmConfig) ? options.visionLlmConfig : options.visionLlmConfig ? [options.visionLlmConfig] : undefined,
                options.downloadFn,
                options.stickerCache,
                options.mediaDownloader,
                options.imageCatalog,
                { forceTextDescriptions: options.forceTextDescriptions },
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

    // ─── 2.5 OpenGraph URL 预览 ───
    if (options.enableOgPreview !== false) {
        try {
            await enrichWithOpenGraph(messages, options);
        } catch (err) {
            log.warn("OG 预览富化失败，继续", { chatId: options.chatId, error: String(err) });
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
        case "audio": return "[🎙 语音/音频]";
        case "document": return "[📎 文件]";
        case "other": return "[📎 媒体]";
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
        ? `: "${m.replyToText.length > 500 ? m.replyToText.slice(0, 500) + "…(已截断，请手动fetch完整消息)" : m.replyToText}"`
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
        visionLlmConfig?: LLMConfig | LLMConfig[];
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
            const emojiCandidates = cached.emojis?.length ? cached.emojis : [info.emoji as string | undefined].filter(Boolean) as string[];
            const emoji = emojiCandidates.length ? `${emojiCandidates.join(" ")} ` : "";
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
                Array.isArray(deps.visionLlmConfig) ? deps.visionLlmConfig : deps.visionLlmConfig ? [deps.visionLlmConfig] : undefined,
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
                url: info.url,
                emoji: info.emoji,
                mimeType: info.mimeType,
                fileName: info.fileName,
                filePath: info.filePath,
                width: info.width,
                height: info.height,
                fileSize: info.fileSize,
                downloadStatus: info.downloadStatus,
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
export function formatMessages(
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
            textPart = textPart.replace(/\[(?:📷 图片|🎭 贴纸[^\]]*|📹 视频|🎙 语音\/音频|🎬 (?:视频|GIF)|🎞 GIF|📎 (?:文件|媒体))\]\s*/g, "").trim();

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
                    const mediaText = pm.description.startsWith("[")
                        ? `${pm.description} 文件: ${pm.filePath}`
                        : `[📷 图片描述: ${pm.description}] 文件: ${pm.filePath}`;
                    textPart = textPart ? `${textPart} ${mediaText}` : mediaText;
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

        // ─── 注入 OpenGraph 链接预览 ───
        if (m.ogPreviews && m.ogPreviews.length > 0) {
            for (const og of m.ogPreviews) {
                const parts: string[] = [];
                if (og.title) parts.push(og.title);
                if (og.description) {
                    // 截断过长的描述
                    const desc = og.description.length > 150
                        ? og.description.slice(0, 150) + "…"
                        : og.description;
                    parts.push(desc);
                }
                if (og.imageDescription) {
                    parts.push(`封面: ${og.imageDescription}`);
                }
                if (og.imageBase64 && og.imageMimeType) {
                    imageParts.push({
                        url: `data:${og.imageMimeType};base64,${og.imageBase64}`,
                    });
                    parts.push(`[🖼 封面图${imageParts.length}]`);
                }
                const sitePrefix = og.siteName ? `${og.siteName}: ` : "";
                const previewText = `[🔗 链接预览: ${sitePrefix}${parts.join(" — ")}]`;
                textPart = textPart ? `${textPart}\n  ${previewText}` : previewText;
            }
        }

        const replyTag = buildReplyTag(m);
        lines.push(`[${formatTsForDisplay(m.timestamp) ?? ""}] [msgId:${m.id ?? "?"}] ${m.sender ?? "?"}${replyTag}: ${textPart}`);
    }

    // ─── 最后一条消息距今时间标记 ───
    if (prevTimestamp !== undefined) {
        const nowMs = Date.now();
        const sinceMs = nowMs - prevTimestamp;
        const sinceMin = Math.round(sinceMs / 60_000);
        if (sinceMin >= 1) {
            const label = sinceMin >= 60
                ? `${Math.floor(sinceMin / 60)} 小时${sinceMin % 60 > 0 ? ` ${sinceMin % 60} 分钟` : ""}`
                : `${sinceMin} 分钟`;
            lines.push(`--- (距今 ${label}) ---`);
        }
    }

    return lines.join("\n") || "(无目标消息原文)";
}

// ─── OpenGraph 富化内部函数 ───

/** OG 封面图 Vision 描述缓存: imageUrl → { description, base64?, mimeType? } */
const ogImageDescriptionCache = new Map<string, { description?: string; base64?: string; mimeType?: string }>();
const OG_IMAGE_CACHE_MAX = 200;


/**
 * 对消息中的 URL 进行 OpenGraph 元数据抓取 + 封面图 Vision 描述
 */
async function enrichWithOpenGraph(
    messages: RawMessage[],
    options: EnrichOptions,
): Promise<void> {
    // 1. 收集所有 URL
    const urlsByMsgIndex = new Map<number, string[]>();
    const allUrls: string[] = [];
    for (let i = 0; i < messages.length; i++) {
        const text = messages[i].text;
        if (!text) continue;
        const urls = extractUrls(text);
        if (urls.length > 0) {
            urlsByMsgIndex.set(i, urls);
            allUrls.push(...urls);
        }
    }
    if (allUrls.length === 0) return;

    log.info("OG 预览开始", { urlCount: allUrls.length, chatId: options.chatId });

    // 2. 批量抓取 OG 元数据
    const ogResults = await fetchOpenGraphBatch(allUrls);
    if (ogResults.size === 0) {
        log.debug("无有效 OG 结果");
        return;
    }

    // 3. 确定 Vision 配置
    const isPathA = options.llmConfig.vision === true;
    const visionLlmConfigs = Array.isArray(options.visionLlmConfig)
        ? options.visionLlmConfig
        : options.visionLlmConfig
            ? [options.visionLlmConfig]
            : (isPathA ? [options.llmConfig] : undefined);

    // 4. 对有封面图的 OG 结果进行 Vision 描述 + 下载
    const imageDescriptions = new Map<string, { description?: string; base64?: string; mimeType?: string }>();
    const imageUrls = [...ogResults.values()]
        .filter(og => og.imageUrl)
        .map(og => og.imageUrl!);
    const uniqueImageUrls = [...new Set(imageUrls)];

    if (uniqueImageUrls.length > 0 && visionLlmConfigs?.length) {
        const imageTasks = uniqueImageUrls.map(async (imageUrl) => {
            // 缓存命中
            const cached = ogImageDescriptionCache.get(imageUrl);
            if (cached) {
                log.debug("OG 封面图 Vision 缓存命中", { imageUrl });
                imageDescriptions.set(imageUrl, {
                    description: cached.description,
                    // Path A: 需要 base64 时从缓存取（缓存可能在非 Path A 下写入，此时无 base64）
                    base64: isPathA ? cached.base64 : undefined,
                    mimeType: isPathA ? cached.mimeType : undefined,
                });
                return;
            }

            const downloaded = await downloadOgImage(imageUrl);
            if (!downloaded) return;

            try {
                // Vision 描述封面图
                const b64 = downloaded.buffer.toString("base64");
                const dataUri = `data:${downloaded.mimeType};base64,${b64}`;
                const visionMessages: ChatMessage[] = [
                    {
                        role: "user",
                        content: "这是一个网页链接的 OpenGraph 封面图。请用一句话简短描述图片内容。",
                        imageParts: [{ url: dataUri }],
                    },
                ];
                const response = await callLLMWithFallback(visionMessages, visionLlmConfigs, { caller: "og-vision", timeoutMs: resolveComponentTimeout("vision") });
                const description = response.content.trim();

                const entry = {
                    description,
                    base64: b64,
                    mimeType: downloaded.mimeType,
                };

                // 写入缓存（LRU 淘汰）
                if (ogImageDescriptionCache.size >= OG_IMAGE_CACHE_MAX) {
                    const firstKey = ogImageDescriptionCache.keys().next().value;
                    if (firstKey) ogImageDescriptionCache.delete(firstKey);
                }
                ogImageDescriptionCache.set(imageUrl, entry);

                imageDescriptions.set(imageUrl, {
                    description,
                    base64: isPathA ? b64 : undefined,
                    mimeType: isPathA ? downloaded.mimeType : undefined,
                });
            } catch (err) {
                log.debug("OG 封面图 Vision 描述失败", { imageUrl, error: String(err).slice(0, 200) });
            }
        });
        await Promise.allSettled(imageTasks);
    }

    // 5. 将 OG 结果写回 messages
    for (const [msgIdx, urls] of urlsByMsgIndex) {
        const previews: OGPreview[] = [];
        for (const url of urls) {
            const og = ogResults.get(url);
            if (!og) continue;

            const imgInfo = og.imageUrl ? imageDescriptions.get(og.imageUrl) : undefined;
            previews.push({
                url: og.url,
                title: og.title,
                description: og.description,
                siteName: og.siteName,
                imageDescription: imgInfo?.description,
                imageBase64: imgInfo?.base64,
                imageMimeType: imgInfo?.mimeType,
            });
        }
        if (previews.length > 0) {
            messages[msgIdx].ogPreviews = previews;
        }
    }

    log.info("OG 预览完成", {
        fetched: ogResults.size,
        imagesDescribed: imageDescriptions.size,
        chatId: options.chatId,
    });
}
