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
            {
                messageId: "g1-2",
                chatId: "g1",
                userId: "u1",
                displayName: "Alice",
                text: "死亡读秒这个功能刚才有人提到。",
                timestamp: "2026-01-03T10:00:00Z",
            },
            {
                messageId: "g2-3",
                chatId: "g2",
                userId: "u2",
                displayName: "Bob",
                text: "windowserver 又开始占用很高。",
                timestamp: "2026-01-03T11:00:00Z",
            },
        ]);

        memory.upsertPersonIdentity("u1", {
            displayName: "Alice",
            aliases: ["爱丽丝"],
            lastSeenAt: "2026-01-02T10:00:00Z",
        });
        memory.upsertPersonIdentity("u2", {
            displayName: "Bob",
            aliases: ["Soha"],
            lastSeenAt: "2026-01-02T11:00:00Z",
        });
        memory.upsertGroupModel("g1", {
            chatTitle: "一号群",
        });
        memory.upsertGroupModel("g2", {
            chatTitle: "二号群",
        });

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
        const result = await api.query({ keyword: "团建", limit: 10 });

        assert.equal(result.messages.length, 2);
        assert.equal(result.topics.length, 2);
        assert.deepEqual(result.messages.map((row) => row.chatId), ["g2", "g1"]);
        assert.deepEqual(result.topics.map((row) => row.chatId), ["g2", "g1"]);
        assert.equal(result.messages[0].chatLabel, "[二号群(g2)]");
    });

    it("splits message keyword terms and searches them with OR semantics", async () => {
        const api = createConversationsApi(memory);
        const result = await api.query({
            chatIds: ["g1", "g2"],
            keyword: "死亡读秒 windowserver",
            limit: 10,
        });

        assert.deepEqual(result.messages.map((row) => row.messageId), ["g2-3", "g1-2"]);
    });

    it("resolves user aliases before searching message bodies", async () => {
        const api = createConversationsApi(memory);
        const result = await api.query({ user: "Soha", limit: 10 });

        assert.deepEqual(result.resolvedUsers.map((user) => user.userId), ["u2"]);
        assert.equal(result.messages.length, 3);
        assert.deepEqual(result.messages.map((row) => row.messageId), ["g2-3", "g2-1", "g2-2"]);
        assert.ok(result.messages.every((row) => row.userId === "u2"));
        assert.equal(result.messages[0].chatLabel, "[二号群(g2)]");
    });

    it("falls back to recent lists when no keyword is provided", async () => {
        const api = createConversationsApi(memory);
        const result = await api.query({ chatIds: ["g2"], userId: "u2", limit: 5 });

        assert.equal(result.messages.length, 3);
        assert.equal(result.topics.length, 1);
        assert.equal(result.messages[0].messageId, "g2-3");
        assert.equal(result.topics[0].topicId.length > 0, true);
        assert.equal(result.topics[0].label, "团建后技术闲聊");
    });

    it("lists chat messages with cursor pagination", async () => {
        const api = createConversationsApi(memory);

        const firstPage = await api.messages("g1", { limit: 1 });
        assert.deepEqual(firstPage.messages.map((row) => row.messageId), ["g1-2"]);
        assert.equal(firstPage.chatLabel, "[一号群(g1)]");
        assert.ok(firstPage.nextCursor);

        const secondPage = await api.messages("g1", {
            limit: 1,
            cursor: firstPage.nextCursor,
        });
        assert.deepEqual(secondPage.messages.map((row) => row.messageId), ["g1-1"]);
        assert.equal(secondPage.nextCursor, undefined);
    });

    it("lists inbox chats with unread chats first by default", async () => {
        const api = createConversationsApi(memory, {
            getAllSubagents: () => [
                {
                    chatId: "g1",
                    lastActivityAt: Date.parse("2026-01-03T10:00:00Z"),
                    lastAttendedAt: "2026-01-02T10:30:00Z",
                    stickiness: { level: "CORE" },
                    observer: { getBufferSize: () => 0 },
                    codeActExecutor: { getQueueSize: () => 2, isProcessing: () => false },
                },
                {
                    chatId: "g2",
                    lastActivityAt: Date.parse("2026-01-03T11:00:00Z"),
                    lastAttendedAt: "2026-01-03T11:30:00Z",
                    stickiness: { level: "FAMILIAR" },
                    observer: { getBufferSize: () => 0 },
                    codeActExecutor: { getQueueSize: () => 0, isProcessing: () => true },
                },
            ],
        });

        const result = await api.inbox({ limit: 10 });

        assert.deepEqual(result.items.map((item) => item.chatId), ["g1", "g2"]);
        assert.equal(result.unreadTotal, 1);
        assert.equal(result.items[0].unread, true);
        assert.equal(result.items[0].unreadCount, 1);
        assert.equal(result.items[0].latestMessage?.messageId, "g1-2");
        assert.equal(result.items[0].queueSize, 2);
        assert.equal(result.items[1].unread, false);
        assert.equal(result.items[1].isProcessing, true);
    });

    it("can page through inbox results with a cursor", async () => {
        const api = createConversationsApi(memory, {
            getAllSubagents: () => [
                { chatId: "g1", lastAttendedAt: "2026-01-03T10:30:00Z" },
                { chatId: "g2", lastAttendedAt: "2026-01-03T11:30:00Z" },
            ],
        });

        const firstPage = await api.inbox({ limit: 1, unreadFirst: false });
        assert.equal(firstPage.items[0].chatId, "g2");
        assert.equal(firstPage.nextCursor, "1");

        const secondPage = await api.inbox({ limit: 1, cursor: firstPage.nextCursor, unreadFirst: false });
        assert.equal(secondPage.items[0].chatId, "g1");
        assert.equal(secondPage.nextCursor, undefined);
    });
});
