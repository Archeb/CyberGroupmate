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
import type { ImageCatalog } from "./image-catalog.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { computePerceptualHashes } from "./perceptual-hash.js";

const log = createLogger("vision-processor");

// ─── 类型定义 ───

/** 待处理的媒体附件（从 message_log.media_info 解析） */
export interface MediaAttachment {
    type: "photo" | "sticker" | "video" | "document" | "animation" | "audio" | "other";
    fileId: string;
    uniqueFileId: string;
    url?: string;
    emoji?: string;       // sticker only
    mimeType?: string;
    fileName?: string;
    filePath?: string;
    width?: number;
    height?: number;
    fileSize?: number;
    downloadStatus?: string;
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
    getStickerDescription(uniqueFileId: string, contentHash?: string): { description: string; emoji?: string; emojis?: string[] } | null;
    linkStickerContent?(uniqueFileId: string, contentHash: string): void;
    setStickerDescription(uniqueFileId: string, description: string, emoji?: string | string[], enabled?: boolean, contentHash?: string): void;
}

/** 下载函数类型 */
export type DownloadFn = (fileId: string, chatId?: string, messageId?: string, uniqueFileId?: string) => Promise<Buffer>;

// ─── 默认配置 ───

const DEFAULT_MAX_IMAGES = 3;
const DEFAULT_MAX_IMAGE_SIZE = 1024;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 20_000;

/** API 支持的图片 MIME 类型 */
const SUPPORTED_MIME = new Set(["image/jpeg", "image/png"]);

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        if (timer.unref) timer.unref();
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

function downloadMediaWithTimeout(downloadFn: DownloadFn, att: MediaAttachment): Promise<Buffer> {
    const startedAt = Date.now();
    const meta = {
        type: att.type,
        chatId: att.chatId,
        messageId: att.messageId,
        uniqueFileId: att.uniqueFileId,
        fileSize: att.fileSize,
        timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
    };
    log.info("media download start", meta);

    return withTimeout(
        downloadFn(att.fileId, att.chatId, att.messageId, att.uniqueFileId),
        MEDIA_DOWNLOAD_TIMEOUT_MS,
        `media download timeout after ${MEDIA_DOWNLOAD_TIMEOUT_MS}ms`,
    ).then((buffer) => {
        log.info("media download success", {
            ...meta,
            bytes: buffer.length,
            durationMs: Date.now() - startedAt,
        });
        return buffer;
    }).catch((err) => {
        log.warn("media download failed", {
            ...meta,
            durationMs: Date.now() - startedAt,
            error: String(err),
        });
        throw err;
    });
}

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

// ─── 动态贴纸抽帧 ───

/** 动态贴纸抽帧识别的默认帧数上限 */
const DEFAULT_ANIMATED_STICKER_FRAMES = 3;
const TGS_RENDER_SIZE = 512;

/** 判断附件是否为动态贴纸（WebM 视频贴纸 / TGS 动画贴纸） */
export function isAnimatedSticker(att: Pick<MediaAttachment, "mimeType" | "fileName">): boolean {
    return att.mimeType === "video/webm"
        || att.mimeType === "application/x-tgsticker"
        || /\.tgs$/i.test(att.fileName ?? "");
}

/** 判断动态贴纸是否为 TGS（Lottie）格式 */
function isTgsSticker(att: Pick<MediaAttachment, "mimeType" | "fileName">): boolean {
    return att.mimeType === "application/x-tgsticker" || /\.tgs$/i.test(att.fileName ?? "");
}

/**
 * 从动态贴纸中抽取关键帧（PNG）
 *
 * - WebM 视频贴纸：用 @napi-rs/webcodecs 解码后均匀采样
 * - TGS 动画贴纸：用 @napi-rs/canvas LottieAnimation 渲染采样帧
 *
 * 抽出的帧按时间均匀采样至 maxFrames 张。
 */
export async function extractAnimatedStickerFrames(
    rawBuffer: Buffer,
    isTgs: boolean,
    maxFrames: number,
): Promise<Buffer[]> {
    if (isTgs) {
        return renderTgsStickerFrames(rawBuffer, maxFrames);
    }
    return renderWebmStickerFrames(rawBuffer, maxFrames);
}

/**
 * TGS 动画贴纸抽帧：LottieAnimation (Skia Skottie) → 多帧 PNG
 * 使用 @napi-rs/canvas 内置的 LottieAnimation，无需额外 WASM 依赖
 */
