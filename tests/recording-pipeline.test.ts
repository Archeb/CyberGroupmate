import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RecordingPipeline } from "../src/pipeline/recording-pipeline.js";
import { TopicRegistry } from "../src/pipeline/topic-registry.js";
import type { Message } from "../src/pipeline/types.js";

describe("RecordingPipeline", () => {
    it("should not emit triage-passed for messages already handled by FAST_PATH", async () => {
        const registry = new TopicRegistry();
        const pipeline = new RecordingPipeline(
            registry,
            {
                provider: "openai",
                baseUrl: "https://example.invalid/v1",
                apiKey: "test-key",
                model: "gpt-test",
                temperature: 0.1,
                maxTokens: 512,
            },
            "赛博群友",
        );

        (pipeline as any).llmTopicClustering = async (messages: Message[]) => ({
            assignments: messages.map((message) => ({
                messageId: message.id,
                topicId: "NEW_1",
                topicLabel: "私聊召唤",
                keywords: ["在吗"],
            })),
            evolutions: [],
        });

        (pipeline as any).llmTopicSummaryTriage = async () => ({
            topics: [{
                topicId: "NEW_1",
                summary: "用户在私聊召唤 agent。",
                should_intervene: true,
                reason: "私聊直接消息",
            }],
        });

        let emitted = false;
        pipeline.on("topics:triage-passed", () => {
            emitted = true;
        });

        pipeline.addMessageDirect({
            id: "m1",
            chatId: "682932098",
            senderId: "682932098",
            senderName: "莫思奇多",
            text: "在吗在吗",
            timestamp: Date.now(),
            scene: "telegram",
            platform: "telegram",
            chatType: "private",
            isDirectMessage: true,
            _viaFastPath: true,
        });

        await pipeline.flush();

        assert.equal(emitted, false);
        const topics = registry.getByChat("682932098");
        assert.equal(topics.length, 1);
        assert.equal(topics[0].state, "IGNORED");
        assert.equal(topics[0].decision?.reason, "already handled via fast path");
    });
});
