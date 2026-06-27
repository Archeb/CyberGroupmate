/**
 * tests/memory-v2-sensitive.test.ts — GroupModel.markedSensitive（append-only 敏感标记）
 *
 * 覆盖：markChatSensitive 落库 / 幂等 / 无取消路径 / 重开数据库后仍生效 / listGroupModels 反映。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, unlinkSync } from "node:fs";
import { createTestMemory, cleanupTestMemory, testDbPath } from "./helpers/test-db.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";

const DB_NAME = "memory-v2-sensitive";
const GROUP = "telegram:-100sensitiveGroup";
const FRESH = "telegram:-100neverSeenBefore";

describe("GroupModel.markedSensitive — append-only 敏感标记", () => {
    it("markChatSensitive 落库：markedSensitive / reason / at", () => {
        const store = createTestMemory(DB_NAME);
        try {
            store.upsertGroupModel(GROUP, { chatTitle: "测试群" });
            assert.equal(store.getGroupModel(GROUP)?.markedSensitive ?? false, false);

            const gm = store.markChatSensitive(GROUP, "群友表达了隐私顾虑");
            assert.equal(gm?.markedSensitive, true);
            assert.equal(gm?.sensitiveReason, "群友表达了隐私顾虑");
            assert.ok(gm?.sensitiveAt, "sensitiveAt 应被记录");

            // 重新读取确认持久
            const reread = store.getGroupModel(GROUP);
            assert.equal(reread?.markedSensitive, true);
            assert.equal(reread?.sensitiveReason, "群友表达了隐私顾虑");
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("幂等：再次标记不覆盖原因、不报错", () => {
        const store = createTestMemory(DB_NAME);
        try {
            store.markChatSensitive(GROUP, "第一次原因");
            const again = store.markChatSensitive(GROUP, "第二次不同原因");
            assert.equal(again?.markedSensitive, true);
            assert.equal(again?.sensitiveReason, "第一次原因", "幂等：保留首次原因");
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("对从未见过的 chatId 也能直接标记（自动建 GroupModel）", () => {
        const store = createTestMemory(DB_NAME);
        try {
            assert.equal(store.getGroupModel(FRESH), null);
            const gm = store.markChatSensitive(FRESH, "preemptive");
            assert.equal(gm?.markedSensitive, true);
            assert.equal(store.getGroupModel(FRESH)?.markedSensitive, true);
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("listGroupModels 反映 markedSensitive", () => {
        const store = createTestMemory(DB_NAME);
        try {
            store.upsertGroupModel(GROUP, { chatTitle: "测试群" });
            store.markChatSensitive(GROUP, "x");
            const listed = store.listGroupModels().find((g) => g.chatId === GROUP);
            assert.equal(listed?.markedSensitive, true);
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("Discord: markChatSensitive 归一化到 guild 级 key，对全 guild 生效", () => {
        const store = createTestMemory(DB_NAME);
        try {
            // 频道级 chatId 标记 → 应写到 guild 级 GroupModel key（getGroupModelKey 折叠 channel→guild）
            store.markChatSensitive("discord:guild1:chanA", "群友提出隐私顾虑");
            assert.equal(store.getGroupModel("discord:guild1")?.markedSensitive, true, "guild 级行应被标记");
            // 同 guild 的另一个频道再标记 → 命中同一行（幂等）
            const again = store.markChatSensitive("discord:guild1:chanB");
            assert.equal(again?.chatId, "discord:guild1");
            assert.equal(again?.markedSensitive, true);
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("isChatPrivate: 种子 / DM / markedSensitive 判私密；普通群 shared；dmAutoPrivate=false 关 DM", () => {
        const store = createTestMemory(DB_NAME);
        try {
            store.setPrivacyClassification({ sensitiveChats: ["telegram:-100seed"], dmAutoPrivate: true });
            store.upsertGroupModel("telegram:-100dm", { chatTitle: "dm", isDirectMessage: true });
            store.upsertGroupModel("telegram:-100normal", { chatTitle: "normal" });
            store.markChatSensitive("telegram:-100marked", "x");

            assert.equal(store.isChatPrivate("telegram:-100seed"), true, "配置种子 → 私密");
            assert.equal(store.isChatPrivate("telegram:-100dm"), true, "DM → 私密");
            assert.equal(store.isChatPrivate("telegram:-100marked"), true, "markedSensitive → 私密");
            assert.equal(store.isChatPrivate("telegram:-100normal"), false, "普通群 → shared");

            store.setPrivacyClassification({ sensitiveChats: [], dmAutoPrivate: false });
            assert.equal(store.isChatPrivate("telegram:-100dm"), false, "dmAutoPrivate=false → DM 不私密");
            assert.equal(store.isChatPrivate("telegram:-100marked"), true, "marked 仍私密");
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("enforce=off 时 isChatPrivate 一律 false（memory 层总开关）", () => {
        const store = createTestMemory(DB_NAME);
        try {
            store.upsertGroupModel("telegram:-100dm", { chatTitle: "dm", isDirectMessage: true });
            store.markChatSensitive("telegram:-100marked", "x");
            store.setPrivacyClassification({ sensitiveChats: ["telegram:-100seed"], dmAutoPrivate: true, enforce: "off" });
            assert.equal(store.isChatPrivate("telegram:-100dm"), false);
            assert.equal(store.isChatPrivate("telegram:-100marked"), false);
            assert.equal(store.isChatPrivate("telegram:-100seed"), false);
            // 切回 block → 恢复私密判定
            store.setPrivacyClassification({ sensitiveChats: ["telegram:-100seed"], dmAutoPrivate: true, enforce: "block" });
            assert.equal(store.isChatPrivate("telegram:-100dm"), true);
            assert.equal(store.isChatPrivate("telegram:-100seed"), true);
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("isChatPrivate 种子支持裸 rawId（与配置迁移一致）", () => {
        const store = createTestMemory(DB_NAME);
        try {
            store.setPrivacyClassification({ sensitiveChats: ["-1009999"], dmAutoPrivate: true, enforce: "block" });
            assert.equal(store.isChatPrivate("telegram:-1009999"), true);
        } finally {
            cleanupTestMemory(store, DB_NAME);
        }
    });

    it("重开数据库后标记依然生效（持久化 + 迁移列）", () => {
        const name = `${DB_NAME}-persist`;
        const store = createTestMemory(name);
        store.markChatSensitive(GROUP, "持久化测试");
        store.close();

        // 用同一路径重开（不清理），模拟重启
        const reopened = new MemoryStoreV2(testDbPath(name));
        try {
            assert.equal(reopened.getGroupModel(GROUP)?.markedSensitive, true);
            assert.equal(reopened.getGroupModel(GROUP)?.sensitiveReason, "持久化测试");
        } finally {
            reopened.close();
            const path = testDbPath(name);
            for (const suffix of ["", "-wal", "-shm"]) {
                try { if (existsSync(path + suffix)) unlinkSync(path + suffix); } catch { /* ignore */ }
            }
        }
    });
});
