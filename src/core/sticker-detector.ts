/**
 * sticker-detector.ts — 异步表情包检测器
 *
 * 扫描 image_catalog 中频率达标的待判定图片，
 * 调用 Vision LLM 判断是否为表情包，
 * 确认后提升到正式贴纸库 (sticker_descriptions)。
 */

import { callLLMWithFallback, type ChatMessage } from "./llm.js";
import { ensureSupportedFormat } from "./vision-processor.js";
import type { LLMConfig } from "./config.js";
import type { ImageCatalog, ImageCatalogEntry } from "./image-catalog.js";
import type { MediaDownloader } from "./media-downloader.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { createLogger } from "./logger.js";

const log = createLogger("sticker-detector");

export interface StickerDetectorDeps {
    imageCatalog: ImageCatalog;
    mediaDownloader: MediaDownloader;
    memory: MemoryStoreV2;
    visionConfigs: LLMConfig[];
    minFrequency?: number;
    newStickerEnabledByDefault?: boolean;
}

export class StickerDetector {
    private deps: StickerDetectorDeps;
    private processing = false;

    constructor(deps: StickerDetectorDeps) {
        this.deps = deps;
    }

    async processCandidates(): Promise<number> {
        if (this.processing) {
            log.debug("processCandidates: 已有处理进行中，跳过");
            return 0;
        }
        this.processing = true;
        try {
            const candidates = this.deps.imageCatalog.getPendingStickerCandidates(this.deps.minFrequency ?? 3);
            if (candidates.length === 0) return 0;

            log.info("processCandidates: 开始处理", { count: candidates.length });
            let processed = 0;

            for (const entry of candidates) {
                if (!entry.filePath || !existsSync(entry.filePath)) {
                    log.debug("processCandidates: 文件不存在，跳过", { contentHash: entry.contentHash, filePath: entry.filePath });
                    continue;
                }

                try {
                    await this.classifyImage(entry);
                    processed++;
                } catch (err) {
                    log.warn("processCandidates: 分类失败", { contentHash: entry.contentHash, error: String(err) });
                }

                if (processed >= 5) break;
            }

            log.info("processCandidates: 完成", { processed, total: candidates.length });
            return processed;
        } finally {
            this.processing = false;
        }
    }

    private async classifyImage(entry: ImageCatalogEntry): Promise<void> {
        const filePath = entry.filePath!;
        const rawBuffer = readFileSync(filePath);
        const mimeType = entry.mimeType ?? inferMimeType(filePath);
        const { buffer, mimeType: processedMime } = await ensureSupportedFormat(rawBuffer, mimeType);

        const b64 = buffer.toString("base64");
        const dataUri = `data:${processedMime};base64,${b64}`;

        const messages: ChatMessage[] = [
            {
                role: "user",
                content: `这张图片在群聊中反复出现，可能是一个表情包/贴纸。
请判断这是否是表情包（而非普通照片、截图、文档等），并描述其含义。

判定标准：
- 表情包：有明显情绪表达、梗图、配文表情、简笔画风格、可爱动物等
- 不是：风景照、真人照片（非表情化的）、截图、文档、商品图等

请用以下 JSON 格式回复（仅返回 JSON，不要包含其他内容）：
{"is_sticker": true/false, "description": "几个词的简短描述", "emoji": "单个代表emoji"}`,
                imageParts: [{ url: dataUri }],
            },
        ];

        const response = await callLLMWithFallback(messages, this.deps.visionConfigs, {
            caller: "sticker-detector",
        });

        const raw = response.content.trim();
        let isSticker = false;
        let description = "";
        let emoji: string | undefined;

        try {
            const jsonStr = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
            const parsed = JSON.parse(jsonStr);
            isSticker = !!parsed.is_sticker;
            description = String(parsed.description ?? "").trim();
            emoji = typeof parsed.emoji === "string" ? parsed.emoji : undefined;
        } catch {
            log.debug("classifyImage: JSON 解析失败，视为非表情包", { contentHash: entry.contentHash, raw: raw.slice(0, 100) });
            isSticker = false;
        }

        this.deps.imageCatalog.setStickerVerdict({
            contentHash: entry.contentHash,
            isSticker,
            description: description || undefined,
            emoji,
        });

        if (isSticker && description) {
            await this.promoteToSticker(entry, description, emoji);
        }
    }

    private async promoteToSticker(entry: ImageCatalogEntry, description: string, emoji?: string): Promise<void> {
        if (!entry.filePath || !existsSync(entry.filePath)) return;

        const rawBuffer = readFileSync(entry.filePath);
        const mimeType = entry.mimeType ?? inferMimeType(entry.filePath);

        const saved = this.deps.mediaDownloader.saveMedia(Buffer.from(rawBuffer), {
            chatId: entry.sourceChatId ?? undefined,
            uniqueFileId: entry.uniqueFileId ?? entry.contentHash,
            mediaType: "sticker",
            mimeType,
        });

        if (!saved) {
            log.warn("promoteToSticker: 保存到 stickers/ 失败", { contentHash: entry.contentHash });
            return;
        }

        this.deps.memory.setStickerDescription(
            entry.uniqueFileId ?? entry.contentHash,
            description,
            emoji,
            this.deps.newStickerEnabledByDefault !== false,
        );

        this.deps.imageCatalog.markPromoted(
            entry.contentHash,
            entry.uniqueFileId ?? entry.contentHash,
            saved.path,
        );

        log.info("promoteToSticker: 表情包已提升到正式贴纸库", {
            contentHash: entry.contentHash,
            uniqueFileId: entry.uniqueFileId ?? entry.contentHash,
            description: description.slice(0, 50),
            emoji,
            stickerPath: saved.path,
        });
    }
}

function inferMimeType(filePath: string): string {
    const ext = filePath.toLowerCase();
    if (ext.endsWith(".png")) return "image/png";
    if (ext.endsWith(".jpg") || ext.endsWith(".jpeg")) return "image/jpeg";
    if (ext.endsWith(".webp")) return "image/webp";
    if (ext.endsWith(".gif")) return "image/gif";
    return "image/jpeg";
}
