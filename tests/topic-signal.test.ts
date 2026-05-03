import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculatePressure } from "../src/accumulator/pressure.js";
import { RecordingPipeline } from "../src/pipeline/recording-pipeline.js";
import { buildTopicSignalEntries } from "../src/pipeline/topic-signal.js";
import { TopicRegistry } from "../src/pipeline/topic-registry.js";
import type { Topic, Message } from "../src/pipeline/types.js";

describe("topic signal builder", () => {
    it("builds one signal per topic with real pressure inputs", () => {
        const messages: Message[] = [
            {
                id: "m1",
                chatId: "telegram:1",
                senderId: "42",
                senderName: "Alice",
                text: "今天晚上一起吃火锅吗",
                timestamp: 1,
            },
            {
                id: "m2",
                chatId: "telegram:1",
                senderId: "42",
                senderName: "Alice",
                text: "我可以现在订位",
                timestamp: 2,
            },
            {
                id: "m3",
                chatId: "telegram:1",
                senderId: "99",
                senderName: "Bob",
                text: "我也想去",
                timestamp: 3,
            },
        ];

        const topic: Topic = {
            id: "topic-1",
            chatId: "telegram:1",
            label: "今晚约饭",
            keywords: ["火锅", "约饭"],
            callbackPotential: 22,
            participantIds: new Set(["42", "99"]),
            messageIds: messages.map((message) => message.id),
            state: "ACTIVE",
            decision: { reason: "可以顺势确认时间和人数。" },
            createdAt: 1,
            lastActivityAt: 3,
            turnCount: 0,
            maxTurns: 0,
            pendingMessages: [],
            exitSignals: [],
            irrelevantStreak: 0,
            messageCount: 3,
            recentContext: "Alice 在组织今晚约饭，Bob 已明确响应。",
            lastSummary: "两个人正在敲定今晚火锅局。",
        };

        const entries = buildTopicSignalEntries({
            chatId: "telegram:1",
            topics: [topic],
            topicMessagesById: new Map([[topic.id, messages]]),
            profiles: [{
                userId: "telegram:42",
                chatId: "telegram:1",
                dunbarTier: 1,
            } as any],
            stickinessLevel: "FAMILIAR",
            now: 123,
        });

        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.topicId, topic.id);
        assert.equal(entries[0]?.reason, "可以顺势确认时间和人数。");
        assert.equal(entries[0]?.callbackPotential, 22);
        assert.equal(entries[0]?.payload.topicDigest.triageReason, "可以顺势确认时间和人数。");
        assert.deepEqual(entries[0]?.payload.pressureInput.participants, [
            {
                messageCount: 2,
                totalChars: "今天晚上一起吃火锅吗".length + "我可以现在订位".length,
                dunbarTier: 1,
            },
            {
                messageCount: 1,
                totalChars: "我也想去".length,
                dunbarTier: 4,
            },
        ]);
        assert.equal(
            entries[0]?.pressure,
            calculatePressure({
                participants: entries[0]!.payload.pressureInput.participants,
                stickinessLevel: "FAMILIAR",
                ageMinutes: 0,
                ignoredCount: 0,
            }),
        );
    });

    it("only promotes triaged topics with shouldSignal into signal-ready output", () => {
        const registry = new TopicRegistry();
        const pipeline = new RecordingPipeline(registry);
        const messages: Message[] = [
            {
                id: "m1",
                chatId: "telegram:1",
                senderId: "42",
                senderName: "Alice",
                text: "Miu 可以帮我看看这个问题吗",
                timestamp: 1,
            },
            {
                id: "m2",
                chatId: "telegram:1",
                senderId: "99",
                senderName: "Bob",
                text: "图片已经收到了，谢谢",
                timestamp: 2,
            },
        ];

        const result = (pipeline as any).updateRegistry("telegram:1", messages, {
            assignments: [
                { messageId: "m1", topicId: "NEW_1", topicLabel: "悬空求助", keywords: ["求助"] },
                { messageId: "m2", topicId: "NEW_2", topicLabel: "图片已收到", keywords: ["图片"] },
            ],
            evolutions: [],
        }, {
            topics: [
                {
                    topicId: "NEW_1",
                    summary: "Alice 有一个问题希望 Miu 帮忙看看。",
                    shouldSignal: true,
                    reason: "存在悬空求助，值得进入 L2 让 Meta 后续判断。",
                },
                {
                    topicId: "NEW_2",
                    summary: "Bob 已经收到图片并表示感谢。",
                    shouldSignal: false,
                    reason: "问题已解决，只需自然结束。",
                },
            ],
        });

        assert.equal(result.signalReadyTopics.length, 1);
        assert.equal(result.signalReadyTopics[0]?.label, "悬空求助");
    });
});
