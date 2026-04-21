/**
 * vision-processor.ts — Vision 处理管线
 *
 * 协调图片下载、识别、和缓存。根据配置走三种路径：
 * - A: 原生多模态（base64 内联，≤maxImagesPerContext 张）
 * - B: Vision 辅助（调用 vision tier LLM 描述）
 * - C: 无 Vision（占位文本）
 *
 * 超出 maxImagesPerContext 张的图片一律走 B 路径描述。
 * Sticker 支持 emoji_only / vision_cache / vision_each 三种模式。
 */

import { callLLMWithFallback, type ChatMessage } from "./llm.js";
import { resolveComponentTimeout, type LLMConfig, type VisionConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { MediaDownloader } from "./media-downloader.js";

const log = createLogger("vision-processor");

// ─── 类型定义 ───

/** 待处理的媒体附件（从 message_log.media_info 解析） */
export interface MediaAttachment {
    type: "photo" | "sticker" | "video" | "document" | "animation" | "other";
    fileId: string;
    uniqueFileId: string;
    url?: string;
    emoji?: string;       // sticker only
    mimeType?: string;
    fileName?: string;
    width?: number;
    height?: number;
    fileSize?: number;
    /** 对应消息在上下文中的序号 */
    messageIndex: number;
    /** 所属群组 ID（用于 file reference refetch） */
    chatId?: string;
    /** 原始消息 ID（用于 file reference refetch） */
    messageId?: string;
}

/** 处理后的媒体结果 */
export interface ProcessedMedia {
    /** 对应 MediaAttachment 的序号 */
    index: number;
    /** 路径 A: base64 图片数据 */
    base64Data?: string;
    mimeType?: string;
    /** 路径 B/C 或溢出的图片: 文本描述 */
    description?: string;
    /** 保存到磁盘的文件路径（相对项目根） */
    filePath?: string;
}

/** Sticker 描述缓存接口 */
export interface StickerCache {
    getStickerDescription(uniqueFileId: string): { description: string; emoji?: string } | null;
    setStickerDescription(uniqueFileId: string, description: string, emoji?: string, enabled?: boolean): void;
}

/** 下载函数类型 */
export type DownloadFn = (fileId: string, chatId?: string, messageId?: string, uniqueFileId?: string) => Promise<Buffer>;

// ─── 默认配置 ───

const DEFAULT_MAX_IMAGES = 3;
const DEFAULT_MAX_IMAGE_SIZE = 1024;

/** API 支持的图片 MIME 类型 */
const SUPPORTED_MIME = new Set(["image/jpeg", "image/png"]);

/**
 * 确保图片为 API 支持的格式（JPEG/PNG）
 * 不支持的格式（如 TIFF、WebP、AVIF 等）通过 ffmpeg 转码为 PNG
 * 如果 ffmpeg 不可用，返回原始 buffer（多数 Vision API 支持 WebP）
 */
export async function ensureSupportedFormat(
    buffer: Buffer,
    mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
    if (SUPPORTED_MIME.has(mimeType)) return { buffer, mimeType };
    log.debug("转码不支持的图片格式", { from: mimeType, to: "image/png" });
    try {
        const { execFileSync } = await import("node:child_process");
        // ffmpeg: 从 stdin 读取, 输出 png 到 stdout
        const converted = execFileSync("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "image2pipe", "-i", "pipe:0",
            "-f", "image2", "-c:v", "png",
            "pipe:1",
        ], {
            input: buffer,
            maxBuffer: 20 * 1024 * 1024, // 20MB
            timeout: 10000,
        });
        return { buffer: Buffer.from(converted), mimeType: "image/png" };
    } catch (err) {
        log.warn("ffmpeg 转码失败，使用原始格式", { from: mimeType, error: String(err).slice(0, 200) });
        // 降级：直接使用原始 buffer（多数 Vision API 支持 WebP）
        return { buffer, mimeType };
    }
}

/** 图片描述内存缓存（Path B）: uniqueFileId → description */
const photoDescriptionCache = new Map<string, string>();

// ─── 核心处理函数 ───

export interface ProcessMediaBatchOptions {
    /** 强制走文本描述路径，不内联图片到主 LLM（attend describe 模式使用） */
    forceTextDescriptions?: boolean;
}

