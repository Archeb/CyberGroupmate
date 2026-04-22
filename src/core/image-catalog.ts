/**
 * image-catalog.ts — 独立图片目录数据库
 *
 * 管理待判定和已判定的图片，与 memory.db 完全隔离。
 * 确认是表情包的图片才提升到正式贴纸库 (sticker_descriptions)。
 *
 * 数据库文件: data/image-catalog.db
 */

import Database from "better-sqlite3";
import { createLogger } from "./logger.js";
import { findSimilarEntries, hammingDistance, type SimilarityResult } from "./perceptual-hash.js";

const log = createLogger("image-catalog");

// ─── 类型 ───

export interface ImageCatalogEntry {
    contentHash: string;
    phash: string | null;
    dhash: string | null;
    sourcePlatform: string;
    sourceChatId: string | null;
    uniqueFileId: string | null;
    filePath: string | null;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    fileSize: number | null;
    frequency: number;
    isSticker: number | null;
    description: string | null;
    emoji: string | null;
    promotedAt: string | null;
    createdAt: string;
    lastSeenAt: string;
}

export interface RecordSightingParams {
    contentHash: string;
    phash?: string;
    dhash?: string;
    sourcePlatform: string;
    sourceChatId?: string;
    uniqueFileId?: string;
    filePath?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    fileSize?: number;
    messageId?: string;
}

export interface RecordSightingResult {
    isNew: boolean;
    frequency: number;
    isSticker: number | null;
    needsClassification: boolean;
}

export interface StickerVerdictParams {
    contentHash: string;
    isSticker: boolean;
    description?: string;
    emoji?: string;
}

// ─── ImageCatalog ───

