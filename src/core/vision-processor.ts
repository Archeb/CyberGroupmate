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

import { callLLM, type ChatMessage } from "./llm.js";
import type { LLMConfig, VisionConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("vision-processor");

// ─── 类型定义 ───

/** 待处理的媒体附件（从 message_log.media_info 解析） */
export interface MediaAttachment {
    type: "photo" | "sticker" | "video" | "document" | "animation" | "other";
    fileId: string;
    uniqueFileId: string;
    emoji?: string;       // sticker only
    mimeType?: string;
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
}

/** Sticker 描述缓存接口 */
export interface StickerCache {
    getStickerDescription(uniqueFileId: string): { description: string; emoji?: string } | null;
    setStickerDescription(uniqueFileId: string, description: string, emoji?: string): void;
}

/** 下载函数类型 */
export type DownloadFn = (fileId: string, chatId?: string, messageId?: string, uniqueFileId?: string) => Promise<Buffer>;

// ─── 默认配置 ───

const DEFAULT_MAX_IMAGES = 3;
const DEFAULT_MAX_IMAGE_SIZE = 1024;

/** 图片描述内存缓存（Path B）: uniqueFileId → description */
const photoDescriptionCache = new Map<string, string>();

// ─── 核心处理函数 ───

/**
 * 批量处理一组消息中的媒体附件
 *
 * @param attachments 按消息顺序排列的媒体附件列表
 * @param config Vision 配置
 * @param llmConfig 主模型配置（检查 vision:true）
 * @param visionLlmConfig 独立 vision tier 配置
 * @param downloadFn 图片下载函数（委托给 adapter）
 * @param stickerCache sticker 描述缓存
 */
export async function processMediaBatch(
    attachments: MediaAttachment[],
    config: VisionConfig | undefined,
    llmConfig: LLMConfig,
    visionLlmConfig?: LLMConfig,
    downloadFn?: DownloadFn,
    stickerCache?: StickerCache,
): Promise<ProcessedMedia[]> {
    const maxImages = config?.maxImagesPerContext ?? DEFAULT_MAX_IMAGES;
    const results: ProcessedMedia[] = [];

    // 分类
    const photos: MediaAttachment[] = [];
    const stickers: MediaAttachment[] = [];

    for (const att of attachments) {
        if (att.type === "photo" || (att.type === "document" && att.mimeType?.startsWith("image/"))) {
            photos.push(att);
        } else if (att.type === "sticker") {
            stickers.push(att);
        }
        // video / animation / other → 跳过（保留占位文本）
    }

    // 确定处理路径
    const isPathA = llmConfig.vision === true;
    const isPathB = !isPathA && !!visionLlmConfig;
    // 如果既不是 A 也不是 B，就是 C

    // ─── 处理 Sticker ───
    for (const sticker of stickers) {
        const processed = await processSingleSticker(
            sticker,
            config,
            isPathA || isPathB,
            isPathA ? llmConfig : visionLlmConfig,
            downloadFn,
            stickerCache,
        );
        results.push(processed);
    }

    // ─── 处理 Photo（并行） ───
    // 先分类：前 maxImages 张走路径 A（内联），其余走路径 B（描述）或 C（占位）
    // 描述结果按 uniqueFileId 缓存，避免重复 vision LLM 调用
    const photoTasks: Array<Promise<ProcessedMedia>> = photos.map((photo, i) => {
        const shouldInline = isPathA && i < maxImages && downloadFn;
        const canDescribe = (isPathA || isPathB) && downloadFn;

        /** 带缓存的图片描述：先查缓存，miss 时下载+LLM 描述并写入缓存 */
        const describeWithCache = async (visionCfg: LLMConfig): Promise<ProcessedMedia> => {
            // 缓存命中
            const cached = photoDescriptionCache.get(photo.uniqueFileId);
            if (cached) {
                log.debug("图片描述缓存命中", { uniqueFileId: photo.uniqueFileId });
                return { index: photo.messageIndex, description: cached };
            }
            // 缓存未命中：下载 + LLM 描述
            const buffer = await downloadFn!(photo.fileId, photo.chatId, photo.messageId, photo.uniqueFileId);
            const desc = await describeImage(buffer, photo.mimeType ?? "image/jpeg", visionCfg);
            photoDescriptionCache.set(photo.uniqueFileId, desc);
            return { index: photo.messageIndex, description: desc };
        };

        if (shouldInline) {
            // 路径 A: 内联 base64（不缓存，每次需要完整数据）
            return downloadFn!(photo.fileId, photo.chatId, photo.messageId, photo.uniqueFileId)
                .then(buffer => ({
                    index: photo.messageIndex,
                    base64Data: buffer.toString("base64"),
                    mimeType: photo.mimeType ?? "image/jpeg",
                } as ProcessedMedia))
                .catch(err => {
                    log.warn("路径 A 下载失败，降级为描述", { fileId: photo.fileId, error: String(err) });
                    if (canDescribe) {
                        const visionCfg = isPathA ? llmConfig : visionLlmConfig!;
                        return describeWithCache(visionCfg).catch(err2 => {
                            log.warn("降级描述也失败", { fileId: photo.fileId, error: String(err2) });
                            return { index: photo.messageIndex, description: "[📷 图片]" } as ProcessedMedia;
                        });
                    }
                    return { index: photo.messageIndex, description: "[📷 图片]" } as ProcessedMedia;
                });
        }

        if (canDescribe) {
            // 路径 A 溢出 或 路径 B: 调用 vision LLM 描述（带缓存）
            const visionCfg = isPathA ? llmConfig : visionLlmConfig!;
            return describeWithCache(visionCfg).catch(err => {
                log.warn("Vision 描述失败，使用占位符", { fileId: photo.fileId, error: String(err) });
                return { index: photo.messageIndex, description: "[📷 图片]" } as ProcessedMedia;
            });
        }

        // 路径 C 或无下载能力
        return Promise.resolve({
            index: photo.messageIndex,
            description: "[📷 图片]",
        } as ProcessedMedia);
    });

    const photoResults = await Promise.all(photoTasks);
    results.push(...photoResults);

    return results;
}

// ─── 内部函数 ───

/**
 * 处理单个 Sticker
 */
async function processSingleSticker(
    sticker: MediaAttachment,
    config: VisionConfig | undefined,
    hasVision: boolean,
    visionLlmConfig?: LLMConfig,
    downloadFn?: DownloadFn,
    stickerCache?: StickerCache,
): Promise<ProcessedMedia> {
    const mode = config?.stickerMode ?? "emoji_only";

    // emoji_only 或无 vision 能力
    if (mode === "emoji_only" || !hasVision || !downloadFn || !visionLlmConfig) {
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
        const buffer = await downloadFn(sticker.fileId, sticker.chatId, sticker.messageId, sticker.uniqueFileId);
        const mime = sticker.mimeType ?? "image/webp";
        const result = await describeSticker(buffer, mime, visionLlmConfig, sticker.emoji);

        // 写入缓存 (vision_cache mode)
        if (mode === "vision_cache" && stickerCache) {
            stickerCache.setStickerDescription(sticker.uniqueFileId, result.description, result.emoji);
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
async function describeImage(
    imageBuffer: Buffer,
    mimeType: string,
    visionConfig: LLMConfig,
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

    const response = await callLLM(messages, visionConfig, { caller: "vision" });
    return response.content.trim();
}

/**
 * 调用 Vision LLM 描述 Sticker，返回描述 + emoji
 */
async function describeSticker(
    stickerBuffer: Buffer,
    mimeType: string,
    visionConfig: LLMConfig,
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

    const response = await callLLM(messages, visionConfig, { caller: "vision" });
    const raw = response.content.trim();

    // 尝试解析 JSON
    try {
        const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
        const parsed = JSON.parse(jsonStr);
        return {
            description: String(parsed.description ?? raw),
            emoji: typeof parsed.emoji === "string" ? parsed.emoji : undefined,
        };
    } catch {
        log.debug("describeSticker: JSON 解析失败，使用原始文本", { raw: raw.slice(0, 100) });
        return { description: raw };
    }
}