/**
 * 批量处理一组消息中的媒体附件
 *
 * @param attachments 按消息顺序排列的媒体附件列表
 * @param config Vision 配置
 * @param llmConfig 主模型配置（检查 vision:true）
 * @param visionLlmConfig 独立 vision tier 配置
 * @param downloadFn 图片下载函数（委托给 adapter）
 * @param stickerCache sticker 描述缓存
 * @param mediaDownloader 媒体下载管理器
 * @param options 额外处理选项
 */
export async function processMediaBatch(
    attachments: MediaAttachment[],
    config: VisionConfig | undefined,
    llmConfig: LLMConfig,
    visionLlmConfigs?: LLMConfig[],
    downloadFn?: DownloadFn,
    stickerCache?: StickerCache,
    mediaDownloader?: MediaDownloader,
    options?: ProcessMediaBatchOptions,
): Promise<ProcessedMedia[]> {
    const maxImages = config?.maxImagesPerContext ?? DEFAULT_MAX_IMAGES;
    const results: ProcessedMedia[] = [];

    // 分类
    const photos: MediaAttachment[] = [];
    const stickers: MediaAttachment[] = [];
    const downloadOnly: MediaAttachment[] = []; // video / document / animation — 只下载不识别

    for (const att of attachments) {
        if (att.type === "photo" || (att.type === "document" && att.mimeType?.startsWith("image/"))) {
            photos.push(att);
        } else if (att.type === "sticker") {
            // 跳过动态贴纸（WebM 视频贴纸和 TGS 动画贴纸大模型无法直接识别）
            if (att.mimeType === "video/webm" || att.mimeType === "application/x-tgsticker") {
                log.debug("跳过动态贴纸", { uniqueFileId: att.uniqueFileId, mimeType: att.mimeType });
                continue;
            }
            stickers.push(att);
        } else if (att.type === "video" || att.type === "document" || att.type === "animation") {
            downloadOnly.push(att);
        }
        // other → 跳过（保留占位文本）
    }

    // 确定处理路径
    // forceTextDescriptions=true 时强制走文本描述（attend describe 模式），不内联 base64
    const isPathA = !options?.forceTextDescriptions && llmConfig.vision === true;
    const isPathB = !isPathA && !!visionLlmConfigs?.length;
    // 如果既不是 A 也不是 B，就是 C

    // ─── 处理 Sticker（并行 + dedup） ───
    // 按 uniqueFileId 去重：相同贴纸只调用一次 Vision LLM，结果复用到所有同 ID 条目
    const stickerByUniqueId = new Map<string, MediaAttachment[]>();
    for (const sticker of stickers) {
        const key = sticker.uniqueFileId;
        const group = stickerByUniqueId.get(key) ?? [];
        group.push(sticker);
        stickerByUniqueId.set(key, group);
    }
    const stickerTasks = [...stickerByUniqueId.values()].map(async (group) => {
        const representative = group[0];
        const processed = await processSingleSticker(
            representative,
            config,
            isPathA || isPathB,
            isPathA ? [llmConfig] : visionLlmConfigs,
            downloadFn,
            stickerCache,
            mediaDownloader,
        );
        // 复用结果到同 uniqueFileId 的所有条目（修正 messageIndex）
        return group.map(s => s === representative
            ? processed
            : { ...processed, index: s.messageIndex },
        );
    });
    const stickerResults = (await Promise.all(stickerTasks)).flat();
    results.push(...stickerResults);

    // ─── 处理 Photo（并行） ───
    // 先分类：前 maxImages 张走路径 A（内联），其余走路径 B（描述）或 C（占位）
    // 描述结果按 uniqueFileId 缓存，避免重复 vision LLM 调用
    // 路径 B 下载的原始 buffer 暂存（用于后续保存到磁盘）
    const pathBBuffers = new Map<string, { buffer: Buffer; mimeType: string }>();

    const photoTasks: Array<Promise<ProcessedMedia>> = photos.map((photo, i) => {
        const shouldInline = isPathA && i < maxImages && downloadFn;
        const canDescribe = (isPathA || isPathB) && downloadFn;

        /** 带缓存的图片描述：先查缓存，miss 时下载+LLM 描述并写入缓存 */
        const describeWithCache = async (visionCfgs: LLMConfig[]): Promise<ProcessedMedia> => {
            // 缓存命中
            const cached = photoDescriptionCache.get(photo.uniqueFileId);
            if (cached) {
                log.debug("图片描述缓存命中", { uniqueFileId: photo.uniqueFileId });
                return { index: photo.messageIndex, description: cached };
            }
            // 缓存未命中：下载 + 转码 + LLM 描述
            const rawBuffer = await downloadFn!(photo.fileId, photo.chatId, photo.messageId, photo.uniqueFileId);
            const { buffer, mimeType } = await ensureSupportedFormat(rawBuffer, photo.mimeType ?? "image/jpeg");
            const desc = await describeImage(buffer, mimeType, visionCfgs);
            photoDescriptionCache.set(photo.uniqueFileId, desc);
            // 暂存原始 buffer 供后续保存到磁盘
            pathBBuffers.set(photo.uniqueFileId, { buffer: rawBuffer, mimeType: photo.mimeType ?? "image/jpeg" });
            return { index: photo.messageIndex, description: desc };
        };

        if (shouldInline) {
            // 路径 A: 内联 base64（不缓存，每次需要完整数据）
            return downloadFn!(photo.fileId, photo.chatId, photo.messageId, photo.uniqueFileId)
                .then(rawBuffer => ensureSupportedFormat(rawBuffer, photo.mimeType ?? "image/jpeg"))
                .then(({ buffer, mimeType }) => ({
                    index: photo.messageIndex,
                    base64Data: buffer.toString("base64"),
                    mimeType,
                } as ProcessedMedia))
                .catch(err => {
                    log.warn("路径 A 下载/转码失败，降级为描述", { fileId: photo.fileId, error: String(err) });
                    if (canDescribe) {
                        const visionCfgs = isPathA ? [llmConfig] : visionLlmConfigs!;
                        return describeWithCache(visionCfgs).catch(err2 => {
                            log.warn("降级描述也失败", { fileId: photo.fileId, error: String(err2) });
                            return { index: photo.messageIndex, description: "[📷 图片（加载失败）]" } as ProcessedMedia;
                        });
                    }
                    return { index: photo.messageIndex, description: "[📷 图片（加载失败）]" } as ProcessedMedia;
                });
        }

        if (canDescribe) {
            // 路径 A 溢出 或 路径 B: 调用 vision LLM 描述（带缓存）
            const visionCfgs = isPathA ? [llmConfig] : visionLlmConfigs!;
            return describeWithCache(visionCfgs).catch(err => {
                log.warn("Vision 描述失败，使用占位符", { fileId: photo.fileId, error: String(err) });
                return { index: photo.messageIndex, description: "[📷 图片（加载失败）]" } as ProcessedMedia;
            });
        }

        // 路径 C 或无下载能力
        return Promise.resolve({
            index: photo.messageIndex,
            description: "[📷 图片（不支持查看）]",
        } as ProcessedMedia);
    });

    const photoResults = await Promise.all(photoTasks);
    results.push(...photoResults);

    // ─── 保存 photo/sticker 到磁盘（如果有 mediaDownloader） ───
    if (mediaDownloader && downloadFn) {
        for (const pm of results) {
            if (pm.filePath) continue; // 已保存
            // 找到对应的 attachment
            const att = attachments.find(a => a.messageIndex === pm.index);
            if (!att) continue;
            // 已有文件则跳过
            const existing = mediaDownloader.getExistingPath(att.uniqueFileId);
            if (existing) {
                pm.filePath = existing;
                continue;
            }
            // 对有 base64Data 的 (路径A) 直接从 base64 保存
            if (pm.base64Data) {
                const buf = Buffer.from(pm.base64Data, "base64");
                const saved = mediaDownloader.saveMedia(buf, {
                    chatId: att.chatId,
                    messageId: att.messageId,
                    uniqueFileId: att.uniqueFileId,
                    mediaType: att.type,
                    mimeType: pm.mimeType ?? att.mimeType,
                    fileName: att.fileName,
                });
                if (saved) pm.filePath = saved.path;
            } else if (pathBBuffers.has(att.uniqueFileId)) {
                // 路径 B: 使用 vision 描述时暂存的原始 buffer 保存到磁盘
                const { buffer: rawBuf, mimeType: rawMime } = pathBBuffers.get(att.uniqueFileId)!;
                const saved = mediaDownloader.saveMedia(rawBuf, {
                    chatId: att.chatId,
                    messageId: att.messageId,
                    uniqueFileId: att.uniqueFileId,
                    mediaType: att.type,
                    mimeType: rawMime ?? att.mimeType,
                    fileName: att.fileName,
                });
                if (saved) pm.filePath = saved.path;
            }
        }
    }

    // ─── 处理 download-only 媒体 (video / document / animation) ───
    if (downloadFn && mediaDownloader) {
        for (const att of downloadOnly) {
            // 大小检查
            if (!mediaDownloader.isWithinSizeLimit(att.fileSize)) {
                const sizeMB = att.fileSize ? (att.fileSize / 1024 / 1024).toFixed(1) : "?";
                results.push({
                    index: att.messageIndex,
                    description: `[📎 ${att.type} (${sizeMB}MB, 超出下载限制)]`,
                });
                continue;
            }

            // 已有文件
            const existing = mediaDownloader.getExistingPath(att.uniqueFileId);
            if (existing) {
                results.push({
                    index: att.messageIndex,
                    filePath: existing,
                    description: typeLabel(att.type),
                });
                continue;
            }

            // 下载 + 保存
            try {
                const buffer = await downloadFn(att.fileId, att.chatId, att.messageId, att.uniqueFileId);
                const saved = mediaDownloader.saveMedia(buffer, {
                    chatId: att.chatId,
                    messageId: att.messageId,
                    uniqueFileId: att.uniqueFileId,
                    mediaType: att.type,
                    mimeType: att.mimeType,
                    fileName: att.fileName,
                });
                results.push({
                    index: att.messageIndex,
                    filePath: saved?.path,
                    description: typeLabel(att.type),
                });
            } catch (err) {
                log.warn("download-only 媒体下载失败", { fileId: att.fileId, type: att.type, error: String(err) });
                results.push({
                    index: att.messageIndex,
                    description: typeLabel(att.type),
                });
            }
        }
    } else {
        // 无 downloader — 返回纯标签
        for (const att of downloadOnly) {
            results.push({
                index: att.messageIndex,
                description: typeLabel(att.type),
            });
        }
    }

    return results;
}

