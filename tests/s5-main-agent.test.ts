/**
 * s5-main-agent.test.ts — S5 主 Agent 注意力循环 单元测试
 *
 * 覆盖 20 个测试用例（subtask.md S5 测试计划）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { calculateDepth, previewSchedule, isDeepUpdate, type ContextDepth } from "../src/main-agent/cosine-decay.js";
import { buildGroupContext, estimateContextTokens } from "../src/main-agent/context-builder.js";
import { estimateReplyMode, estimateReplyCount, buildObserveDecision, buildReplyDecisions } from "../src/main-agent/decision-maker.js";
import { renderPrompt, buildAttentionVariables, setPromptDirectory, loadTemplate, renderTemplate } from "../src/main-agent/prompt-renderer.js";
import { MainAgentLoop } from "../src/main-agent/main-agent-loop.js";
import { DynamicAttentionQueue } from "../src/subagent/attention-queue.js";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { SubagentManager } from "../src/subagent/subagent-manager.js";
import type { GroupContextPackage, TopicDigest } from "../src/subagent/types.js";

function makeDigest(overrides?: Partial<TopicDigest>): TopicDigest {
    return {
        topicId: "topic1",
        label: "Test Topic",
        summary: "A test topic",
        state: "ACTIVE",
        participants: ["u1"],
        keywords: ["test"],
        messageCount: 5,
        lastActivityAt: new Date().toISOString(),
        ...overrides,
    };
}

describe("S5: 主 Agent 注意力循环", () => {

    // ─── S5.2: Cosine Decay ───

    describe("S5.2: Cosine Decay", () => {
        it("#1 calculateDepth(0, 20) = 3 (L3, 周期起点最深)", () => {
            const depth = calculateDepth(0, 20);
            assert.equal(depth, 3, "周期起点 cos(0)=1 → 最深");
        });

        it("#2 calculateDepth(10, 20) = 0 (L0, 半周期最浅)", () => {
            const depth = calculateDepth(10, 20);
            assert.equal(depth, 0, "半周期 cos(π)=-1 → 最浅");
        });

        it("#3 calculateDepth 输出始终在 0-3 范围", () => {
            for (let i = 0; i < 100; i++) {
                const d = calculateDepth(i, 20);
                assert.ok(d >= 0 && d <= 3, `depth ${d} 超出范围 at count=${i}`);
            }
        });

        it("#4 previewSchedule 产出周期性模式", () => {
            const schedule = previewSchedule(0, 20, 20);
            assert.equal(schedule.length, 20);
            // 应该有 L0 和 L3
            assert.ok(schedule.includes(3 as ContextDepth), "应包含 L3");
            assert.ok(schedule.includes(0 as ContextDepth), "应包含 L0");
        });

        it("#5 isDeepUpdate 在适当位置为 true", () => {
            // 周期起点附近应是 deep
            assert.equal(isDeepUpdate(0, 20), true, "count=0 应是 deep");
            // 半周期应不是 deep
            assert.equal(isDeepUpdate(10, 20), false, "count=10 应不是 deep");
        });
    });

    // ─── S5.3: Decision Maker ───

    describe("S5.3: Decision Maker", () => {
        it("#6 estimateReplyMode: 高 engagement + 多消息 → BATCH", () => {
            const pkg: GroupContextPackage = {
                depth: 0, chatId: "c1", snapshotTimestamp: new Date().toISOString(),
                topicDigests: [makeDigest()], engagementScore: 70,
            };
            const mode = estimateReplyMode(pkg, 15, false, "FAMILIAR");
            assert.equal(mode, "BATCH");
        });

        it("#7 estimateReplyMode: @ mention 总是至少 SINGLE", () => {
            const pkg: GroupContextPackage = {
                depth: 0, chatId: "c1", snapshotTimestamp: new Date().toISOString(),
                topicDigests: [], engagementScore: 5,
            };
            const mode = estimateReplyMode(pkg, 1, true, "STRANGER");
            assert.equal(mode, "SINGLE");
        });

        it("#8 estimateReplyMode: 低 engagement → NONE", () => {
            const pkg: GroupContextPackage = {
                depth: 0, chatId: "c1", snapshotTimestamp: new Date().toISOString(),
                topicDigests: [], engagementScore: 3,
            };
            const mode = estimateReplyMode(pkg, 1, false, "ACQUAINTANCE");
            assert.equal(mode, "NONE");
        });

        it("#9 estimateReplyCount BATCH 模式", () => {
            assert.equal(estimateReplyCount("BATCH", 4, 20), 4);
            assert.equal(estimateReplyCount("BATCH", 1, 20), 2, "至少 2");
            assert.equal(estimateReplyCount("BATCH", 10, 50), 5, "最多 5");
        });

        it("#10 estimateReplyCount SINGLE/NONE", () => {
            assert.equal(estimateReplyCount("SINGLE", 5, 20), 1);
            assert.equal(estimateReplyCount("NONE", 5, 20), 0);
        });
    });

    // ─── S5.4: Context Builder ───

    describe("S5.4: Context Builder", () => {
        it("#11 L0 只包含 topicDigests + engagement", () => {
            const pkg = buildGroupContext({
                chatId: "c1", depth: 0, snapshotTimestamp: "2026-01-01",
                topicDigests: [makeDigest()], engagementScore: 50,
                groupModel: { chatId: "c1", chatTitle: "Test" } as any,
                messages: [{ messageId: "m1", chatId: "c1", userId: "u1", displayName: "A", text: "hi", replyToMessageId: null, timestamp: "2026-01-01" }],
            });
            assert.equal(pkg.depth, 0);
            assert.equal(pkg.topicDigests.length, 1);
            assert.equal(pkg.groupModel, undefined, "L0 不应有 groupModel");
            assert.equal(pkg.messages, undefined, "L0 不应有 messages");
        });

        it("#12 L2 包含 messages", () => {
            const pkg = buildGroupContext({
                chatId: "c1", depth: 2, snapshotTimestamp: "2026-01-01",
                topicDigests: [makeDigest()], engagementScore: 50,
                messages: [{ messageId: "m1", chatId: "c1", userId: "u1", displayName: "A", text: "hello world long message", replyToMessageId: null, timestamp: "2026-01-01" }],
            });
            assert.ok(pkg.messages, "L2 应有 messages");
            assert.equal(pkg.messages!.length, 1);
        });

        it("#13 estimateContextTokens 返回正整数", () => {
            const pkg = buildGroupContext({
                chatId: "c1", depth: 2, snapshotTimestamp: "2026-01-01",
                topicDigests: [makeDigest()], engagementScore: 50,
                messages: [{ messageId: "m1", chatId: "c1", userId: "u1", displayName: "Alice", text: "Hello world, this is a test message.", replyToMessageId: null, timestamp: "2026-01-01" }],
            });
            const tokens = estimateContextTokens(pkg);
            assert.ok(tokens > 0, `tokens 应为正: ${tokens}`);
        });
    });

    // ─── S5.5: Prompt Renderer ───

    describe("S5.5: Prompt Renderer", () => {
        it("#14 renderPrompt: 变量替换", () => {
            const result = renderPrompt("ATTENTION", {
                chatId: "chat123",
                depth: 2,
                snapshotTimestamp: "2026-01-01",
                engagementScore: 75,
                newMessageCount: 10,
                topicCount: 3,
                topicDigests: "(3 topics listed here)",
            });

            assert.ok(result.includes("chat123"), "应包含 chatId");
            assert.ok(result.includes("75"), "应包含 engagementScore");
            assert.ok(result.includes("L2"), "应包含深度");
        });

        it("#15 renderPrompt: 条件块", () => {
            const withGroup = renderPrompt("ATTENTION", {
                chatId: "c1", depth: 1, snapshotTimestamp: "2026-01-01",
                engagementScore: 50, newMessageCount: 5, topicCount: 1,
                topicDigests: "",
                groupModel: true, chatTitle: "Test Group", description: "A group",
                avgMessagesPerDay: 100, engagementLevel: "high",
            });
            assert.ok(withGroup.includes("Test Group"), "应包含群组画像");

            const withoutGroup = renderPrompt("ATTENTION", {
                chatId: "c1", depth: 0, topicDigests: "",
                groupModel: false,
            });
            assert.ok(!withoutGroup.includes("群组画像"), "不应包含群组画像块");
        });

        it("#16 buildAttentionVariables 构建正确", () => {
            const pkg: GroupContextPackage = {
                depth: 1, chatId: "c1", snapshotTimestamp: "2026-01-01",
                topicDigests: [makeDigest()], engagementScore: 60,
                groupModel: { chatId: "c1", chatTitle: "TestGroup" } as any,
            };

            const vars = buildAttentionVariables(pkg, 5);
            assert.equal(vars.chatId, "c1");
            assert.equal(vars.depth, 1);
            assert.equal(vars.engagementScore, 60);
            assert.equal(vars.newMessageCount, 5);
        });
    });

    // ─── S5.1: MainAgentLoop ───

    describe("S5.1: MainAgentLoop", () => {
        it("#17 tick() 空队列不报错", async () => {
            const q3 = new DynamicAttentionQueue();
            const q5 = new CallbackQueue();
            const mgr = new SubagentManager();
            const loop = new MainAgentLoop(q3, q5, mgr);

            const result = await loop.tick();
            assert.equal(result.phase3Attended.length, 0);
            assert.equal(result.phase1Callbacks, 0);

            mgr.dispose();
        });

        it("#18 tick() dequeue 最高优先级", async () => {
            const q3 = new DynamicAttentionQueue();
            const q5 = new CallbackQueue();
            const mgr = new SubagentManager();
            const loop = new MainAgentLoop(q3, q5, mgr);

            // 创建 subagent 以便 markAttended 不出错
            mgr.getOrCreate("chatA");
            mgr.getOrCreate("chatB");

            q3.enqueueOrUpdate({ chatId: "chatA", priority: 30, topicDigests: [] });
            q3.enqueueOrUpdate({ chatId: "chatB", priority: 80, topicDigests: [makeDigest()] });

            const result = await loop.tick();
            // chatB 优先级更高，应先被 attend
            assert.ok(result.phase3Attended.includes("chatB"), "chatB 应被 attend");

            mgr.dispose();
        });

        it("#19 tick() 收集 Q5 callback", async () => {
            const q3 = new DynamicAttentionQueue();
            const q5 = new CallbackQueue();
            const mgr = new SubagentManager();
            const loop = new MainAgentLoop(q3, q5, mgr);

            q5.enqueue({
                taskId: "t1", chatId: "c1", executionType: "CODEACT",
                status: "COMPLETED", summary: "ok", durationMs: 100,
                createdAt: new Date().toISOString(),
            });

            const result = await loop.tick();
            assert.equal(result.phase1Callbacks, 1, "应收集 1 个 callback");

            mgr.dispose();
        });

        it("#20 tick() 正确更新 subagent markAttended", async () => {
            const q3 = new DynamicAttentionQueue();
            const q5 = new CallbackQueue();
            const mgr = new SubagentManager();
            const loop = new MainAgentLoop(q3, q5, mgr);

            const sub = mgr.getOrCreate("chatX");
            assert.equal(sub.attendCount, 0);

            q3.enqueueOrUpdate({ chatId: "chatX", priority: 50, topicDigests: [] });

            await loop.tick();

            assert.equal(sub.attendCount, 1, "attendCount 应加一");
            assert.ok(sub.lastAttendedAt !== null, "lastAttendedAt 应被设置");

            mgr.dispose();
        });
    });

    // ─── Edge cases ───

    describe("S5 Edge Cases", () => {
        it("#21 CosineDecay: cyclePeriod=0 returns 0", () => {
            assert.equal(calculateDepth(5, 0), 0);
        });

        it("#22 CosineDecay: negative attendCount stays in range", () => {
            const d = calculateDepth(-1, 20);
            assert.ok(d >= 0 && d <= 3, `depth=${d} should be in range`);
        });

        it("#23 CosineDecay: very large attendCount stays in range", () => {
            const d = calculateDepth(1_000_000, 20);
            assert.ok(d >= 0 && d <= 3);
        });

        it("#24 ContextBuilder: empty topicDigests + depth=0", () => {
            const pkg = buildGroupContext({ chatId: "c1", depth: 0, snapshotTimestamp: "", topicDigests: [], engagementScore: 0 });
            assert.equal(pkg.topicDigests.length, 0);
            const tokens = estimateContextTokens(pkg);
            assert.ok(tokens >= 0);
        });

        it("#25 DecisionMaker: engagement exactly at threshold", () => {
            const pkg: GroupContextPackage = { depth: 0, chatId: "c1", snapshotTimestamp: "", topicDigests: [], engagementScore: 50 };
            const mode = estimateReplyMode(pkg, 10, false, "FAMILIAR", { batchThreshold: 50, noneThreshold: 10, batchMessageThreshold: 10 });
            assert.equal(mode, "BATCH");
        });

        it("#26 renderTemplate with unknown variables left empty", () => {
            const result = renderTemplate("Hello {{name}}, score={{score}}.", { name: "Alice" });
            assert.ok(result.includes("Alice"));
            assert.ok(!result.includes("{{score}}"));
        });

        it("#27 renderTemplate conditional block with false flag removed", () => {
            const result = renderTemplate("Start {{#showExtra}}EXTRA{{/showExtra}} End", { showExtra: false });
            assert.ok(!result.includes("EXTRA"));
            assert.ok(result.includes("Start") && result.includes("End"));
        });

        it("#28 CosineDecay: forceMinDepth boosts shallow depth", () => {
            // count=10 in period=20 gives L0 (cos(π)=-1 → shallowest)
            assert.equal(calculateDepth(10, 20), 0, "without force: L0");
            assert.equal(calculateDepth(10, 20, { forceMinDepth: 2 }), 2, "with forceMinDepth=2: boosted to L2");
        });

        it("#29 CosineDecay: forceMinDepth does not lower deep depth", () => {
            // count=0 in period=20 gives L3 (cos(0)=1 → deepest)
            assert.equal(calculateDepth(0, 20, { forceMinDepth: 1 }), 3, "L3 should not be lowered to L1");
        });

        it("#30 CosineDecay: cyclePeriod=0 with forceMinDepth returns forced depth", () => {
            assert.equal(calculateDepth(5, 0, { forceMinDepth: 2 }), 2, "cyclePeriod=0 should use forceMinDepth");
        });
    });
});
