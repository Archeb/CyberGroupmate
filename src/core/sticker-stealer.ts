/**
 * sticker-stealer.ts — OneBot 偷表情包核心逻辑
 *
 * 协调图片出现次数追踪、下载、VLM 确认、保存。
 * 流程：图片出现 N 次 → 下载 → VLM 确认 → 保存到 sticker_descriptions
 * 全程静默，仅写日志。
 */

import { StickerStealDB } from "./sticker-steal-db.js";
import type { MediaDownloader } from "./media-downloader.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import { classifyAndDescribeMeme, ensureSupportedFormat } from "./vision-processor.js";
import type { LLMConfig, VisionConfig } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("sticker-stealer");

export interface StickerStealConfig {
    enabled: boolean;
    occurrenceThreshold: number;
    skipVlmConfirm: boolean;
}

const EXT_MIME_MAP: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
};

function inferMimeType(fileIdOrUrl: string): string {
    const lower = fileIdOrUrl.toLowerCase();
    for (const [ext, mime] of Object.entries(EXT_MIME_MAP)) {
        if (lower.includes(ext)) return mime;
    }
    return "image/jpeg";
}

export class StickerStealer {
    private db: StickerStealDB;
    private mediaDownloader: MediaDownloader;
    private memory: MemoryStoreV2;
    private visionConfigs: LLMConfig[];
    private config: StickerStealConfig;
    private visionConfig?: VisionConfig;

    constructor(options: {
        dbPath: string;
        mediaDownloader: MediaDownloader;
        memory: MemoryStoreV2;
        visionConfigs: LLMConfig[];
        config: StickerStealConfig;
        visionConfig?: VisionConfig;
    }) {
        this.db = new StickerStealDB(options.dbPath);
        this.mediaDownloader = options.mediaDownloader;
        this.memory = options.memory;
        this.visionConfigs = options.visionConfigs;
        this.config = options.config;
        this.visionConfig = options.visionConfig;
    }

    async processImage(params: {
        uniqueFileId: string;
        fileId: string;
        url?: string;
        chatId: string;
        messageId: string;
    }): Promise<void> {
        const { uniqueFileId, fileId, url, chatId, messageId } = params;

        const existing = this.memory.getStickerDescription(uniqueFileId);
        if (existing) return;

        const count = this.db.incrementImageOccurrence(uniqueFileId, fileId, url);
        if (count < this.config.occurrenceThreshold) {
            log.debug("图片计数未达阈值", { uniqueFileId, count, threshold: this.config.occurrenceThreshold });
            return;
        }

        log.info("图片计数达到阈值，开始偷表情包", { uniqueFileId, count });

        try {
            const { buffer, mimeType } = await this.downloadImage(url, fileId);
            const { buffer: convBuf, mimeType: convMime } = await ensureSupportedFormat(buffer, mimeType);

            if (this.config.skipVlmConfirm) {
                this.saveAsSticker(convBuf, convMime, uniqueFileId, chatId, messageId, `QQ表情包-${uniqueFileId.slice(0, 8)}`);
                return;
            }

            const result = await classifyAndDescribeMeme(convBuf, convMime, this.visionConfigs);
            if (result.isMeme && result.description) {
                this.saveAsSticker(convBuf, convMime, uniqueFileId, chatId, messageId, result.description, result.emoji);
            } else {
                log.debug("图片非表情包，跳过收集", { uniqueFileId });
            }
        } catch (err) {
            log.warn("偷表情包处理失败", { uniqueFileId, error: String(err) });
        } finally {
            this.db.removeImageOccurrence(uniqueFileId);
        }
    }

    private async downloadImage(url?: string, fileId?: string): Promise<{ buffer: Buffer; mimeType: string }> {
        const downloadUrl = url;
        if (downloadUrl) {
            const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(30000) });
            if (!resp.ok) throw new Error(`下载图片失败: HTTP ${resp.status}`);
            const buffer = Buffer.from(await resp.arrayBuffer());
            const mimeType = inferMimeType(downloadUrl);
            return { buffer, mimeType };
        }

        if (fileId) {
            const mimeType = inferMimeType(fileId);
            throw new Error(`无法下载图片：无 URL，fileId=${fileId}（需要 OneBot 图片 URL）`);
        }

        throw new Error("无法下载图片：无 URL 且无 fileId");
    }

    private saveAsSticker(
        buffer: Buffer,
        mimeType: string,
        uniqueFileId: string,
        chatId: string,
        messageId: string,
        description: string,
        emoji?: string,
    ): void {
        this.mediaDownloader.saveMedia(buffer, {
            chatId,
            messageId,
            uniqueFileId,
            mediaType: "sticker",
            mimeType,
        });

        const newDefault = this.visionConfig?.newStickerDefault !== "disabled";
        this.memory.setStickerDescription(uniqueFileId, description, emoji, newDefault);

        log.info("自动收集 QQ 表情包", { uniqueFileId, description, emoji });
    }

    close(): void {
        this.db.close();
    }
}
