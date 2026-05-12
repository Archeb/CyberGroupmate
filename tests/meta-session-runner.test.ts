import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, LLMCallOptions, LLMResponse } from "../src/core/llm.js";
import type { LLMConfig } from "../src/core/config.js";
import type { ContextManifest } from "../src/context-engine/types.js";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";
import { codeActEvents } from "../src/sandbox/session-runner.js";
import {
    META_CODEACT_CHAT_ID,
    compactThinking,
    extractSessionDigest,
    getMetaCodeActState,
    parseMetaResponse,
    resetMetaCodeActState,
    runMetaSession,
} from "../src/meta-sandbox/meta-session-runner.js";
import { buildPrefixMap } from "../src/sandbox/api-intent-extractor.js";
import type { ModuleEntry } from "../src/sandbox/modules/module-registry.js";

const TEST_LLM_CONFIG: LLMConfig = {
    provider: "openai",
    baseUrl: "https://example.invalid",
    apiKey: "test",
    model: "fake-model",
    temperature: 0,
    maxTokens: 1024,
};

describe("parseMetaResponse", () => {
    it("extracts thinking and the first js code block", () => {
        const parsed = parseMetaResponse([
            "Plan first.",
            "",
            "```ts",
            "const value = 1;",
            "```",
            "",
            "[SESSION_DIGEST]done[/SESSION_DIGEST]",
            "<end_turn>",
        ].join("\n"));

        assert.equal(parsed.code, "const value = 1;");
        assert.match(parsed.thinking, /Plan first/);
        assert.doesNotMatch(parsed.thinking, /SESSION_DIGEST/);
        assert.doesNotMatch(parsed.thinking, /end_turn/);
    });
});

describe("extractSessionDigest", () => {
    it("prefers explicit SESSION_DIGEST blocks", () => {
        assert.equal(
            extractSessionDigest("thinking\n[SESSION_DIGEST]final summary[/SESSION_DIGEST]"),
            "final summary",
        );
    });

    it("falls back to the tail of thinking", () => {
        assert.equal(compactThinking("abcdef", 3), "def");
        assert.equal(extractSessionDigest("abcdef", 3), "def");
    });
});