async function renderTgsStickerFrames(rawBuffer: Buffer, maxFrames: number): Promise<Buffer[]> {
    const { createCanvas, LottieAnimation } = await import("@napi-rs/canvas");
    const { gunzipSync } = await import("node:zlib");

    const lottieJson = gunzipSync(rawBuffer).toString("utf-8");
    const anim = LottieAnimation.loadFromData(lottieJson);
    const totalFrames = Math.max(1, anim.frames);
    const frameIndexes = sampleFrameIndexes(totalFrames, maxFrames);

    const canvas = createCanvas(
        anim.width || TGS_RENDER_SIZE,
        anim.height || TGS_RENDER_SIZE,
    );
    const ctx = canvas.getContext("2d");

    return frameIndexes.map((frame) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        anim.seekFrame(frame);
        anim.render(ctx as any);
        return Buffer.from(canvas.toBuffer("image/png"));
    });
}

/**
 * WebM 视频贴纸抽帧：WebCodecs 全量解码 → 采样 → PNG
 * 先全量解码收集所有帧，再均匀采样，最后统一释放资源（无竞态）
 */
async function renderWebmStickerFrames(rawBuffer: Buffer, maxFrames: number): Promise<Buffer[]> {
    const { createCanvas } = await import("@napi-rs/canvas");
    const webcodecs = await import("@napi-rs/webcodecs");

    type VF = InstanceType<typeof webcodecs.VideoFrame>;
    const frames: VF[] = [];
    let demuxError: Error | undefined;
    let decodeError: Error | undefined;

    const decoder = new webcodecs.VideoDecoder({
        output: (frame) => frames.push(frame),
        error: (error) => { decodeError = error; },
    });
    const demuxer = new webcodecs.WebMDemuxer({
        videoOutput: (chunk) => decoder.decode(chunk),
        error: (error) => { demuxError = error; },
    });

    try {
        // 零拷贝视图，正确处理 Buffer 作为 ArrayBuffer 切片的情况
        await demuxer.loadBuffer(new Uint8Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength));
        if (demuxError) throw demuxError;

        const decoderConfig = demuxer.videoDecoderConfig;
        if (!decoderConfig) {
            throw new Error("WebM 动态贴纸没有可解码的视频轨道");
        }

        decoder.configure(decoderConfig);
        await demuxer.demuxAsync();
        if (demuxError) throw demuxError;

        await decoder.flush();
        if (decodeError) throw decodeError;
        if (frames.length === 0) {
            throw new Error("WebM 动态贴纸未解码出任何帧");
        }

        const picked = sampleFrameIndexes(frames.length, maxFrames);
        const pngFrames: Buffer[] = [];
        for (const idx of picked) {
            const frame = frames[idx];
            if (frame) pngFrames.push(await videoFrameToPng(frame, createCanvas));
        }
        return pngFrames;
    } finally {
        decoder.close();
        demuxer.close();
        for (const frame of frames) frame.close();
    }
}

/** VideoFrame → PNG：使用 allocationSize 确保 buffer 大小正确 */
async function videoFrameToPng(
    frame: any,
    createCanvas: (w: number, h: number) => any,
): Promise<Buffer> {
    const width: number = frame.displayWidth || frame.codedWidth;
    const height: number = frame.displayHeight || frame.codedHeight;
    const size: number = frame.allocationSize({ format: "RGBA" });
    const rgba = new Uint8Array(size);
    await frame.copyTo(rgba, { format: "RGBA" });
    return rgbaToPng(rgba, width, height, createCanvas);
}

/** RGBA 像素数据 → PNG Buffer */
function rgbaToPng(
    rgba: Uint8Array,
    width: number,
    height: number,
    createCanvas: (w: number, h: number) => any,
): Buffer {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const imgData = ctx.createImageData(width, height);
    imgData.data.set(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4));
    ctx.putImageData(imgData, 0, 0);
    return Buffer.from(canvas.toBuffer("image/png"));
}

