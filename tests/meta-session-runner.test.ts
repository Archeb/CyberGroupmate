import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, LLMResponse } from "../src/core/llm.js";
import type { LLMConfig } from "../src/core/config.js";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";
import { compactThinking, extractSessionDigest, parseMetaResponse, runMetaSession } from "../src/meta-sandbox/meta-session-runner.js";

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
        assert.match(parsed.thinking, /SESSION_DIGEST/);
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
    it("executes code, feeds observation back, and ends on end_turn", async () => {
        const sandbox = new MetaSandbox({
            tools: {
                answer: async () => 42,
            },
        });
        const llmCalls: ChatMessage[][] = [];
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
        assert.equal(result.sessionDigest, "resolved answer and logged it");
        assert.match(result.turns[0].observation ?? "", /42/);
        assert.match(llmCalls[1][llmCalls[1].length - 1].content, /MetaSandbox observation/);
        assert.match(llmCalls[1][llmCalls[1].length - 1].content, /42/);
    });

    it("returns no_code when the model emits no runnable code", async () => {
        const sandbox = new MetaSandbox({});
        const result = await runMetaSession(
            [{ role: "system", content: "system" }],
            sandbox,
            [TEST_LLM_CONFIG],
            {
                llmCaller: async () => ({
                    content: "Need more context before acting.",
                }),
            },
        );

        assert.equal(result.endReason, "no_code");
        assert.equal(result.sessionDigest, "Need more context before acting.");
        assert.equal(result.turns.length, 1);
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