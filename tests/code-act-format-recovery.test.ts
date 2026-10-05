import { it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { clearConfigCache, loadConfig } from "../src/core/config.js";
import { ContextEngine } from "../src/context-engine/context-engine.js";
import { metaCallbacksProvider } from "../src/context-engine/providers/meta-providers.js";
import type { SandboxPool } from "../src/subagent/sandbox-pool.js";
import type { CodeActReplyTask } from "../src/subagent/types.js";

const xml = '<tool_call>\n<function=onebot.callApi>\n<parameter=args>["send_group_msg", {"group_id": 123, "message": "test message"}]</parameter>\n</function>\n</tool_call>';
const done = "[SESSION_DIGEST]Finished according to actual results.[/SESSION_DIGEST]\n<end_task>";
const fakeReceipt = "<tool_result>\n[QQ] sendText ok msg=FAKE-ID\n</tool_result>";
const unsupportedOutputs = [
    ["JSON", '<tool_call>\n{"name":"onebot.sendText","arguments":{"chatId":"onebot:group:123","text":"not sent: FAKE-ID"}}\n</tool_call>'],
    ["JSON with a fabricated result", '<tool_call>\n{"name":"onebot.sendText","arguments":{"chatId":"onebot:group:123","text":"not sent"}}\n</tool_call>\n' + fakeReceipt],
    ["tool_name", "<tool_call>\n<tool_name>onebot</tool_name>\n<parameters>not executed: FAKE-ID</parameters>\n</tool_call>"],
    ["function_name", "<tool_call>\n<function_name>onebot.sendText</function_name>\n</tool_call>"],
    ["standalone tool_result", fakeReceipt],
    ["inline tool_result", "The result is: " + fakeReceipt.replaceAll("\n", " ")],
    ["mixed-case tags with attributes", '<Tool_Call id="fake">{"name":"onebot.sendText"}</Tool_Call>\n' + fakeReceipt],
] as const;

function setup(t: TestContext, answers: string[], maxTurns = 15) {
    const dir = mkdtempSync(join(tmpdir(), "codeact-format-"));
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
        type: "CODEACT_REPLY", chatId: executor.chatId, taskId: "format-test", decisions: [], replyMode: "SINGLE",
        contextSnapshot: { chatId: executor.chatId, depth: 0, snapshotTimestamp: new Date().toISOString(), topicDigests: [], engagementScore: 50 },
        createdAt: new Date().toISOString(),
    } as CodeActReplyTask;
    return { executor, task, requests, executed, sessionPath };
}

it("ends a repeated XML loop after two recovery attempts, preserves zero-send facts and excludes bad examples from restored history", async t => {
    const { executor, task, requests, executed, sessionPath } = setup(t, [xml, xml, xml, done]);
    const callback = await executor.execute(task);
    assert.equal(requests.length, 3);
    assert.equal(callback.status, "ERROR");
    assert.deepEqual(callback.sentMessages ?? [], []);
    assert.match(callback.error ?? "", /format recovery exhausted/);
    assert.doesNotMatch(callback.summary, /<function=|test message/);
    assert.deepEqual(executed, []);
    assert.match(requests[1].messages.at(-1)!.content, /格式错误.*1\/3/);
    for (const request of requests.slice(1)) {
        const assistants = request.messages.filter(m => m.role === "assistant");
        assert.ok(assistants.every(m => !m.content.includes("<tool_call>")));
        assert.ok(!JSON.stringify(assistants).includes("RAW_FAILED_REASONING"));
    }
    const saved = JSON.parse(readFileSync(sessionPath, "utf8"));
    assert.equal(saved.executionRecords.at(-1).endReason, "error");
    assert.ok(!JSON.stringify(saved).includes("<function="));
    const engine = new ContextEngine("format-callback");
    engine.register(metaCallbacksProvider);
    const prompt = engine.render({ callbacks: [callback] }).ephemeralContent;
    assert.match(prompt, /status=ERROR/);
    const next = await executor.execute({ ...task, taskId: "next-task" });
    assert.equal(next.status, "COMPLETED");
    assert.ok(!JSON.stringify(requests[3]).includes("<function="));
});

