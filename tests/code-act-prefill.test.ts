import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { clearConfigCache, loadConfig } from "../src/core/config.js";
import type { SandboxPool } from "../src/subagent/sandbox-pool.js";
import type { CodeActReplyTask } from "../src/subagent/types.js";

it("executes consecutive tasks without injecting a persona prefill into requests or saved history", async t => {
    const dir = mkdtempSync(join(tmpdir(), "codeact-prefill-"));
    const configPath = join(dir, "config.yaml");
    writeFileSync(configPath, [
        "persona:", "  name: Orbit", "  description: Respond naturally.",
        "llm_profiles:", "  test:", "    provider: openai", "    base_url: https://llm.invalid/v1",
        "    api_key: test-only", "    model: test-model", "    max_tokens: 100",
        "llm_routing:", "  session: [test]",
    ].join("\n"));
    loadConfig(configPath, true);
    const nc = new NotificationCenter();
    t.after(() => { nc.dispose(); clearConfigCache(); rmSync(dir, { recursive: true, force: true }); });
    const requests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const answers = ["First task", "Second task"].map(text => `[SESSION_DIGEST]\n${text}: no tool call needed.\n[/SESSION_DIGEST]\n<end_task>`);
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        assert.equal(url, "https://llm.invalid/v1/chat/completions");
        requests.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({
            choices: [{ message: { role: "assistant", content: answers[requests.length - 1] }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
    });
    const sandbox = Object.assign(new EventEmitter(), {
        execute: async () => ({ success: true, output: "", executionMs: 0 }),
        consumeExecutionControl: () => null,
        isAlive: () => true,
        resetNotebookScope: async () => {},
    });
    let releases = 0;
    const pool = { acquire: async () => sandbox, release: () => { releases++; } } as unknown as SandboxPool;
    const executor = new CodeActExecutor("telegram:101");
    executor.setDependencies(pool, nc, { name: "Orbit", description: "Respond naturally." });
    executor.setSessionFilePath(join(dir, "session.json"));
    for (let index = 0; index < 2; index++) {
        const task = {
            type: "CODEACT_REPLY", chatId: executor.chatId, taskId: `task-${index}`, decisions: [], replyMode: "SINGLE",
            contextSnapshot: { chatId: executor.chatId, depth: 0, snapshotTimestamp: new Date().toISOString(), topicDigests: [], engagementScore: 50 },
            createdAt: new Date().toISOString(),
        } as CodeActReplyTask;
        const callback = await executor.execute(task);
        assert.notEqual(callback.status, "ERROR", callback.error);
    }
    assert.equal(requests.length, 2);
    assert.equal(releases, 2);
    for (const request of requests) {
        assert.equal(request.messages.at(-1)?.role, "user", "the request must end with the task, not synthetic assistant text");
        assert.ok(request.messages[0].content.includes("Orbit"), "persona still belongs in the system prompt");
        // System-prompt examples may use this wording; they are not a synthetic assistant turn.
        assert.ok(!request.messages.some(m => m.role === "assistant" && m.content.includes("让Orbit想想，")));
    }
    assert.ok(requests[1].messages.some(m => m.role === "assistant" && m.content === answers[0]), "real model history is retained");
    assert.deepEqual(executor.session.filter(m => m.role === "assistant").map(m => m.content), answers);
    const restored = new CodeActExecutor(executor.chatId);
    assert.equal(restored.loadSession(join(dir, "session.json")), true);
    assert.deepEqual(restored.session.filter(m => m.role === "assistant").map(m => m.content), answers);
});
