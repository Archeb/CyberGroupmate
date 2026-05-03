/**
 * s2-subagent-observer.test.ts — S2 SubagentManager + Observer 单元测试
 *
 * 覆盖 15 个测试用例（subtask.md S2 测试计划）
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { SubagentManager } from "../src/subagent/subagent-manager.js";
import { GroupSubagent } from "../src/subagent/group-subagent.js";
import { Observer } from "../src/subagent/observer.js";
import type { NotificationEvent } from "../src/event/notification-center.js";

/** 创建模拟 NCEvent */
function mockEvent(overrides: Partial<NotificationEvent> & { chatId: string }): NotificationEvent {
    return {
        _id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        _ts: new Date().toISOString(),
        type: "nc.message",
        ...overrides,
    };
}

describe("S2: SubagentManager + Observer", () => {

    // ─── S2.1: SubagentManager ───

    describe("S2.1: SubagentManager", () => {
        it("#1 getOrCreate() 创建新实例", () => {
            const mgr = new SubagentManager();
            const sub = mgr.getOrCreate("chatA");

            assert.ok(sub instanceof GroupSubagent);
            assert.equal(sub.chatId, "chatA");
            assert.equal(mgr.size, 1);

            mgr.dispose();
        });

        it("#2 getOrCreate() 复用已有实例", () => {
            const mgr = new SubagentManager();
            const sub1 = mgr.getOrCreate("chatA");
            const sub2 = mgr.getOrCreate("chatA");

            assert.strictEqual(sub1, sub2, "两次调用应返回同一对象");
            assert.equal(mgr.size, 1);

            mgr.dispose();
        });

        it("#3 restoreAll() 从磁盘恢复 session", async () => {
            const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
            const { join } = await import("node:path");

            // 准备临时 session 目录
            const tmpDir = join("/tmp", `test-sessions-${Date.now()}`);
            const platformDir = join(tmpDir, "telegram");
            mkdirSync(platformDir, { recursive: true });

            // 写入一个模拟的 session 文件（使用 composite key 文件名格式）
            writeFileSync(join(platformDir, "telegram_chatA.json"), JSON.stringify({
                chatId: "telegram:chatA",
                session: [{ role: "user", content: "test", timestamp: new Date().toISOString() }],
                executionRecords: [],
                executionCount: 3,
                lastCompactedAt: null,
                savedAt: new Date().toISOString(),
            }));

            const mgr = new SubagentManager({ sessionsDir: tmpDir, platformName: "telegram" });
            const restored = mgr.restoreAll();

            assert.deepEqual(restored, ["telegram:chatA"]);
            assert.equal(mgr.size, 1);
            const sub = mgr.get("telegram:chatA");
            assert.ok(sub, "telegram:chatA should exist");

            mgr.dispose();
            rmSync(tmpDir, { recursive: true, force: true });
        });
    });

    // ─── S2.3: Observer ───

    describe("S2.3: Observer", () => {
        it("#4 onMessage() 写入 Q2 buffer", () => {
            const obs = new Observer("chat1", { engagementWindowMs: 60000 });
            const event = mockEvent({ chatId: "chat1", userId: "u1", text: "Hello" });

            obs.onMessage(event);
            assert.equal(obs.getBufferSize(), 1);
            assert.equal(obs.getTotalMessageCount(), 1);
        });

        it("#5 getMessageSnapshot() 返回 buffer 中的消息快照", () => {
            const obs = new Observer("chat1");
            obs.onMessage(mockEvent({ chatId: "chat1", userId: "u1", text: "Hello" }));
            obs.onMessage(mockEvent({ chatId: "chat1", userId: "u2", text: "World" }));

            const snapshot = obs.getMessageSnapshot();
            assert.equal(snapshot.length, 2);
            assert.equal(snapshot[0]?.userId, "u1");
            assert.equal(snapshot[0]?.text, "Hello");
            assert.equal(snapshot[1]?.userId, "u2");
        });

        it("#6 getEngagementScore() 纯算法计算", () => {
            const obs = new Observer("chat1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 60,
                mentionKeywords: [],
            });

            // 高频消息 + 多人 → 高分
            for (let i = 0; i < 20; i++) {
                obs.onMessage(mockEvent({
                    chatId: "chat1",
                    userId: `user${i % 5}`,
                    text: `msg ${i}`,
                }));
            }
            const highScore = obs.getEngagementScore();
            assert.ok(highScore > 30, `高频多人应高分, 实际: ${highScore}`);

            // 低频 → 低分
            const obs2 = new Observer("chat2", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 60,
                mentionKeywords: [],
            });
            obs2.onMessage(mockEvent({ chatId: "chat2", userId: "u1", text: "hi" }));
            const lowScore = obs2.getEngagementScore();
            assert.ok(lowScore < highScore, `单条消息应低于多条, low=${lowScore}, high=${highScore}`);
        });

        it("#7 hasMentionKeyword() 命中关键词时返回 true", () => {
            const obs = new Observer("chat1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 10,
                mentionKeywords: ["赛博群友", "bot"],
            });

            assert.equal(obs.hasMentionKeyword("你好，赛博群友"), true);
            assert.equal(obs.hasMentionKeyword("plain text"), false);
        });

        it("#8 clearBuffer() 会清空 buffer 并重置 engagement / mention 计数", () => {
            const obs = new Observer("chat1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 99,
                mentionKeywords: ["bot"],
            });

            obs.onMessage(mockEvent({ chatId: "chat1", userId: "u1", text: "hello bot" }));
            assert.equal(obs.getBufferSize(), 1);
            assert.ok(obs.getEngagementScore() > 0);
            assert.equal(obs.getMentionCount(), 1);

            obs.clearBuffer();

            assert.equal(obs.getBufferSize(), 0);
            assert.equal(obs.getEngagementScore(), 0);
            assert.equal(obs.getMentionCount(), 0);
        });
    });

    // ─── per-group 隔离 ───

    describe("S2.3: per-group 隔离", () => {
        it("#9 per-group Observer 隔离", () => {
            const obsA = new Observer("chatA");
            const obsB = new Observer("chatB");

            obsA.onMessage(mockEvent({ chatId: "chatA", userId: "u1", text: "A msg" }));
            obsA.onMessage(mockEvent({ chatId: "chatA", userId: "u2", text: "A msg 2" }));

            obsB.onMessage(mockEvent({ chatId: "chatB", userId: "u3", text: "B msg" }));

            assert.equal(obsA.getTotalMessageCount(), 2, "chatA 应有 2 条");
            assert.equal(obsB.getTotalMessageCount(), 1, "chatB 应有 1 条");
        });

        it("#10 per-group SubagentManager 隔离", () => {
            const mgr = new SubagentManager();
            const subA = mgr.getOrCreate("chatA");
            const subB = mgr.getOrCreate("chatB");

            subA.observer.onMessage(mockEvent({ chatId: "chatA", userId: "u1", text: "A" }));
            subB.observer.onMessage(mockEvent({ chatId: "chatB", userId: "u2", text: "B" }));

            assert.equal(subA.observer.getTotalMessageCount(), 1);
            assert.equal(subB.observer.getTotalMessageCount(), 1);
            assert.notEqual(subA, subB);

            mgr.dispose();
        });
    });

    describe("S2.3b: callbackPotential 提权", () => {
        it("#10b buildQueueEntry() 会根据 callbackPotential 提升基础优先级", () => {
            const sub = new GroupSubagent({ chatId: "chatA" });
            const event = mockEvent({ chatId: "chatA", userId: "u1", text: "hello meme callback" });
            sub.onMessage(event);

            const topic = sub.topicRegistry.create("chatA", "旧梗回调", ["meme", "callback"], [{
                id: "m1",
                chatId: "chatA",
                senderId: "u1",
                senderName: "Alice",
                text: "hello meme callback",
                timestamp: Date.now(),
            }]);
            topic.callbackPotential = 82;

            const engagement = sub.observer.getEngagementScore();
            const entry = sub.buildQueueEntry();
            const expectedBoost = Math.floor((82 - 60) * 0.5);

            assert.equal(entry.callbackPotential, 82);
            assert.equal(entry.hasHighCallbackPotential, true);
            assert.equal(entry.basePriority, Math.min(100, engagement * sub.stickiness.priorityMultiplier + expectedBoost));
        });
    });

    describe("S2.4: Edge cases", () => {
        it("#11 Observer: zero messages → engagement=0", () => {
            const obs = new Observer("g1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 60,
                mentionKeywords: [],
            });
            assert.equal(obs.getEngagementScore(), 0);
            assert.equal(obs.getTotalMessageCount(), 0);
        });

        it("#12 Observer: engagement capped at 100", () => {
            const obs = new Observer("g1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 60,
                mentionKeywords: [],
            });
            for (let i = 0; i < 200; i++) {
                obs.onMessage(mockEvent({ chatId: "g1", userId: `u${i % 20}`, text: `msg ${i}` }));
            }
            assert.ok(obs.getEngagementScore() <= 100, `engagement 应 ≤ 100: ${obs.getEngagementScore()}`);
        });

        it("#13 SubagentManager: getOrCreate returns same instance", () => {
            const mgr = new SubagentManager();
            const s1 = mgr.getOrCreate("g1");
            const s2 = mgr.getOrCreate("g1");
            assert.strictEqual(s1, s2, "同一 chatId 应返回同一实例");
            assert.equal(mgr.size, 1);
            mgr.dispose();
        });
    });
});
