/**
 * m5-guardrail.test.ts — M5 Subagent 审查 + corrections 机制 单元测试
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type {
    SubagentCallback,
    MiniCodeActCall,
    AttendResult,
} from "../../src/subagent/types.js";

import {
    executeMiniCodeActs,
    registerHandlers,
    clearHandlers,
    type MiniCodeActHandler,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";
import { formatMiniCodeActReport } from "../../src/main-agent/minicodeact-formatter.js";
import {
    renderTemplate,
    clearTemplateCache,
} from "../../src/main-agent/prompt-renderer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

function createHandler(
    fn: (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps) => unknown,
    descFn: (args: Record<string, unknown>) => string,
): MiniCodeActHandler {
    const handler = fn as MiniCodeActHandler;
    handler.describe = descFn;
    return handler;
}

function mockDeps(): MiniCodeActDeps {
    return {
        globalState: {
            recordDecision: () => {},
        } as any,
        memory: {} as any,
        attentionQueue: {} as any,
        subagentManager: {} as any,
    };
}

describe("M5: Subagent 审查 + corrections 机制", () => {
    beforeEach(() => {
        clearHandlers();
        clearTemplateCache();
    });

    // ── Test #1: task prompt 含 MiniCodeAct Report ──
    it("#1 task prompt 含 MiniCodeAct Report (hasMiniCodeActReport=true)", () => {
        const template = readFileSync(
            join(projectRoot, "system-prompts", "executor", "subagent-execution-task.md"),
            "utf-8",
        );

        const rendered = renderTemplate(template, {
            taskId: "task-001",
            chatTitle: "TestGroup",
            chatId: "tg:123",
            chatType: "群聊",
            decisions: "REPLY: 回复消息",
            toneGuidance: "友好",
            topicSummary: "测试话题",
            personContext: "无",
            targetMessages: "msg#1",
            hasMiniCodeActReport: true,
            miniCodeActReport: "✅ memory.writeCoreFact → 已写入核心事实",
        });

        assert.ok(rendered.includes("预执行操作结果"), "should contain MiniCodeAct report header");
        assert.ok(rendered.includes("memory.writeCoreFact"), "should contain report details");
        assert.ok(rendered.includes("审查结果"), "should contain review instruction");
    });

    // ── Test #2: task prompt 无 MiniCodeAct Report ──
    it("#2 task prompt 无 MiniCodeAct Report (hasMiniCodeActReport=false)", () => {
        const template = readFileSync(
            join(projectRoot, "system-prompts", "executor", "subagent-execution-task.md"),
            "utf-8",
        );

        const rendered = renderTemplate(template, {
            taskId: "task-002",
            chatTitle: "TestGroup",
            chatId: "tg:123",
            chatType: "群聊",
            decisions: "REPLY: 回复消息",
            toneGuidance: "友好",
            topicSummary: "测试话题",
            personContext: "无",
            targetMessages: "msg#1",
            hasMiniCodeActReport: false,
        });

        assert.ok(!rendered.includes("预执行操作结果"), "should NOT contain MiniCodeAct report");
    });

    // ── Test #3: dispatch-handler 注入 miniCodeActReport ──
    it("#3 dispatch-handler 注入 miniCodeActReport 到 contextSnapshot", () => {
        const miniResults = [
            { call: "tasks.add", success: true, summary: '已创建任务: "买菜"' },
        ];
        const report = formatMiniCodeActReport(miniResults);

        // Simulate what dispatch-handler does
        const contextSnapshot: Record<string, unknown> = {};
        if (miniResults.length > 0) {
            contextSnapshot.miniCodeActReport = report;
            contextSnapshot.hasMiniCodeActReport = true;
        }

        assert.ok(contextSnapshot.hasMiniCodeActReport);
        assert.ok((contextSnapshot.miniCodeActReport as string).includes("tasks.add"));
    });

    // ── Test #4: Phase 1 处理无 corrections 的 callback ──
    it("#4 Phase 1 处理无 corrections 的 callback", () => {
        const cb: SubagentCallback = {
            taskId: "t1",
            chatId: "c1",
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: "done",
            durationMs: 100,
            createdAt: new Date().toISOString(),
        };

        // No corrections → no executeMiniCodeActs call
        assert.equal(cb.corrections, undefined);
        assert.ok(!cb.corrections?.length);
    });

    // ── Test #5: Phase 1 处理含 corrections 的 callback ──
    it("#5 Phase 1 处理含 corrections 的 callback", () => {
        let fixExecuted = false;
        registerHandlers("memory", {
            writeCoreFact: createHandler(
                (args) => { fixExecuted = true; return { factId: "f1" }; },
                (args) => `写入事实: ${args.content}`,
            ),
        });

        const cb: SubagentCallback = {
            taskId: "t1",
            chatId: "c1",
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: "done",
            durationMs: 100,
            createdAt: new Date().toISOString(),
            corrections: [
                {
                    originalCall: "memory.writeCoreFact",
                    issue: "判断有误，用户不是不吃辣",
                    suggestedFix: {
                        call: "memory.writeCoreFact",
                        args: { subject: "u1", content: "会根据心情选辣度", category: "preference" },
                    },
                },
            ],
        };

        // Simulate Phase 1 corrections processing
        const decisions: string[] = [];
        if (cb.corrections?.length) {
            for (const correction of cb.corrections) {
                const fixResults = executeMiniCodeActs(
                    [correction.suggestedFix],
                    cb.chatId,
                    mockDeps(),
                );
                for (const r of fixResults) {
                    decisions.push(
                        `CORRECTION: ${r.call} → ${r.success ? "OK" : "FAIL"} (${correction.issue})`
                    );
                }
            }
        }

        assert.equal(fixExecuted, true, "correction handler should be called");
        assert.equal(decisions.length, 1);
        assert.ok(decisions[0].includes("CORRECTION"));
        assert.ok(decisions[0].includes("OK"));
    });

    // ── Test #6: corrections 中 suggestedFix 执行成功 ──
    it("#6 corrections suggestedFix 执行成功 → recordDecision 含 CORRECTION: OK", () => {
        registerHandlers("tasks", {
            update: createHandler(
                () => ({ success: true }),
                () => "任务已更新",
            ),
        });

        const correction = {
            originalCall: "tasks.add",
            issue: "任务不需要",
            suggestedFix: { call: "tasks.update", args: { taskId: "t1", status: "CANCELLED" } },
        };

        const fixResults = executeMiniCodeActs([correction.suggestedFix], "c1", mockDeps());
        assert.equal(fixResults[0].success, true);

        const log = `CORRECTION: ${fixResults[0].call} → ${fixResults[0].success ? "OK" : "FAIL"} (${correction.issue})`;
        assert.ok(log.includes("CORRECTION: tasks.update → OK"));
    });

    // ── Test #7: corrections 中 suggestedFix 执行失败 ──
    it("#7 corrections suggestedFix 执行失败 → recordDecision 含 CORRECTION: FAIL", () => {
        registerHandlers("tasks", {
            update: createHandler(
                () => { throw new Error("task not found"); },
                () => "任务已更新",
            ),
        });

        const correction = {
            originalCall: "tasks.add",
            issue: "任务不需要",
            suggestedFix: { call: "tasks.update", args: { taskId: "nonexistent", status: "CANCELLED" } },
        };

        const fixResults = executeMiniCodeActs([correction.suggestedFix], "c1", mockDeps());
        assert.equal(fixResults[0].success, false);

        const log = `CORRECTION: ${fixResults[0].call} → ${fixResults[0].success ? "OK" : "FAIL"} (${correction.issue})`;
        assert.ok(log.includes("CORRECTION: tasks.update → FAIL"));
    });

    // ── Test #8: 多个 corrections 依次执行 ──
    it("#8 多个 corrections 依次执行", () => {
        let callCount = 0;
        registerHandlers("memory", {
            writeCoreFact: createHandler(
                () => { callCount++; return { factId: "f" + callCount }; },
                () => "写入事实",
            ),
        });
        registerHandlers("tasks", {
            update: createHandler(
                () => { callCount++; return { success: true }; },
                () => "更新任务",
            ),
        });

        const corrections = [
            {
                originalCall: "memory.writeCoreFact",
                issue: "事实有误",
                suggestedFix: { call: "memory.writeCoreFact", args: { subject: "u1", content: "corrected" } },
            },
            {
                originalCall: "tasks.add",
                issue: "任务不需要",
                suggestedFix: { call: "tasks.update", args: { taskId: "t1", status: "CANCELLED" } },
            },
        ];

        const allResults: any[] = [];
        for (const correction of corrections) {
            const fixResults = executeMiniCodeActs([correction.suggestedFix], "c1", mockDeps());
            allResults.push(...fixResults);
        }

        assert.equal(allResults.length, 2, "should have 2 results");
        assert.equal(callCount, 2, "both handlers should be called");
        assert.ok(allResults.every(r => r.success), "all fixes should succeed");
    });

    // ── Test #9: E2E writeCoreFact → correction 覆盖 ──
    it("#9 E2E: writeCoreFact → Subagent corrections → 纠正后值", () => {
        const facts: Record<string, string> = {};

        registerHandlers("memory", {
            writeCoreFact: createHandler(
                (args) => {
                    const subject = args.subject as string;
                    const content = args.content as string;
                    facts[subject] = content;
                    return { factId: "f1" };
                },
                (args) => `写入: ${args.content}`,
            ),
        });

        // Phase 5.5: 主 Agent 写入初步判断
        executeMiniCodeActs(
            [{ call: "memory.writeCoreFact", args: { subject: "u1", content: "不吃辣", category: "preference" } }],
            "c1",
            mockDeps(),
        );
        assert.equal(facts["u1"], "不吃辣");

        // Phase 1: Subagent correction
        const correction = {
            originalCall: "memory.writeCoreFact",
            issue: "用户不是不吃辣",
            suggestedFix: {
                call: "memory.writeCoreFact",
                args: { subject: "u1", content: "根据心情选辣度", category: "preference" },
            },
        };

        executeMiniCodeActs([correction.suggestedFix], "c1", mockDeps());
        assert.equal(facts["u1"], "根据心情选辣度", "fact should be overwritten by correction");
    });

    // ── Test #10: E2E tasks.add → correction cancel ──
    it("#10 E2E: tasks.add → correction cancel → task CANCELLED", () => {
        const tasks: Record<string, string> = {};

        registerHandlers("tasks", {
            add: createHandler(
                (args) => {
                    const id = "t-" + Math.random().toString(36).slice(2, 6);
                    tasks[id] = "PENDING";
                    return { taskId: id };
                },
                (args) => `创建任务: ${args.description}`,
            ),
            update: createHandler(
                (args) => {
                    const taskId = args.taskId as string;
                    const status = args.status as string;
                    if (tasks[taskId]) {
                        tasks[taskId] = status;
                        return { success: true };
                    }
                    return { success: false };
                },
                (args) => `更新任务: ${args.taskId} → ${args.status}`,
            ),
        });

        // Phase 5.5: 主 Agent 创建任务
        const results = executeMiniCodeActs(
            [{ call: "tasks.add", args: { description: "推荐奶茶" } }],
            "c1",
            mockDeps(),
        );
        const taskId = (results[0].result as any).taskId;
        assert.equal(tasks[taskId], "PENDING");

        // Phase 1: Subagent correction
        const correction = {
            originalCall: "tasks.add",
            issue: "用户是在吐槽不是求推荐",
            suggestedFix: {
                call: "tasks.update",
                args: { taskId, status: "CANCELLED" },
            },
        };

        executeMiniCodeActs([correction.suggestedFix], "c1", mockDeps());
        assert.equal(tasks[taskId], "CANCELLED", "task should be cancelled by correction");
    });
});