/** 从 totalFrames 帧中均匀采样 maxFrames 个帧索引 */
export function sampleFrameIndexes(totalFrames: number, maxFrames: number): number[] {
    const count = Math.min(maxFrames, totalFrames);
    if (count <= 0) return [];
    if (count === 1) return [0];
    if (count === 2) return [0, Math.floor(totalFrames / 2)];

    const picked: number[] = [];
    for (let i = 0; i < count; i++) {
        const idx = Math.round((i * (totalFrames - 1)) / (count - 1));
        if (!picked.includes(idx)) picked.push(idx);
    }
    return picked;
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
    imageCatalog?: ImageCatalog,
    options?: ProcessMediaBatchOptions,
): Promise<ProcessedMedia[]> {
    const maxImages = config?.maxImagesPerContext ?? DEFAULT_MAX_IMAGES;
    const results: ProcessedMedia[] = [];

    // 分类
    const photos: MediaAttachment[] = [];
    const stickers: MediaAttachment[] = [];
    const downloadOnly: MediaAttachment[] = []; // video / document / animation / audio / other — 只下载不识别

    for (const att of attachments) {
        if (att.type === "photo" || (att.type === "document" && att.mimeType?.startsWith("image/"))) {
            photos.push(att);
        } else if (att.type === "sticker") {
            // Keep disabled animated stickers visible by letting processSingleSticker emit emoji fallback.
            stickers.push(att);
        } else if (att.type === "video" || att.type === "document" || att.type === "animation" || att.type === "audio" || att.type === "other") {
            downloadOnly.push(att);
        }
    }

    // 确定处理路径
    // forceTextDescriptions=true 时强制走文本描述（attend describe 模式），不内联 base64
    const isPathA = !options?.forceTextDescriptions && llmConfig.vision === true;
    const isPathB = !isPathA && !!visionLlmConfigs?.length;
    // 如果既不是 A 也不是 B，就是 C
    log.info("processMediaBatch: start", {
        total: attachments.length,
        photos: photos.length,
        stickers: stickers.length,
        downloadOnly: downloadOnly.length,
        mode: isPathA ? "inline" : isPathB ? "describe" : "placeholder",
        hasDownloadFn: !!downloadFn,
        hasMediaDownloader: !!mediaDownloader,
    });

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
            imageCatalog,
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
            const rawBuffer = await downloadMediaWithTimeout(downloadFn!, photo);
            const { buffer, mimeType } = await ensureSupportedFormat(rawBuffer, photo.mimeType ?? "image/jpeg");
            const desc = await describeImage(buffer, mimeType, visionCfgs);
            photoDescriptionCache.set(photo.uniqueFileId, desc);
            // 暂存原始 buffer 供后续保存到磁盘
            pathBBuffers.set(photo.uniqueFileId, { buffer: rawBuffer, mimeType: photo.mimeType ?? "image/jpeg" });
            return { index: photo.messageIndex, description: desc };
        };

        if (shouldInline) {
            // 路径 A: 内联 base64（不缓存，每次需要完整数据）
            return downloadMediaWithTimeout(downloadFn!, photo)
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

    // ─── 图片目录追踪（记录 photo 的 SHA256 + 出现频率 + pHash/dHash） ───
    if (imageCatalog) {
        const hashPromises: Array<Promise<void>> = [];
        for (const pm of results) {
            const att = attachments.find(a => a.messageIndex === pm.index);
            if (!att || att.type !== "photo") continue;
            let rawBuffer: Buffer | undefined;
            if (pm.base64Data) {
                rawBuffer = Buffer.from(pm.base64Data, "base64");
            } else if (pathBBuffers.has(att.uniqueFileId)) {
                rawBuffer = pathBBuffers.get(att.uniqueFileId)!.buffer;
            } else if (pm.filePath) {
                try {
                    rawBuffer = readFileSync(pm.filePath);
                } catch { /* ignore */ }
            }
            if (!rawBuffer) continue;
            const contentHash = createHash("sha256").update(rawBuffer).digest("hex");
            const platform = att.chatId?.split(":")[0] ?? "unknown";
            try {
                imageCatalog.recordSighting({
                    contentHash,
                    sourcePlatform: platform,
                    sourceChatId: att.chatId,
                    uniqueFileId: att.uniqueFileId,
                    filePath: pm.filePath ?? undefined,
                    mimeType: pm.mimeType ?? att.mimeType,
                    width: att.width,
                    height: att.height,
                    fileSize: att.fileSize ?? rawBuffer.length,
                    messageId: att.messageId,
                });
            } catch (err) {
                log.debug("imageCatalog.recordSighting 失败", { contentHash, error: String(err) });
            }
            // 异步计算 pHash + dHash（不阻塞主流程）
            hashPromises.push(
                computePerceptualHashes(rawBuffer).then(({ phash, dhash }) => {
                    if (phash || dhash) {
                        try {
                            imageCatalog.updateHashes(contentHash, phash, dhash);
                            const similar = imageCatalog.findSimilar(phash, dhash);
                            for (const s of similar) {
                                if (s.entry.contentHash !== contentHash && s.entry.isSticker !== null) {
                                    imageCatalog.setStickerVerdict({
                                        contentHash,
                                        isSticker: s.entry.isSticker === 1,
                                        description: s.entry.description ?? undefined,
                                        emoji: s.entry.emoji ?? undefined,
                                    });
                                    break;
                                }
                            }
                        } catch { /* ignore */ }
                    }
                }).catch(() => { /* ignore */ }),
            );
        }
        if (hashPromises.length > 0) {
            await Promise.allSettled(hashPromises);
        }
    }

    // ─── 处理 download-only 媒体 (video / document / animation) ───
    if (downloadFn && mediaDownloader) {
        for (const att of downloadOnly) {
            if (att.filePath) {
                results.push({
                    index: att.messageIndex,
                    filePath: att.filePath,
                    description: typeLabel(att.type),
                });
                continue;
            }

            // 大小检查
            if (!mediaDownloader.isWithinSizeLimit(att.fileSize)) {
                const sizeMB = att.fileSize ? (att.fileSize / 1024 / 1024).toFixed(1) : "?";
                results.push({
                    index: att.messageIndex,
                    description: `[📎 ${typeLabelText(att.type)} ${sizeMB}MB，超过 ${formatSizeLimit(mediaDownloader.getMaxFileSize())} 自动下载限制，请手动调用 downloadMedia 下载]`,
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
                const buffer = await downloadMediaWithTimeout(downloadFn, att);
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
                    description: saved
                        ? typeLabel(att.type)
                        : `[📎 ${typeLabelText(att.type)} ${(buffer.length / 1024 / 1024).toFixed(1)}MB，超过 ${formatSizeLimit(mediaDownloader.getMaxFileSize())} 自动下载限制，请手动调用 downloadMedia 下载]`,
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
            if (att.filePath) {
                results.push({
                    index: att.messageIndex,
                    filePath: att.filePath,
                    description: typeLabel(att.type),
                });
                continue;
            }
            if (att.downloadStatus === "too_large") {
                const sizeMB = att.fileSize ? (att.fileSize / 1024 / 1024).toFixed(1) : "?";
                results.push({
                    index: att.messageIndex,
                    description: `[📎 ${typeLabelText(att.type)} ${sizeMB}MB，超过 20MB 自动下载限制，请手动调用 downloadMedia 下载]`,
                });
                continue;
            }
            results.push({
                index: att.messageIndex,
                description: typeLabel(att.type),
            });
        }
    }

    log.info("processMediaBatch: complete", {
        total: attachments.length,
        results: results.length,
        photos: photos.length,
        stickers: stickers.length,
        downloadOnly: downloadOnly.length,
    });

    return results;
}

/** 媒体类型 → 显示标签 */
function typeLabel(type: string): string {
    switch (type) {
        case "video": return "[📹 视频]";
        case "animation": return "[🎬 GIF]";
        case "audio": return "[🎙 语音/音频]";
        case "document": return "[📎 文件]";
        case "other": return "[📎 媒体]";
        default: return `[📎 ${type}]`;
    }
}

function typeLabelText(type: string): string {
    switch (type) {
        case "video": return "视频";
        case "animation": return "GIF";
        case "audio": return "语音/音频";
        case "document": return "文件";
        case "other": return "媒体";
        default: return type;
    }
}

function formatSizeLimit(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
    return `${bytes}B`;
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
    imageCatalog?: ImageCatalog,
): Promise<ProcessedMedia> {
    const mode = config?.stickerMode ?? "emoji_only";
    const animated = isAnimatedSticker(sticker);
    const label = animated ? "动态贴纸" : "贴纸";
    const maxFrames = config?.animatedStickerFrames ?? DEFAULT_ANIMATED_STICKER_FRAMES;
    // A zero frame budget means dynamic stickers should stay visible without vision cost.
    const animatedDisabled = animated && maxFrames <= 0;

    // Disabled dynamic sticker vision should not reuse stale cached descriptions.
    if (mode === "vision_cache" && stickerCache && !animatedDisabled) {
        const cached = stickerCache.getStickerDescription(sticker.uniqueFileId);
        if (cached) {
            log.debug("Sticker 缓存命中", { uniqueFileId: sticker.uniqueFileId });
            const emojiTag = formatEmojiTag(cached.emojis ?? cached.emoji ?? sticker.emoji);
            return {
                index: sticker.messageIndex,
                description: `[🎭 ${label}${emojiTag}: ${cached.description}]`,
            };
        }
    }

    // Fall back before downloading when vision is unavailable or explicitly disabled.
    if (mode === "emoji_only" || animatedDisabled || !hasVision || !downloadFn || !visionLlmConfigs?.length) {
        if (animatedDisabled) {
            log.debug("动态贴纸 vision 识别已禁用，降级为 emoji", { uniqueFileId: sticker.uniqueFileId, mimeType: sticker.mimeType });
        }
        return {
            index: sticker.messageIndex,
            description: sticker.emoji
                ? `[🎭 ${label}: ${sticker.emoji}]`
                : `[🎭 ${label}]`,
        };
    }

    // vision_each 或 vision_cache miss: 下载+识别
    try {
        const rawBuffer = await downloadMediaWithTimeout(downloadFn, sticker);

        // 保存贴纸原始文件到磁盘（用于后续发送）
        let savedSticker: ReturnType<MediaDownloader["saveMedia"]> | null = null;
        if (mediaDownloader) {
            savedSticker = mediaDownloader.saveMedia(Buffer.from(rawBuffer), {
                chatId: sticker.chatId,
                messageId: sticker.messageId,
                uniqueFileId: sticker.uniqueFileId,
                mediaType: "sticker",
                mimeType: sticker.mimeType ?? "image/webp",
                fileName: sticker.fileName,
            });
        }
        const contentHash = savedSticker?.contentHash;

        if (mode === "vision_cache" && stickerCache && contentHash) {
            stickerCache.linkStickerContent?.(sticker.uniqueFileId, contentHash);
            const cached = stickerCache.getStickerDescription(sticker.uniqueFileId, contentHash);
            if (cached) {
                log.debug("Sticker 内容缓存命中", { uniqueFileId: sticker.uniqueFileId, contentHash });
                const emojiTag = formatEmojiTag(cached.emojis ?? cached.emoji ?? sticker.emoji);
                return {
                    index: sticker.messageIndex,
                    description: `[🎭 ${label}${emojiTag}: ${cached.description}]`,
                };
            }
        }

        // 动态贴纸：抽帧后多帧识别；静态贴纸：单图识别
        let frames: Array<{ buffer: Buffer; mimeType: string }>;
        if (animated) {
            // The WebM renderer already respects Buffer slices, so avoid copying sticker payloads.
            frames = (await extractAnimatedStickerFrames(
                rawBuffer,
                isTgsSticker(sticker),
                maxFrames,
            )).map((buffer) => ({ buffer, mimeType: "image/png" }));
        } else {
            const { buffer, mimeType } = await ensureSupportedFormat(rawBuffer, sticker.mimeType ?? "image/webp");
            frames = [{ buffer, mimeType }];
        }
        const result = await describeSticker(frames, animated, visionLlmConfigs, sticker.emoji);

        // 写入缓存 (vision_cache mode)
        if (mode === "vision_cache" && stickerCache) {
            const newDefault = config?.newStickerDefault !== "disabled";
            stickerCache.setStickerDescription(sticker.uniqueFileId, result.description, result.emojis, newDefault, contentHash);
        }

        const emojiTag = formatEmojiTag(result.emojis.length > 0 ? result.emojis : (result.emoji ?? sticker.emoji));
        return {
            index: sticker.messageIndex,
            description: `[🎭 ${label}${emojiTag}: ${result.description}]`,
        };
    } catch (err) {
        log.warn("Sticker 识别失败，降级为 emoji", { uniqueFileId: sticker.uniqueFileId, animated, error: String(err) });
        return {
            index: sticker.messageIndex,
            description: sticker.emoji
                ? `[🎭 ${label}: ${sticker.emoji}]`
                : `[🎭 ${label}]`,
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

    const response = await callLLMWithFallback(messages, visionConfigs, { caller: "vision", component: "vision", timeoutMs: resolveComponentTimeout("vision") });
    const collapseNewlines = !trimmedPrompt;
    return normalizeVisionDescription(response.content, collapseNewlines);
}

/**
 * 调用 Vision LLM 描述 Sticker，返回描述 + 多个 emoji 候选
 *
 * 静态贴纸传单帧；动态贴纸传按时间顺序抽取的多帧
 */
async function describeSticker(
    frames: Array<{ buffer: Buffer; mimeType: string }>,
    animated: boolean,
    visionConfigs: LLMConfig[],
    emoji?: string,
): Promise<{ description: string; emoji?: string; emojis: string[] }> {
    const imageParts = frames.map(({ buffer, mimeType }) => ({
        url: `data:${mimeType};base64,${buffer.toString("base64")}`,
    }));

    const emojiHint = emoji ? `（这个贴纸的原始 emoji 是 ${emoji}）` : "";
    const intro = animated
        ? `这是一个 Telegram 动态贴纸${emojiHint}，下面 ${imageParts.length} 张图片是从动画中采样的关键帧；先判断整体表情/动作/含义，不要默认写成前后状态变化。只有变化本身清晰可见且是贴纸核心含义时，才简短描述变化。`
        : `这是一个 Telegram 贴纸图片${emojiHint}。`;
    const describeHint = "用几个词简短描述贴纸表情/动作/含义。如果贴纸中有文字，结合图片内容理解并描述文字的完整内容。";
    const messages: ChatMessage[] = [
        {
            role: "user",
            content: `${intro}

请你：
1. ${describeHint}
2. 生成多个可用于匹配这个贴纸含义的 emoji 候选，输出为数组。候选数量无上限，但至少 2 个；包含主要情绪、近义情绪、动作/语气相关 emoji。若原始 emoji 合理，也应放入数组。

请用以下 JSON 格式回复（仅返回 JSON，不要包含其他内容）：
{"description": "描述内容", "emojis": ["emoji1", "emoji2", "..."]}`,
            imageParts,
        },
    ];

    const response = await callLLMWithFallback(messages, visionConfigs, { caller: "vision", component: "vision" });
    const raw = response.content.trim();

    // 尝试解析 JSON（先直接解析，失败再从文本中抽取 {...} 片段救一把）
    const parsed = parseStickerJson(raw);
    const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
    if (parsed && description) {
        const emojis = normalizeEmojiCandidates(parsed.emojis ?? parsed.emoji, emoji);
        return {
            description: normalizeVisionDescription(description),
            emoji: emojis[0] ?? (typeof parsed.emoji === "string" ? parsed.emoji : undefined),
            emojis,
        };
    }

    // 解析不出结构化描述：绝不能把整段回复当成贴纸描述（否则模型的解释/拒答/报错
    // 都会被写进贴纸库）。抛错让上层降级为 emoji-only，并且本次不写缓存。
    log.warn("describeSticker: 无法解析贴纸描述 JSON，降级为 emoji-only", { raw: raw.slice(0, 120) });
    throw new Error("describeSticker: 贴纸描述 JSON 无法解析");
}

/** 解析贴纸描述 LLM 回复：先整体解析，失败再抽取首个 {...} 片段重试。失败返回 null。 */
function parseStickerJson(raw: string): { description?: unknown; emoji?: unknown; emojis?: unknown } | null {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const candidates = [cleaned];
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch && objMatch[0] !== cleaned) candidates.push(objMatch[0]);
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === "object") {
                return parsed as { description?: unknown; emoji?: unknown; emojis?: unknown };
            }
        } catch { /* 尝试下一个候选 */ }
    }
    return null;
}

function normalizeEmojiCandidates(value: unknown, fallback?: string): string[] {
    const candidates: string[] = [];
    const add = (item: unknown) => {
        if (typeof item !== "string") return;
        const trimmed = item.trim();
        if (!trimmed || candidates.includes(trimmed)) return;
        candidates.push(trimmed);
    };

    if (Array.isArray(value)) {
        for (const item of value) add(item);
    } else {
        add(value);
    }
    add(fallback);

    return candidates;
}

function formatEmojiTag(value?: string | string[]): string {
    const emojis = normalizeEmojiCandidates(value);
    return emojis.length > 0 ? ` ${emojis.join(" ")}` : "";
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