export class ImageCatalog {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
        log.info("ImageCatalog 初始化完成", { dbPath });
    }

    private initTables(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS image_catalog (
                content_hash TEXT PRIMARY KEY,
                phash TEXT,
                dhash TEXT,
                source_platform TEXT NOT NULL,
                source_chat_id TEXT,
                unique_file_id TEXT,
                file_path TEXT,
                mime_type TEXT,
                width INTEGER,
                height INTEGER,
                file_size INTEGER,
                frequency INTEGER DEFAULT 1,
                is_sticker INTEGER DEFAULT NULL,
                description TEXT,
                emoji TEXT,
                promoted_at TEXT,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS image_sightings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content_hash TEXT NOT NULL REFERENCES image_catalog(content_hash),
                chat_id TEXT NOT NULL,
                message_id TEXT,
                seen_at TEXT NOT NULL,
                UNIQUE(content_hash, chat_id, message_id)
            );

            CREATE INDEX IF NOT EXISTS idx_image_catalog_phash ON image_catalog(phash);
            CREATE INDEX IF NOT EXISTS idx_image_catalog_dhash ON image_catalog(dhash);
            CREATE INDEX IF NOT EXISTS idx_image_catalog_is_sticker ON image_catalog(is_sticker);
            CREATE INDEX IF NOT EXISTS idx_image_sightings_hash ON image_sightings(content_hash);
        `);

        try { this.db.exec(`ALTER TABLE image_catalog ADD COLUMN phash TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE image_catalog ADD COLUMN dhash TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE image_catalog ADD COLUMN width INTEGER`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE image_catalog ADD COLUMN height INTEGER`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE image_catalog ADD COLUMN file_size INTEGER`); } catch { /* 列已存在 */ }
        try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_image_catalog_phash ON image_catalog(phash)`); } catch { /* index exists */ }
    }

    recordSighting(params: RecordSightingParams): RecordSightingResult {
        const now = new Date().toISOString();
        const existing = this.db.prepare(
            "SELECT frequency, is_sticker, unique_file_id, file_path FROM image_catalog WHERE content_hash = ?"
        ).get(params.contentHash) as { frequency: number; is_sticker: number | null; unique_file_id: string | null; file_path: string | null } | undefined;

        if (existing) {
            const newFreq = existing.frequency + 1;
            const updateFields: string[] = ["frequency = ?", "last_seen_at = ?"];
            const updateValues: unknown[] = [newFreq, now];

            if (params.phash && !this.db.prepare("SELECT phash FROM image_catalog WHERE content_hash = ? AND phash IS NOT NULL").get(params.contentHash)) {
                updateFields.push("phash = ?");
                updateValues.push(params.phash);
            }
            if (params.dhash && !this.db.prepare("SELECT dhash FROM image_catalog WHERE content_hash = ? AND dhash IS NOT NULL").get(params.contentHash)) {
                updateFields.push("dhash = ?");
                updateValues.push(params.dhash);
            }
            if (params.filePath && !existing.file_path) {
                updateFields.push("file_path = ?");
                updateValues.push(params.filePath);
            }
            if (params.uniqueFileId && !existing.unique_file_id) {
                updateFields.push("unique_file_id = ?");
                updateValues.push(params.uniqueFileId);
            }

            updateValues.push(params.contentHash);
            this.db.prepare(`UPDATE image_catalog SET ${updateFields.join(", ")} WHERE content_hash = ?`).run(...updateValues);

            if (params.sourceChatId && params.messageId) {
                try {
                    this.db.prepare(
                        "INSERT OR IGNORE INTO image_sightings (content_hash, chat_id, message_id, seen_at) VALUES (?, ?, ?, ?)"
                    ).run(params.contentHash, params.sourceChatId, params.messageId, now);
                } catch { /* ignore duplicate */ }
            }

            const needsClassification = existing.is_sticker === null && newFreq >= 3;
            return { isNew: false, frequency: newFreq, isSticker: existing.is_sticker, needsClassification };
        }

        this.db.prepare(`
            INSERT INTO image_catalog (content_hash, phash, dhash, source_platform, source_chat_id, unique_file_id, file_path, mime_type, width, height, file_size, frequency, is_sticker, created_at, last_seen_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
        `).run(
            params.contentHash,
            params.phash ?? null,
            params.dhash ?? null,
            params.sourcePlatform,
            params.sourceChatId ?? null,
            params.uniqueFileId ?? null,
            params.filePath ?? null,
            params.mimeType ?? null,
            params.width ?? null,
            params.height ?? null,
            params.fileSize ?? null,
            now, now,
        );

        if (params.sourceChatId && params.messageId) {
            this.db.prepare(
                "INSERT OR IGNORE INTO image_sightings (content_hash, chat_id, message_id, seen_at) VALUES (?, ?, ?, ?)"
            ).run(params.contentHash, params.sourceChatId, params.messageId, now);
        }

        return { isNew: true, frequency: 1, isSticker: null, needsClassification: false };
    }

    getPendingStickerCandidates(minFrequency: number): ImageCatalogEntry[] {
        const rows = this.db.prepare(
            "SELECT * FROM image_catalog WHERE is_sticker IS NULL AND frequency >= ? ORDER BY frequency DESC, last_seen_at DESC"
        ).all(minFrequency) as Record<string, unknown>[];
        return rows.map(r => this.rowToEntry(r));
    }

    setStickerVerdict(params: StickerVerdictParams): void {
        const isSticker = params.isSticker ? 1 : 0;
        const now = new Date().toISOString();
        if (params.description !== undefined) {
            this.db.prepare(
                "UPDATE image_catalog SET is_sticker = ?, description = ?, emoji = ?, last_seen_at = ? WHERE content_hash = ?"
            ).run(isSticker, params.description ?? null, params.emoji ?? null, now, params.contentHash);
        } else {
            this.db.prepare(
                "UPDATE image_catalog SET is_sticker = ?, last_seen_at = ? WHERE content_hash = ?"
            ).run(isSticker, now, params.contentHash);
        }
        log.info("setStickerVerdict", { contentHash: params.contentHash, isSticker: params.isSticker, descPreview: params.description?.slice(0, 50) });
    }

    getByContentHash(contentHash: string): ImageCatalogEntry | null {
        const row = this.db.prepare("SELECT * FROM image_catalog WHERE content_hash = ?").get(contentHash) as Record<string, unknown> | undefined;
        return row ? this.rowToEntry(row) : null;
    }

    getStickerEntries(): ImageCatalogEntry[] {
        const rows = this.db.prepare(
            "SELECT * FROM image_catalog WHERE is_sticker = 1 ORDER BY promoted_at DESC NULLS LAST, last_seen_at DESC"
        ).all() as Record<string, unknown>[];
        return rows.map(r => this.rowToEntry(r));
    }

    getAllEntries(limit = 100, offset = 0): { items: ImageCatalogEntry[]; total: number } {
        const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM image_catalog").get() as { cnt: number }).cnt;
        const rows = this.db.prepare("SELECT * FROM image_catalog ORDER BY last_seen_at DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
        return { items: rows.map(r => this.rowToEntry(r)), total };
    }

    markPromoted(contentHash: string, uniqueFileId: string, filePath: string): void {
        const now = new Date().toISOString();
        this.db.prepare(
            "UPDATE image_catalog SET promoted_at = ?, unique_file_id = ?, file_path = ? WHERE content_hash = ?"
        ).run(now, uniqueFileId, filePath, contentHash);
        log.info("markPromoted", { contentHash, uniqueFileId, filePath });
    }

    findSimilar(phash: string | null, dhash: string | null, maxPHashDistance: number = 14, maxDHashDistance: number = 10): SimilarityResult[] {
        if (!phash && !dhash) return [];
        const allRows = this.db.prepare(
            "SELECT * FROM image_catalog WHERE phash IS NOT NULL OR dhash IS NOT NULL"
        ).all() as Record<string, unknown>[];
        const entries = allRows.map(r => this.rowToEntry(r));
        return findSimilarEntries(entries, phash, dhash, maxPHashDistance, maxDHashDistance);
    }

    updateHashes(contentHash: string, phash: string | null, dhash: string | null): void {
        const fields: string[] = [];
        const values: unknown[] = [];
        if (phash !== undefined) { fields.push("phash = ?"); values.push(phash); }
        if (dhash !== undefined) { fields.push("dhash = ?"); values.push(dhash); }
        if (fields.length === 0) return;
        values.push(contentHash);
        this.db.prepare(`UPDATE image_catalog SET ${fields.join(", ")} WHERE content_hash = ?`).run(...values);
    }

    updateFilePath(contentHash: string, filePath: string): void {
        this.db.prepare("UPDATE image_catalog SET file_path = ? WHERE content_hash = ?").run(filePath, contentHash);
    }

    getStats(): {
        totalImages: number;
        pendingCandidates: number;
        confirmedStickers: number;
        rejectedImages: number;
        unclassified: number;
        recentPromotions: Array<{ contentHash: string; description: string | null; emoji: string | null; promotedAt: string | null }>;
    } {
        const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM image_catalog").get() as { cnt: number }).cnt;
        const confirmed = (this.db.prepare("SELECT COUNT(*) as cnt FROM image_catalog WHERE is_sticker = 1").get() as { cnt: number }).cnt;
        const rejected = (this.db.prepare("SELECT COUNT(*) as cnt FROM image_catalog WHERE is_sticker = 0").get() as { cnt: number }).cnt;
        const unclassified = (this.db.prepare("SELECT COUNT(*) as cnt FROM image_catalog WHERE is_sticker IS NULL").get() as { cnt: number }).cnt;
        const pending = (this.db.prepare("SELECT COUNT(*) as cnt FROM image_catalog WHERE is_sticker IS NULL AND frequency >= 3").get() as { cnt: number }).cnt;
        const recentRows = this.db.prepare(
            "SELECT content_hash, description, emoji, promoted_at FROM image_catalog WHERE is_sticker = 1 AND promoted_at IS NOT NULL ORDER BY promoted_at DESC LIMIT 5"
        ).all() as Array<{ content_hash: string; description: string | null; emoji: string | null; promoted_at: string | null }>;
        return {
            totalImages: total,
            pendingCandidates: pending,
            confirmedStickers: confirmed,
            rejectedImages: rejected,
            unclassified,
            recentPromotions: recentRows.map(r => ({
                contentHash: r.content_hash,
                description: r.description,
                emoji: r.emoji,
                promotedAt: r.promoted_at,
            })),
        };
    }

    cleanup(retentionDays: number): number {
        const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const cutoffStr = new Date(cutoffMs).toISOString();
        const result = this.db.prepare(
            "DELETE FROM image_catalog WHERE is_sticker = 0 AND last_seen_at < ?"
        ).run(cutoffStr);
        if (result.changes > 0) {
            this.db.prepare("DELETE FROM image_sightings WHERE content_hash NOT IN (SELECT content_hash FROM image_catalog)").run();
            log.info("cleanup: 已清理过期非表情包条目", { removed: result.changes, retentionDays });
        }
        return result.changes;
    }

    dispose(): void {
        this.db.close();
    }

    private rowToEntry(r: Record<string, unknown>): ImageCatalogEntry {
        return {
            contentHash: r.content_hash as string,
            phash: (r.phash as string) ?? null,
            dhash: (r.dhash as string) ?? null,
            sourcePlatform: r.source_platform as string,
            sourceChatId: (r.source_chat_id as string) ?? null,
            uniqueFileId: (r.unique_file_id as string) ?? null,
            filePath: (r.file_path as string) ?? null,
            mimeType: (r.mime_type as string) ?? null,
            width: (r.width as number) ?? null,
            height: (r.height as number) ?? null,
            fileSize: (r.file_size as number) ?? null,
            frequency: r.frequency as number,
            isSticker: r.is_sticker as number | null,
            description: (r.description as string) ?? null,
            emoji: (r.emoji as string) ?? null,
            promotedAt: (r.promoted_at as string) ?? null,
            createdAt: r.created_at as string,
            lastSeenAt: r.last_seen_at as string,
        };
    }
}
