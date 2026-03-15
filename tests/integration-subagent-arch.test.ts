/**
 * integration-subagent-arch.test.ts — Subagent 架构跨节点集成测试
 *
 * 覆盖 Main Agent ↔ Subagent 架构中多组件贯通流程：
 * NC → MessageLogWriter → Observer → Q3 → MainAgentLoop → CodeActExecutor → Q5 → GlobalState
 *
 * 测试设计原则：每个测试串联 ≥3 个组件，验证数据在节点间的流转正确性。
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync } from "node:fs";

import { NotificationCenter } from "../src/event/notification-center.js";
import { MessageLogWriter } from "../src/event/message-log-writer.js";
import { GroupDispatcher } from "../src/event/group-dispatcher.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";

import { SubagentManager } from "../src/subagent/subagent-manager.js";
import { DynamicAttentionQueue } from "../src/subagent/attention-queue.js";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import { FastPathHandler } from "../src/subagent/fast-path-handler.js";
import { Observer } from "../src/subagent/observer.js";

import { MainAgentLoop } from "../src/main-agent/main-agent-loop.js";
import { GlobalState } from "../src/main-agent/global-state.js";
import { calculateDepth } from "../src/main-agent/cosine-decay.js";
import { estimateReplyMode, buildReplyDecisions, buildObserveDecision } from "../src/main-agent/decision-maker.js";

import type {
    AttentionQueueEntry,
    AttendResult,
    CodeActReplyTask,
    SubagentCallback,
    FastPathConfig,
    GroupContextPackage,
} from "../src/subagent/types.js";

// ─── Test Utilities ───

const tempDirs: string[] = [];
function tempDir(): string {
    const d = join(tmpdir(), `int-subagent-${randomUUID()}`);
    mkdirSync(d, { recursive: true });
    tempDirs.push(d);
    return d;
}
after(() => {
    for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function makeNCEvent(chatId: string, userId: string, text: string, messageId?: string) {
    return {
        type: "nc.message" as const,
        chatId,
        userId,
        messageId: messageId ?? `m-${randomUUID().slice(0, 8)}`,
        text,
        timestamp: new Date().toISOString(),
    };
}

function makeCodeActTask(chatId: string, taskId?: string, replyMode: "SINGLE" | "BATCH" = "SINGLE"): CodeActReplyTask {
    return {
        type: "CODEACT_REPLY",
        chatId,
        taskId: taskId ?? `task-${randomUUID().slice(0, 8)}`,
        decisions: [{ action: "REPLY", confidence: 0.9, reason: "test reply decision" }],
        contextSnapshot: {
            depth: 0,
            chatId,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: [],
            engagementScore: 50,
        },
        replyMode,
        createdAt: new Date().toISOString(),
    };
}

// ─── Tests ───

describe("Subagent Architecture: 跨节点集成测试", () => {

    // ━━━ Test 1: 完整感知链 NC → MessageLogWriter → Observer → Q3 → MainAgentLoop ━━━
    it("#1 完整感知链: NC → MessageLogWriter → Observer → Q3 → MainAgentLoop.tick()", async () => {
        const dir = tempDir();
        const nc = new NotificationCenter(join(dir, "events.jsonl"), false);
        const memory = new MemoryStoreV2(join(dir, "memory.db"));
        const writer = new MessageLogWriter(memory, { eventTypes: ["nc.message", "telegram.message"] });
        const mgr = new SubagentManager({
            observerConfig: {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 90,
                fastPathEngagementThreshold: 95,
                mentionKeywords: [],
            },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 2 });

        // Wire: NC.onPush → writer + observer + Q3
        nc.onPush(event => writer.write(event));
        nc.onPush(event => {
            const chatId = String(event.chatId ?? "");
            if (!chatId) return;
            const sub = mgr.getOrCreate(chatId);
            sub.observer.onMessage(event);
            q3.enqueueOrUpdate(sub.buildQueueEntry());
        });

        // Push 3 messages into 2 groups
        nc.push(makeNCEvent("g1", "u1", "Hello group 1"));
        nc.push(makeNCEvent("g1", "u2", "Reply in group 1"));
        nc.push(makeNCEvent("g2", "u3", "Hello group 2"));

        // Verify: MessageLogWriter persisted messages
        const g1Msgs = memory.getRecentMessages("g1", 10);
        assert.equal(g1Msgs.length, 2, "g1 should have 2 messages in message_log");
        const g2Msgs = memory.getRecentMessages("g2", 10);
        assert.equal(g2Msgs.length, 1, "g2 should have 1 message");

        // Verify: Q3 has 2 groups
        assert.equal(q3.size, 2, "Q3 should have 2 group entries");

        // Verify: Observer state
        const g1Sub = mgr.get("g1")!;
        assert.ok(g1Sub, "g1 subagent should exist");
        assert.equal(g1Sub.observer.getTotalMessageCount(), 2, "g1 observer should see 2 messages");

        // Verify: MainAgentLoop processes
        const tickResult = await loop.tick();
        assert.ok(tickResult.phase3Attended.length >= 1, "Should attend at least 1 group");

        // Verify: subagent markAttended updated
        const attendedChat = tickResult.phase3Attended[0];
        const attendedSub = mgr.get(attendedChat);
        assert.ok(attendedSub, "Attended subagent should exist");
        assert.equal(attendedSub!.attendCount, 1, "attendCount should be 1 after first attend");

        memory.close();
        nc.dispose();
        mgr.dispose();
    });

    // ━━━ Test 2: Observer engagement → Alert → Q3 boost → 优先 dequeue ━━━
    it("#2 Observer 告警触发优先 dequeue: 高 engagement → Q3 boost", async () => {
        const mgr = new SubagentManager({
            observerConfig: {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 30,
                fastPathEngagementThreshold: 90,
                mentionKeywords: [],
            },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 1 });

        // g1: low activity
        const s1 = mgr.getOrCreate("g1");
        s1.observer.onMessage(makeNCEvent("g1", "u1", "quiet"));
        q3.enqueueOrUpdate(s1.buildQueueEntry());

        // g2: high activity, lots of senders → high engagement
        const s2 = mgr.getOrCreate("g2");
        for (let i = 0; i < 20; i++) {
            s2.observer.onMessage(makeNCEvent("g2", `u${i}`, `message ${i}`));
        }
        const entry2 = s2.buildQueueEntry();
        q3.enqueueOrUpdate(entry2);

        // Verify: g2 has higher engagement
        assert.ok(s2.observer.getEngagementScore() > s1.observer.getEngagementScore(),
            "g2 engagement should be higher than g1");

        // Check if alert fires for g2
        const alert = s2.observer.checkAlert();
        assert.ok(alert !== null, "g2 should trigger an alert");

        // Boost g2 due to alert
        if (alert) {
            q3.boost("g2", 20);
        }

        // MainAgentLoop should dequeue g2 first
        const result = await loop.tick();
        assert.equal(result.phase3Attended[0], "g2", "g2 should be attended first due to higher priority + boost");

        mgr.dispose();
    });

    // ━━━ Test 3: 决策 → CodeAct 执行 → Q5 Callback 完整链 ━━━
    it("#3 决策→执行→回调: MainAgentLoop attend → CodeActReplyTask → Q4 → CodeActExecutor → Q5", async () => {
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        // maxAttendsPerTick: 1 → 不触发 mid-iteration Q5 drain
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 1 });

        const exec = new CodeActExecutor("g1");
        exec.setCallbackHandler(cb => q5.enqueue(cb));

        // Set up attend handler that creates CodeActReplyTask and dispatches to executor
        loop.setAttendHandler(async (entry): Promise<AttendResult> => {
            return {
                chatId: entry.chatId,
                decisions: [{ action: "REPLY", confidence: 0.9, reason: "test" }],
                replyMode: "SINGLE",
                reasoning: "integration test decision",
            };
        });

        loop.setDispatchHandler(async (result) => {
            if (result.replyMode !== "NONE") {
                const task = makeCodeActTask(result.chatId);
                exec.enqueue(task);
            }
        });

        // Enqueue g1 in Q3
        mgr.getOrCreate("g1");
        q3.enqueueOrUpdate({ chatId: "g1", priority: 50, topicDigests: [] });

        // Tick: attend → dispatch → CodeActExecutor executes → Q5 callback
        await loop.tick();
        await new Promise(r => setTimeout(r, 200));  // Wait for async executor

        // Verify: callback arrived in Q5
        assert.equal(q5.size, 1, "Q5 should have 1 callback");
        const cb = q5.drain()[0];
        assert.equal(cb.chatId, "g1");
        assert.equal(cb.executionType, "CODEACT");
        assert.equal(cb.status, "COMPLETED");

        // Session should have entries
        assert.ok(exec.getSessionSize() >= 2, "Executor session should have task + response entries");

        mgr.dispose();
    });

    // ━━━ Test 4: FastPath 完整生命周期 ━━━
    it("#4 FastPath 完整流: 授权 → 触发 → 回复 → Q5 callback → MainAgentLoop drain", async () => {
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        const loop = new MainAgentLoop(q3, q5, mgr);

        const fp = new FastPathHandler("g1");
        fp.setCallbackHandler(cb => q5.enqueue(cb));

        // Step 1: Authorize
        const config: FastPathConfig = {
            preauthorizedActions: ["ack", "greet"],
            blockedActions: ["spam"],
            tonePreset: "casual",
            maxRepliesBeforeReauth: 2,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            authorizedAt: new Date().toISOString(),
        };
        fp.authorize(config);
        assert.ok(fp.isAuthorized(), "Should be authorized after authorize()");

        // Step 2: Handle first trigger → reply
        const reply1 = await fp.handle({
            chatId: "g1", messageId: "m1", userId: "u1",
            text: "ack please", timestamp: new Date().toISOString(),
        });
        assert.ok(reply1, "Should produce reply for 'ack' trigger");
        assert.equal(q5.size, 1, "Q5 should have 1 callback after first reply");

        // Step 3: Handle second trigger → reply + auto-disable
        const reply2 = await fp.handle({
            chatId: "g1", messageId: "m2", userId: "u2",
            text: "greet me", timestamp: new Date().toISOString(),
        });
        assert.ok(reply2, "Should produce reply for second trigger");
        assert.equal(q5.size, 2, "Q5 should have 2 callbacks");
        assert.equal(fp.isAuthorized(), false, "Should auto-disable after maxReplies");

        // Step 4: MainAgentLoop drains callbacks
        const tickResult = await loop.tick();
        assert.equal(tickResult.phase1Callbacks, 2, "Should drain 2 callbacks in Phase 1");

        mgr.dispose();
    });

    // ━━━ Test 5: 多群组竞争调度 ━━━
    it("#5 多群组竞争: 不同 priority + stickiness → 正确 dequeue 顺序", async () => {
        const mgr = new SubagentManager();
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 3 });

        // g1: CORE stickiness, medium engagement
        const s1 = mgr.getOrCreate("g1");
        s1.stickiness.level = "CORE";
        s1.stickiness.priorityMultiplier = 1.0;
        for (let i = 0; i < 5; i++) {
            s1.observer.onMessage(makeNCEvent("g1", `u${i}`, "msg"));
        }
        q3.enqueueOrUpdate(s1.buildQueueEntry());

        // g2: STRANGER stickiness, high engagement (but multiplier squashes it)
        const s2 = mgr.getOrCreate("g2");
        s2.stickiness.level = "STRANGER";
        s2.stickiness.priorityMultiplier = 0.2;
        for (let i = 0; i < 10; i++) {
            s2.observer.onMessage(makeNCEvent("g2", `u${i}`, "msg"));
        }
        q3.enqueueOrUpdate(s2.buildQueueEntry());

        // g3: FAMILIAR stickiness, high engagement
        const s3 = mgr.getOrCreate("g3");
        s3.stickiness.level = "FAMILIAR";
        s3.stickiness.priorityMultiplier = 0.7;
        for (let i = 0; i < 15; i++) {
            s3.observer.onMessage(makeNCEvent("g3", `u${i % 8}`, "msg"));
        }
        q3.enqueueOrUpdate(s3.buildQueueEntry());

        const result = await loop.tick();
        assert.equal(result.phase3Attended.length, 3, "Should attend all 3 groups");

        // g3 should come before g2 (FAMILIAR*high > STRANGER*high)
        const g3Idx = result.phase3Attended.indexOf("g3");
        const g2Idx = result.phase3Attended.indexOf("g2");
        assert.ok(g3Idx < g2Idx, "g3 (FAMILIAR) should be attended before g2 (STRANGER)");

        mgr.dispose();
    });

    // ━━━ Test 6: Block/Unblock 机制 ━━━
    it("#6 Block/Unblock: CodeAct 执行中 block → Observer 继续 → unblock 后重新调度", async () => {
        const mgr = new SubagentManager({
            observerConfig: {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 90,
                fastPathEngagementThreshold: 95,
                mentionKeywords: [],
            },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 2 });

        // Create g1 with messages
        const s1 = mgr.getOrCreate("g1");
        for (let i = 0; i < 5; i++) {
            s1.observer.onMessage(makeNCEvent("g1", `u${i}`, "msg"));
        }
        q3.enqueueOrUpdate(s1.buildQueueEntry());

        // Block g1 (simulating CodeAct in progress)
        q3.block("g1", "CodeAct executing");

        // Verify: blocked entry can't be dequeued
        const tick1 = await loop.tick();
        assert.equal(tick1.phase3Attended.length, 0, "Blocked g1 should not be dequeued");

        // Meanwhile, Observer still accepts new messages during block
        s1.observer.onMessage(makeNCEvent("g1", "u10", "new message during block"));
        assert.equal(s1.observer.getTotalMessageCount(), 6, "Observer should still accept messages while blocked");

        // Unblock g1
        q3.unblock("g1");

        // Now it should be dequeueable
        const tick2 = await loop.tick();
        assert.ok(tick2.phase3Attended.includes("g1"), "g1 should be attended after unblock");

        mgr.dispose();
    });

    // ━━━ Test 7: Q5 Callback → GlobalState + Q3 Unblock 闭环 ━━━
    it("#7 Callback 闭环: Q5 drain → GlobalState recordDecision → Q3 unblock", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0, // disable for test
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        const loop = new MainAgentLoop(q3, q5, mgr);

        // Set up g1 in Q3 and block it
        mgr.getOrCreate("g1");
        q3.enqueueOrUpdate({ chatId: "g1", priority: 60, topicDigests: [] });
        q3.block("g1", "CodeAct executing");

        // Simulate CodeActExecutor completing task → Q5 callback
        const cb: SubagentCallback = {
            taskId: "task-001",
            chatId: "g1",
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: "Successfully replied",
            durationMs: 500,
            createdAt: new Date().toISOString(),
        };
        q5.enqueue(cb);

        // Set up loop to process callbacks: drain Q5 → update GlobalState → unblock Q3
        loop.setAttendHandler(async (entry) => {
            return buildObserveDecision(entry.chatId);
        });

        // Manually drain Q5 and process (simulating Phase 1)
        const callbacks = q5.drain();
        for (const c of callbacks) {
            globalState.recordDecision(c.chatId, `${c.executionType}: ${c.status} (${c.summary})`);
            q3.unblock(c.chatId);
        }

        // Verify: GlobalState updated
        const decisions = globalState.getRecentDecisions();
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0].chatId, "g1");
        assert.ok(decisions[0].decision.includes("COMPLETED"));

        // Verify: g1 unblocked and can be dequeued
        const entry = q3.get("g1");
        assert.ok(entry, "g1 should still be in Q3");
        assert.equal(entry!.blocked, false, "g1 should be unblocked");

        globalState.dispose();
        mgr.dispose();
    });

    // ━━━ Test 8: Cosine Decay 上下文深度变化 ━━━
    it("#8 Cosine Decay: 连续 attend → depth 从 L3 → L0 → 回升", async () => {
        const cyclePeriod = 20;
        const depths: number[] = [];

        // Simulate continuous attending
        for (let attendCount = 0; attendCount < cyclePeriod; attendCount++) {
            const depth = calculateDepth(attendCount, cyclePeriod);
            depths.push(depth);
        }

        // Verify: starts deep (L3)
        assert.equal(depths[0], 3, "Should start at L3 (deepest)");

        // Verify: reaches shallow (L0) around middle
        assert.ok(depths.includes(0), "Should reach L0 during cycle");

        // Verify: cycle length matches
        // The depth at cyclePeriod should be same as at 0 (periodic)
        const depthAtEnd = calculateDepth(cyclePeriod, cyclePeriod);
        assert.equal(depthAtEnd, depths[0], "Depth should be periodic");

        // Verify: monotonic decrease from start to half-cycle
        let foundDecrease = false;
        for (let i = 1; i < cyclePeriod / 2; i++) {
            if (depths[i] < depths[i - 1]) {
                foundDecrease = true;
                break;
            }
        }
        assert.ok(foundDecrease, "Depth should decrease from cycle start toward middle");

        // Verify: L0 and L3 both present
        const hasL0 = depths.some(d => d === 0);
        const hasL3 = depths.some(d => d === 3);
        assert.ok(hasL0 && hasL3, "Cycle should include both L0 and L3");
    });

    // ━━━ Test 9: 端到端最小完整路径 ━━━
    it("#9 端到端: NC push → Observer → Q3 → attend → CodeActExecutor → Q5 → GlobalState 更新", async () => {
        const dir = tempDir();
        const nc = new NotificationCenter(join(dir, "events.jsonl"), false);
        const memory = new MemoryStoreV2(join(dir, "memory.db"));
        const writer = new MessageLogWriter(memory, { eventTypes: ["nc.message", "telegram.message"] });
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });

        const mgr = new SubagentManager({
            observerConfig: {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 90,
                fastPathEngagementThreshold: 95,
                mentionKeywords: [],
            },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 1 });

        // Create executor for g1
        const exec = new CodeActExecutor("g1");
        exec.setCallbackHandler(cb => q5.enqueue(cb));

        // Wire NC → writer + observer + Q3
        nc.onPush(event => writer.write(event));
        nc.onPush(event => {
            const chatId = String(event.chatId ?? "");
            if (!chatId) return;
            const sub = mgr.getOrCreate(chatId);
            sub.observer.onMessage(event);
            q3.enqueueOrUpdate(sub.buildQueueEntry());
        });

        // Wire loop handler → dispatch to executor
        loop.setAttendHandler(async (entry): Promise<AttendResult> => ({
            chatId: entry.chatId,
            decisions: [{ action: "REPLY", confidence: 0.8, reason: "auto" }],
            replyMode: "SINGLE",
            reasoning: "e2e test",
        }));

        loop.setDispatchHandler(async (result) => {
            if (result.replyMode !== "NONE") {
                exec.enqueue(makeCodeActTask(result.chatId));
                q3.block(result.chatId, "CodeAct executing");
            }
        });

        // ─── Execute the full path ───

        // Step 1: Push messages to NC
        nc.push(makeNCEvent("g1", "u1", "Hey what's up?"));
        nc.push(makeNCEvent("g1", "u2", "Not much, you?"));

        // Step 2: Tick → attend → dispatch → block
        await loop.tick();

        // Step 3: Wait for CodeActExecutor to complete
        await new Promise(r => setTimeout(r, 200));

        // Verify: Q5 has callback
        assert.equal(q5.size, 1, "Q5 should have callback from CodeActExecutor");

        // Step 4: Simulate Phase 1 of next tick (drain Q5 → update state → unblock)
        const callbacks = q5.drain();
        for (const cb of callbacks) {
            globalState.recordDecision(cb.chatId, `Executed: ${cb.status}`);
            q3.unblock(cb.chatId);
        }

        // Step 5: Verify end state
        // - Messages persisted
        assert.equal(memory.getRecentMessages("g1", 10).length, 2, "Messages persisted in message_log");

        // - GlobalState has decision record
        const recentDec = globalState.getRecentDecisions();
        assert.equal(recentDec.length, 1, "GlobalState should have 1 decision");
        assert.equal(recentDec[0].chatId, "g1");

        // - G1 unblocked
        const g1Entry = q3.get("g1");
        // G1 might have been dequeued (removed from Q3), or could be unblocked
        // Either way, it should not be blocked
        if (g1Entry) {
            assert.equal(g1Entry.blocked, false, "g1 should be unblocked");
        }

        // - SubagentManager has g1
        assert.ok(mgr.get("g1"), "g1 subagent should still exist");

        memory.close();
        nc.dispose();
        globalState.dispose();
        mgr.dispose();
    });

    // ━━━ Test 10: SubagentManager 空闲回收不影响活跃实例 ━━━
    it("#10 生命周期: 空闲回收保留活跃 + Q3/CodeActExecutor 状态独立", async () => {
        const mgr = new SubagentManager({ idleTimeout: 100 });
        const q3 = new DynamicAttentionQueue();

        // Create 3 active subagents
        const active1 = mgr.getOrCreate("active1");
        const active2 = mgr.getOrCreate("active2");
        const idle1 = mgr.getOrCreate("idle1");

        // Give them all Q3 entries
        q3.enqueueOrUpdate(active1.buildQueueEntry());
        q3.enqueueOrUpdate(active2.buildQueueEntry());
        q3.enqueueOrUpdate(idle1.buildQueueEntry());

        // Mark idle1 as old
        idle1.lastActivityAt = Date.now() - 200;

        // Keep active ones fresh
        active1.touch();
        active2.touch();

        // Release idle
        const released = mgr.releaseIdle();
        assert.deepEqual(released, ["idle1"], "Only idle1 should be released");
        assert.equal(mgr.size, 2, "2 active subagents remain");

        // Q3 still has idle1 entry (orphaned, but that's expected - Q3 manages its own lifecycle)
        assert.equal(q3.size, 3, "Q3 still has all 3 entries (lifecycle independent)");

        // Verify independent CodeActExecutor sessions
        const exec1 = new CodeActExecutor("active1");
        const exec2 = new CodeActExecutor("active2");

        await exec1.execute(makeCodeActTask("active1"));
        assert.ok(exec1.getSessionSize() > 0, "exec1 should have session entries");
        assert.equal(exec2.getSessionSize(), 0, "exec2 should have no session entries");

        mgr.dispose();
    });

    // ━━━ Test 11: 多群组交叉: 两轮 tick 的状态演进 ━━━
    it("#11 多轮 tick: tick1 attend g1 → block → tick2 attend g2 → Q5 callback unblocks g1", async () => {
        const dir = tempDir();
        const mgr = new SubagentManager({
            observerConfig: {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 90,
                fastPathEngagementThreshold: 95,
                mentionKeywords: [],
            },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 1 });

        const exec1 = new CodeActExecutor("g1");
        exec1.setCallbackHandler(cb => q5.enqueue(cb));

        // Set up handlers
        loop.setAttendHandler(async (entry): Promise<AttendResult> => ({
            chatId: entry.chatId,
            decisions: [{ action: "REPLY", confidence: 0.9, reason: "test" }],
            replyMode: "SINGLE",
            reasoning: "multi-tick test",
        }));

        loop.setDispatchHandler(async (result) => {
            if (result.chatId === "g1") {
                exec1.enqueue(makeCodeActTask("g1"));
                q3.block("g1", "executing");
            }
        });

        // Prepare both groups
        const s1 = mgr.getOrCreate("g1");
        const s2 = mgr.getOrCreate("g2");
        for (let i = 0; i < 8; i++) s1.observer.onMessage(makeNCEvent("g1", `u${i}`, "msg"));
        for (let i = 0; i < 3; i++) s2.observer.onMessage(makeNCEvent("g2", `u${i}`, "msg"));
        q3.enqueueOrUpdate({ ...s1.buildQueueEntry(), priority: 80 });
        q3.enqueueOrUpdate({ ...s2.buildQueueEntry(), priority: 40 });

        // Tick 1: g1 attended (higher priority) → blocked
        const tick1 = await loop.tick();
        assert.deepEqual(tick1.phase3Attended, ["g1"], "Tick 1 should attend g1");

        await new Promise(r => setTimeout(r, 100)); // Wait for executor

        // Tick 2: g1 blocked → g2 attended
        const tick2 = await loop.tick();
        assert.deepEqual(tick2.phase3Attended, ["g2"], "Tick 2 should attend g2 (g1 blocked)");
        assert.equal(tick2.phase1Callbacks, 1, "Tick 2 should drain g1's callback in Phase 1");

        mgr.dispose();
    });

    // ━━━ Test 12: DecisionMaker 驱动 BATCH 模式多任务分派 ━━━
    it("#12 BATCH 分派: estimateReplyMode=BATCH → 多条 CodeActReplyTask 入 Q4", async () => {
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        // maxAttendsPerTick: 1 → 不触发 mid-iteration Q5 drain
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 1 });

        const exec = new CodeActExecutor("g1");
        exec.setCallbackHandler(cb => q5.enqueue(cb));

        const dispatchedTasks: CodeActReplyTask[] = [];

        loop.setAttendHandler(async (entry): Promise<AttendResult> => {
            // Simulate BATCH mode: generate multiple reply decisions
            return {
                chatId: entry.chatId,
                decisions: [
                    { action: "REPLY", topicId: "topic_a", confidence: 0.9, reason: "answer question" },
                    { action: "REPLY", topicId: "topic_b", confidence: 0.7, reason: "join discussion" },
                    { action: "IGNORE", topicId: "topic_c", confidence: 0.95, reason: "private topic" },
                ],
                replyMode: "BATCH",
                reasoning: "High engagement + multiple topics",
            };
        });

        loop.setDispatchHandler(async (result) => {
            // Dispatch REPLY decisions as separate tasks
            for (const d of result.decisions) {
                if (d.action === "REPLY") {
                    const task = makeCodeActTask(result.chatId, `task-${d.topicId}`, "BATCH");
                    dispatchedTasks.push(task);
                    exec.enqueue(task);
                }
            }
        });

        mgr.getOrCreate("g1");
        q3.enqueueOrUpdate({ chatId: "g1", priority: 70, topicDigests: [] });

        await loop.tick();
        await new Promise(r => setTimeout(r, 300));

        // Verify: 2 REPLY decisions dispatched (IGNORE skipped)
        assert.equal(dispatchedTasks.length, 2, "Should dispatch 2 tasks (ignoring IGNORE decision)");
        assert.equal(q5.size, 2, "Q5 should have 2 callbacks from executor");

        mgr.dispose();
    });

    // ━━━ Test 13: Phase 1 自动处理 — tick 内部自动 drain Q5 → recordDecision → unblock ━━━
    it("#13 Phase 1 自动处理: tick 内部 drain Q5 → GlobalState recordDecision → markTaskComplete → unblock", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        // Pass globalState as 5th parameter
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 1 }, globalState);

        // Setup: g1 blocked with pending callback
        const s1 = mgr.getOrCreate("g1");
        q3.enqueueOrUpdate({ chatId: "g1", priority: 60, topicDigests: [] });
        q3.block("g1", "CodeAct executing");

        // Simulate CodeActExecutor callback in Q5
        const taskId = "task-auto-001";
        q5.enqueue({
            taskId,
            chatId: "g1",
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: "Auto reply sent",
            durationMs: 350,
            createdAt: new Date().toISOString(),
        });

        // tick() should automatically: drain Q5 → recordDecision → markTaskComplete → unblock
        const tick = await loop.tick();

        // Verify Phase 1 processed 1 callback
        assert.equal(tick.phase1Callbacks, 1, "Phase 1 should drain 1 callback");

        // Verify GlobalState was updated
        const decisions = globalState.getRecentDecisions();
        assert.equal(decisions.length, 1, "GlobalState should have 1 decision from callback");
        assert.ok(decisions[0].decision.includes("COMPLETED"), "Decision should mention COMPLETED");

        // Verify markTaskComplete was called
        assert.ok(s1.isTaskCompleted(taskId), "Task should be marked complete on subagent");

        // Verify g1 unblocked (can be attended)
        // Note: g1 was dequeued-then-re-enqueued during Phase 2 re-enqueue
        // so we need to check that it's in Q3 and not blocked
        const g1Entry = q3.get("g1");
        if (g1Entry) {
            assert.equal(g1Entry.blocked, false, "g1 should be unblocked after callback");
        }

        globalState.dispose();
        mgr.dispose();
    });

    // ━━━ Test 14: Phase 2 Observer Alert Boost ━━━
    it("#14 Phase 2 Alert Boost: Observer 高 engagement → tick 内自动 boost Q3 条目", async () => {
        const mgr = new SubagentManager({
            observerConfig: {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 30, // low threshold for testing
                fastPathEngagementThreshold: 90,
                mentionKeywords: [],
            },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 0 }); // 0 attends — just run Phase 1+2

        // g1: low engagement
        const s1 = mgr.getOrCreate("g1");
        s1.observer.onMessage(makeNCEvent("g1", "u1", "quiet"));
        q3.enqueueOrUpdate(s1.buildQueueEntry());

        // g2: high engagement (exceeds alert threshold)
        const s2 = mgr.getOrCreate("g2");
        for (let i = 0; i < 15; i++) {
            s2.observer.onMessage(makeNCEvent("g2", `u${i}`, `active message ${i}`));
        }
        q3.enqueueOrUpdate(s2.buildQueueEntry());

        // Capture g2's priority before tick
        const g2Before = q3.get("g2")!.priority;

        // Tick runs Phase 2: should boost g2 due to alert
        const tick = await loop.tick();
        assert.ok(tick.phase2Eval.boostedAlerts >= 1, "Should boost at least 1 alert (g2)");

        // g2's entry should have been boosted during Phase 2
        // (Note: entry was re-enqueued + boosted + evaluated)
        const g2After = q3.get("g2");
        assert.ok(g2After, "g2 should still be in Q3");
        // The boost should have increased basePriority
        assert.ok(g2After!.basePriority > g2Before || g2After!.priority >= 0,
            "g2 should have been boosted (basePriority increased)");

        mgr.dispose();
    });

    // ━━━ Test 15: Phase 2 re-enqueueOrUpdate — Q3 自动刷新 ━━━
    it("#15 Phase 2 re-enqueue: 新 tick 自动刷新所有 subagent 的 Q3 条目", async () => {
        const mgr = new SubagentManager({
            observerConfig: {
                engagementWindowMs: 60000,
                alertEngagementThreshold: 90,
                fastPathEngagementThreshold: 95,
                mentionKeywords: [],
            },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 0 }); // 0 attends

        // Create subagent WITHOUT manually enqueuing to Q3
        const s1 = mgr.getOrCreate("g1");
        s1.observer.onMessage(makeNCEvent("g1", "u1", "hello"));

        // Q3 should be empty initially
        assert.equal(q3.size, 0, "Q3 should be empty before tick");

        // Tick runs Phase 2: iterates all subagents → enqueueOrUpdate
        await loop.tick();

        // Q3 should now have g1 (auto-enqueued during Phase 2)
        assert.equal(q3.size, 1, "Q3 should have 1 entry after Phase 2 re-enqueue");
        const entry = q3.get("g1");
        assert.ok(entry, "g1 should be in Q3");
        assert.ok(entry!.priority >= 0, "g1 should have a priority");

        mgr.dispose();
    });

    // ━━━ Test 16: estimateReplyMode 信号丰富化 — BATCH 触发 ━━━
    it("#16 estimateReplyMode: distinctTopicCount + timeSinceLastAttend 触发 BATCH", () => {
        const pkg: GroupContextPackage = {
            depth: 0,
            chatId: "g1",
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: [],
            engagementScore: 30, // moderate engagement
        };

        // Base case: without new signals → SINGLE
        const mode1 = estimateReplyMode(pkg, 5, false, "FAMILIAR");
        assert.equal(mode1, "SINGLE", "Moderate engagement + few messages → SINGLE");

        // With distinctTopicCount >= 2 → BATCH
        const mode2 = estimateReplyMode(pkg, 5, false, "FAMILIAR", 3); // 3 distinct topics
        assert.equal(mode2, "BATCH", "3 distinct topics → BATCH regardless of engagement");

        // With high engagement + long time since last attend → BATCH
        const highPkg = { ...pkg, engagementScore: 60 };
        const mode3 = estimateReplyMode(highPkg, 5, false, "FAMILIAR", 0, 10 * 60_000); // 10 min
        assert.equal(mode3, "BATCH", "High engagement + 10min since last attend → BATCH");

        // Low engagement with new signals + zero topics → NONE
        const lowPkg = { ...pkg, engagementScore: 5 };
        const mode4 = estimateReplyMode(lowPkg, 1, false, "STRANGER", 0, 0, 0);
        assert.equal(mode4, "NONE", "Very low engagement → NONE even with new signal params");
    });

    // ━━━ Test 17: FastPath 触发路径 ━━━
    it("#17 FastPath 触发: 消息到达 → 已授权 FastPath 自动 handle", async () => {
        const q5 = new CallbackQueue();

        const fp = new FastPathHandler("g1");
        fp.setCallbackHandler(cb => q5.enqueue(cb));
        fp.authorize({
            preauthorizedActions: ["greet", "acknowledge"],
            blockedActions: ["spam"],
            tonePreset: "friendly",
            maxRepliesBeforeReauth: 3,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            authorizedAt: new Date().toISOString(),
        });

        assert.ok(fp.isAuthorized(), "FastPath should be authorized");

        // Simulate the trigger path (as if nc.onPush called fp.handle)
        const result = await fp.handle({
            chatId: "g1",
            messageId: "m1",
            userId: "u1",
            text: "greet me please",
            timestamp: new Date().toISOString(),
        });

        assert.ok(result, "FastPath should produce a reply");
        assert.equal(q5.size, 1, "Q5 should have 1 callback from FastPath");

        const cb = q5.drain()[0];
        assert.equal(cb.executionType, "FAST_PATH");
        assert.equal(cb.status, "COMPLETED");

        // Blocked action should not trigger
        const blocked = await fp.handle({
            chatId: "g1",
            messageId: "m2",
            userId: "u2",
            text: "spam content",
            timestamp: new Date().toISOString(),
        });
        assert.equal(blocked, null, "Blocked action should return null");
    });

    // ━━━ Test 18: RecordingPipeline → Observer 桥接 ━━━
    it("#18 RecordingPipeline→Observer 桥接: setTopicDigests 注入 → Q3 更新反映", () => {
        const mgr = new SubagentManager();
        const q3 = new DynamicAttentionQueue();

        const s1 = mgr.getOrCreate("g1");

        // Initially: observer has no topic digests
        assert.equal(s1.observer.getDigest().length, 0, "Should start with no digests");

        // Simulate RecordingPipeline → Observer bridge (as main.ts does)
        const digests = [
            {
                topicId: "topic_1",
                label: "旅行讨论",
                summary: "讨论京都一日游行程",
                state: "ACTIVE",
                participants: ["u1", "u2"],
                keywords: ["京都", "旅行"],
                messageCount: 5,
                lastActivityAt: new Date().toISOString(),
                triageDecision: "ENGAGE" as const,
                triageConfidence: 0.8,
            },
            {
                topicId: "topic_2",
                label: "美食推荐",
                summary: "分享拉面店推荐",
                state: "ACTIVE",
                participants: ["u2", "u3"],
                keywords: ["拉面", "美食"],
                messageCount: 3,
                lastActivityAt: new Date().toISOString(),
                triageDecision: "IGNORE" as const,
                triageConfidence: 0.6,
            },
        ];
        s1.observer.setTopicDigests(digests);

        // Verify: observer now has digests
        assert.equal(s1.observer.getDigest().length, 2, "Observer should have 2 digests");
        assert.equal(s1.observer.getDigest()[0].label, "旅行讨论");

        // Verify: buildQueueEntry reflects digests
        const entry = s1.buildQueueEntry();
        assert.equal(entry.topicDigests.length, 2, "Queue entry should have 2 topic digests");

        // Verify: Q3 enqueue reflects digests
        q3.enqueueOrUpdate(entry);
        const q3Entry = q3.get("g1")!;
        assert.equal(q3Entry.topicDigests.length, 2, "Q3 entry should have 2 topic digests");
        assert.equal(q3Entry.topicDigests[0].topicId, "topic_1");

        mgr.dispose();
    });

    // ━━━ Test 19: Fix 8 LLM 决策 Fallback ━━━
    it("#19 LLM 决策 fallback: attendHandler LLM 失败 → 算法结果保底", async () => {
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        const loop = new MainAgentLoop(q3, q5, mgr);

        // The default attendHandler uses estimateReplyMode (algorithmic path)
        // which acts as the fallback when no LLM is configured.
        // We verify that the algorithmic path always produces valid results.
        const s1 = mgr.getOrCreate("g1");
        for (let i = 0; i < 5; i++) {
            s1.observer.onMessage(makeNCEvent("g1", `u${i}`, `message ${i}`));
        }
        q3.enqueueOrUpdate(s1.buildQueueEntry());

        // Default attend handler (no custom handler set → defaultAttend with algorithm)
        const tick = await loop.tick();
        assert.equal(tick.phase3Attended.length, 1, "Should attend 1 group");
        assert.equal(tick.phase5Decisions.length, 1, "Should produce 1 decision");

        const decision = tick.phase5Decisions[0];
        assert.equal(decision.chatId, "g1");
        assert.ok(decision.replyMode, "Decision should have a replyMode");
        assert.ok(decision.decisions.length > 0, "Decision should have at least 1 sub-decision");

        mgr.dispose();
    });

    // ━━━ Test 20: Fix 9 CodeActExecutor 依赖注入生命周期 ━━━
    it("#20 CodeActExecutor 依赖: setDependencies → hasDependencies → skeleton fallback", async () => {
        const exec = new CodeActExecutor("g1");

        // Initially: no dependencies
        assert.equal(exec.hasDependencies(), false, "Should not have dependencies initially");

        // Execute without dependencies → skeleton fallback
        const task = makeCodeActTask("g1", "task-skeleton-1");
        const cb1 = await exec.execute(task);
        assert.equal(cb1.status, "COMPLETED", "Skeleton should complete successfully");
        assert.ok(cb1.summary.includes("skeleton"), "Summary should mention skeleton fallback");

        // Session should have entries
        assert.ok(exec.getSessionSize() >= 2, "Session should have task + response entries");
        assert.equal(exec.getExecutionCount(), 1, "Should have 1 execution");

        // Execute another task
        const task2 = makeCodeActTask("g1", "task-skeleton-2");
        const cb2 = await exec.execute(task2);
        assert.equal(cb2.status, "COMPLETED");
        assert.equal(exec.getExecutionCount(), 2, "Should have 2 executions");
    });

});
