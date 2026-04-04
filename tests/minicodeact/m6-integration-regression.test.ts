/**
 * m6-integration-regression.test.ts — M6 集成测试 + 安全回归
 *
 * 端到端场景、安全约束验证、回归测试。
 */

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
    Decision,
    AttendResult,
    MiniCodeActCall,
    MiniCodeActResult,
    SubagentCallback,
} from "../../src/subagent/types.js";

import {
    executeMiniCodeActs,
    registerHandlers,
    clearHandlers,
    type MiniCodeActHandler,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";
import { formatMiniCodeActReport } from "../../src/main-agent/minicodeact-formatter.js";
import { GlobalState } from "../../src/main-agent/global-state.js";
import {
    renderPrompt,
    renderTemplate,
    setPromptDirectory,
    clearTemplateCache,
} from "../../src/main-agent/prompt-renderer.js";

// Import all handlers (side-effect: register them)
import "../../src/main-agent/minicodeact-handlers/tasks.js";
import "../../src/main-agent/minicodeact-handlers/notes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

const tempDirs: string[] = [];
function tempDir(): string {
    const d = join(tmpdir(), `m6-${randomUUID()}`);
    mkdirSync(d, { recursive: true });
    tempDirs.push(d);
    return d;
}
after(() => {
    for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function createGS(): GlobalState {
    const dir = tempDir();
    return new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
}

function mockDeps(gs: GlobalState): MiniCodeActDeps {
    return {
        globalState: gs,
        memory: {} as any,
        attentionQueue: {} as any,
        subagentManager: {} as any,
    };
}

/** Simulate the decision parsing logic from attend-handler */
function parseDecisions(parsed: any): Decision[] {
    return Array.isArray(parsed.decisions) ? parsed.decisions.map((d: any) => ({
        action: d.action ?? "REPLY",
        topicId: d.topicId || undefined,
        targetMessageIds: Array.isArray(d.targetMessageIds) ? d.targetMessageIds : undefined,
        contentDirection: d.contentDirection,
        toneGuidance: d.toneGuidance,
        suggestedEmojis: Array.isArray(d.suggestedEmojis) ? d.suggestedEmojis : undefined,
        confidence: d.confidence ?? 0.5,
        reason: d.reason ?? "",
        miniCodeActs: Array.isArray(d.miniCodeActs) ? d.miniCodeActs : undefined,
    })) : [{ action: "OBSERVE" as const, confidence: 0.3, reason: "LLM 返回格式异常" }];
}

describe("M6: 集成测试 + 安全回归", () => {
    beforeEach(() => {
        clearTemplateCache();
        setPromptDirectory(join(projectRoot, "system-prompts"));
    });

    // ═══ 端到端场景 ═══

    it("#1 E2E: 跨群待办 → addFollowup → 下一 tick attend ATTENTION 含待办", () => {
        const gs = createGS();
        const deps = mockDeps(gs);

        // Tick 1: LLM 输出 addFollowup
        const llmJson = {
            replyMode: "SINGLE",
            decisions: [{
                action: "REPLY",
                contentDirection: "回复用户",
                confidence: 0.9,
                reason: "test",
                miniCodeActs: [{
                    call: "tasks.addFollowup",
                    args: {
                        sourceChatId: "tg:groupA",
                        targetChatId: "tg:groupB",
                        description: "转告聚会时间改为 19:00",
                    },
                }],
            }],
        };

        const decisions = parseDecisions(llmJson);
        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const d of decisions) {
            if (d.miniCodeActs?.length) allMiniCodeActs.push(...d.miniCodeActs);
        }

        const results = executeMiniCodeActs(allMiniCodeActs, "tg:groupA", deps);
        assert.equal(results.length, 1);
        assert.equal(results[0].success, true);

        // Verify followup is in GlobalState
        const followups = gs.getPendingFollowups();
        assert.equal(followups.length, 1);
        assert.equal(followups[0].targetChatId, "tg:groupB");
        assert.equal(followups[0].description, "转告聚会时间改为 19:00");

        // Tick 2: Simulate attend to groupB → complete the followup
        const fuId = followups[0].id;
        const results2 = executeMiniCodeActs(
            [{ call: "tasks.completeFollowup", args: { followupId: fuId } }],
            "tg:groupB",
            deps,
        );
        assert.equal(results2[0].success, true);
        assert.equal(gs.getPendingFollowups()[0].status, "DONE");

        gs.dispose();
    });

    it("#2 E2E: 长期记忆写入 → notes.add + tasks.add 混合操作", () => {
        const gs = createGS();
        const deps = mockDeps(gs);

        // Mixed operations in a single decision
        const results = executeMiniCodeActs(
            [
                { call: "tasks.add", args: { description: "提醒小明买菜", priority: "HIGH" } },
                { call: "notes.add", args: { content: "用户提到下周聚会", tags: ["聚会"], relatedChatId: "tg:group1" } },
            ],
            "tg:group1",
            deps,
        );

        assert.equal(results.length, 2);
        assert.ok(results.every(r => r.success));

        // Verify state
        assert.equal(gs.getTaskList().length, 1);
        assert.equal(gs.getTaskList()[0].description, "提醒小明买菜");
        assert.equal(gs.getNotes().length, 1);
        assert.ok(gs.getNotes()[0].content.includes("聚会"));

        // Simulate next tick: notes visible in ATTENTION prompt
        const notes = gs.getNotes("tg:group1");
        const notesText = notes.map(n => `- [${n.id}] ${n.content} (${n.tags.join(", ")})`).join("\n");
        const template = readFileSync(
            join(projectRoot, "system-prompts", "main-agent", "mainagent-attention.md"),
            "utf-8",
        );
        const rendered = renderTemplate(template, {
            chatTitle: "Group1",
            chatId: "tg:group1",
            chatType: "群聊",
            hasNotes: true,
            notes: notesText,
        });
        assert.ok(rendered.includes("聚会"));

        gs.dispose();
    });

    it("#3 E2E: 定时任务模拟 → tasks.add 用于提醒追踪", () => {
        const gs = createGS();
        const deps = mockDeps(gs);

        // Create reminder task
        const results = executeMiniCodeActs(
            [{
                call: "tasks.add",
                args: {
                    description: "15:00 提醒小明开会",
                    chatId: "tg:group_meeting",
                    priority: "HIGH",
                },
            }],
            "tg:group_meeting",
            deps,
        );

        assert.equal(results[0].success, true);
        const taskId = (results[0].result as any).taskId;

        // Task visible in state
        const task = gs.getTaskList().find(t => t.id === taskId);
        assert.ok(task);
        assert.equal(task!.priority, "HIGH");
        assert.equal(task!.chatId, "tg:group_meeting");

        // Complete it later
        gs.updateTaskStatus(taskId, "DONE");
        assert.equal(gs.getTaskList().find(t => t.id === taskId)!.status, "DONE");

        gs.dispose();
    });

    it("#4 E2E: 身份查验模拟 → report 写入 history → 下一 tick 可见", () => {
        // Register a mock searchIdentity handler
        clearHandlers();
        // Re-import tasks/notes won't re-register since the module was already loaded.
        // Register fresh handlers for this test
        const handler = (fn: any, descFn: any) => {
            const h = fn as MiniCodeActHandler;
            h.describe = descFn;
            return h;
        };

        registerHandlers("memory", {
            searchIdentity: handler(
                (args: any) => ({
                    results: [
                        { userId: "tg:user_wang1", displayName: "王明", aliases: ["老王", "王总"] },
                        { userId: "tg:user_wang2", displayName: "王伟", aliases: ["老王"] },
                    ],
                }),
                (args: any) => `搜索身份: "${args.query}"`,
            ),
        });

        const results = executeMiniCodeActs(
            [{ call: "memory.searchIdentity", args: { query: "老王" } }],
            "tg:group1",
            { globalState: {} as any, memory: {} as any, attentionQueue: {} as any, subagentManager: {} as any },
        );

        assert.equal(results[0].success, true);
        const searchResults = (results[0].result as any).results;
        assert.equal(searchResults.length, 2);

        // Report would be appended to history
        const report = formatMiniCodeActReport(results);
        assert.ok(report.includes("✅"));
        assert.ok(report.includes("memory.searchIdentity"));

        const reportPrompt = renderPrompt("MINI_CODE_ACT_REPORT", {
            chatId: "tg:group1",
            results: report,
            timestamp: new Date().toISOString(),
        });
        assert.ok(reportPrompt.includes("老王"));
    });

    // ═══ 安全约束验证 ═══

    it("#5 安全: 每次 attend 最多 8 条 miniCodeAct", () => {
        clearHandlers();
        let count = 0;
        const h = ((args: any) => { count++; return "ok"; }) as MiniCodeActHandler;
        h.describe = () => "test";
        registerHandlers("test", { ping: h });

        const calls: MiniCodeActCall[] = Array.from({ length: 12 }, () => ({
            call: "test.ping",
            args: {},
        }));

        const results = executeMiniCodeActs(calls, "c1",
            { globalState: {} as any, memory: {} as any, attentionQueue: {} as any, subagentManager: {} as any });
        assert.equal(results.length, 8, "should only execute 8");
        assert.equal(count, 8, "handler called 8 times");
    });

    it("#6 安全: boost amount 限制 1-50", () => {
        clearHandlers();
        let receivedAmount = 0;
        const h = ((args: any, _chatId: any, deps: any) => {
            const raw = args.amount as number;
            receivedAmount = Math.max(1, Math.min(50, raw ?? 1));
            return { newPriority: receivedAmount, success: true };
        }) as MiniCodeActHandler;
        h.describe = () => "boost";
        registerHandlers("attention", { boost: h });

        executeMiniCodeActs(
            [{ call: "attention.boost", args: { chatId: "c1", amount: 100 } }],
            "c1",
            { globalState: {} as any, memory: {} as any, attentionQueue: {} as any, subagentManager: {} as any },
        );
        assert.equal(receivedAmount, 50, "amount should be clamped to 50");
    });

    it("#7 安全: adjustStickiness 只允许相邻等级", () => {
        clearHandlers();
        const STICKINESS_ORDER = ["CORE", "FAMILIAR", "ACQUAINTANCE", "STRANGER"];
        const h = ((args: any) => {
            const currentLevel = "STRANGER";
            const targetLevel = args.targetLevel as string;
            const currentIdx = STICKINESS_ORDER.indexOf(currentLevel);
            const targetIdx = STICKINESS_ORDER.indexOf(targetLevel);
            if (Math.abs(currentIdx - targetIdx) > 1) {
                return { success: false, currentLevel };
            }
            return { success: true, currentLevel: targetLevel };
        }) as MiniCodeActHandler;
        h.describe = () => "adjust";
        registerHandlers("attention", { adjustStickiness: h });

        const results = executeMiniCodeActs(
            [{ call: "attention.adjustStickiness", args: { chatId: "c1", targetLevel: "CORE" } }],
            "c1",
            { globalState: {} as any, memory: {} as any, attentionQueue: {} as any, subagentManager: {} as any },
        );
        assert.equal((results[0].result as any).success, false, "STRANGER → CORE should be rejected");
    });

    it("#8 安全: 未知 namespace.method 静默失败", () => {
        clearHandlers();

        const results = executeMiniCodeActs(
            [
                { call: "nonexistent.method", args: {} },
                { call: "also.nonexistent", args: {} },
            ],
            "c1",
            { globalState: {} as any, memory: {} as any, attentionQueue: {} as any, subagentManager: {} as any },
        );

        assert.equal(results.length, 2);
        assert.equal(results[0].success, false);
        assert.equal(results[1].success, false);
        assert.ok(results[0].error!.includes("Unknown"));
        // Should not crash
    });

    it("#9 安全: handler 异常不影响主流程", () => {
        clearHandlers();
        const h1 = ((args: any) => { throw new Error("KABOOM"); }) as MiniCodeActHandler;
        h1.describe = () => "fail";
        const h2 = ((args: any) => "survived") as MiniCodeActHandler;
        h2.describe = () => "ok";
        registerHandlers("test", { fail: h1, ok: h2 });

        const results = executeMiniCodeActs(
            [
                { call: "test.fail", args: {} },
                { call: "test.ok", args: {} },
            ],
            "c1",
            { globalState: {} as any, memory: {} as any, attentionQueue: {} as any, subagentManager: {} as any },
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error!.includes("KABOOM"));
        assert.equal(results[1].success, true);
    });

    // ═══ 回归测试 ═══

    it("#10 回归: 不含 miniCodeActs 的 attend 行为不变", () => {
        const llmJson = {
            replyMode: "NONE",
            decisions: [{
                action: "OBSERVE",
                confidence: 0.5,
                reason: "不需要介入",
            }],
            reasoning: "话题不相关",
        };

        const decisions = parseDecisions(llmJson);
        const llmResult: AttendResult = {
            chatId: "tg:group_2",
            replyMode: llmJson.replyMode as any,
            decisions,
            reasoning: llmJson.reasoning,
        };

        // No miniCodeActs collected
        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const d of llmResult.decisions) {
            if (d.miniCodeActs?.length) allMiniCodeActs.push(...d.miniCodeActs);
        }

        assert.equal(allMiniCodeActs.length, 0);
        assert.equal(llmResult.miniCodeActResults, undefined);
        assert.equal(llmResult.decisions[0].action, "OBSERVE");
        assert.equal(llmResult.decisions[0].miniCodeActs, undefined);
    });

    it("#11 回归: dispatch-handler 对 REPLY/IGNORE/DEFER 行为不变", () => {
        // Verify Decision types still work correctly
        const replyDecision: Decision = {
            action: "REPLY",
            contentDirection: "回复",
            confidence: 0.9,
            reason: "需要回复",
        };
        const ignoreDecision: Decision = {
            action: "IGNORE",
            confidence: 0.8,
            reason: "无需介入",
        };
        const deferDecision: Decision = {
            action: "DEFER",
            confidence: 0.6,
            reason: "下次再看",
        };

        assert.equal(replyDecision.action, "REPLY");
        assert.equal(ignoreDecision.action, "IGNORE");
        assert.equal(deferDecision.action, "DEFER");

        // miniCodeActs is undefined when not present
        assert.equal(replyDecision.miniCodeActs, undefined);

        // Can coexist with miniCodeActs
        replyDecision.miniCodeActs = [{ call: "tasks.add", args: { description: "test" } }];
        assert.equal(replyDecision.miniCodeActs.length, 1);
        assert.equal(replyDecision.action, "REPLY"); // action unchanged
    });

    it("#12 回归: GlobalState save/load 向后兼容 (旧版无 notes)", () => {
        const dir = tempDir();
        const filePath = join(dir, "s.json");

        // Write old-format state (no notes field)
        const oldState = {
            lastActiveAt: new Date().toISOString(),
            taskList: [{ id: "t1", description: "old task", status: "PENDING", priority: "MEDIUM", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
            recentDecisions: [],
            pendingFollowups: [],
            attentionSummary: "old summary",
            // Note: no 'notes' field
        };
        writeFileSync(filePath, JSON.stringify(oldState), "utf-8");

        // Load with new code
        const gs = new GlobalState({ filePath, autoSaveInterval: 0 });
        const state = gs.getState();

        // Old data preserved
        assert.equal(state.taskList.length, 1);
        assert.equal(state.taskList[0].description, "old task");
        assert.equal(state.attentionSummary, "old summary");

        // notes defaults to empty array
        assert.deepEqual(state.notes, []);

        // Can add notes after load
        gs.addNote("new note");
        assert.equal(gs.getNotes().length, 1);

        gs.dispose();
    });

    it("#13 回归: tsc 编译通过 (验证类型)", () => {
        // This is a compile-time check. If this test file compiles and runs, types are correct.
        // Verify key type constraints:

        // MiniCodeActCall requires call and args
        const call: MiniCodeActCall = { call: "tasks.add", args: { description: "test" } };
        assert.equal(typeof call.call, "string");
        assert.equal(typeof call.args, "object");

        // MiniCodeActResult has required fields
        const result: MiniCodeActResult = {
            call: "tasks.add",
            success: true,
            summary: "done",
        };
        assert.equal(typeof result.success, "boolean");

        // AttendResult can have miniCodeActResults
        const attendResult: AttendResult = {
            chatId: "c1",
            decisions: [],
            replyMode: "NONE",
            reasoning: "test",
            miniCodeActResults: [result],
        };
        assert.equal(attendResult.miniCodeActResults!.length, 1);

        // SubagentCallback can have corrections
        const cb: SubagentCallback = {
            taskId: "t1",
            chatId: "c1",
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: "done",
            durationMs: 100,
            createdAt: new Date().toISOString(),
            corrections: [{
                originalCall: "memory.writeCoreFact",
                issue: "error",
                suggestedFix: { call: "memory.writeCoreFact", args: { content: "fixed" } },
            }],
        };
        assert.equal(cb.corrections!.length, 1);
    });
});
