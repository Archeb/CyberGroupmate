/**
 * m0-types-executor.test.ts — M0 类型基础 + 执行器骨架 单元测试
 *
 * 验证 MiniCodeAct 类型定义、执行器路由、限流、异常隔离和格式化。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type {
    MiniCodeActCall,
    MiniCodeActResult,
    Decision,
    AttendResult,
    SubagentCallback,
    AgentNote,
    MainAgentGlobalState,
} from "../../src/subagent/types.js";

import {
    executeMiniCodeActs,
    registerHandlers,
    clearHandlers,
    type MiniCodeActHandler,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";

import { formatMiniCodeActReport } from "../../src/main-agent/minicodeact-formatter.js";

// ─── Mock deps ───

function mockDeps(): MiniCodeActDeps {
    return {
        globalState: {} as any,
        memory: {} as any,
        attentionQueue: {} as any,
        subagentManager: {} as any,
    };
}

// ─── Helper: create a handler with describe ───

function createHandler(
    fn: (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps) => unknown,
    descFn: (args: Record<string, unknown>) => string,
): MiniCodeActHandler {
    const handler = fn as MiniCodeActHandler;
    handler.describe = descFn;
    return handler;
}

describe("M0: 类型基础 + 执行器骨架", () => {
    beforeEach(() => {
        clearHandlers();
    });

    // ── Test #1: MiniCodeActCall 类型校验 ──
    it("#1 MiniCodeActCall 类型校验", () => {
        const call: MiniCodeActCall = {
            call: "tasks.add",
            args: { description: "测试任务", priority: "HIGH" },
        };
        assert.equal(call.call, "tasks.add");
        assert.equal(call.args.description, "测试任务");
        assert.equal(call.args.priority, "HIGH");

        // Decision 应该能携带 miniCodeActs
        const decision: Decision = {
            action: "REPLY",
            confidence: 0.9,
            reason: "测试",
            miniCodeActs: [call],
        };
        assert.equal(decision.miniCodeActs!.length, 1);
        assert.equal(decision.miniCodeActs![0].call, "tasks.add");

        // AttendResult 应该能携带 miniCodeActResults
        const result: AttendResult = {
            chatId: "tg:123",
            decisions: [decision],
            replyMode: "SINGLE",
            reasoning: "test",
            miniCodeActResults: [
                { call: "tasks.add", success: true, summary: "ok" },
            ],
        };
        assert.equal(result.miniCodeActResults!.length, 1);

        // SubagentCallback 应该能携带 corrections
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
                    issue: "判断有误",
                    suggestedFix: { call: "memory.writeCoreFact", args: { content: "修正" } },
                },
            ],
        };
        assert.equal(cb.corrections!.length, 1);

        // AgentNote 类型
        const note: AgentNote = {
            id: "n1",
            content: "测试笔记",
            tags: ["test"],
            createdAt: new Date().toISOString(),
        };
        assert.equal(note.id, "n1");

        // MainAgentGlobalState 应包含 notes
        const state: MainAgentGlobalState = {
            lastActiveAt: new Date().toISOString(),
            taskList: [],
            recentDecisions: [],
            pendingFollowups: [],
            attentionSummary: "",
            notes: [note],
        };
        assert.equal(state.notes.length, 1);
    });

    // ── Test #2: executeMiniCodeActs 空调用列表 ──
    it("#2 executeMiniCodeActs 空调用列表返回空数组", () => {
        const results = executeMiniCodeActs([], "chat1", mockDeps());
        assert.deepEqual(results, []);
    });

    // ── Test #3: executeMiniCodeActs 未知 namespace ──
    it("#3 executeMiniCodeActs 未知 namespace", () => {
        const results = executeMiniCodeActs(
            [{ call: "unknown.method", args: {} }],
            "chat1",
            mockDeps(),
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].success, false);
        assert.ok(results[0].error!.includes("Unknown method"));
        assert.ok(results[0].error!.includes("unknown.method"));
    });

    // ── Test #4: executeMiniCodeActs 未知 method ──
    it("#4 executeMiniCodeActs 未知 method", () => {
        registerHandlers("tasks", {
            add: createHandler(
                () => ({ taskId: "t1" }),
                () => "添加任务",
            ),
        });

        const results = executeMiniCodeActs(
            [{ call: "tasks.nonexistent", args: {} }],
            "chat1",
            mockDeps(),
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].success, false);
        assert.ok(results[0].error!.includes("Unknown method"));
    });

    // ── Test #5: executeMiniCodeActs 限流 MAX=8 ──
    it("#5 executeMiniCodeActs 限流 MAX=8", () => {
        let callCount = 0;
        registerHandlers("test", {
            ping: createHandler(
                () => { callCount++; return "pong"; },
                () => "ping",
            ),
        });

        const calls: MiniCodeActCall[] = Array.from({ length: 10 }, () => ({
            call: "test.ping",
            args: {},
        }));

        const results = executeMiniCodeActs(calls, "chat1", mockDeps());
        assert.equal(results.length, 8, "should only execute 8 calls");
        assert.equal(callCount, 8, "handler should be called 8 times");
    });

    // ── Test #6: executeMiniCodeActs handler 抛异常不中断后续 ──
    it("#6 executeMiniCodeActs handler 抛异常不中断后续", () => {
        let secondCalled = false;

        registerHandlers("test", {
            fail: createHandler(
                () => { throw new Error("boom"); },
                () => "会失败",
            ),
            ok: createHandler(
                () => { secondCalled = true; return "fine"; },
                () => "正常",
            ),
        });

        const results = executeMiniCodeActs(
            [
                { call: "test.fail", args: {} },
                { call: "test.ok", args: {} },
            ],
            "chat1",
            mockDeps(),
        );

        assert.equal(results.length, 2);
        assert.equal(results[0].success, false);
        assert.ok(results[0].error!.includes("boom"));
        assert.equal(results[1].success, true);
        assert.equal(secondCalled, true, "second handler should still be called");
    });

    // ── Test #7: registerHandlers 注册后可调用 ──
    it("#7 registerHandlers 注册后可调用", () => {
        registerHandlers("tasks", {
            add: createHandler(
                (args) => ({ taskId: "task-123", description: args.description }),
                (args) => `已创建任务: "${args.description}"`,
            ),
        });

        const results = executeMiniCodeActs(
            [{ call: "tasks.add", args: { description: "买菜" } }],
            "chat1",
            mockDeps(),
        );

        assert.equal(results.length, 1);
        assert.equal(results[0].success, true);
        assert.deepEqual(results[0].result, { taskId: "task-123", description: "买菜" });
        assert.equal(results[0].summary, '已创建任务: "买菜"');
    });

    // ── Test #8: formatMiniCodeActReport 成功项 ──
    it("#8 formatMiniCodeActReport 成功项", () => {
        const results: MiniCodeActResult[] = [
            {
                call: "memory.writeCoreFact",
                success: true,
                summary: '已写入核心事实: user_456 "对花生严重过敏" [biographical]',
            },
        ];
        const report = formatMiniCodeActReport(results);
        assert.ok(report.includes("✅"));
        assert.ok(report.includes("memory.writeCoreFact"));
        assert.ok(report.includes("已写入核心事实"));
    });

    // ── Test #9: formatMiniCodeActReport 失败项 ──
    it("#9 formatMiniCodeActReport 失败项", () => {
        const results: MiniCodeActResult[] = [
            {
                call: "attention.boost",
                success: false,
                error: "目标群组不存在",
                summary: "执行失败",
            },
        ];
        const report = formatMiniCodeActReport(results);
        assert.ok(report.includes("❌"));
        assert.ok(report.includes("attention.boost"));
        assert.ok(report.includes("目标群组不存在"));
    });

    // ── Test #10: formatMiniCodeActReport 空列表 ──
    it("#10 formatMiniCodeActReport 空列表", () => {
        const report = formatMiniCodeActReport([]);
        assert.equal(report, "(无操作)");
    });

    // ── Bonus: invalid call format (no dot) ──
    it("#bonus executeMiniCodeActs invalid call format (no dot)", () => {
        const results = executeMiniCodeActs(
            [{ call: "nodot", args: {} }],
            "chat1",
            mockDeps(),
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].success, false);
        assert.ok(results[0].error!.includes("Invalid call format"));
    });
});
