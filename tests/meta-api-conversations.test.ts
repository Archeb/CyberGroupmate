import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createConversationsApi } from "../src/meta-sandbox/meta-api/conversations.js";
import { createTestMemory, cleanupTestMemory } from "./helpers/test-db.js";
import type { MemoryStoreV2 } from "../src/memory-v2/index.js";

describe("createConversationsApi", () => {
    let memory: MemoryStoreV2;

    before(() => {
        memory = createTestMemory("meta-api-conversations");

        memory.storeMessageBatch([
            {
                messageId: "g1-1",
                chatId: "g1",
                userId: "u1",
                displayName: "Alice",
                text: "周五团建要不要去露营？",
                timestamp: "2026-01-02T10:00:00Z",
            },
            {
                messageId: "g2-1",
                chatId: "g2",
                userId: "u2",
                displayName: "Bob",
                text: "团建之后继续聊 Python TypeError。",
                timestamp: "2026-01-02T11:00:00Z",
            },
            {
                messageId: "g2-2",
                chatId: "g2",
                userId: "u2",
                displayName: "Bob",
                text: "我这周五白天都在公司。",
                timestamp: "2026-01-01T08:00:00Z",
            },
        ]);

        memory.upsertTopic("topic_team_g1", {
            chatId: "g1",
            label: "团建安排",
            summary: "讨论周五团建和露营地点",
            keywords: ["团建", "露营", "周五"],
            participants: ["u1"],
            messageRange: { messageIds: ["g1-1"], count: 1 },
            startedAt: "2026-01-02T10:00:00Z",
        });
        memory.upsertTopic("topic_team_g2", {
            chatId: "g2",
            label: "团建后技术闲聊",
            summary: "先聊团建，再转到 Python TypeError",
            keywords: ["团建", "Python", "TypeError"],
            participants: ["u2"],
            messageRange: { messageIds: ["g2-1", "g2-2"], count: 2 },
            startedAt: "2026-01-02T11:00:00Z",
        });
    });

    after(() => {
        cleanupTestMemory(memory, "meta-api-conversations");
    });

    it("queries messages and topics across chats by keyword", async () => {
        const api = createConversationsApi(memory);
        const result = await api.query({ keywords: ["团建"], limit: 10 });

        assert.equal(result.messages.length, 2);
        assert.equal(result.topics.length, 2);
        assert.deepEqual(result.messages.map((row) => row.chatId), ["g2", "g1"]);
        assert.deepEqual(result.topics.map((row) => row.chatId), ["g2", "g1"]);
    });

    it("falls back to recent lists when no keyword is provided", async () => {
        const api = createConversationsApi(memory);
        const result = await api.query({ chatIds: ["g2"], userId: "u2", limit: 5 });

        assert.equal(result.messages.length, 2);
        assert.equal(result.topics.length, 1);
        assert.equal(result.messages[0].messageId, "g2-1");
        assert.equal(result.topics[0].topicId.length > 0, true);
        assert.equal(result.topics[0].label, "团建后技术闲聊");
    });
});