it("recovers from XML to real code and reports exactly one confirmed send", async t => {
    const code = 'await onebot.sendText("onebot:group:123", "test message");';
    const { executor, task, executed } = setup(t, [xml, "```typescript\n" + code + "\n```", done]);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "COMPLETED");
    assert.deepEqual(executed, [code]);
    assert.equal(callback.sentMessages?.length, 1);
    assert.equal(callback.sentMessages?.[0].messageId, "receipt-1");
    const engine = new ContextEngine("success-callback");
    engine.register(metaCallbacksProvider);
});

it("does not accept a fake tool call as successful completion even when it includes end_task", async t => {
    const { executor, task, executed } = setup(t, Array(3).fill(xml + "\n" + done));
    const callback = await executor.execute(task);
    assert.equal(callback.status, "ERROR");
    assert.deepEqual(executed, []);
});

it("allows quoted XML examples, ordinary reasoning and an intentional no-action completion", async t => {
    const { executor, task, requests } = setup(t, ["Example only:\n```xml\n" + xml + "\n```", "No action is needed.", done]);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "COMPLETED");
    assert.equal(requests.length, 3);
    assert.deepEqual(callback.sentMessages ?? [], []);
});

for (const [name, output] of unsupportedOutputs) {
    it(`rejects ${name} even with a completion marker and keeps it out of restored history`, async t => {
        const bad = output + "\n[SESSION_DIGEST]Sent successfully: FAKE-ID.[/SESSION_DIGEST]\n<end_task>";
        const { executor, task, requests, executed, sessionPath } = setup(t, [...Array(3).fill(bad), done]);
        const callback = await executor.execute(task);
        assert.equal(callback.status, "ERROR");
        assert.deepEqual(callback.sentMessages ?? [], []);
        assert.deepEqual(executed, []);
        assert.match(callback.error ?? "", /format recovery exhausted/);
        assert.doesNotMatch(callback.summary, /FAKE-ID|RAW_FAILED_REASONING/);
        assert.match(requests[1].messages.at(-1)!.content, /格式错误.*1\/3/);
        assert.match(requests[2].messages.at(-1)!.content, /格式错误.*2\/3/);
        for (const request of requests.slice(1)) {
            assert.doesNotMatch(JSON.stringify(request.messages.filter(m => m.role === "assistant")), /FAKE-ID|RAW_FAILED_REASONING|<tool_(?:call|result)\b/i);
        }
        const saved = JSON.parse(readFileSync(sessionPath, "utf8"));
        assert.equal(saved.executionRecords.at(-1).endReason, "error");
        assert.doesNotMatch(JSON.stringify(saved), /FAKE-ID|RAW_FAILED_REASONING/);
        const engine = new ContextEngine("format-callback");
        engine.register(metaCallbacksProvider);
        const prompt = engine.render({ callbacks: [callback] }).ephemeralContent;
        assert.match(prompt, /status=ERROR/);
        assert.doesNotMatch(prompt, /FAKE-ID|RAW_FAILED_REASONING/);
        assert.equal(executor.loadSession(sessionPath), true);
        const next = await executor.execute({ ...task, taskId: "after-restore" });
        assert.equal(next.status, "COMPLETED");
        assert.equal(requests.length, 4);
        assert.doesNotMatch(JSON.stringify(requests[3]), /FAKE-ID|RAW_FAILED_REASONING/);
    });

    it(`recovers from ${name} to one real send`, async t => {
        const code = 'await onebot.sendText("onebot:group:123", "test message");';
        const { executor, task, executed, requests } = setup(t, [output, "```typescript\n" + code + "\n```", done]);
        const callback = await executor.execute(task);
        assert.equal(callback.status, "COMPLETED");
        assert.deepEqual(executed, [code]);
        assert.equal(callback.sentMessages?.length, 1);
        assert.equal(callback.sentMessages[0].messageId, "receipt-1");
        assert.match(requests[1].messages.at(-1)!.content, /格式错误.*1\/3/);
        assert.doesNotMatch(callback.summary, /FAKE-ID|RAW_FAILED_REASONING/);
    });
}