/** 媒体类型 → 显示标签 */
function typeLabel(type: string): string {
    switch (type) {
        case "video": return "[📹 视频]";
        case "animation": return "[🎬 GIF]";
        case "document": return "[📎 文件]";
        default: return `[📎 ${type}]`;
    }
}

// ─── 内部函数 ───

/**
 * 处理单个 Sticker
 */
async function processSingleSticker(
    sticker: MediaAttachment,
    config: VisionConfig | undefined,
    hasVision: boolean,
    visionLlmConfigs?: LLMConfig[],
    downloadFn?: DownloadFn,
    stickerCache?: StickerCache,
    mediaDownloader?: MediaDownloader,
): Promise<ProcessedMedia> {
    const mode = config?.stickerMode ?? "emoji_only";

    // emoji_only 或无 vision 能力
    if (mode === "emoji_only" || !hasVision || !downloadFn || !visionLlmConfigs?.length) {
        return {
            index: sticker.messageIndex,
            description: sticker.emoji
                ? `[🎭 贴纸: ${sticker.emoji}]`
                : "[🎭 贴纸]",
        };
    }

    // vision_cache: 查缓存
    if (mode === "vision_cache" && stickerCache) {
        const cached = stickerCache.getStickerDescription(sticker.uniqueFileId);
        if (cached) {
            log.debug("Sticker 缓存命中", { uniqueFileId: sticker.uniqueFileId });
            const emojiTag = cached.emoji ?? sticker.emoji ?? "";
            return {
                index: sticker.messageIndex,
                description: `[🎭 贴纸${emojiTag ? " " + emojiTag : ""}: ${cached.description}]`,
            };
        }
    }

    // vision_each 或 vision_cache miss: 下载+识别
    try {
        const rawBuffer = await downloadFn(sticker.fileId, sticker.chatId, sticker.messageId, sticker.uniqueFileId);

        // 保存贴纸原始文件到磁盘（用于后续发送）
        if (mediaDownloader) {
            mediaDownloader.saveMedia(Buffer.from(rawBuffer), {
                chatId: sticker.chatId,
                messageId: sticker.messageId,
                uniqueFileId: sticker.uniqueFileId,
                mediaType: "sticker",
                mimeType: sticker.mimeType ?? "image/webp",
            });
        }

        const { buffer: stickerBuf, mimeType: mime } = await ensureSupportedFormat(rawBuffer, sticker.mimeType ?? "image/webp");
        const result = await describeSticker(stickerBuf, mime, visionLlmConfigs, sticker.emoji);

        // 写入缓存 (vision_cache mode)
        if (mode === "vision_cache" && stickerCache) {
            const newDefault = config?.newStickerDefault !== "disabled";
            stickerCache.setStickerDescription(sticker.uniqueFileId, result.description, result.emoji, newDefault);
        }

        const emojiTag = result.emoji ?? sticker.emoji ?? "";
        return {
            index: sticker.messageIndex,
            description: `[🎭 贴纸${emojiTag ? " " + emojiTag : ""}: ${result.description}]`,
        };
    } catch (err) {
        log.warn("Sticker 识别失败，降级为 emoji", { uniqueFileId: sticker.uniqueFileId, error: String(err) });
        return {
            index: sticker.messageIndex,
            description: sticker.emoji
                ? `[🎭 贴纸: ${sticker.emoji}]`
                : "[🎭 贴纸]",
        };
    }
}

