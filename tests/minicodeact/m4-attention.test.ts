/**
 * m4-attention.test.ts — M4 attention 命名空间单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    executeMiniCodeActs,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";

// Side-effect import: registers attention handlers
import "../../src/main-agent/minicodeact-handlers/attention.js";

import type { AttentionQueueEntry, StickinessLevel } from "../../src/subagent/types.js";

// ─── Mock helpers ───

function makeMockEntry(chatId: string, priority = 50, stickinessLevel: StickinessLevel = "ACQUAINTANCE"): AttentionQueueEntry {
    return {
        chatId,
        source: "DIGEST_UPDATE",
        priority,
        basePriority: priority,
        enqueuedAt: Date.now(),
        lastAttendedAt: null,
        attendCount: 0,
        blocked: false,
        hasFastPathRequest: false,
        newMessageCount: 0,
        topicDigests: [],
        stickinessLevel,
    };
}

function makeMockAttentionQueue(initialEntry?: AttentionQueueEntry) {
    const store = new Map<string, AttentionQueueEntry>();
    if (initialEntry) {
        store.set(initialEntry.chatId, { ...initialEntry });
    }

    const boostCalls: Array<{ chatId: string; amount: number }> = [];
    const enqueueCalls: AttentionQueueEntry[] = [];

    return {
        store,
        boostCalls,
        enqueueCalls,

        get(chatId: string): AttentionQueueEntry | undefined {
            return store.get(chatId);
        },
        boost(chatId: string, amount: number): void {
            boostCalls.push({ chatId, amount });
            const entry = store.get(chatId);
            if (entry) {
                entry.priority = Math.min(100, entry.priority + amount);
                entry.basePriority = Math.min(100, entry.basePriority + amount);
            }
        },
        enqueueOrUpdate(entry: AttentionQueueEntry): void {
            enqueueCalls.push({ ...entry });
        },
    };
}

function makeMockSubagentManager(fastPathAuthorized = false) {
    const authorizedMap = new Map<string, boolean>();

    return {
        authorizedMap,
        get(chatId: string) {
            if (!authorizedMap.has(chatId)) return undefined;
            const isAuthorized = authorizedMap.get(chatId) ?? false;
            let revoked = false;
            return {
                fastPathHandler: {
                    isAuthorized(): boolean {
                        return isAuthorized && !revoked;
                    },
                    revoke(): void {
                        revoked = true;
                        authorizedMap.set(chatId, false);
                    },
                },
            };
        },
        setAuthorized(chatId: string, value: boolean) {
            authorizedMap.set(chatId, value);
        },
    };
}

function makeDeps(
    attentionQueue: ReturnType<typeof makeMockAttentionQueue>,
    subagentManager: ReturnType<typeof makeMockSubagentManager>,
): MiniCodeActDeps {
    return {
        globalState: {} as any,
        memory: {} as any,
        attentionQueue: attentionQueue as any,
        subagentManager: subagentManager as any,
    };
}

// ─── Tests ───

describe("M4: attention 命名空间", () => {

    it("#1 attention.boost 正常提升", () => {
        const entry = makeMockEntry("tg:123", 40);
        const queue = makeMockAttentionQueue(entry);
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.boost", args: { chatId: "tg:123", amount: 20, reason: "test" } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.equal(result.success, true);
        assert.equal(result.newPriority, 60);
        assert.equal(queue.boostCalls.length, 1);
        assert.equal(queue.boostCalls[0].amount, 20);
    });

    it("#2 attention.boost amount 超过 50 → 截断为 50", () => {
        const entry = makeMockEntry("tg:123", 10);
        const queue = makeMockAttentionQueue(entry);
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.boost", args: { chatId: "tg:123", amount: 999 } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        // amount should have been clamped to 50
        assert.equal(queue.boostCalls[0].amount, 50);
        const result = results[0].result as any;
        assert.equal(result.newPriority, 60); // 10 + 50
    });

    it("#3 attention.boost 目标 chatId 不存在 → 自动入队并 boost", () => {
        const queue = makeMockAttentionQueue(); // empty
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.boost", args: { chatId: "tg:nonexistent", amount: 10 } }],
            "tg:nonexistent",
            deps,
        );

        assert.equal(results[0].success, true); // handler itself doesn't throw
        const result = results[0].result as any;
        assert.equal(result.success, true); // 现在 auto-enqueue 后 success
        assert.equal(result.autoEnqueued, true); // 标记为自动入队
        assert.equal(queue.enqueueCalls.length, 1); // 调用了 enqueueOrUpdate
    });

    it("#4 attention.scheduleRevisit 正常安排", () => {
        const queue = makeMockAttentionQueue();
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const before = Date.now();
        const results = executeMiniCodeActs(
            [{ call: "attention.scheduleRevisit", args: { chatId: "tg:123", delayMinutes: 10, reason: "follow up" } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.ok(result.scheduledAt, "should have scheduledAt");

        // scheduledAt should be roughly 10 minutes in the future
        const scheduledTime = new Date(result.scheduledAt).getTime();
        assert.ok(scheduledTime > before + 9 * 60 * 1000, "scheduled time should be ~10 min in future");
        assert.ok(scheduledTime < before + 11 * 60 * 1000, "scheduled time should not be too far in future");
    });

    it("#5 attention.revokeFastPath 正常撤销", () => {
        const queue = makeMockAttentionQueue();
        const manager = makeMockSubagentManager();
        manager.setAuthorized("tg:123", true);
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.revokeFastPath", args: { chatId: "tg:123", reason: "misbehaving" } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.equal(result.success, true);
        // Verify it's now revoked
        assert.equal(manager.authorizedMap.get("tg:123"), false);
    });

    it("#6 attention.revokeFastPath 未授权 → success false", () => {
        const queue = makeMockAttentionQueue();
        const manager = makeMockSubagentManager();
        manager.setAuthorized("tg:123", false); // exists but not authorized
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.revokeFastPath", args: { chatId: "tg:123" } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.equal(result.success, false);
    });

    it("#7 attention.adjustStickiness 升级: ACQUAINTANCE → FAMILIAR", () => {
        const entry = makeMockEntry("tg:123", 50, "ACQUAINTANCE");
        const queue = makeMockAttentionQueue(entry);
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.adjustStickiness", args: { chatId: "tg:123", targetLevel: "FAMILIAR", reason: "active" } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.equal(result.success, true);
        assert.equal(result.currentLevel, "FAMILIAR");
        assert.equal(queue.get("tg:123")?.stickinessLevel, "FAMILIAR");
    });

    it("#8 attention.adjustStickiness 降级: FAMILIAR → ACQUAINTANCE", () => {
        const entry = makeMockEntry("tg:123", 50, "FAMILIAR");
        const queue = makeMockAttentionQueue(entry);
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.adjustStickiness", args: { chatId: "tg:123", targetLevel: "ACQUAINTANCE" } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.equal(result.success, true);
        assert.equal(result.currentLevel, "ACQUAINTANCE");
        assert.equal(queue.get("tg:123")?.stickinessLevel, "ACQUAINTANCE");
    });

    it("#9 attention.adjustStickiness 边界: CORE 尝试再升级 → stays CORE (success false)", () => {
        const entry = makeMockEntry("tg:123", 80, "CORE");
        const queue = makeMockAttentionQueue(entry);
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.adjustStickiness", args: { chatId: "tg:123", targetLevel: "CORE" } }],
            "tg:123",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        // Already at CORE, currentIdx === targetIdx, returns success: true
        assert.equal(result.success, true);
        assert.equal(result.currentLevel, "CORE");

        // Now try to jump 2 levels
        const results2 = executeMiniCodeActs(
            [{ call: "attention.adjustStickiness", args: { chatId: "tg:123", targetLevel: "ACQUAINTANCE" } }],
            "tg:123",
            deps,
        );
        const result2 = results2[0].result as any;
        assert.equal(result2.success, false);
        assert.equal(result2.currentLevel, "CORE");
        // stickinessLevel should not have changed
        assert.equal(queue.get("tg:123")?.stickinessLevel, "CORE");
    });

    it("#10 attention.adjustStickiness 目标不存在 → success false", () => {
        const queue = makeMockAttentionQueue(); // empty
        const manager = makeMockSubagentManager();
        const deps = makeDeps(queue, manager);

        const results = executeMiniCodeActs(
            [{ call: "attention.adjustStickiness", args: { chatId: "tg:nonexistent", targetLevel: "FAMILIAR" } }],
            "tg:nonexistent",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.equal(result.success, false);
    });
});
