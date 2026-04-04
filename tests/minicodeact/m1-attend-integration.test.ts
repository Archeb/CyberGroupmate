/**
 * m1-attend-integration.test.ts — M1 attend-handler 集成 + Prompt 模板 单元测试
 *
 * 验证 JSON 解析提取 miniCodeActs、Phase 5.5 执行分支、
 * 对话历史追加顺序、模板渲染和 system prompt 内容。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { MiniCodeActCall, Decision, AttendResult } from "../../src/subagent/types.js";
import {
    registerHandlers,
    clearHandlers,
    executeMiniCodeActs,
    type MiniCodeActHandler,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";
import { formatMiniCodeActReport } from "../../src/main-agent/minicodeact-formatter.js";
import {
    renderPrompt,
    renderTemplate,
    setPromptDirectory,
    clearTemplateCache,
} from "../../src/main-agent/prompt-renderer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

// ─── Helpers ───

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
        globalState: {} as any,
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

describe("M1: attend-handler 集成 + Prompt 模板", () => {
    beforeEach(() => {
        clearHandlers();
        clearTemplateCache();
        setPromptDirectory(join(projectRoot, "system-prompts"));
    });

    // ── Test #1: JSON 解析提取 miniCodeActs ──
    it("#1 JSON 解析提取 miniCodeActs", () => {
        const parsed = {
            replyMode: "SINGLE",
            decisions: [
                {
                    action: "REPLY",
                    contentDirection: "回复",
                    confidence: 0.9,
                    reason: "test",
                    miniCodeActs: [
                        { call: "tasks.add", args: { description: "测试" } },
                        { call: "memory.writeCoreFact", args: { subject: "u1", content: "fact" } },
                    ],
                },
            ],
        };

        const decisions = parseDecisions(parsed);
        assert.equal(decisions.length, 1);
        assert.ok(decisions[0].miniCodeActs);
        assert.equal(decisions[0].miniCodeActs!.length, 2);
        assert.equal(decisions[0].miniCodeActs![0].call, "tasks.add");
        assert.equal(decisions[0].miniCodeActs![1].call, "memory.writeCoreFact");
    });

    // ── Test #2: JSON 解析无 miniCodeActs 时为 undefined ──
    it("#2 JSON 解析无 miniCodeActs 时为 undefined", () => {
        const parsed = {
            replyMode: "NONE",
            decisions: [
                {
                    action: "OBSERVE",
                    confidence: 0.5,
                    reason: "无需回复",
                },
            ],
        };

        const decisions = parseDecisions(parsed);
        assert.equal(decisions.length, 1);
        assert.equal(decisions[0].miniCodeActs, undefined);
    });

    // ── Test #3: Phase 5.5 无 miniCodeActs 时跳过 ──
    it("#3 Phase 5.5 无 miniCodeActs 时跳过", () => {
        const decisions: Decision[] = [
            { action: "OBSERVE", confidence: 0.5, reason: "无需回复" },
        ];

        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const decision of decisions) {
            if (decision.miniCodeActs?.length) {
                allMiniCodeActs.push(...decision.miniCodeActs);
            }
        }

        assert.equal(allMiniCodeActs.length, 0, "should collect 0 miniCodeActs");
    });

    // ── Test #4: Phase 5.5 有 miniCodeActs 时执行 ──
    it("#4 Phase 5.5 有 miniCodeActs 时执行", () => {
        let executed = false;
        registerHandlers("test", {
            ping: createHandler(
                () => { executed = true; return "pong"; },
                () => "ping 执行",
            ),
        });

        const decisions: Decision[] = [
            {
                action: "REPLY",
                confidence: 0.9,
                reason: "test",
                miniCodeActs: [{ call: "test.ping", args: {} }],
            },
        ];

        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const decision of decisions) {
            if (decision.miniCodeActs?.length) {
                allMiniCodeActs.push(...decision.miniCodeActs);
            }
        }

        assert.equal(allMiniCodeActs.length, 1);
        const results = executeMiniCodeActs(allMiniCodeActs, "chat1", mockDeps());
        assert.equal(results.length, 1);
        assert.equal(results[0].success, true);
        assert.equal(executed, true);
    });

    // ── Test #5: 对话历史追加顺序正确 ──
    it("#5 对话历史追加顺序正确", () => {
        registerHandlers("test", {
            ping: createHandler(
                () => "pong",
                () => "ping 执行",
            ),
        });

        // Simulate the append sequence
        const history: Array<{ role: string; content: string }> = [];
        const appendToHistory = (msg: { role: string; content: string }) => {
            history.push(msg);
        };

        const currentTurnPrompt = "[ATTENTION] chat1 context...";
        const jsonContent = '{"replyMode":"SINGLE","decisions":[{"action":"REPLY","miniCodeActs":[{"call":"test.ping","args":{}}]}]}';

        // Step 1: user prompt
        appendToHistory({ role: "user", content: currentTurnPrompt });
        // Step 2: assistant decision
        appendToHistory({ role: "assistant", content: jsonContent });

        // Step 3: MiniCodeAct report (if any)
        const decisions = parseDecisions(JSON.parse(jsonContent));
        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const decision of decisions) {
            if (decision.miniCodeActs?.length) {
                allMiniCodeActs.push(...decision.miniCodeActs);
            }
        }

        if (allMiniCodeActs.length > 0) {
            const results = executeMiniCodeActs(allMiniCodeActs, "chat1", mockDeps());
            const report = formatMiniCodeActReport(results);
            const reportPrompt = renderPrompt("MINI_CODE_ACT_REPORT", {
                chatId: "chat1",
                results: report,
                timestamp: "2026-04-04T00:00:00Z",
            });
            appendToHistory({ role: "user", content: reportPrompt });
        }

        // Verify order
        assert.equal(history.length, 3, "should have 3 entries");
        assert.equal(history[0].role, "user", "1st: user prompt");
        assert.ok(history[0].content.includes("ATTENTION"), "1st content is attention prompt");
        assert.equal(history[1].role, "assistant", "2nd: assistant decision");
        assert.ok(history[1].content.includes("replyMode"), "2nd content is JSON decision");
        assert.equal(history[2].role, "user", "3rd: user report");
        assert.ok(history[2].content.includes("MiniCodeAct"), "3rd content is MiniCodeAct report");
    });

    // ── Test #6: miniCodeActResults 附加到 AttendResult ──
    it("#6 miniCodeActResults 附加到 AttendResult", () => {
        registerHandlers("test", {
            ping: createHandler(
                () => "pong",
                () => "ping 执行",
            ),
        });

        const llmResult: AttendResult = {
            chatId: "chat1",
            replyMode: "SINGLE",
            decisions: [
                {
                    action: "REPLY",
                    confidence: 0.9,
                    reason: "test",
                    miniCodeActs: [{ call: "test.ping", args: {} }],
                },
            ],
            reasoning: "test reasoning",
        };

        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const decision of llmResult.decisions) {
            if (decision.miniCodeActs?.length) {
                allMiniCodeActs.push(...decision.miniCodeActs);
            }
        }

        if (allMiniCodeActs.length > 0) {
            const results = executeMiniCodeActs(allMiniCodeActs, "chat1", mockDeps());
            llmResult.miniCodeActResults = results;
        }

        assert.ok(llmResult.miniCodeActResults);
        assert.equal(llmResult.miniCodeActResults!.length, 1);
        assert.equal(llmResult.miniCodeActResults![0].success, true);
    });

    // ── Test #7: MINI_CODE_ACT_REPORT 模板渲染 ──
    it("#7 MINI_CODE_ACT_REPORT 模板渲染", () => {
        const report = renderPrompt("MINI_CODE_ACT_REPORT", {
            chatId: "tg:group_123",
            results: "✅ tasks.add → 已创建任务",
            timestamp: "2026-04-04T12:00:00Z",
        });

        assert.ok(report.includes("tg:group_123"), "should contain chatId");
        assert.ok(report.includes("2026-04-04T12:00:00Z"), "should contain timestamp");
        assert.ok(report.includes("✅ tasks.add"), "should contain results");
        assert.ok(report.includes("MiniCodeAct"), "should contain report header");
    });

    // ── Test #8: System Prompt 包含 MiniCodeAct API 概览 ──
    it("#8 System Prompt 包含 MiniCodeAct API 概览", () => {
        const systemPromptPath = join(projectRoot, "system-prompts", "main-agent", "mainagent-main-system.md");
        const content = readFileSync(systemPromptPath, "utf-8");

        assert.ok(content.includes("即时操作"), "should contain '即时操作' section");
        assert.ok(content.includes("MiniCodeAct"), "should mention MiniCodeAct");
        assert.ok(content.includes("tasks.add"), "should list tasks.add");
        assert.ok(content.includes("memory.writeCoreFact"), "should list memory.writeCoreFact");
        assert.ok(content.includes("attention.boost"), "should list attention.boost");
        assert.ok(content.includes("notes.add"), "should list notes.add");
        assert.ok(content.includes("miniCodeActs"), "JSON example should show miniCodeActs field");
    });

    // ── Test #9: 完整 attend 流程 (含 miniCodeActs) ──
    it("#9 完整 attend 流程: LLM 输出含 miniCodeActs", () => {
        let handlerCalled = false;
        registerHandlers("tasks", {
            add: createHandler(
                (args) => { handlerCalled = true; return { taskId: "t-123" }; },
                (args) => `已创建任务: "${args.description}"`,
            ),
        });

        // Simulate full attend flow
        const llmJson = {
            replyMode: "SINGLE",
            decisions: [
                {
                    action: "REPLY",
                    contentDirection: "回复",
                    confidence: 0.9,
                    reason: "test",
                    miniCodeActs: [
                        { call: "tasks.add", args: { description: "买菜", priority: "HIGH" } },
                    ],
                },
            ],
            reasoning: "需要回复并创建任务",
        };

        // Parse
        const decisions = parseDecisions(llmJson);
        const llmResult: AttendResult = {
            chatId: "tg:group_1",
            replyMode: llmJson.replyMode as any,
            decisions,
            reasoning: llmJson.reasoning,
        };

        // Phase 5.5
        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const d of llmResult.decisions) {
            if (d.miniCodeActs?.length) allMiniCodeActs.push(...d.miniCodeActs);
        }

        const history: any[] = [];
        history.push({ role: "user", content: "attention prompt" });
        history.push({ role: "assistant", content: JSON.stringify(llmJson) });

        if (allMiniCodeActs.length > 0) {
            const results = executeMiniCodeActs(allMiniCodeActs, "tg:group_1", mockDeps());
            const reportPrompt = renderPrompt("MINI_CODE_ACT_REPORT", {
                chatId: "tg:group_1",
                results: formatMiniCodeActReport(results),
                timestamp: new Date().toISOString(),
            });
            history.push({ role: "user", content: reportPrompt });
            llmResult.miniCodeActResults = results;
        }

        assert.equal(handlerCalled, true, "handler should be called");
        assert.equal(history.length, 3, "history should have 3 entries");
        assert.ok(llmResult.miniCodeActResults);
        assert.equal(llmResult.miniCodeActResults![0].success, true);
        assert.ok(llmResult.miniCodeActResults![0].summary.includes("买菜"));
    });

    // ── Test #10: 完整 attend 流程 (无 miniCodeActs, 无回归) ──
    it("#10 完整 attend 流程: LLM 输出不含 miniCodeActs (无回归)", () => {
        const llmJson = {
            replyMode: "NONE",
            decisions: [
                {
                    action: "OBSERVE",
                    confidence: 0.5,
                    reason: "不需要介入",
                },
            ],
            reasoning: "话题不相关",
        };

        const decisions = parseDecisions(llmJson);
        const llmResult: AttendResult = {
            chatId: "tg:group_2",
            replyMode: llmJson.replyMode as any,
            decisions,
            reasoning: llmJson.reasoning,
        };

        // Phase 5.5 should be skipped
        const allMiniCodeActs: MiniCodeActCall[] = [];
        for (const d of llmResult.decisions) {
            if (d.miniCodeActs?.length) allMiniCodeActs.push(...d.miniCodeActs);
        }

        const history: any[] = [];
        history.push({ role: "user", content: "attention prompt" });
        history.push({ role: "assistant", content: JSON.stringify(llmJson) });

        if (allMiniCodeActs.length > 0) {
            // This block should NOT execute
            assert.fail("should not execute MiniCodeAct for OBSERVE-only decisions");
        }

        assert.equal(history.length, 2, "history should have 2 entries (no report)");
        assert.equal(llmResult.miniCodeActResults, undefined, "no miniCodeActResults");
        assert.equal(llmResult.decisions[0].action, "OBSERVE");
    });
});
