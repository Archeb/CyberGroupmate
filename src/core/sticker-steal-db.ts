/**
 * sticker-steal-db.ts — OneBot 偷表情包：图片出现次数追踪（独立 SQLite）
 *
 * 独立于 memory.db 的专用数据库，追踪 OneBot 群聊中图片的出现次数。
 * 同一图片（以 unique_file_id 去重）累计出现 N 次后触发 VLM 确认。
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("sticker-steal-db");

export interface ImageOccurrence {
    uniqueFileId: string;
    fileId: string;
    url?: string;
    occurrenceCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
}

export class StickerStealDB {
    private db: Database.Database;

    constructor(dbPath: string) {
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS image_occurrences (
                unique_file_id TEXT PRIMARY KEY,
                file_id TEXT NOT NULL,
                url TEXT,
                occurrence_count INTEGER DEFAULT 1,
                first_seen_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL
            )
        `);
        log.info("StickerStealDB 已初始化", { dbPath });
    }

    incrementImageOccurrence(uniqueFileId: string, fileId: string, url?: string): number {
        const now = new Date().toISOString();
        const existing = this.db.prepare(
            "SELECT occurrence_count FROM image_occurrences WHERE unique_file_id = ?"
        ).get(uniqueFileId) as { occurrence_count: number } | undefined;

        if (existing) {
            const newCount = existing.occurrence_count + 1;
            this.db.prepare(`
                UPDATE image_occurrences
                SET file_id = ?, url = ?, occurrence_count = ?, last_seen_at = ?
                WHERE unique_file_id = ?
            `).run(fileId, url ?? null, newCount, now, uniqueFileId);
            return newCount;
        }

        this.db.prepare(`
            INSERT INTO image_occurrences (unique_file_id, file_id, url, occurrence_count, first_seen_at, last_seen_at)
            VALUES (?, ?, ?, 1, ?, ?)
        `).run(uniqueFileId, fileId, url ?? null, now, now);
        return 1;
    }

    getImageOccurrence(uniqueFileId: string): ImageOccurrence | null {
        const row = this.db.prepare(
            "SELECT unique_file_id, file_id, url, occurrence_count, first_seen_at, last_seen_at FROM image_occurrences WHERE unique_file_id = ?"
        ).get(uniqueFileId) as { unique_file_id: string; file_id: string; url: string | null; occurrence_count: number; first_seen_at: string; last_seen_at: string } | undefined;
        if (!row) return null;
        return {
            uniqueFileId: row.unique_file_id,
            fileId: row.file_id,
            url: row.url ?? undefined,
            occurrenceCount: row.occurrence_count,
            firstSeenAt: row.first_seen_at,
            lastSeenAt: row.last_seen_at,
        };
    }

    removeImageOccurrence(uniqueFileId: string): void {
        this.db.prepare(
            "DELETE FROM image_occurrences WHERE unique_file_id = ?"
        ).run(uniqueFileId);
    }

    close(): void {
        this.db.close();
        log.info("StickerStealDB 已关闭");
    }
}
