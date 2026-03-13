/**
 * s8-integration.test.ts — S8 端到端集成测试
 *
 * 从 s6-s7-s8-integration.test.ts 拆分 + s-audit-edge-cases.test.ts edge cases 合并
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync } from "node:fs";

import { SubagentManager } from "../src/subagent/subagent-manager.js";
import { DynamicAttentionQueue } from "../src/subagent/attention-queue.js";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { MainAgentLoop } from "../src/main-agent/main-agent-loop.js";
import { Observer } from "../src/subagent/observer.js";
import { FastPathHandler } from "../src/subagent/fast-path-handler.js";
import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import { MessageLogWriter } from "../src/event/message-log-writer.js";
import { GroupDispatcher } from "../src/event/group-dispatcher.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";

const tempDirs: string[] = [];
function tempDir(): string { const d = join(tmpdir(), `s8-${randomUUID()}`); mkdirSync(d, { recursive: true }); tempDirs.push(d); return d; }
after(() => { for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true }); });

describe("S8: 端到端集成", () => {
    it("#1 NC → MessageLogWriter → GroupDispatcher → Observer → Q3 → MainAgentLoop", async () => {
        const dir = tempDir();
        const nc = new NotificationCenter(join(dir, "events.jsonl"), false);
        const memory = new MemoryStoreV2(join(dir, "memory.db"));
        const writer = new MessageLogWriter(memory);
        const mgr = new SubagentManager({
            observerConfig: { engagementWindowMs: 60000, alertEngagementThreshold: 10, fastPathEngagementThreshold: 70, mentionKeywords: [] },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 1 });

        nc.onPush(event => writer.write(event));
        nc.onPush(event => {
            const chatId = String(event.chatId ?? "");
            if (!chatId) return;
            const sub = mgr.getOrCreate(chatId);
            sub.observer.onMessage(event);
            q3.enqueueOrUpdate(sub.buildQueueEntry());
        });

        nc.push({ type: "telegram.message", chatId: "g1", userId: "u1", messageId: "m1", text: "Hello", timestamp: new Date().toISOString() });
        nc.push({ type: "telegram.message", chatId: "g1", userId: "u2", messageId: "m2", text: "World", timestamp: new Date().toISOString() });
        nc.push({ type: "telegram.message", chatId: "g2", userId: "u3", messageId: "m3", text: "Hi g2", timestamp: new Date().toISOString() });

        const g1Msgs = memory.getRecentMessages("g1", 10);
        assert.equal(g1Msgs.length, 2, "g1 应有 2 条消息");
        assert.equal(q3.size, 2, "Q3 应有 2 个群组");

        const result = await loop.tick();
        assert.equal(result.phase3Attended.length, 1, "应 attend 1 个群组");

        memory.close();
    });

    it("#2 多群同时: g1, g2, g3 按 priority 排序", async () => {
        const mgr = new SubagentManager({
            observerConfig: { engagementWindowMs: 60000, alertEngagementThreshold: 60, fastPathEngagementThreshold: 70, mentionKeywords: [] },
        });
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 3 });

        const s1 = mgr.getOrCreate("g1");
        s1.stickiness.priorityMultiplier = 0.2;
        q3.enqueueOrUpdate({ chatId: "g1", priority: 10, topicDigests: [] });
        const s2 = mgr.getOrCreate("g2");
        s2.stickiness.priorityMultiplier = 1.0;
        q3.enqueueOrUpdate({ chatId: "g2", priority: 80, topicDigests: [] });
        mgr.getOrCreate("g3");
        q3.enqueueOrUpdate({ chatId: "g3", priority: 40, topicDigests: [] });

        const result = await loop.tick();
        assert.equal(result.phase3Attended[0], "g2", "最高优先级的 g2 应先被 attend");
        mgr.dispose();
    });

    it("#3 CodeActExecutor → Q5 callback → MainAgentLoop", async () => {
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        const exec = new CodeActExecutor("chatX");

        exec.setCallbackHandler(cb => q5.enqueue(cb));
        exec.enqueue({
            type: "CODEACT_REPLY", chatId: "chatX", taskId: "t1",
            decisions: [{ action: "REPLY", confidence: 1, reason: "test" }],
            contextSnapshot: { depth: 0, chatId: "chatX", snapshotTimestamp: "", topicDigests: [], engagementScore: 50 },
            replyMode: "SINGLE", createdAt: new Date().toISOString(),
        });

        await new Promise(r => setTimeout(r, 100));
        assert.equal(q5.size, 1, "callback 应到达 Q5");

        const loop = new MainAgentLoop(q3, q5, mgr);
        const tick = await loop.tick();
        assert.equal(tick.phase1Callbacks, 1, "应收集 callback");
        mgr.dispose();
    });

    it("#4 FastPath: 授权 → 回复 → 自动禁用", async () => {
        const fp = new FastPathHandler("chatY");
        const q5 = new CallbackQueue();
        fp.setCallbackHandler(cb => q5.enqueue(cb));

        fp.authorize({
            preauthorizedActions: ["ack"], blockedActions: [], tonePreset: "casual",
            maxRepliesBeforeReauth: 1, expiresAt: new Date(Date.now() + 60000).toISOString(), authorizedAt: new Date().toISOString(),
        });

        const reply = await fp.handle({ chatId: "chatY", messageId: "m1", userId: "u1", text: "please ack", timestamp: new Date().toISOString() });
        assert.ok(reply, "应有回复");
        assert.equal(q5.size, 1, "callback 应入 Q5");
        assert.equal(fp.isAuthorized(), false, "达到 maxReplies 应自动禁用");
    });

    it("#5 Observer per-group 隔离", () => {
        const obs1 = new Observer("g1", { engagementWindowMs: 60000, alertEngagementThreshold: 90, fastPathEngagementThreshold: 95, mentionKeywords: [] });
        const obs2 = new Observer("g2", { engagementWindowMs: 60000, alertEngagementThreshold: 90, fastPathEngagementThreshold: 95, mentionKeywords: [] });

        for (let i = 0; i < 30; i++) {
            obs1.onMessage({ _id: `e${i}`, _ts: new Date().toISOString(), type: "telegram.message", chatId: "g1", userId: `u${i % 5}`, text: `msg ${i}` });
        }
        obs2.onMessage({ _id: "e0", _ts: new Date().toISOString(), type: "telegram.message", chatId: "g2", userId: "u1", text: "hello" });

        assert.ok(obs1.getEngagementScore() > obs2.getEngagementScore(), "g1 应比 g2 engagement 高");
        assert.equal(obs2.getTotalMessageCount(), 1);
    });

    it("#6 Stickiness 影响 Q3 优先级", () => {
        const q3 = new DynamicAttentionQueue();
        q3.enqueueOrUpdate({ chatId: "core1", priority: 50, stickinessLevel: "CORE" });
        q3.enqueueOrUpdate({ chatId: "str1", priority: 10, stickinessLevel: "STRANGER" });
        const top = q3.dequeue();
        assert.equal(top?.chatId, "core1", "CORE 群组应先出队");
    });

    it("#7 GroupDispatcher 多 handler", () => {
        const dispatcher = new GroupDispatcher();
        const results: string[] = [];
        dispatcher.subscribe("g1", e => results.push("handler1:" + e.type));
        dispatcher.subscribe("g1", e => results.push("handler2:" + e.type));
        dispatcher.dispatch({ _id: "e1", _ts: "", type: "telegram.message", chatId: "g1" });
        assert.equal(results.length, 2, "两个 handler 都应被调用");
    });

    it("#8 CodeActExecutor session 独立", async () => {
        const exec1 = new CodeActExecutor("g1");
        const exec2 = new CodeActExecutor("g2");

        await exec1.execute({
            type: "CODEACT_REPLY", chatId: "g1", taskId: "t1",
            decisions: [{ action: "REPLY", confidence: 1, reason: "" }],
            contextSnapshot: { depth: 0, chatId: "g1", snapshotTimestamp: "", topicDigests: [], engagementScore: 0 },
            replyMode: "SINGLE", createdAt: new Date().toISOString(),
        });

        assert.equal(exec1.getSessionSize(), 2, "g1 应有 2 条 session");
        assert.equal(exec2.getSessionSize(), 0, "g2 session 应为空");
    });

    it("#9 Q3 block 防止 dequeue", () => {
        const q3 = new DynamicAttentionQueue();
        q3.enqueueOrUpdate({ chatId: "blocked1", priority: 90 });
        q3.block("blocked1", "executing");
        assert.equal(q3.dequeue(), null, "blocked 应不可 dequeue");
    });

    it("#10 SubagentManager releaseIdle 不影响活跃实例", () => {
        const mgr = new SubagentManager({ idleTimeout: 100 });
        const active = mgr.getOrCreate("active");
        const idle = mgr.getOrCreate("idle");
        idle.lastActivityAt = Date.now() - 200;
        active.touch();
        const released = mgr.releaseIdle();
        assert.deepEqual(released, ["idle"], "只应释放 idle");
        assert.equal(mgr.size, 1);
        assert.ok(mgr.get("active"), "active 应保留");
        mgr.dispose();
    });

    // ─── Edge cases (from audit) ───

    it("#11 Multi-group: 5 groups competing, only maxAttendsPerTick=2 served", async () => {
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        const loop = new MainAgentLoop(q3, q5, mgr, { maxAttendsPerTick: 2 });
        for (let i = 0; i < 5; i++) { mgr.getOrCreate(`g${i}`); q3.enqueueOrUpdate({ chatId: `g${i}`, priority: (i + 1) * 10, topicDigests: [] }); }
        const r = await loop.tick();
        assert.equal(r.phase3Attended.length, 2, "只应 attend 2 个");
        assert.equal(q3.size, 3, "剩余 3 个");
        mgr.dispose();
    });

    it("#12 MainAgentLoop attendHandler→dispatchHandler chain", async () => {
        const q3 = new DynamicAttentionQueue();
        const q5 = new CallbackQueue();
        const mgr = new SubagentManager();
        mgr.getOrCreate("g1");
        const loop = new MainAgentLoop(q3, q5, mgr);
        const dispatched: string[] = [];
        loop.setAttendHandler(async entry => ({ chatId: entry.chatId, decisions: [{ action: "REPLY", confidence: 1, reason: "test" }], replyMode: "SINGLE", reasoning: "test" }));
        loop.setDispatchHandler(async result => { dispatched.push(result.chatId); });
        q3.enqueueOrUpdate({ chatId: "g1", priority: 50, topicDigests: [] });
        await loop.tick();
        assert.deepEqual(dispatched, ["g1"]);
        mgr.dispose();
    });

    it("#13 config.yaml subagent section parses correctly", async () => {
        const configMod = await import("../src/core/config.js");
        configMod.clearConfigCache();
        const config = configMod.loadConfig();
        assert.ok(config.subagent, "subagent 配置应存在");
        assert.equal(config.subagent!.maxSandboxInstances, 5);
        assert.equal(config.subagent!.cosineDecay?.defaultCyclePeriod, 20);
        assert.equal(config.subagent!.fastPath?.defaultMaxReplies, 3);
        assert.equal(config.subagent!.attentionQueue?.maxSize, 100);
        assert.equal(config.subagent!.decision?.batchThreshold, 50);
        assert.equal(config.subagent!.stickiness?.CORE?.priorityMultiplier, 1.0);
        assert.equal(config.subagent!.stickinessThresholds?.upgrade?.strangerToAcquaintance, 5);
        configMod.clearConfigCache();
    });

    it("#14 FastPath re-authorize resets counter", async () => {
        const fp = new FastPathHandler("g1");
        fp.authorize({ preauthorizedActions: ["ack"], blockedActions: [], tonePreset: "casual", maxRepliesBeforeReauth: 2, expiresAt: new Date(Date.now() + 60000).toISOString(), authorizedAt: new Date().toISOString() });
        await fp.handle({ chatId: "g1", messageId: "m1", userId: "u1", text: "ack 1", timestamp: new Date().toISOString() });
        assert.equal(fp.getStatus().repliesSent, 1);
        fp.authorize({ preauthorizedActions: ["ack"], blockedActions: [], tonePreset: "casual", maxRepliesBeforeReauth: 5, expiresAt: new Date(Date.now() + 60000).toISOString(), authorizedAt: new Date().toISOString() });
        assert.equal(fp.getStatus().repliesSent, 0, "re-authorize 应重置计数器");
        assert.equal(fp.getStatus().maxReplies, 5);
    });

    it("#15 CodeActExecutor rapid successive enqueue processes all", async () => {
        const exec = new CodeActExecutor("g1");
        const cbs: any[] = [];
        exec.setCallbackHandler(cb => cbs.push(cb));
        for (let i = 0; i < 5; i++) {
            exec.enqueue({ type: "CODEACT_REPLY", chatId: "g1", taskId: `t${i}`, decisions: [{ action: "REPLY", confidence: 1, reason: "" }], contextSnapshot: { depth: 0, chatId: "g1", snapshotTimestamp: "", topicDigests: [], engagementScore: 0 }, replyMode: "SINGLE", createdAt: new Date().toISOString() });
        }
        await new Promise(r => setTimeout(r, 500));
        assert.equal(cbs.length, 5, "所有 5 个任务应被处理");
    });
});
