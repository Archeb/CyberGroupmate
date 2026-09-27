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

    it("keeps multiple attachments from one message associated with their own files", async () => {
        const directory = join(TEST_DIR, "multi-attachment");
        try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
        const downloader = new MediaDownloader({ downloadDir: directory, retentionDays: 1, maxFileSize: 20 * 1024 * 1024 });
        try {
            const result = await enrichMessages([{
                id: "multi",
                sender: "Alice",
                text: "",
                timestamp: "2026-05-02T06:58:13.000Z",
                chatId: "feishu:oc_test",
                mediaType: "photo",
                mediaInfo: JSON.stringify({
                    type: "photo",
                    fileId: "image-a",
                    uniqueFileId: "unique-a",
                    mimeType: "image/png",
                    attachments: [
                        { type: "photo", fileId: "image-a", uniqueFileId: "unique-a", mimeType: "image/png" },
                        { type: "photo", fileId: "image-b", uniqueFileId: "unique-b", mimeType: "image/png" },
                    ],
                }),
            }], {
                llmConfig: { ...llmConfig, vision: true },
                chatId: "feishu:oc_test",
                mediaDownloader: downloader,
                enableOgPreview: false,
                downloadFn: async fileId => Buffer.from(fileId),
            });

            const first = downloader.getExistingPath("unique-a");
            const second = downloader.getExistingPath("unique-b");
            assert.ok(first);
            assert.ok(second);
            assert.notEqual(first, second);
            assert.deepEqual(fs.readFileSync(first), Buffer.from("image-a"));
            assert.deepEqual(fs.readFileSync(second), Buffer.from("image-b"));
            assert.equal(result.imageParts.length, 2);
        } finally {
            downloader.dispose();
        }
    });

    it("keeps Feishu sticker download identity separate from its sendable reference", async () => {
        const lookups: string[] = [];
        const downloadIdentities: string[] = [];
        await enrichMessages([{
            id: "om_sticker",
            sender: "Alice",
            text: "[Sticker: sticker_key]",
            timestamp: "2026-05-27T03:51:00.000Z",
            chatId: "feishu:oc_chat",
            mediaType: "sticker",
            mediaInfo: JSON.stringify({
                type: "sticker",
                fileId: "feishu-media:encoded",
                uniqueFileId: "feishu:hashed-identity",
                sendableFileId: "feishu-media:encoded",
            }),
        }], {
            llmConfig,
            visionConfig: { stickerMode: "vision_cache" },
            visionLlmConfig: llmConfig,
            stickerCache: {
                getStickerDescription: uniqueFileId => { lookups.push(uniqueFileId); return null; },
                setStickerDescription: () => {},
            },
            downloadFn: async (_fileId, _chatId, _messageId, uniqueFileId) => {
                downloadIdentities.push(String(uniqueFileId));
                throw new Error("stop after identity assertion");
            },
            enableOgPreview: false,
        });

        assert.equal(lookups[0], "feishu:hashed-identity");
        assert.deepEqual(downloadIdentities, ["feishu:hashed-identity"]);
    });

    it("uses cached sticker descriptions without leaking raw mediaInfo", async () => {
        const result = await enrichMessages([
            {
                id: "1167459",
                sender: "莫思奇多",
                text: "[🎭 贴纸: 🫶]",
                timestamp: "2026-05-27T03:51:00.000Z",
                chatId: "telegram:-100",
                mediaType: "sticker",
                mediaInfo: JSON.stringify({
                    type: "sticker",
                    fileId: "file-sticker",
                    uniqueFileId: "AgADzw4AAs9qqFY",
                    emoji: "🫶",
                    mimeType: "image/webp",
                }),
            },
        ], {
            llmConfig,
            visionConfig: { stickerMode: "vision_cache" },
            stickerCache: {
                getStickerDescription: (uniqueFileId: string) => uniqueFileId === "AgADzw4AAs9qqFY"
                    ? { description: "比心示好的温柔贴纸", emojis: ["🫶"] }
                    : null,
                setStickerDescription: () => {},
            },
            chatId: "telegram:-100",
            enableOgPreview: false,
        });

        assert.match(result.formattedText, /贴纸 🫶: 比心示好的温柔贴纸/);
        assert.doesNotMatch(result.formattedText, /fileId/);
        assert.doesNotMatch(result.formattedText, /AgADzw4AAs9qqFY/);
        assert.doesNotMatch(result.formattedText, /图片描述: \[🎭 贴纸/);
    });

    it("can run in cache-only formatting mode without media downloads", async () => {
        let downloadCalls = 0;
        const result = await enrichMessages([
            {
                id: "cache-only-sticker",
                sender: "Alice",
                text: "[🎭 贴纸: sticker-known]",
                timestamp: "2026-05-27T03:51:00.000Z",
                mediaType: "sticker",
                mediaInfo: JSON.stringify({
                    type: "sticker",
                    fileId: "file-sticker",
                    uniqueFileId: "sticker-known",
                    emoji: "🫶",
                }),
            },
        ], {
            llmConfig,
            stickerDescriptionLookup: {
                getStickerDescription: (uniqueFileId: string) => uniqueFileId === "sticker-known"
                    ? { description: "比心示好的温柔贴纸", emojis: ["🫶"] }
                    : null,
            },
            downloadFn: async () => {
                downloadCalls += 1;
                return Buffer.from("should-not-download");
            },
            enableMediaProcessing: false,
            enableMediaDownload: false,
            enableOgPreview: false,
        });

        assert.equal(downloadCalls, 0);
        assert.match(result.formattedText, /贴纸 🫶: 比心示好的温柔贴纸/);
        assert.doesNotMatch(result.formattedText, /贴纸: sticker-known/);
        assert.doesNotMatch(result.formattedText, /file-sticker/);
    });

    it("uses the sent sticker id for cache lookup when Telegram returns a different uniqueFileId", async () => {
        let downloadCalls = 0;
        const result = await enrichMessages([
            {
                id: "4059",
                sender: "Miu",
                text: "[🎭 贴纸: AgADdg0AAvE2QVQ]",
                timestamp: "2026-05-27T13:24:04.000Z",
                mediaType: "sticker",
                mediaInfo: JSON.stringify({
                    type: "sticker",
                    fileId: "CAACAgUAAyEGAASSDYs1AAIP22oW8HOv8YPnYqAcp_PDn3hSYL3sAALiHQACtJK5VIO-anIsyB9fOgQ",
                    uniqueFileId: "AgAD4h0AArSSuVQ",
                    fileName: "telegram_-1002984884196_550880_AgADdg0AAvE2QVQ.webp",
                    mimeType: "image/webp",
                }),
            },
        ], {
            llmConfig,
            visionConfig: { stickerMode: "vision_cache" },
            stickerCache: {
                getStickerDescription: (uniqueFileId: string) => uniqueFileId === "AgADdg0AAvE2QVQ"
                    ? { description: "惊讶、意外，带点紧张的小表情", emojis: ["😮", "😳"] }
                    : null,
                setStickerDescription: () => {},
            },
            downloadFn: async () => {
                downloadCalls += 1;
                return Buffer.from("should-not-download");
            },
            enableOgPreview: false,
        });

        assert.equal(downloadCalls, 0);
        assert.match(result.formattedText, /贴纸 😮 😳: 惊讶、意外，带点紧张的小表情/);
        assert.doesNotMatch(result.formattedText, /AgADdg0AAvE2QVQ/);
        assert.doesNotMatch(result.formattedText, /AgAD4h0AArSSuVQ/);
    });
});
