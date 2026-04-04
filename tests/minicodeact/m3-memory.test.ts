/**
 * m3-memory.test.ts — M3 memory 命名空间 单元测试
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestMemory, cleanupTestMemory } from "../helpers/test-db.js";
import { MemoryStoreV2 } from "../../src/memory-v2/index.js";
import {
    executeMiniCodeActs,
    clearHandlers,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";

// Import handlers (side-effect: registers them)
import "../../src/main-agent/minicodeact-handlers/memory.js";

function mockDeps(memory: MemoryStoreV2): MiniCodeActDeps {
    return {
        globalState: {} as any,
        memory,
        attentionQueue: {} as any,
        subagentManager: {} as any,
    };
}

describe("M3: memory 命名空间", () => {
    // ── memory.writeCoreFact ──

    it("#1 memory.writeCoreFact 正常写入", () => {
        const mem = createTestMemory("m3-1");
        try {
            const results = executeMiniCodeActs(
                [{ call: "memory.writeCoreFact", args: { subject: "u1", content: "u1 喜欢猫", category: "preference" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results.length, 1);
            assert.equal(results[0].success, true);
            const factId = (results[0].result as any).factId;
            assert.ok(factId, "should return factId");
            // Verify in DB
            const db = (mem as any).db;
            const row = db.prepare("SELECT * FROM core_facts WHERE id = ?").get(factId);
            assert.ok(row, "fact should be in DB");
            assert.equal(row.subject, "u1");
            assert.equal(row.content, "u1 喜欢猫");
            assert.equal(row.category, "preference");
        } finally {
            cleanupTestMemory(mem, "m3-1");
        }
    });

    it("#2 memory.writeCoreFact 缺少 subject", () => {
        const mem = createTestMemory("m3-2");
        try {
            const results = executeMiniCodeActs(
                [{ call: "memory.writeCoreFact", args: { content: "something", category: "preference" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, false);
            assert.ok(results[0].error!.includes("subject"));
        } finally {
            cleanupTestMemory(mem, "m3-2");
        }
    });

    it("#3 memory.writeCoreFact confidence 默认为 0.9 (spec default)", () => {
        const mem = createTestMemory("m3-3");
        try {
            const results = executeMiniCodeActs(
                [{ call: "memory.writeCoreFact", args: { subject: "u1", content: "test", category: "general" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const factId = (results[0].result as any).factId;
            const db = (mem as any).db;
            const row = db.prepare("SELECT confidence FROM core_facts WHERE id = ?").get(factId);
            assert.equal(row.confidence, 0.9, "default confidence should be 0.9 per spec");
        } finally {
            cleanupTestMemory(mem, "m3-3");
        }
    });

    // ── memory.updateIdentity ──

    it("#4 memory.updateIdentity 修改 displayName", () => {
        const mem = createTestMemory("m3-4");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "老王", aliases: [] });
            const results = executeMiniCodeActs(
                [{ call: "memory.updateIdentity", args: { userId: "u1", displayName: "王大锤" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const identity = mem.getPersonIdentity("u1");
            assert.equal(identity!.displayName, "王大锤");
        } finally {
            cleanupTestMemory(mem, "m3-4");
        }
    });

    it("#5 memory.updateIdentity 添加 alias", () => {
        const mem = createTestMemory("m3-5");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "Alice", aliases: ["爱丽丝"] });
            const results = executeMiniCodeActs(
                [{ call: "memory.updateIdentity", args: { userId: "u1", addAlias: "小爱" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const identity = mem.getPersonIdentity("u1");
            assert.ok(identity!.aliases.includes("爱丽丝"));
            assert.ok(identity!.aliases.includes("小爱"));
        } finally {
            cleanupTestMemory(mem, "m3-5");
        }
    });

    it("#6 memory.updateIdentity 删除 alias", () => {
        const mem = createTestMemory("m3-6");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "Alice", aliases: ["爱丽丝", "小爱"] });
            const results = executeMiniCodeActs(
                [{ call: "memory.updateIdentity", args: { userId: "u1", removeAlias: "小爱" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const identity = mem.getPersonIdentity("u1");
            assert.ok(!identity!.aliases.includes("小爱"));
            assert.ok(identity!.aliases.includes("爱丽丝"));
        } finally {
            cleanupTestMemory(mem, "m3-6");
        }
    });

    it("#7 memory.updateIdentity 不存在的 userId 自动创建", () => {
        const mem = createTestMemory("m3-7");
        try {
            const results = executeMiniCodeActs(
                [{ call: "memory.updateIdentity", args: { userId: "new-user", displayName: "新人" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const identity = mem.getPersonIdentity("new-user");
            assert.ok(identity, "identity should be created");
            assert.equal(identity!.displayName, "新人");
        } finally {
            cleanupTestMemory(mem, "m3-7");
        }
    });

    // ── searchByAlias ──

    it("#8 searchByAlias 通过 displayName 匹配", () => {
        const mem = createTestMemory("m3-8");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "老王", aliases: [] });
            mem.upsertPersonIdentity("u2", { displayName: "老李", aliases: [] });
            const results = mem.searchByAlias("老王");
            assert.equal(results.length, 1);
            assert.equal(results[0].userId, "u1");
        } finally {
            cleanupTestMemory(mem, "m3-8");
        }
    });

    it("#9 searchByAlias 通过 alias 匹配", () => {
        const mem = createTestMemory("m3-9");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "Alice", aliases: ["爱丽丝", "小爱"] });
            mem.upsertPersonIdentity("u2", { displayName: "Bob", aliases: ["小鲍"] });
            const results = mem.searchByAlias("爱丽丝");
            assert.equal(results.length, 1);
            assert.equal(results[0].userId, "u1");
        } finally {
            cleanupTestMemory(mem, "m3-9");
        }
    });

    it("#10 searchByAlias 无匹配返回空数组", () => {
        const mem = createTestMemory("m3-10");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "Alice", aliases: [] });
            const results = mem.searchByAlias("不存在的名字xyz");
            assert.equal(results.length, 0);
        } finally {
            cleanupTestMemory(mem, "m3-10");
        }
    });

    // ── memory.searchIdentity ──

    it("#11 memory.searchIdentity 返回结果", () => {
        const mem = createTestMemory("m3-11");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "老王", aliases: ["王哥"] });
            const results = executeMiniCodeActs(
                [{ call: "memory.searchIdentity", args: { query: "老王" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const { results: found } = results[0].result as any;
            assert.equal(found.length, 1);
            assert.equal(found[0].userId, "u1");
            assert.equal(found[0].displayName, "老王");
        } finally {
            cleanupTestMemory(mem, "m3-11");
        }
    });

    it("#12 memory.searchIdentity 跨群同名消歧（两个叫老王的人）", () => {
        const mem = createTestMemory("m3-12");
        try {
            mem.upsertPersonIdentity("u1", { displayName: "老王", aliases: ["群A的老王"] });
            mem.upsertPersonIdentity("u2", { displayName: "老王", aliases: ["群B的老王"] });
            const results = executeMiniCodeActs(
                [{ call: "memory.searchIdentity", args: { query: "老王" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const { results: found } = results[0].result as any;
            assert.equal(found.length, 2);
            const userIds = found.map((r: any) => r.userId);
            assert.ok(userIds.includes("u1"));
            assert.ok(userIds.includes("u2"));
        } finally {
            cleanupTestMemory(mem, "m3-12");
        }
    });

    // ── memory.getProfile ──

    it("#13 memory.getProfile 正常查询", () => {
        const mem = createTestMemory("m3-13");
        try {
            mem.upsertPersonGroupProfile("u1", "chat1", {
                dunbarTier: 2,
                traits: ["热情"],
                interests: ["旅行"],
            });
            const results = executeMiniCodeActs(
                [{ call: "memory.getProfile", args: { userId: "u1", chatId: "chat1" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const profile = results[0].result as any;
            assert.ok(profile, "profile should not be null");
            assert.equal(profile.userId, "u1");
            assert.equal(profile.chatId, "chat1");
            assert.deepEqual(profile.traits, ["热情"]);
        } finally {
            cleanupTestMemory(mem, "m3-13");
        }
    });

    it("#14 memory.getProfile 用户不存在返回 null", () => {
        const mem = createTestMemory("m3-14");
        try {
            const results = executeMiniCodeActs(
                [{ call: "memory.getProfile", args: { userId: "nonexistent", chatId: "chat1" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            assert.equal(results[0].result, null);
        } finally {
            cleanupTestMemory(mem, "m3-14");
        }
    });

    // ── memory.updateProfile ──

    it("#15 memory.updateProfile 添加 traits", () => {
        const mem = createTestMemory("m3-15");
        try {
            mem.upsertPersonGroupProfile("u1", "chat1", {
                traits: ["冷静"],
                interests: [],
            });
            const results = executeMiniCodeActs(
                [{ call: "memory.updateProfile", args: { userId: "u1", chatId: "chat1", addTraits: ["幽默", "热情"] } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const profiles = mem.getProfilesForChat("chat1");
            const profile = profiles.find(p => p.userId === "u1");
            assert.ok(profile!.traits.includes("冷静"));
            assert.ok(profile!.traits.includes("幽默"));
            assert.ok(profile!.traits.includes("热情"));
        } finally {
            cleanupTestMemory(mem, "m3-15");
        }
    });

    // ── source field ──

    it("#16 storeFact source 字段为 'minicodeact'", () => {
        const mem = createTestMemory("m3-16");
        try {
            const results = executeMiniCodeActs(
                [{ call: "memory.writeCoreFact", args: { subject: "u1", content: "test fact", category: "general" } }],
                "chat1",
                mockDeps(mem),
            );
            assert.equal(results[0].success, true);
            const factId = (results[0].result as any).factId;
            const db = (mem as any).db;
            const row = db.prepare("SELECT source FROM core_facts WHERE id = ?").get(factId);
            assert.equal(row.source, "minicodeact");
        } finally {
            cleanupTestMemory(mem, "m3-16");
        }
    });
});
