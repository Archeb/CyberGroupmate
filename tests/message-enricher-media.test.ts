import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enrichMessages } from "../src/core/message-enricher.js";
import { MediaDownloader } from "../src/core/media-downloader.js";
import type { LLMConfig } from "../src/core/config.js";

const llmConfig = { provider: "openai", model: "test" } as LLMConfig;
const TEST_DIR = join(tmpdir(), "cybergroupmate-enricher-media-test");

describe("message-enricher media downloads", () => {
    after(() => {
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it("prints eager-downloaded audio file paths in target messages", async () => {
        const filePath = join(TEST_DIR, "voice.ogg");
        const result = await enrichMessages([
            {
                id: "7387",
                sender: "莫思奇多",
                text: "[🎙 语音/音频]",
                timestamp: "2026-05-02T06:58:13.000Z",
                mediaType: "audio",
                mediaInfo: JSON.stringify({
                    type: "audio",
                    fileId: "file-audio",
                    uniqueFileId: "unique-audio",
                    mimeType: "audio/ogg",
                    filePath,
                    downloadStatus: "downloaded",
                }),
            },
        ], {
            llmConfig,
            enableOgPreview: false,
        });

        assert.match(result.formattedText, /\[🎙 语音\/音频\] 文件: /);
        assert.match(result.formattedText, /voice\.ogg/);
        assert.doesNotMatch(result.formattedText, /\[📎 audio\]/);
    });

    it("downloads unknown media and prints the saved path", async () => {
        try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
        const downloader = new MediaDownloader({ downloadDir: TEST_DIR, retentionDays: 1, maxFileSize: 20 * 1024 * 1024 });
        try {
            const result = await enrichMessages([
                {
                    id: "9",
                    sender: "Alice",
                    text: "[📎 媒体]",
                    timestamp: "2026-05-02T06:58:13.000Z",
                    chatId: "telegram:-100",
                    mediaType: "other",
                    mediaInfo: JSON.stringify({
                        type: "other",
                        fileId: "file-other",
                        uniqueFileId: "unique-other",
                        mimeType: "application/octet-stream",
                    }),
                },
            ], {
                llmConfig,
                chatId: "telegram:-100",
                mediaDownloader: downloader,
                enableOgPreview: false,
                downloadFn: async (fileId, chatId, messageId, uniqueFileId) => {
                    assert.equal(fileId, "file-other");
                    assert.equal(chatId, "telegram:-100");
                    assert.equal(messageId, "9");
                    assert.equal(uniqueFileId, "unique-other");
                    return Buffer.from("unknown-media");
                },
            });

            assert.match(result.formattedText, /\[📎 媒体\] 文件: /);
            assert.match(result.formattedText, /unique-other/);
            assert.ok(downloader.getExistingPath("unique-other"));
        } finally {
            downloader.dispose();
        }
    });
});
