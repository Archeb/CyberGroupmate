import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { clearConfigCache, loadConfig, resolveComponentProfiles } from "../src/core/config.js";
import { shouldCompact } from "../src/memory-v2/context-manager.js";
import type { SandboxPool } from "../src/subagent/sandbox-pool.js";
import type { CodeActReplyTask } from "../src/subagent/types.js";

function setup(t: TestContext, history: CodeActExecutor["session"], maxSessionMessages = 6, maxContextTokens = 32768) {
    const dir = mkdtempSync(join(tmpdir(), "codeact-preflight-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, [
        "persona:", "  name: Test", "  description: Test.",
        "llm_profiles:", "  test:", "    provider: openai", "    base_url: https://llm.invalid/v1",
        "    api_key: test-only", "    model: test-model", "    max_tokens: 100", `    max_context_tokens: ${maxContextTokens}`,
        "llm_routing:", "  session: [test]", "  compact: []",
    ].join("\n"));
    loadConfig(configPath, true);
    const nc = new NotificationCenter();
    t.after(() => { nc.dispose(); clearConfigCache(); rmSync(dir, { recursive: true, force: true }); });
    const sessionFile = join(dir, "session.json");
    const original = JSON.stringify({ chatId: "telegram:102", session: history, executionCount: 3 });
    writeFileSync(sessionFile, original);
    const executor = new CodeActExecutor("telegram:102", { maxSessionMessages });
    assert.equal(executor.loadSession(sessionFile), true);
    const snapshots: Array<{ history: CodeActExecutor["session"]; saved: string; request: any }> = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(url, "https://llm.invalid/v1/chat/completions");
        snapshots.push({ history: structuredClone(executor.session), saved: readFileSync(sessionFile, "utf8"), request: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content: "[SESSION_DIGEST]No action needed.[/SESSION_DIGEST]\n<end_task>" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
    });
    const sandbox = Object.assign(new EventEmitter(), {
        execute: async () => ({ success: true, output: "", executionMs: 0 }),
        consumeExecutionControl: () => null, isAlive: () => true, resetNotebookScope: async () => {},
    });
    executor.setDependencies({ acquire: async () => sandbox, release() {} } as unknown as SandboxPool, nc);
    const task = {
        type: "CODEACT_REPLY", chatId: executor.chatId, taskId: "next-task", decisions: [], replyMode: "SINGLE",
        contextSnapshot: { chatId: executor.chatId, depth: 0, snapshotTimestamp: new Date().toISOString(), topicDigests: [], engagementScore: 50 },
        createdAt: new Date().toISOString(),
    } as CodeActReplyTask;
    return { executor, task, snapshots, original };
}
const history = (count: number): CodeActExecutor["session"] => Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}`, timestamp: "2026-01-01T00:00:00.000Z",
}));

it("compacts and saves restored history before the first executor model request", async t => {
    const { executor, task, snapshots } = setup(t, history(20));
    const callback = await executor.execute(task);
    assert.notEqual(callback.status, "ERROR", callback.error);
    assert.equal(snapshots.length, 1);
    const first = snapshots[0];
    assert.ok(first.history.length <= 6, "restored over-limit history must not reach the first request");
    assert.match(first.history[0].content, /SESSION_HISTORY_COMPACT/);
    assert.equal(first.history.at(-1)?.content, "message 19");
    assert.deepEqual(JSON.parse(first.saved).session, first.history, "preflight must persist recovery before the call");
    assert.ok(first.request.messages.some((m: any) => m.content.includes("message 19")));
    assert.ok(!first.request.messages.some((m: any) => m.content === "message 0"));
});

it("leaves in-budget restored history and its persisted file unchanged before execution", async t => {
    const originalHistory = history(4);
    const { executor, task, snapshots, original } = setup(t, originalHistory);
    const callback = await executor.execute(task);
    assert.notEqual(callback.status, "ERROR", callback.error);
    assert.deepEqual(snapshots[0].history, originalHistory);
    assert.equal(snapshots[0].saved, original);
});

it("uses the configured token budget for a few huge restored messages, including reasoning", async t => {
    const large = history(2);
    large[0].content = "old context ".repeat(25000);
    large[1].content = "recent context ".repeat(25000);
    large[1].reasoning = { provider: "openai_chat", content: "old reasoning ".repeat(25000), originKey: "test", tokenCount: 80000 };
    const { executor, task, snapshots } = setup(t, large);
    assert.ok(shouldCompact(executor.session, undefined, resolveComponentProfiles("session")[0]));
    const callback = await executor.execute(task);
    assert.notEqual(callback.status, "ERROR", callback.error);
    assert.equal(snapshots.length, 1);
    assert.equal(shouldCompact(snapshots[0].history, undefined, resolveComponentProfiles("session")[0]), false);
    assert.deepEqual(JSON.parse(snapshots[0].saved).session, snapshots[0].history);
});

it("falls back to existing local trimming when compaction throws before execution", async t => {
    const { executor, task, snapshots } = setup(t, history(20));
    t.mock.method(executor as any, "compactSession", async () => { throw new Error("summary unavailable"); });
    const callback = await executor.execute(task);
    assert.notEqual(callback.status, "ERROR", callback.error);
    assert.ok(snapshots[0].history.length <= 6);
    assert.equal(snapshots[0].history.at(-1)?.content, "message 19");
    assert.deepEqual(JSON.parse(snapshots[0].saved).session, snapshots[0].history);
});

it("returns a controlled error instead of submitting history that remains untrimmable", async t => {
    const protectedHistory = [{ role: "system" as const, content: "protected ".repeat(50000), timestamp: "2026-01-01T00:00:00.000Z" }];
    const { executor, task, snapshots } = setup(t, protectedHistory);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "ERROR");
    assert.match(callback.error ?? "", /session.*budget/i);
    assert.equal(snapshots.length, 0, "must not send the over-budget executor request");
});
