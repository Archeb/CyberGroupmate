/**
 * media-downloader.ts — 媒体文件下载与管理
 *
 * 负责：
 * - 将下载的媒体 Buffer 按类型保存到 workspace/Downloads/
 * - 按 uniqueFileId 去重（已存在则跳过）
 * - 3 天（可配）自动清理过期文件
 *
 * 目录结构：
 *   workspace/Downloads/
 *     photos/      chatId_msgId_uniqueFileId.jpg
 *     videos/      chatId_msgId_uniqueFileId.mp4
 *     stickers/    chatId_msgId_uniqueFileId.webp
 *     documents/   chatId_msgId_uniqueFileId.pdf
 *     other/       chatId_msgId_uniqueFileId.bin
 */

import * as fs from "node:fs";
import * as path from "node:path";
import mime from "mime-to-extensions";
import { createLogger } from "./logger.js";

const log = createLogger("media-downloader");

// ─── 类型 ───

export type MediaCategory = "photos" | "videos" | "stickers" | "documents" | "other";

export interface MediaFileInfo {
    /** 磁盘绝对路径 */
    path: string;
    /** 分类目录名 */
    category: MediaCategory;
    /** MIME 类型 */
    mimeType?: string;
    /** 文件大小 bytes */
    size: number;
}

export interface MediaSaveOptions {
    chatId?: string;
    messageId?: string;
    uniqueFileId: string;
    mediaType: string;
    mimeType?: string;
    /** 原始文件名（如 Telegram document.fileName），用于提取扩展名 */
    fileName?: string;
}

export interface MediaDownloaderConfig {
    /** 下载根目录。默认 "workspace/Downloads"，会被 resolve 为绝对路径 */
    downloadDir?: string;
    /** 文件保留天数。默认 3 */
    retentionDays?: number;
    /** 文件大小上限 (bytes)。默认 20MB */
    maxFileSize?: number;
}

// ─── 常量 ───

const DEFAULT_DOWNLOAD_DIR = "workspace/Downloads";
const DEFAULT_RETENTION_DAYS = 3;
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** mediaType → 分类目录 */
function categorize(mediaType: string): MediaCategory {
    switch (mediaType) {
        case "photo": return "photos";
        case "video": return "videos";
        case "sticker": return "stickers";
        case "document": return "documents";
        case "animation": return "other";
        default: return "other";
    }
}

/**
 * 解析文件扩展名（优先级：fileName → mime-db → .bin）
 */
function resolveExt(mimeType?: string, fileName?: string): string {
    // 1. 优先从原始文件名提取扩展名
    if (fileName) {
        const dotIdx = fileName.lastIndexOf(".");
        if (dotIdx > 0) {
            return fileName.slice(dotIdx).toLowerCase();
        }
    }
    // 2. 通过 mime-db 查询
    if (mimeType) {
        const ext = mime.extension(mimeType);
        if (ext) return `.${ext}`;
    }
    // 3. fallback
    return ".bin";
}

// ─── MediaDownloader ───

export class MediaDownloader {
    private readonly downloadDir: string;
    private readonly retentionDays: number;
    private readonly maxFileSize: number;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    /** uniqueFileId → relative path 索引 (内存) */
    private readonly pathIndex = new Map<string, string>();

