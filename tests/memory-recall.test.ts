/**
 * tests/memory-recall.test.ts — 本地 SQLite 语义检索（recall）测试
 *
 * 确定性、离线：seed 几个 topic + fact，断言 store.recall() 能召回。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestMemory, cleanupTestMemory } from "./helpers/test-db.js";

const DB_NAME = "memory-recall-local";
const CHAT_ID = "-100042";

describe("MemoryStoreV2.recall — 本地语义检索", () => {
    it("召回 seed 的话题与事实", async () => {
        const store = createTestMemory(DB_NAME);
        try {
            store.upsertTopic("topic_kyoto", {
                chatId: CHAT_ID,
                label: "京都旅行攻略",
                summary: "讨论京都岚山竹林和交通方式",
                keywords: ["京都", "岚山", "交通"],
                participants: ["111"],
                startedAt: new Date().toISOString(),
                sentiment: "positive",
            });
            store.storeFact("111", "alice 喜欢吃拉面", "preference");

            // 话题：命中 label/summary/keywords
            const topicResult = await store.recall("京都", { maxResults: 5 });
            const topicLabels = topicResult.topics.map((t) => t.label);
            assert.ok(
                topicLabels.includes("京都旅行攻略"),
                `应召回京都话题，实际：${topicLabels.join(",")}`,
            );

            // 事实：命中 content
            const factResult = await store.recall("拉面", { maxResults: 5 });
            const factContents = factResult.facts.map((f) => f.content);
            assert.ok(
                factContents.some((c) => c.includes("拉面")),
                `应召回拉面事实，实际：${factContents.join(",")}`,
            );
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });
});