/**
 * 调用 Vision LLM 描述图片
 */
export async function describeImage(
    imageBuffer: Buffer,
    mimeType: string,
    visionConfigs: LLMConfig[],
): Promise<string> {
    const b64 = imageBuffer.toString("base64");
    const dataUri = `data:${mimeType};base64,${b64}`;

    const messages: ChatMessage[] = [
        {
            role: "user",
            content: "请具体而详细地描述这张图片的内容。如图中有文字/代码，尽你所能给出完整内容。",
            imageParts: [{ url: dataUri }],
        },
    ];

    const response = await callLLMWithFallback(messages, visionConfigs, { caller: "vision", timeoutMs: resolveComponentTimeout("vision") });
    return normalizeVisionDescription(response.content);
}

/**
 * 调用 Vision LLM 描述 Sticker，返回描述 + emoji
 */
async function describeSticker(
    stickerBuffer: Buffer,
    mimeType: string,
    visionConfigs: LLMConfig[],
    emoji?: string,
): Promise<{ description: string; emoji?: string }> {
    const b64 = stickerBuffer.toString("base64");
    const dataUri = `data:${mimeType};base64,${b64}`;

    const emojiHint = emoji ? `（这个贴纸的原始 emoji 是 ${emoji}）` : "";
    const messages: ChatMessage[] = [
        {
            role: "user",
            content: `这是一个 Telegram 贴纸图片${emojiHint}。

请你：
1. 用几个词简短描述贴纸表情/动作/含义。如果贴纸中有文字，结合图片内容理解并描述文字的完整内容。
2. 选择一个最能代表这个贴纸含义的 emoji。

请用以下 JSON 格式回复（仅返回 JSON，不要包含其他内容）：
{"description": "描述内容", "emoji": "单个emoji"}`,
            imageParts: [{ url: dataUri }],
        },
    ];

    const response = await callLLMWithFallback(messages, visionConfigs, { caller: "vision" });
    const raw = response.content.trim();

    // 尝试解析 JSON
    try {
        const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        const parsed = JSON.parse(jsonStr);
        return {
            description: normalizeVisionDescription(String(parsed.description ?? raw)),
            emoji: typeof parsed.emoji === "string" ? parsed.emoji : undefined,
        };
    } catch {
        log.debug("describeSticker: JSON 解析失败，使用原始文本", { raw: raw.slice(0, 100) });
        return { description: normalizeVisionDescription(raw) };
    }
}

/**
 * 规范化 vision LLM 的输出：去除 markdown 代码围栏，将换行折叠为空格
 */
function normalizeVisionDescription(raw: string): string {
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/);
    const unfenced = fenceMatch?.[1] ?? trimmed;
    return unfenced.replace(/\s*\n+\s*/g, " ").trim();
}
