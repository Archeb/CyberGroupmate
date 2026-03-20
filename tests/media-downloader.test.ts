/**
 * media-downloader.test.ts — MediaDownloader 单元测试
 */

import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MediaDownloader } from "../src/core/media-downloader.js";

const TEST_DIR = "/tmp/test-media-downloads";

describe("MediaDownloader", () => {
    let downloader: MediaDownloader;

    before(() => {
        // 清理测试目录
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    after(() => {
        downloader?.dispose();
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("should create download directories on construction", () => {
        downloader = new MediaDownloader({ downloadDir: TEST_DIR, retentionDays: 1 });

        for (const cat of ["photos", "videos", "stickers", "documents", "other"]) {
            assert.ok(
                fs.existsSync(path.join(TEST_DIR, cat)),
                `Directory ${cat} should exist`,
            );
        }
    });

    it("should save media to correct category with correct filename", () => {
        const buffer = Buffer.from("fake image data");
        const result = downloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "456",
            uniqueFileId: "abc123",
            mediaType: "photo",
            mimeType: "image/jpeg",
        });

        assert.ok(result !== null);
        assert.equal(result!.category, "photos");
        assert.ok(result!.path.endsWith(".jpeg"), `Expected .jpeg extension, got ${result!.path}`);
        assert.ok(result!.path.includes("abc123"));
        assert.equal(result!.size, buffer.length);
        assert.ok(fs.existsSync(result!.path));
    });

    it("should dedup by uniqueFileId", () => {
        const buffer = Buffer.from("more data");
        const result1 = downloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "789",
            uniqueFileId: "dedup_test",
            mediaType: "document",
            mimeType: "application/pdf",
        });
        assert.ok(result1 !== null);

        const result2 = downloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "999",
            uniqueFileId: "dedup_test",
            mediaType: "document",
            mimeType: "application/pdf",
        });
        assert.ok(result2 !== null);

        // Same path (deduped)
        assert.equal(result1!.path, result2!.path);
    });

    it("should return null for files exceeding size limit", () => {
        const smallDownloader = new MediaDownloader({
            downloadDir: TEST_DIR,
            maxFileSize: 10,
            retentionDays: 1,
        });

        const buffer = Buffer.alloc(20); // 20 bytes > 10 byte limit
        const result = smallDownloader.saveMedia(buffer, {
            chatId: "-100123",
            messageId: "100",
            uniqueFileId: "toobig",
            mediaType: "video",
            mimeType: "video/mp4",
        });
        assert.equal(result, null);
        smallDownloader.dispose();
    });

    it("should check size limits correctly", () => {
        assert.equal(downloader.isWithinSizeLimit(100), true);
        assert.equal(downloader.isWithinSizeLimit(undefined), true);
        assert.equal(downloader.isWithinSizeLimit(100 * 1024 * 1024), false);
    });

    it("should find existing files by uniqueFileId", () => {
        const existing = downloader.getExistingPath("abc123");
        assert.ok(existing !== null);
        assert.ok(existing!.includes("abc123"));

        const notFound = downloader.getExistingPath("nonexistent");
        assert.equal(notFound, null);
    });

    it("should categorize different media types correctly", () => {
        const testCases = [
            { mediaType: "video", mimeType: "video/mp4", expectedCat: "videos", ext: ".mp4" },
            { mediaType: "sticker", mimeType: "image/webp", expectedCat: "stickers", ext: ".webp" },
            { mediaType: "animation", mimeType: "video/mp4", expectedCat: "other", ext: ".mp4" },
        ];

        for (const tc of testCases) {
            const result = downloader.saveMedia(Buffer.from("test"), {
                chatId: "1",
                messageId: "1",
                uniqueFileId: `cat_test_${tc.mediaType}`,
                mediaType: tc.mediaType,
                mimeType: tc.mimeType,
            });
            assert.ok(result !== null, `Should save ${tc.mediaType}`);
            assert.equal(result!.category, tc.expectedCat, `${tc.mediaType} → ${tc.expectedCat}`);
            assert.ok(result!.path.endsWith(tc.ext), `${tc.mediaType} should have ${tc.ext} ext`);
        }
    });

    it("should cleanup expired files", () => {
        // Create a file and backdate its mtime to 5 days ago
        const buffer = Buffer.from("old file");
        const result = downloader.saveMedia(buffer, {
            chatId: "1",
            messageId: "1",
            uniqueFileId: "old_file_test",
            mediaType: "photo",
            mimeType: "image/png",
        });
        assert.ok(result !== null);

        // Backdate the file
        const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
        fs.utimesSync(result!.path, fiveDaysAgo, fiveDaysAgo);

        // Run cleanup (retention = 1 day)
        downloader.cleanupExpired();

        // File should be deleted
        assert.equal(fs.existsSync(result!.path), false, "Expired file should be deleted");
        assert.equal(downloader.getExistingPath("old_file_test"), null, "Index should be cleared");
    });
});
