import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryApi } from "../src/meta-sandbox/meta-api/memory.js";
import { createTestMemory, cleanupTestMemory } from "./helpers/test-db.js";
import type { MemoryStoreV2 } from "../src/memory-v2/index.js";

describe("createMemoryApi", () => {
    let memory: MemoryStoreV2;

    before(() => {
        memory = createTestMemory("meta-api-memory");

        memory.upsertPersonIdentity("u1", {
            displayName: "alice",
            aliases: ["爱丽丝", "Alice"],
            firstSeenAt: "2026-01-01T00:00:00Z",
            lastSeenAt: "2026-01-03T00:00:00Z",
        });
        memory.upsertPersonIdentity("u2", {
            displayName: "bob",
            aliases: ["鲍勃", "Bob"],
            firstSeenAt: "2026-01-01T00:00:00Z",
            lastSeenAt: "2026-01-02T00:00:00Z",
        });

        memory.upsertPersonGroupProfile("u1", "g1", {
            lastSeenAt: "2026-01-03T00:00:00Z",
            firstSeenAt: "2026-01-01T00:00:00Z",
            relationToAgent: "经常追问旅行细节",
            messageCount: 12,
        });

        memory.upsertTopic("topic_kyoto_meta", {
            chatId: "g1",
            label: "京都旅行",
            summary: "爱丽丝在问京都路线，Bob 补充交通建议",
            keywords: ["京都", "旅行", "交通"],
            participants: ["u1", "u2"],
            messageRange: { messageIds: ["m1", "m2"], count: 2 },
            startedAt: "2026-01-03T09:00:00Z",
        });

        memory.storeFact("u1", "alice 是前端程序员", "biographical");
        memory.storeFact("u2", "bob 擅长 Rust 和 Python", "biographical");
    });

    after(() => {
        cleanupTestMemory(memory, "meta-api-memory");
    });

    it("searches entities through aliases and augments with recent sessions and core facts", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("爱丽丝", { chatId: "g1", limit: 10 });

        assert.equal(result.identities[0].identity.userId, "u1");
        assert.ok(result.recentSessions.some((row) => row.label === "京都旅行"));
        assert.ok(result.coreFacts.some((row) => row.content.includes("前端程序员")));
        assert.ok(result.topicKeywords.includes("京都"));
    });

    it("surfaces participant identities from topic keyword matches", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("京都", { chatId: "g1", limit: 10 });

        assert.ok(result.recentSessions.some((row) => row.label === "京都旅行"));
        assert.ok(result.topicKeywords.includes("交通"));
        assert.ok(result.identities.some((row) => row.identity.userId === "u1"));
        assert.ok(result.identities.some((row) => row.identity.userId === "u2"));
    });

    it("links core fact hits back to person identities", async () => {
        const api = createMemoryApi(memory);
        const result = await api.searchEntities("Rust", { limit: 10 });

        assert.ok(result.coreFacts.some((row) => row.content.includes("Rust")));
        assert.ok(result.identities.some((row) => row.identity.userId === "u2"));
    });

    it("searches session digests from global state", async () => {
        const api = createMemoryApi(memory, {
            getSessionDigests: () => [
                { createdAt: "2026-01-01T00:00:00.000Z", content: "普通巡检无事项" },
                { createdAt: "2026-01-02T00:00:00.000Z", content: "需要跟进 Soha 的 Chiikawa Park 话题" },
            ],
        } as any);
        const result = await api.searchEntities("soha", { limit: 10 });

        assert.deepEqual(result.sessionDigests, [
            { createdAt: "2026-01-02T00:00:00.000Z", content: "需要跟进 Soha 的 Chiikawa Park 话题" },
        ]);
    });
});
