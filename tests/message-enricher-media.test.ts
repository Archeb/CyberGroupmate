import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enrichMessages, formatMessageBody, formatMessages } from "../src/core/message-enricher.js";
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

describe("media placeholder summaries", () => {
    const message = (attachments: unknown[], text = "看看 [📷 图片]") => ({
        id: "multi-summary",
        sender: "Alice",
        text,
        mediaType: "photo",
        mediaInfo: JSON.stringify({ type: "photo", fileId: "first", attachments }),
    });

    it("counts the attachment list without counting the legacy first item twice", () => {
        const result = formatMessageBody(message([
            { type: "photo", fileId: "first" },
            { type: "photo", fileId: "second" },
        ]), { includeMediaTags: true });
        assert.equal(result, "看看 [📷 图片×2]");
    });

    it("groups mixed media and replaces existing tags while ignoring invalid attachments", () => {
        const result = formatMessageBody(message([
            { type: "photo", fileId: "first" },
            { type: "sticker", fileId: "sticker" },
            { type: "video", fileId: "video-1" },
            { type: "photo", fileId: "second" },
            { type: "video", fileId: "video-2" },
            { type: "audio", fileId: "audio" },
            { type: "document", fileId: "document" },
            { type: "animation", fileId: "gif" },
            null,
            { type: "photo" },
            { fileId: "missing-type" },
        ], "@Bob 看看 [📷 图片] [📹 视频]"), { includeMediaTags: true });
        assert.equal(result, "@Bob 看看 [📷 图片×2] [🎭 贴纸×1] [📹 视频×2] [🎙 语音/音频×1] [📎 文件×1] [🎬 GIF×1]");
    });

    it("keeps repeated formatting and cache-only message formatting consistent", () => {
        const original = message([
            { type: "photo", fileId: "first" },
            { type: "video", fileId: "video" },
        ]);
        const first = formatMessageBody(original, { includeMediaTags: true });
        const second = formatMessageBody({ ...original, text: first }, { includeMediaTags: true });
        assert.equal(first, "看看 [📷 图片×1] [📹 视频×1]");
        assert.equal(second, first);
        assert.ok(formatMessages([original], []).endsWith(`: ${first}`));
    });

    it("preserves legacy single media labels when the envelope has only one valid attachment", () => {
        assert.equal(formatMessageBody(message([
            { type: "photo", fileId: "first" },
            { type: "photo" },
        ]), { includeMediaTags: true }), "看看 [📷 图片]");
        assert.equal(formatMessageBody({ text: "看看", mediaType: "video", mediaInfo: "invalid-json" }, { includeMediaTags: true }), "看看 [📹 视频]");
    });

    it("preserves the cached description of a single sticker", () => {
        const result = formatMessageBody({
            text: "[🎭 贴纸]",
            mediaType: "sticker",
            mediaInfo: JSON.stringify({ type: "sticker", fileId: "sticker", uniqueFileId: "known" }),
        }, {
            includeMediaTags: true,
            stickerDescriptionLookup: {
                getStickerDescription: id => id === "known" ? { description: "挥手", emojis: ["👋"] } : null,
            },
        });
        assert.equal(result, "[🎭 贴纸 👋: 挥手]");
    });

    it("removes counted placeholders after media descriptions are available", () => {
        const result = formatMessages([{
            ...message([
                { type: "photo", fileId: "first" },
                { type: "photo", fileId: "second" },
            ], "看看 [📷 图片×2]"),
            processedMedia: [
                { index: 0, description: "第一张", filePath: "/tmp/first.png" },
                { index: 0, description: "第二张", filePath: "/tmp/second.png" },
            ],
        }], []);
        assert.doesNotMatch(result, /×2/);
        assert.match(result, /第一张/);
        assert.match(result, /第二张/);
    });
});