describe("runMetaSession", () => {
    it("tracks meta codeact state and emits progress events for the dashboard", async () => {
        resetMetaCodeActState();
        const sandbox = new MetaSandbox({
            tools: {
                answer: async () => 7,
            },
        });
        const progressEvents: any[] = [];
        const onProgress = (event: unknown) => {
            const data = event as { chatId?: string };
            if (data.chatId === META_CODEACT_CHAT_ID) {
                progressEvents.push(event);
            }
        };
        codeActEvents.on("codeact:progress", onProgress);

        try {
            const responses: LLMResponse[] = [
                {
                    content: [
                        "先执行一段代码。",
                        "",
                        "```ts",
                        "return await tools.answer();",
                        "```",
                    ].join("\n"),
                },
                {
                    content: "结束。\n[SESSION_DIGEST]meta state captured[/SESSION_DIGEST]\n<end_turn>",
                },
            ];

            const result = await runMetaSession(
                [
                    { role: "system", content: "system" },
                    { role: "user", content: "meta task" },
                ],
                sandbox,
                [TEST_LLM_CONFIG],
                {
                    llmCaller: async () => {
                        const next = responses.shift();
                        assert.ok(next);
                        return next;
                    },
                },
            );

            assert.equal(result.endReason, "end_turn");

            const state = getMetaCodeActState();
            assert.equal(state.chatId, META_CODEACT_CHAT_ID);
            assert.equal(state.isProcessing, false);
            assert.equal(state.executionCount, 1);
            assert.ok(state.session.length >= 4);
            assert.match(state.session.at(-1)?.content ?? "", /MetaSandbox observation|结束/);

            assert.deepEqual(
                progressEvents.map((event) => event.phase),
                ["task", "thinking", "executing", "observation", "thinking", "end"],
            );
            assert.equal(progressEvents[0]?.chatId, META_CODEACT_CHAT_ID);
            assert.match(progressEvents[0]?.userMessage ?? "", /meta task/);
            assert.match(progressEvents[1]?.thinking ?? "", /先执行一段代码/);
            assert.equal(progressEvents[2]?.codeBlocks?.[0]?.code, "return await tools.answer();");
            assert.match(progressEvents[3]?.executionOutput ?? "", /7/);
            assert.equal(progressEvents.at(-1)?.endReason, "end_turn");
        } finally {
            codeActEvents.off("codeact:progress", onProgress);
            resetMetaCodeActState();
        }
    });

    it("executes code, feeds observation back, and ends on end_turn", async () => {
        const sandbox = new MetaSandbox({
            tools: {
                answer: async () => 42,
            },
        });
        const llmCalls: ChatMessage[][] = [];
        const llmOptions: Array<LLMCallOptions | undefined> = [];
        const contextManifest: ContextManifest = {
            timestamp: "2026-05-02T00:00:00.000Z",
            chatId: "__meta__",
            engineId: "meta-agent",
            sections: [],
            summary: {
                totalSections: 0,
                activeSections: 0,
                skippedSections: 0,
                totalChars: 0,
                historicalChars: 0,
                ephemeralChars: 0,
                estimatedTokens: 0,
            },
        };
        const responses: LLMResponse[] = [
            {
                content: [
                    "Need one lookup.",
                    "",
                    "```ts",
                    "const value = await tools.answer();",
                    "console.log(\"value\", value);",
                    "return value;",
                    "```",
                ].join("\n"),
            },
            {
                content: "Done.\n[SESSION_DIGEST]resolved answer and logged it[/SESSION_DIGEST]\n<end_turn>",
            },
        ];

        const result = await runMetaSession(
            [
                { role: "system", content: "system" },
                { role: "user", content: "user" },
            ],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                contextManifest,
                llmCaller: async (messages, _configs, options) => {
                    llmCalls.push(messages.map((message) => ({ ...message })));
                    llmOptions.push(options);
                    const next = responses.shift();
                    assert.ok(next);
                    return next;
                },
            },
        );

        assert.equal(result.endReason, "end_turn");
        assert.equal(result.turns.length, 2);
        assert.equal(result.sessionDigest, "resolved answer and logged it");
        assert.match(result.messages.at(-1)?.content ?? "", /<end_turn>/);
        assert.match(result.turns[0].observation ?? "", /42/);
        assert.equal(llmOptions[0]?.contextManifest, contextManifest);
        assert.deepEqual(llmOptions[0]?.stop, ["[MetaSandbox observation]"]);
        assert.deepEqual(llmOptions[1]?.stop, ["[MetaSandbox observation]"]);
        assert.match(llmCalls[1][llmCalls[1].length - 1].content, /MetaSandbox observation/);
        assert.match(llmCalls[1][llmCalls[1].length - 1].content, /42/);
        assert.match(llmCalls[1][llmCalls[1].length - 2].content, /const value = await tools\.answer/);
        assert.doesNotMatch(llmCalls[1][llmCalls[1].length - 2].content, /<end_turn>/);
    });

    it("injects Meta API docs through two-pass before executing platform APIs", async () => {
        const registry: ModuleEntry[] = [{
            name: "dispatch",
            description: "Meta dispatch API",
            methods: [{
                name: "taskToGroup",
                brief: "taskToGroup(chatId, taskSpec)",
                fullDoc: [
                    "```typescript",
                    "taskToGroup(chatId: string, taskSpec: { contentDirection: string }): Promise<{ taskId: string }>",
                    "```",
                    "",
                    "Use this to delegate writes to a group Subagent.",
                ].join("\n"),
            }],
        }];
        const sandbox = new MetaSandbox({
            dispatch: {
                taskToGroup: async (_chatId: string, taskSpec: { contentDirection: string }) => ({
                    taskId: "task-1",
                    contentDirection: taskSpec.contentDirection,
                }),
            },
        });
        const llmCalls: ChatMessage[][] = [];
        const progressEvents: any[] = [];
        const onProgress = (event: unknown) => {
            const data = event as { chatId?: string };
            if (data.chatId === META_CODEACT_CHAT_ID) {
                progressEvents.push(event);
            }
        };
        codeActEvents.on("codeact:progress", onProgress);

        const responses: LLMResponse[] = [
            {
                content: [
                    "Need to dispatch.",
                    "",
                    "```ts",
                    "await dispatch.taskToGroup(\"telegram:g1\", { contentDirection: \"pass1\" });",
                    "```",
                ].join("\n"),
            },
            {
                content: [
                    "Docs loaded; rewrite with the right shape.",
                    "",
                    "```ts",
                    "const task = await dispatch.taskToGroup(\"telegram:g1\", { contentDirection: \"pass2\" });",
                    "console.log(task.taskId, task.contentDirection);",
                    "```",
                ].join("\n"),
            },
            {
                content: "Done.\n[SESSION_DIGEST]dispatched via injected docs[/SESSION_DIGEST]\n<end_turn>",
            },
        ];

        try {
            const result = await runMetaSession(
                [{ role: "system", content: "system" }],
                sandbox,
                [TEST_LLM_CONFIG],
                {
                    llmCaller: async (messages) => {
                        llmCalls.push(messages.map((message) => ({ ...message })));
                        const next = responses.shift();
                        assert.ok(next);
                        return next;
                    },
                    twoPassConfig: {
                        getPrefixMap: () => buildPrefixMap(registry),
                        lookupDocs: (methods) => {
                            assert.deepEqual(methods, ["dispatch.taskToGroup"]);
                            return "# 完整 API 文档\n\n### dispatch.taskToGroup\n\n" + registry[0].methods[0].fullDoc;
                        },
                    },
                },
            );

            assert.equal(result.endReason, "end_turn");
            assert.equal(result.turns[0]?.code, [
                "const task = await dispatch.taskToGroup(\"telegram:g1\", { contentDirection: \"pass2\" });",
                "console.log(task.taskId, task.contentDirection);",
            ].join("\n"));
            assert.match(result.turns[0]?.observation ?? "", /task-1 pass2/);
            assert.match(llmCalls[1]?.at(-1)?.content ?? "", /Meta API 文档加载完成/);
            assert.match(llmCalls[1]?.at(-1)?.content ?? "", /### dispatch\.taskToGroup/);
            assert.deepEqual(
                progressEvents.map((event) => event.phase),
                ["thinking", "type_resolving", "thinking", "executing", "observation", "thinking", "end"],
            );
        } finally {
            codeActEvents.off("codeact:progress", onProgress);
        }
    });

    it("ignores code+end_turn and waits for a pure-text digest+end_turn turn", async () => {
        const sandbox = new MetaSandbox({
            tools: {
                dispatch: async () => ({ taskId: "task-1", status: "PENDING" }),
            },
        });
        const llmCalls: ChatMessage[][] = [];

        const responses: LLMResponse[] = [
            {
                content: [
                    "Need to dispatch once.",
                    "",
                    "```ts",
                    "return await tools.dispatch();",
                    "```",
                    "",
                    "[SESSION_DIGEST]dispatched greeting task[/SESSION_DIGEST]",
                    "<end_turn>",
                ].join("\n"),
            },
            {
                content: "Done.\n[SESSION_DIGEST]dispatched greeting task[/SESSION_DIGEST]\n<end_turn>",
            },
        ];
        const result = await runMetaSession(
            [
                { role: "system", content: "system" },
                { role: "user", content: "user" },
            ],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                llmCaller: async (messages) => {
                    llmCalls.push(messages.map((message) => ({ ...message })));
                    const next = responses.shift();
                    assert.ok(next);
                    return next;
                },
            },
        );

        assert.equal(result.endReason, "end_turn");
        assert.equal(result.turns.length, 2);
        assert.equal(llmCalls.length, 2);
        assert.equal(result.sessionDigest, "dispatched greeting task");
        assert.match(result.turns[0]?.observation ?? "", /task-1/);
        assert.match(result.messages.map((message) => message.content).join("\n\n"), /dispatched greeting task/);
    });

    it("keeps post-code history, runs only first block, then waits next round to end", async () => {
        const sandbox = new MetaSandbox({
            tools: {
                answer: async () => 42,
            },
        });
        const llmCalls: ChatMessage[][] = [];

        const responses: LLMResponse[] = [
            {
                content: [
                    "Need one real lookup.",
                    "",
                    "```ts",
                    "const value = await tools.answer();",
                    "console.log(\"real\", value);",
                    "return value;",
                    "```",
                    "",
                    "[MetaSandbox observation]",
                    "real 42",
                    "",
                    "Now I will dispatch based on the fake observation.",
                    "",
                    "```ts",
                    "throw new Error(\"second block must not run\");",
                    "```",
                    "",
                    "[SESSION_DIGEST]fake completed[/SESSION_DIGEST]",
                    "<end_turn>",
                ].join("\n"),
            },
            {
                content: "Done.\n[SESSION_DIGEST]real observation handled[/SESSION_DIGEST]\n<end_turn>",
            },
        ];
        const result = await runMetaSession(
            [
                { role: "system", content: "system" },
                { role: "user", content: "user" },
            ],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                llmCaller: async (messages) => {
                    llmCalls.push(messages.map((message) => ({ ...message })));
                    const next = responses.shift();
                    assert.ok(next);
                    return next;
                },
            },
        );

        assert.equal(result.endReason, "end_turn");
        assert.equal(result.turns[0]?.code, [
            "const value = await tools.answer();",
            "console.log(\"real\", value);",
            "return value;",
        ].join("\n"));
        assert.match(result.turns[0]?.observation ?? "", /42/);
        assert.equal(result.sessionDigest, "real observation handled");

        assert.equal(llmCalls.length, 2);
        const secondCallText = llmCalls[1]?.map((message) => message.content).join("\n\n") ?? "";
        assert.match(secondCallText, /Need one real lookup/);
        assert.match(secondCallText, /second block must not run/);
        assert.match(secondCallText, /fake completed/);
        assert.match(secondCallText, /Now I will dispatch/);
    });

    it("keeps requesting an explicit end_turn when the model emits no runnable code", async () => {
        const sandbox = new MetaSandbox({});
        const result = await runMetaSession(
            [{ role: "system", content: "system" }],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                maxTurns: 2,
                llmCaller: async () => ({
                    content: "Need more context before acting.",
                }),
            },
        );

        assert.equal(result.endReason, "max_turns");
        assert.equal(result.sessionDigest, "Need more context before acting.");
        assert.equal(result.turns.length, 2);
        assert.match(result.messages.at(-1)?.content ?? "", /Meta runner notice/);
    });

    it("requires confirmation before accepting first-turn no-code end_turn", async () => {
        const sandbox = new MetaSandbox({});
        const responses: LLMResponse[] = [
            { content: "[SESSION_DIGEST]no dispatch needed[/SESSION_DIGEST]\n<end_turn>" },
            { content: "<end_turn>" },
        ];
        const llmCalls: ChatMessage[][] = [];

        const result = await runMetaSession(
            [{ role: "system", content: "system" }],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                llmCaller: async (messages) => {
                    llmCalls.push(messages.map((message) => ({ ...message })));
                    const next = responses.shift();
                    assert.ok(next);
                    return next;
                },
            },
        );

        assert.equal(result.endReason, "end_turn");
        assert.equal(result.sessionDigest, "no dispatch needed");
        assert.equal(result.turns.length, 2);
        assert.match(llmCalls[1]?.at(-1)?.content ?? "", /你本次未写代码分配任务/);
    });

    it("requires SESSION_DIGEST before accepting a pure-text end_turn after code ran", async () => {
        const sandbox = new MetaSandbox({
            tools: {
                noop: async () => "ok",
            },
        });
        const responses: LLMResponse[] = [
            {
                content: [
                    "Need one action.",
                    "",
                    "```ts",
                    "await tools.noop();",
                    "```",
                ].join("\n"),
            },
            { content: "Done.\n<end_turn>" },
            { content: "[SESSION_DIGEST]finished after digest reminder[/SESSION_DIGEST]\n<end_turn>" },
        ];

        const result = await runMetaSession(
            [{ role: "system", content: "system" }],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                llmCaller: async () => {
                    const next = responses.shift();
                    assert.ok(next);
                    return next;
                },
            },
        );

        assert.equal(result.endReason, "end_turn");
        assert.equal(result.sessionDigest, "finished after digest reminder");
        assert.match(result.messages[4]?.content ?? "", /没有输出 \[SESSION_DIGEST\]/);
    });

    it("feeds sandbox errors back to the model and allows a repair turn", async () => {
        const sandbox = new MetaSandbox({});
        const result = await runMetaSession(
            [{ role: "system", content: "system" }],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                llmCaller: async (messages) => {
                    const lastMessage = messages.at(-1)?.content ?? "";
                    if (!lastMessage.includes("MetaSandbox observation")) {
                        return {
                            content: [
                                "```js",
                                "throw new Error(\"boom\");",
                                "```",
                            ].join("\n"),
                        };
                    }

                    assert.match(lastMessage, /boom/);
                    return {
                        content: "已根据报错修正。\n[SESSION_DIGEST]recovered after sandbox error[/SESSION_DIGEST]\n<end_turn>",
                    };
                },
            },
        );

        assert.equal(result.endReason, "end_turn");
        assert.equal(result.error, undefined);
        assert.equal(result.sessionDigest, "recovered after sandbox error");
        assert.equal(result.turns.length, 2);
        assert.match(result.turns[0].observation ?? "", /boom/);
    });

    it("returns max_turns when the loop exhausts its budget", async () => {
        const sandbox = new MetaSandbox({
            tools: {
                noop: async () => "ok",
            },
        });
        const result = await runMetaSession(
            [{ role: "system", content: "system" }],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                maxTurns: 2,
                llmCaller: async () => ({
                    content: [
                        "thinking",
                        "",
                        "```ts",
                        "await tools.noop();",
                        "```",
                    ].join("\n"),
                }),
            },
        );

        assert.equal(result.endReason, "max_turns");
        assert.equal(result.turns.length, 2);
    });
});
