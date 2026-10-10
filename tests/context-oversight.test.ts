/**
 * context-oversight.test.ts — 上下文超窗防护回归测试
 *
 * 覆盖三层修复：
 * 1. context-manager 的 overheadTokens：system prompt + 任务 prompt 等窗口外开销计入预算
 * 2. runCodeActSession 的 session 内守卫：运行中每轮检查，超窗只裁 session 内新增消息
 * 3. executor 任务 prompt 的 scope 标记：旧任务 prompt 按 scope 折叠（含旧数据内容回退）
 * 4. executeWithSandbox 的出站消息预检：完整语料（system + 历史 + 任务 prompt）超窗先压缩
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeActExecutor, type SessionMessage } from "../src/subagent/code-act-executor.js";
import { runCodeActSession } from "../src/sandbox/session-runner.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { clearConfigCache, loadConfig, resolveComponentProfiles } from "../src/core/config.js";
import type { ChatMessage } from "../src/core/llm.js";
import type { SandboxPool } from "../src/subagent/sandbox-pool.js";
import type { CodeActReplyTask } from "../src/subagent/types.js";
import { EXECUTOR_FOOTER_TEXT } from "../src/context-engine/providers/executor-providers.js";
import {
    estimateMessagesTokens,
    forceTrim,
    shouldCompact,
    FORCE_TRIM_MARKER,
    type ContextBudget,
} from "../src/memory-v2/context-manager.js";

// ─── 公共 harness ───

function makeSandbox(output = "") {
    return Object.assign(new EventEmitter(), {
        execute: async () => ({ output, executionMs: 0 }),
        executeShell: async () => ({ output, executionMs: 0 }),
        consumeExecutionControl: () => ({ extendSteps: 0, timeoutMs: null }),
        isAlive: () => true,
        resetNotebookScope: async () => {},
    });
}

function makeTask(chatId: string, taskId: string, overrides: Record<string, unknown> = {}): CodeActReplyTask {
    return {
        type: "CODEACT_REPLY",
        chatId,
        taskId,
        decisions: [],
        replyMode: "SINGLE",
        contextSnapshot: {
            chatId,
            depth: 0,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: [],
            engagementScore: 50,
            ...overrides,
        },
        createdAt: new Date().toISOString(),
    } as CodeActReplyTask;
}

function setupExecutorEnv(t: ReturnType<typeof it>, options: {
    maxContextTokens?: number;
    globalState?: object;
    history?: SessionMessage[];
}) {
    const dir = mkdtempSync(join(tmpdir(), "ctx-oversight-"));
    const configLines = [
        "persona:", "  name: Test", "  description: Test.",
        "llm_profiles:", "  test:", "    provider: openai", "    base_url: https://llm.invalid/v1",
        "    api_key: test-only", "    model: test-model", "    max_tokens: 100",
    ];
    if (options.maxContextTokens) configLines.push(`    max_context_tokens: ${options.maxContextTokens}`);
    configLines.push("llm_routing:", "  session: [test]", "  compact: []");
    writeFileSync(join(dir, "config.yaml"), configLines.join("\n"));
    loadConfig(join(dir, "config.yaml"), true);
    const nc = new NotificationCenter();
    t.after(() => { nc.dispose(); clearConfigCache(); rmSync(dir, { recursive: true, force: true }); });

    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    let answerIndex = 0;
    const answers: string[] = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(url, "https://llm.invalid/v1/chat/completions");
        requests.push(JSON.parse(String(init.body)));
        const content = answers[Math.min(answerIndex++, answers.length - 1)];
        return new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
    });

    const executor = new CodeActExecutor("telegram:202");
    const sandbox = makeSandbox();
    const pool = { acquire: async () => sandbox, release: () => {} } as unknown as SandboxPool;
    executor.setDependencies(
        pool, nc,
        { name: "Test", description: "Test." },
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        options.globalState as never,
    );
    if (options.history) {
        executor.session.push(...options.history);
    }
    return { executor, requests, answers, dir };
}

/** 稳定 token 量的英文文本（cl100k 下约 4 字符/token） */
function englishText(words: number): string {
    return "history word ".repeat(words);
}

