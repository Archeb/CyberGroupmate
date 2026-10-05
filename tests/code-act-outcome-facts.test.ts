import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { clearConfigCache, loadConfig } from "../src/core/config.js";
import { ContextEngine } from "../src/context-engine/context-engine.js";
import { metaCallbacksProvider } from "../src/context-engine/providers/meta-providers.js";
import type { SandboxPool } from "../src/subagent/sandbox-pool.js";
import type { CodeActReplyTask } from "../src/subagent/types.js";

const done = "[SESSION_DIGEST]No action required.[/SESSION_DIGEST]\n<end_task>";

function setup(t: TestContext, answers: string[], maxTurns = 15) {
    const dir = mkdtempSync(join(tmpdir(), "codeact-outcome-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, [
        "persona:", "  name: Test", "  description: Test.",
        "llm_profiles:", "  test:", "    provider: openai", "    base_url: https://llm.invalid/v1",
        "    api_key: test-only", "    model: test-model", "    max_tokens: 100",
        "llm_routing:", "  session: [test]", "  compact: []",
    ].join("\n"));
    loadConfig(path, true);
    const nc = new NotificationCenter();
    t.after(() => { nc.dispose(); clearConfigCache(); rmSync(dir, { recursive: true, force: true }); });
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(url, "https://llm.invalid/v1/chat/completions");
        requests.push(JSON.parse(String(init.body)));
        const content = answers[requests.length - 1];
        assert.notEqual(content, undefined, "runner made an unexpected extra model request");
        return new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content, reasoning_content: /<tool_(?:call|result)\b/i.test(content) ? "RAW_FAILED_REASONING" : undefined }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
    });
    const executed: string[] = [];
    const sandbox = Object.assign(new EventEmitter(), {
        execute: async (code: string) => {
            if (!code.startsWith("__set")) executed.push(code);
            if (code.includes("onebot.sendText(")) {
                sandbox.emit("notify", { type: "system.agent_message_sent", chatId: "onebot:group:123", messageId: "receipt-1", text: "test message", timestamp: new Date().toISOString() });
            }
            return { output: "ok", error: false };
        },
        consumeExecutionControl: () => ({}), isAlive: () => true, resetNotebookScope: async () => {},
    });
    const executor = new CodeActExecutor("onebot:group:123", { maxTurns });
    executor.setDependencies({ acquire: async () => sandbox, release() {} } as unknown as SandboxPool, nc);
    const sessionPath = join(dir, "session.json");
    executor.setSessionFilePath(sessionPath);
    const task = {
        type: "CODEACT_REPLY", chatId: executor.chatId, taskId: "outcome-test", decisions: [], replyMode: "SINGLE",
        contextSnapshot: { chatId: executor.chatId, depth: 0, snapshotTimestamp: new Date().toISOString(), topicDigests: [], engagementScore: 50 },
        createdAt: new Date().toISOString(),
    } as CodeActReplyTask;
    return { executor, task, requests, executed, sessionPath };
}

it("reports exhausted turns as failure without losing an already confirmed send", async t => {
    const { executor, task } = setup(t, ['```javascript\nawait onebot.sendText("onebot:group:123", "test message");\n```'], 1);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "ERROR");
    assert.equal(callback.endReason, "max_turns");
    assert.equal(callback.turns, 1);
    assert.equal(callback.executedCodeBlocks, 1);
    assert.match(callback.error ?? "", /turn limit/);
    assert.equal(callback.sentMessages?.[0].messageId, "receipt-1");
    const engine = new ContextEngine("outcome-callback");
    engine.register(metaCallbacksProvider);
    const prompt = engine.render({ callbacks: [callback] }).ephemeralContent;
    assert.match(prompt, /status=ERROR/);
    assert.match(prompt, /executedCodeBlocks=1/);
    assert.match(prompt, /messageId=receipt-1/);
});

it("reports zero execution and zero sends without failing an intentional no-action finish", async t => {
    const { executor, task } = setup(t, [done]);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "COMPLETED");
    assert.equal(callback.endReason, "end_turn");
    assert.equal(callback.executedCodeBlocks, 0);
    assert.deepEqual(callback.sentMessages, []);
    const engine = new ContextEngine("no-action-callback");
    engine.register(metaCallbacksProvider);
    assert.match(engine.render({ callbacks: [callback] }).ephemeralContent, /sentMessageCount=0/);
});