    constructor(config?: MediaDownloaderConfig) {
        // 始终 resolve 为绝对路径，确保从任意 cwd 都能正确访问
        this.downloadDir = path.resolve(config?.downloadDir ?? DEFAULT_DOWNLOAD_DIR);
        this.retentionDays = config?.retentionDays ?? DEFAULT_RETENTION_DAYS;
        this.maxFileSize = config?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;

        // 确保目录存在
        for (const cat of ["photos", "videos", "stickers", "documents", "other"] as MediaCategory[]) {
            const dir = path.join(this.downloadDir, cat);
            try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
        }

        // 启动清理 + 建立索引
        this.rebuildIndex();
        this.cleanupExpired();

        this.cleanupTimer = setInterval(() => {
            this.cleanupExpired();
        }, CLEANUP_INTERVAL_MS);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    /**
     * 文件大小是否在下载限制内
     */
    isWithinSizeLimit(fileSize?: number): boolean {
        if (fileSize == null) return true; // 未知大小 → 尝试下载
        return fileSize <= this.maxFileSize;
    }

    /**
     * 获取最大文件大小限制 (bytes)
     */
    getMaxFileSize(): number {
        return this.maxFileSize;
    }

    /**
     * 检查文件是否已下载，返回路径或 null
     */
    getExistingPath(uniqueFileId: string): string | null {
        return this.pathIndex.get(uniqueFileId) ?? null;
    }

    /**
     * 保存媒体文件到磁盘
     *
     * @returns 保存信息 (路径、大小等)，或 null 如果超出大小限制
     */
    saveMedia(buffer: Buffer, opts: MediaSaveOptions): MediaFileInfo | null {
        // 大小检查
        if (buffer.length > this.maxFileSize) {
            log.debug("saveMedia: 超出大小限制", {
                uniqueFileId: opts.uniqueFileId,
                size: buffer.length,
                limit: this.maxFileSize,
            });
            return null;
        }

        // 去重
        const existing = this.pathIndex.get(opts.uniqueFileId);
        if (existing) {
            try {
                if (fs.existsSync(existing)) {
                    const stat = fs.statSync(existing);
                    return {
                        path: existing,
                        category: categorize(opts.mediaType),
                        mimeType: opts.mimeType,
                        size: stat.size,
                    };
                }
            } catch { /* 文件可能已被清理 */ }
            this.pathIndex.delete(opts.uniqueFileId);
        }

        const category = categorize(opts.mediaType);
        const ext = resolveExt(opts.mimeType, opts.fileName);
        const chatId = opts.chatId ?? "unknown";
        const msgId = opts.messageId ?? "0";
        // 清理 uniqueFileId 中的非法文件名字符
        const safeUniqueId = opts.uniqueFileId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileName = `${chatId}_${msgId}_${safeUniqueId}${ext}`;
        const filePath = path.join(this.downloadDir, category, fileName);

        try {
            fs.writeFileSync(filePath, buffer);
            this.pathIndex.set(opts.uniqueFileId, filePath);
            log.debug("saveMedia: 已保存", { filePath, size: buffer.length });
            return {
                path: filePath,
                category,
                mimeType: opts.mimeType,
                size: buffer.length,
            };
        } catch (err) {
            log.warn("saveMedia: 写入失败", { filePath, error: String(err) });
            return null;
        }
    }

    /**
     * 清理超过保留期的文件
     */
    cleanupExpired(): void {
        const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
        let removed = 0;

        for (const cat of ["photos", "videos", "stickers", "documents", "other"]) {
            const dir = path.join(this.downloadDir, cat);
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const filePath = path.join(dir, file);
                    try {
                        const stat = fs.statSync(filePath);
                        if (stat.isFile() && stat.mtimeMs < cutoffMs) {
                            fs.unlinkSync(filePath);
                            removed++;
                            // 从索引中移除
                            for (const [key, val] of this.pathIndex.entries()) {
                                if (val === filePath) {
                                    this.pathIndex.delete(key);
                                    break;
                                }
                            }
                        }
                    } catch { /* skip individual files */ }
                }
            } catch { /* dir might not exist yet */ }
        }

        if (removed > 0) {
            log.info("cleanupExpired: 已清理过期文件", { removed, retentionDays: this.retentionDays });
        }
    }

    /**
     * 从磁盘重建 uniqueFileId → path 索引
     * 通过解析文件名中的第三段 (chatId_msgId_uniqueFileId.ext) 提取
     */
    private rebuildIndex(): void {
        for (const cat of ["photos", "videos", "stickers", "documents", "other"]) {
            const dir = path.join(this.downloadDir, cat);
            try {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    // 文件名格式: chatId_msgId_uniqueFileId.ext
                    // uniqueFileId 部分从第二个 _ 之后到 .ext 之前
                    const dotIndex = file.lastIndexOf(".");
                    const base = dotIndex > 0 ? file.slice(0, dotIndex) : file;
                    const parts = base.split("_");
                    if (parts.length >= 3) {
                        // uniqueFileId 可能本身含下划线，取第三段及之后
                        const uniqueFileId = parts.slice(2).join("_");
                        this.pathIndex.set(uniqueFileId, path.join(dir, file));
                    }
                }
            } catch { /* ignore */ }
        }
        if (this.pathIndex.size > 0) {
            log.debug("rebuildIndex: 已索引文件", { count: this.pathIndex.size });
        }
    }

    /**
     * 停止定时清理
     */
    dispose(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
}