// ─── 1. context-manager overheadTokens ───

describe("context-manager overheadTokens", () => {
    const budget: ContextBudget = {
        effectiveContextWindow: 1000,
        systemPromptRatio: 0.2,
        briefingRatio: 0.15,
        recentHistoryRatio: 0.5,
        outputReserve: 512,
        minRecentMessages: 2,
        maxBriefingTokens: 300,
    };

    it("shouldCompact 把 overhead 计入预算", () => {
        // BPE 对重复文本压缩不可预测，按实际估算自校准 overhead
        const msgs: ChatMessage[] = Array.from({ length: 10 }, () => ({
            role: "user" as const,
            content: "hello world ".repeat(20),
        }));
        const base = estimateMessagesTokens(msgs);
        const threshold = 1000 * 0.85;
        assert.ok(base < threshold, `前置：消息应低于阈值，实际 ${base}`);
        assert.equal(shouldCompact(msgs, budget), false, "无 overhead 时应在预算内");
        const overhead = Math.ceil(threshold - base + 50);
        assert.equal(shouldCompact(msgs, budget, undefined, overhead), true, "overhead 应把总量推过阈值");
    });

    it("forceTrim 按 overhead 收紧裁剪目标", () => {
        // 2 条消息（各远超 64 tokens 的截断下限）全部落在受保护尾部：
        // 无 overhead 时原样返回；overhead 把限额压到总量之下后走逐条截断。
        const msgs: ChatMessage[] = [
            { role: "user" as const, content: `msg-0 ${"hello world ".repeat(100)}` },
            { role: "assistant" as const, content: `msg-1 ${"hello world ".repeat(100)}` },
        ];
        const total = estimateMessagesTokens(msgs);
        assert.ok(total < 850, `前置：总量应低于限额，实际 ${total}`);
        assert.ok(total > 400, `前置：总量应足够大以体现截断效果，实际 ${total}`);

        const untouched = forceTrim(msgs, budget);
        assert.equal(untouched.dropped, 0, "无 overhead 时不应裁剪");
        assert.equal(untouched.truncated, false);

        // 限额压到总量之下，逐条截断
        const trimmed = forceTrim(msgs, budget, { overheadTokens: Math.ceil(850 - total + 100) });
        assert.ok(trimmed.truncated, "overhead 超限时应触发截断");
        assert.ok(
            estimateMessagesTokens(trimmed.messages) < total,
            `截断后总量应低于原总量，实际 ${estimateMessagesTokens(trimmed.messages)} < ${total}`,
        );
    });
});

// ─── 2. runCodeActSession session 内守卫 ───

