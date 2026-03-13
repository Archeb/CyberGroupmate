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
import { DynamicAttentionQueue } from "../src/subagent/attention-queue.js";
import type { NotificationEvent } from "../src/event/notification-center.js";

/** 创建模拟 NCEvent */
function mockEvent(overrides: Partial<NotificationEvent> & { chatId: string }): NotificationEvent {
    return {
        _id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        _ts: new Date().toISOString(),
        type: "telegram.message",
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

        it("#3 releaseIdle() 回收超时实例", () => {
            const mgr = new SubagentManager({ idleTimeout: 50 });
            const sub = mgr.getOrCreate("chatA");

            // 手动设置 lastActivityAt 到过去
            sub.lastActivityAt = Date.now() - 100;

            const released = mgr.releaseIdle();
            assert.deepEqual(released, ["chatA"]);
            assert.equal(mgr.size, 0);

            mgr.dispose();
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

        it("#5 getDigest() 返回 TopicDigest", () => {
            const obs = new Observer("chat1");

            obs.setTopicDigests([
                { topicId: "t1", label: "Test", summary: "A test", state: "ACTIVE",
                  participants: ["u1"], keywords: ["test"], messageCount: 5,
                  lastActivityAt: new Date().toISOString() },
            ]);

            const digests = obs.getDigest();
            assert.equal(digests.length, 1);
            assert.equal(digests[0].topicId, "t1");
        });

        it("#6 getEngagementScore() 纯算法计算", () => {
            const obs = new Observer("chat1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 60,
                fastPathEngagementThreshold: 70,
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
            const obs2 = new Observer("chat2", { engagementWindowMs: 60000, alertEngagementThreshold: 60, fastPathEngagementThreshold: 70, mentionKeywords: [] });
            obs2.onMessage(mockEvent({ chatId: "chat2", userId: "u1", text: "hi" }));
            const lowScore = obs2.getEngagementScore();
            assert.ok(lowScore < highScore, `单条消息应低于多条, low=${lowScore}, high=${highScore}`);
        });

        it("#7 checkAlert() 超阈值触发告警", () => {
            const obs = new Observer("chat1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 10, // 降低阈值方便测试
                fastPathEngagementThreshold: 70,
                mentionKeywords: [],
            });

            // 发足够多的消息超过阈值
            for (let i = 0; i < 10; i++) {
                obs.onMessage(mockEvent({
                    chatId: "chat1",
                    userId: `user${i % 3}`,
                    text: `msg ${i}`,
                }));
            }

            const alert = obs.checkAlert();
            assert.ok(alert !== null, "应该触发告警");
            assert.equal(alert!.type, "OBSERVER_ALERT");
            assert.equal(alert!.chatId, "chat1");
        });

        it("#8 checkAlert() 未超阈值不告警", () => {
            const obs = new Observer("chat1", {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 99, // 极高阈值
                fastPathEngagementThreshold: 70,
                mentionKeywords: [],
            });

            obs.onMessage(mockEvent({ chatId: "chat1", userId: "u1", text: "hi" }));

            const alert = obs.checkAlert();
            assert.equal(alert, null, "不应触发告警");
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

    // ─── S2.4: DynamicAttentionQueue ───

    describe("S2.4: DynamicAttentionQueue", () => {
        it("#11 enqueueOrUpdate() 新增条目", () => {
            const q = new DynamicAttentionQueue();
            q.enqueueOrUpdate({ chatId: "c1", priority: 50 });

            const entry = q.dequeue();
            assert.ok(entry);
            assert.equal(entry!.chatId, "c1");
            assert.equal(entry!.priority, 50);
        });

        it("#12 enqueueOrUpdate() 更新已有条目（priority 取最高）", () => {
            const q = new DynamicAttentionQueue();
            q.enqueueOrUpdate({ chatId: "c1", priority: 30 });
            q.enqueueOrUpdate({ chatId: "c1", priority: 70 });

            const entry = q.get("c1");
            assert.ok(entry);
            assert.equal(entry!.priority, 70, "应取最高值");
        });

        it("#13 dequeue() 返回最高优先级", () => {
            const q = new DynamicAttentionQueue();
            q.enqueueOrUpdate({ chatId: "c1", priority: 30 });
            q.enqueueOrUpdate({ chatId: "c2", priority: 80 });
            q.enqueueOrUpdate({ chatId: "c3", priority: 50 });

            const first = q.dequeue();
            assert.equal(first!.chatId, "c2", "最高优先级应先出");

            const second = q.dequeue();
            assert.equal(second!.chatId, "c3", "第二高优先级");
        });

        it("#14 block() / unblock()", () => {
            const q = new DynamicAttentionQueue();
            q.enqueueOrUpdate({ chatId: "c1", priority: 90 });
            q.enqueueOrUpdate({ chatId: "c2", priority: 50 });

            // Block c1
            q.block("c1", "executing");

            // dequeue 应跳过 c1
            const entry = q.dequeue();
            assert.equal(entry!.chatId, "c2", "blocked 的应被跳过");

            // c1 还在队列中
            assert.equal(q.size, 1);
            assert.equal(q.get("c1")!.blocked, true);

            // unblock
            q.unblock("c1");
            assert.equal(q.get("c1")!.blocked, false);

            const entry2 = q.dequeue();
            assert.equal(entry2!.chatId, "c1", "unblock 后应可出队");
        });

        it("#15 evaluate() 时间衰减", () => {
            const q = new DynamicAttentionQueue({ timeDecayPerSecond: 1 }); // 极快衰减

            q.enqueueOrUpdate({ chatId: "c1", priority: 50 });

            // 模拟时间流逝：将 enqueuedAt 设为 10 秒前
            const entry = q.get("c1")!;
            entry.enqueuedAt = Date.now() - 10000;

            const eval1 = q.evaluate();
            assert.ok(entry.priority < 50, `时间衰减后 priority 应下降: ${entry.priority}`);
            assert.ok(entry.priority >= 0, "priority 不应为负");
        });

        // ─── Edge cases ───

        it("#16 Observer: zero messages → engagement=0", () => {
            const obs = new Observer("g1", { engagementWindowMs: 60000, alertEngagementThreshold: 60, fastPathEngagementThreshold: 70, mentionKeywords: [] });
            assert.equal(obs.getEngagementScore(), 0);
            assert.equal(obs.checkAlert(), null);
            assert.equal(obs.getTotalMessageCount(), 0);
        });

        it("#17 Observer: engagement capped at 100", () => {
            const obs = new Observer("g1", { engagementWindowMs: 60000, alertEngagementThreshold: 60, fastPathEngagementThreshold: 70, mentionKeywords: [] });
            for (let i = 0; i < 200; i++) {
                obs.onMessage(mockEvent({ chatId: "g1", userId: `u${i % 20}`, text: `msg ${i}` }));
            }
            assert.ok(obs.getEngagementScore() <= 100, `engagement 应 ≤ 100: ${obs.getEngagementScore()}`);
        });

        it("#18 Q3: enqueueOrUpdate updates priority for same chatId", () => {
            const q = new DynamicAttentionQueue();
            q.enqueueOrUpdate({ chatId: "c1", priority: 10 });
            q.enqueueOrUpdate({ chatId: "c1", priority: 50 });
            assert.equal(q.size, 1, "同一 chatId 不重复入队");
            const entry = q.dequeue();
            assert.equal(entry?.priority, 50, "priority 应更新为 50");
        });

        it("#19 Q3: dequeue from empty queue returns null", () => {
            const q = new DynamicAttentionQueue();
            assert.equal(q.dequeue(), null);
        });

        it("#20 Q3: block nonexistent chatId is no-op", () => {
            const q = new DynamicAttentionQueue();
            q.block("nonexistent", "test");
            assert.equal(q.size, 0);
        });

        it("#21 Q3 eviction: insert beyond maxSize evicts lowest priority", () => {
            const q = new DynamicAttentionQueue({ maxSize: 3, timeDecayPerSecond: 0 });
            q.enqueueOrUpdate({ chatId: "low", priority: 5 });
            q.enqueueOrUpdate({ chatId: "mid", priority: 20 });
            q.enqueueOrUpdate({ chatId: "high", priority: 50 });
            q.enqueueOrUpdate({ chatId: "higher", priority: 60 });
            assert.equal(q.size, 3);
            assert.equal(q.get("low"), undefined, "最低优先级应被淘汰");
            assert.ok(q.get("higher"), "新入的应存在");
        });

        it("#22 SubagentManager: getOrCreate returns same instance", () => {
            const mgr = new SubagentManager();
            const s1 = mgr.getOrCreate("g1");
            const s2 = mgr.getOrCreate("g1");
            assert.strictEqual(s1, s2, "同一 chatId 应返回同一实例");
            assert.equal(mgr.size, 1);
            mgr.dispose();
        });
    });
});