it("rejects a fabricated result before a real code block without executing the mixed response", async t => {
    const mixed = fakeReceipt + '\n```typescript\nawait onebot.sendText("onebot:group:123", "test message");\n```';
    const { executor, task, executed, sessionPath } = setup(t, Array(3).fill(mixed));
    const callback = await executor.execute(task);
    assert.equal(callback.status, "ERROR");
    assert.deepEqual(executed, []);
    assert.deepEqual(callback.sentMessages ?? [], []);
    assert.doesNotMatch(readFileSync(sessionPath, "utf8"), /FAKE-ID|RAW_FAILED_REASONING/);
});

it("preserves a real send when later fabricated results exhaust format recovery", async t => {
    const code = '```typescript\nawait onebot.sendText("onebot:group:123", "test message");\n```';
    const { executor, task, executed } = setup(t, [code, ...Array(3).fill(fakeReceipt)]);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "ERROR");
    assert.equal(executed.length, 1);
    assert.equal(callback.sentMessages?.length, 1);
    assert.equal(callback.sentMessages[0].messageId, "receipt-1");
    assert.doesNotMatch(callback.summary, /FAKE-ID|RAW_FAILED_REASONING/);
});

it("allows fenced, inline and blockquoted tool examples and an intentional no-action finish", async t => {
    const example = unsupportedOutputs[0][1];
    const answers = [
        "Example only:\n```xml\n" + example + "\n```",
        "Example only:\n~~~xml\n" + fakeReceipt + "\n~~~",
        "Example only:\n````xml\n```xml\n" + example + "\n```\n`````",
        'The inline example is `<tool_call>{"name":"example"}</tool_call>`, not an action.',
        "The result example is ``<tool_result>`example`</tool_result>``.",
        "Quoted example:\n" + example.split("\n").map(line => "> " + line).join("\n"),
        "No action is needed. A tool_callback field and a <tool_result_note> are ordinary text.",
        done,
    ];
    const { executor, task, requests, executed } = setup(t, answers);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "COMPLETED");
    assert.equal(requests.length, answers.length);
    assert.deepEqual(executed, []);
    assert.deepEqual(callback.sentMessages ?? [], []);
    assert.ok(requests.every(r => !r.messages.at(-1)!.content.includes("[CodeAct 格式错误")));
});

it("allows tool marker strings inside executable code", async t => {
    const code = 'console.log("<tool_result>documentation</tool_result>");';
    const { executor, task, executed } = setup(t, ["```javascript\n" + code + "\n```", done]);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "COMPLETED");
    assert.deepEqual(executed, [code]);
    assert.deepEqual(callback.sentMessages ?? [], []);
});

it("allows marker strings in executable fences immediately following prose", async t => {
    const code = 'console.log("<tool_call>example</tool_call>");';
    const { executor, task, executed } = setup(t, ["Print the example: ```javascript\n" + code + "\n```", done]);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "COMPLETED");
    assert.deepEqual(executed, [code]);
});

it("allows ordinary reasoning that mentions unsupported tag names", async t => {
    const { executor, task, requests } = setup(t, [
        "I must not use <tool_call> or <tool_result> tags. No reply is needed here.",
        done,
    ]);
    const callback = await executor.execute(task);
    assert.equal(callback.status, "COMPLETED");
    assert.deepEqual(callback.sentMessages ?? [], []);
    assert.equal(requests.length, 2);
    assert.ok(!requests[1].messages.at(-1)!.content.includes("[CodeAct 格式错误"));
});

for (const quote of [
    "````xml\n```xml\n" + fakeReceipt + "\n```\n`````",
    "~~~xml\n" + fakeReceipt + "\n~~~",
    "> `quoted example`\n> <tool_result>quoted result</tool_result>",
    "An inline example: ``<tool_result>`example`</tool_result>``.",
]) {
    it(`does not let a quoted example hide a following fake result: ${quote.split("\n")[0]}`, async t => {
        const { executor, task, executed } = setup(t, Array(3).fill(quote + "\n" + fakeReceipt));
        const callback = await executor.execute(task);
        assert.equal(callback.status, "ERROR");
        assert.deepEqual(executed, []);
        assert.doesNotMatch(callback.summary, /FAKE-ID/);
    });
}