describe("runCodeActSession in-session guard", () => {
    it("session 运行中超窗时只裁 session 内新增消息，prefix 保持原样", async t => {
        const dir = mkdtempSync(join(tmpdir(), "ctx-guard-"));
        writeFileSync(join(dir, "config.yaml"), [
            "persona:", "  name: Test", "  description: Test.",
            "llm_profiles:", "  test:", "    provider: openai", "    base_url: https://llm.invalid/v1",
            "    api_key: test-only", "    model: test-model", "    max_tokens: 100",
            "    max_context_tokens: 3000",
            "llm_routing:", "  session: [test]",
        ].join("\n"));
        loadConfig(join(dir, "config.yaml"), true);
        const nc = new NotificationCenter();
        t.after(() => { nc.dispose(); clearConfigCache(); rmSync(dir, { recursive: true, force: true }); });

        const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
        const answers = [
            "```typescript\nstep1();\n```",
            "```typescript\nstep2();\n```",
            "[SESSION_DIGEST]done[/SESSION_DIGEST]\n<end_task>",
        ];
        let answerIndex = 0;
        t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
            requests.push(JSON.parse(String(init.body)));
            return new Response(JSON.stringify({
                choices: [{ message: { role: "assistant", content: answers[answerIndex++] }, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
            }));
        });

        // 每轮 observation 约 5000 tokens（20000 字符 ASCII），2 轮必然超过 3000×0.85
        const bigOutput = "Z".repeat(20000);
        const sandbox = Object.assign(makeSandbox(), {
            execute: async () => ({ output: bigOutput, executionMs: 0 }),
        });

        const initialMessages: ChatMessage[] = [
            { role: "system", content: "SYS-PROMPT" },
            { role: "user", content: "TASK-PROMPT" },
        ];

        const result = await runCodeActSession(
            initialMessages,
            sandbox as never,
            nc,
            resolveComponentProfiles("session"),
            5000,
            undefined, undefined, undefined, undefined,
            ["[Execution Output]"],
            undefined,
            3,
        );

        assert.equal(result.endReason, "end_turn", "session 应正常结束，而不是被超窗拖死");
        assert.equal(requests.length, 3);

        // 最后一次请求必须回到预算内
        const lastRequest: ChatMessage[] = requests[2].messages.map((m: { role: "system" | "user" | "assistant"; content: string }) => ({
            role: m.role, content: m.content,
        }));
        const lastTokens = estimateMessagesTokens(lastRequest);
        assert.ok(lastTokens <= 3000, `最后一次请求应回到窗口内，实际约 ${lastTokens} tokens`);

        // prefix（system + 任务 prompt）不被裁剪，保证调用方的切分约定
        assert.equal(requests[2].messages[0].content, "SYS-PROMPT");
        assert.equal(requests[2].messages[1]?.content, "TASK-PROMPT");

        // 裁剪留下了可解释的占位说明
        assert.ok(
            result.messages.some(m => typeof m.content === "string" && m.content.includes(FORCE_TRIM_MARKER)),
            "session 内裁剪应插入强制裁剪占位说明",
        );
        assert.ok(
            !result.messages.some(m => typeof m.content === "string" && m.content === bigOutput),
            "超长的 observation 不应原样保留",
        );
    });
});

// ─── 3. executor 任务 prompt 的 scope 折叠 ───

describe("executor task prompt collapse", () => {
    it("digests 排在 header 之前时，旧任务 prompt 仍按 scope 折叠 ephemeral 部分", async t => {
        const digest = [{ sourceChatId: "telegram:202", createdAt: "2026-05-01T10:00:00.000Z", content: "digest-old" }];
        const globalState = {
            getSessionDigests: () => digest,
            updateDispatchedSubagentTask: () => {},
        };
        const { executor, requests, answers } = setupExecutorEnv(t, { globalState });
        answers.push(
            "[SESSION_DIGEST]first done[/SESSION_DIGEST]\n<end_task>",
            "[SESSION_DIGEST]second done[/SESSION_DIGEST]\n<end_task>",
        );

        // task-1 渲染时 digests section 排最前，任务 prompt 以 "# 历史 Session Digests" 开头
        await executor.execute(makeTask(executor.chatId, "task-1", { topicSummary: "TOPIC-EPHEMERAL-1" }));
        assert.ok(requests[0].messages.some(m => m.content.includes("TOPIC-EPHEMERAL-1")), "前置：首个请求应包含本任务的 ephemeral 内容");

        // 新数据在持久化时带上 scope 标记
        assert.ok(
            executor.session.some(m => m.role === "user" && m.scope === "executor-task"),
            "任务 prompt 持久化时应携带 executor-task scope",
        );

        // task-2 的请求中，task-1 的 prompt 必须已折叠（ephemeral 部分不重发）
        await executor.execute(makeTask(executor.chatId, "task-2", { topicSummary: "TOPIC-EPHEMERAL-2" }));
        assert.ok(requests[1].messages.some(m => m.content.includes("TOPIC-EPHEMERAL-2")), "当前任务的 ephemeral 内容应在场");
        assert.ok(
            !requests[1].messages.some(m => m.content.includes("TOPIC-EPHEMERAL-1")),
            "旧任务 prompt 的 ephemeral 部分不应再进入请求（scope 折叠）",
        );
        assert.ok(
            requests[1].messages.some(m => m.content.includes("digest-old")),
            "折叠只裁 footer 之后的内容，digests 等 historical 部分保留",
        );
    });

    it("旧持久化数据（无 scope，digests-first）通过内容回退识别并折叠", async t => {
        const legacyPrompt = [
            "# 历史 Session Digests",
            "- digest-legacy",
            "",
            "═══ legacy-task ═══",
            "聊天对象: test(telegram:202) [group]",
            "",
            EXECUTOR_FOOTER_TEXT,
            "",
            "## 话题摘要",
            "LEGACY-EPHEMERAL",
        ].join("\n");
        const history: SessionMessage[] = [
            { role: "user", content: legacyPrompt, timestamp: "2026-05-01T00:00:00.000Z" },
            { role: "assistant", content: "legacy reply", timestamp: "2026-05-01T00:00:01.000Z" },
        ];
        const { executor, requests, answers } = setupExecutorEnv(t, { history });
        answers.push("[SESSION_DIGEST]done[/SESSION_DIGEST]\n<end_task>");

        await executor.execute(makeTask(executor.chatId, "new-task", { topicSummary: "TOPIC-NEW" }));

        assert.ok(
            !requests[0].messages.some(m => m.content.includes("LEGACY-EPHEMERAL")),
            "旧格式任务 prompt（digests-first、无 scope）的 ephemeral 部分应被内容回退折叠",
        );
        assert.ok(
            requests[0].messages.some(m => m.content.includes("digest-legacy")),
            "旧格式任务 prompt 的 historical 部分应保留",
        );
    });
});

