import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RecordingPipeline } from "../src/pipeline/recording-pipeline.js";
import { TopicRegistry } from "../src/pipeline/topic-registry.js";
import type { Message } from "../src/pipeline/types.js";

describe("recording pipeline message enrichment", () => {
    it("formats cluster/triage messages through message-enricher with reply and sticker cache context", async () => {
        const registry = new TopicRegistry();
        const memory = {
            getStickerDescription(uniqueFileId: string) {
                return uniqueFileId === "sticker-known"
                    ? { description: "怀疑地皱眉打量，表示不太相信", emojis: ["🤨"] }
                    : null;
            },
            getMessagesByIds() {
                return [];
            },
        };
        const pipeline = new RecordingPipeline(registry, "Miu", "Miu", memory as any);
        const now = Date.now();
        const messages: Message[] = [
            {
                id: "4120",
                chatId: "telegram:-100",
                senderId: "u1",
                senderName: "莫思奇多",
                text: "[📷 图片]",
                timestamp: now,
                mediaType: "photo",
                mediaInfo: JSON.stringify({
                    type: "photo",
                    fileId: "photo-file",
                    uniqueFileId: "photo-unique",
                }),
            },
            {
                id: "4123",
                chatId: "telegram:-100",
                senderId: "u2",
                senderName: "Soha Jin",
                text: "[🎭 贴纸: sticker-known]",
                replyToMessageId: "4120",
                timestamp: now + 1_000,
                mediaType: "sticker",
                mediaInfo: JSON.stringify({
                    type: "sticker",
                    fileId: "file-sticker",
                    uniqueFileId: "sticker-known",
                    emoji: "🤨",
                }),
            },
        ];

        const context = await (pipeline as any).buildRecordingMessageContext(messages, "telegram:-100");

        assert.match(context.formattedText, /\[msgId:4120\] 莫思奇多 \[userId:telegram:u1\]: \[📷 图片\]/);
        assert.match(
            context.formattedText,
            /\[msgId:4123\] Soha Jin \[userId:telegram:u2\] \(↩ reply to 莫思奇多 \[userId:telegram:u1\] #4120: "\[📷 图片\]"\): \[🎭 贴纸 🤨: 怀疑地皱眉打量，表示不太相信\]/,
        );
        assert.equal(
            context.formattedMessagesById.get("4123")?.includes("sticker-known"),
            false,
        );
    });

    it("stores enriched recentContext lines in topic registry updates", () => {
        const registry = new TopicRegistry();
        const pipeline = new RecordingPipeline(registry);
        const messages: Message[] = [{
            id: "4123",
            chatId: "telegram:-100",
            senderId: "u2",
            senderName: "Soha Jin",
            text: "[🎭 贴纸: sticker-known]",
            timestamp: Date.now(),
            mediaType: "sticker",
        }];
        const formattedMessagesById = new Map<string, string>([[
            "4123",
            "[21:45] [msgId:4123] Soha Jin: [🎭 贴纸 🤨: 怀疑地皱眉打量，表示不太相信]",
        ]]);

        const result = (pipeline as any).updateRegistry("telegram:-100", messages, {
            assignments: [
                { messageId: "4123", topicId: "NEW_1", topicLabel: "Prompt 质量讨论", keywords: ["prompt"] },
            ],
            evolutions: [],
        }, {
            topics: [],
        }, formattedMessagesById);

        assert.equal(result.topics.length, 1);
        assert.match(result.topics[0].recentContext, /怀疑地皱眉打量/);
        assert.doesNotMatch(result.topics[0].recentContext, /sticker-known/);
    });
});