// ─── 4. executeWithSandbox 出站消息预检 ───

describe("executeWithSandbox outbound preflight", () => {
    it("历史在预算内但完整出站消息超窗时，先压缩历史再发第一个请求", async t => {
        // 窗口 20000，阈值 17000。历史 12 条 ≈ 14400 tokens（单独不触发 compact），
        // system prompt（EXECUTION 模板 + apiTypeDefs）与任务 prompt（targetMessages）
        // 合计约 1 万 tokens —— 完整出站消息必然超过阈值，必须在首个请求前压缩历史。
        const history: SessionMessage[] = Array.from({ length: 12 }, (_, index) => ({
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            content: `hist-${index} ${englishText(400)}`,
            timestamp: "2026-05-01T00:00:00.000Z",
        }));
        const recentMessages = [{
            messageId: "m-1",
            userId: "u-1",
            displayName: "Alice",
            text: englishText(400),
            timestamp: "2026-05-01T00:00:02.000Z",
        }];
        const { executor, requests, answers } = setupExecutorEnv(t, {
            maxContextTokens: 20000,
            history,
        });
        answers.push("[SESSION_DIGEST]done[/SESSION_DIGEST]\n<end_task>");

        const callback = await executor.execute(makeTask(executor.chatId, "task-1", { recentMessages }));
        assert.notEqual(callback.status, "ERROR", callback.error);

        // 任务 prompt 里的 targetMessages 本来就应保留；
        // 判定对象是历史消息：hist-N 标记应被压缩掉一部分（其余进入受保护尾部）
        const histHits = requests[0].messages.flatMap((m: { content: string }) => m.content.match(/hist-\d+/g) ?? []);
        assert.ok(histHits.length < 12, `历史应被预检压缩（${histHits.length}/12 保留）`);
        assert.ok(histHits.length > 0, "受保护的尾部历史应保留");
        assert.ok(
            requests[0].messages.some(m => m.content.includes(FORCE_TRIM_MARKER)),
            "预检压缩应留下强制裁剪占位说明",
        );
        const firstTokens = estimateMessagesTokens(requests[0].messages.map((m: { role: "system" | "user" | "assistant"; content: string }) => ({
            role: m.role, content: m.content,
        })));
        assert.ok(firstTokens <= 20000, `首个请求应回到窗口内，实际约 ${firstTokens} tokens`);
    });
});
