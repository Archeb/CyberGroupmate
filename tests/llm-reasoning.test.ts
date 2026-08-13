import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { LLMConfig } from "../src/core/config.js";
import { callAnthropic } from "../src/core/llm/anthropic.js";
import { callOpenAI } from "../src/core/llm/openai.js";
import { callOpenAIResponses } from "../src/core/llm/openai-responses.js";
import type { ChatMessage } from "../src/core/llm/types.js";

const servers: Server[] = [];

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    })));
});

async function startServer(
    handler: (body: Record<string, any>, requestIndex: number) => Record<string, unknown>,
): Promise<{ baseUrl: string; requests: Array<Record<string, any>> }> {
    const requests: Array<Record<string, any>> = [];
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        req.on("end", () => {
            const body = JSON.parse(raw) as Record<string, any>;
            requests.push(body);
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(handler(body, requests.length - 1)));
        });
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

function config(provider: LLMConfig["provider"], baseUrl: string): LLMConfig {
    return {
        provider,
        baseUrl,
        apiKey: "test-key",
        model: "reasoning-model",
        temperature: 1,
        maxTokens: 1024,
    };
}

function secondTurn(first: Awaited<ReturnType<typeof callOpenAI>>): ChatMessage[] {
    return [
        { role: "user", content: "first" },
        {
            role: "assistant",
            content: first.content,
            ...(first.reasoning ? { reasoning: first.reasoning } : {}),
        },
        { role: "user", content: "second" },
    ];
}

describe("native reasoning round-trip", () => {
    it("round-trips Responses encrypted reasoning items", async () => {
        const reasoningItem = {
            id: "rs_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-state",
        };
        const { baseUrl, requests } = await startServer((_body, index) => ({
            id: `resp_${index}`,
            object: "response",
            status: "completed",
            output_text: index === 0 ? "first answer" : "second answer",
            output: [
                ...(index === 0 ? [reasoningItem] : []),
                {
                    id: `msg_${index}`,
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{
                        type: "output_text",
                        text: index === 0 ? "first answer" : "second answer",
                        annotations: [],
                    }],
                },
            ],
            usage: {
                input_tokens: 10,
                output_tokens: 12,
                total_tokens: 22,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 7 },
            },
        }));
        const profile = config("openai_responses", baseUrl);

        const first = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );
        assert.deepEqual(first.reasoning, {
            provider: "openai_responses",
            items: [reasoningItem],
            tokenCount: 7,
        });

        await callOpenAIResponses(secondTurn(first), profile, profile.model, 1, 1024, "high");
        assert.deepEqual(requests[1].include, ["reasoning.encrypted_content"]);
        assert.deepEqual(requests[1].input.slice(0, 3), [
            { role: "user", content: [{ type: "input_text", text: "first" }] },
            reasoningItem,
            { role: "assistant", content: "first answer" },
        ]);
    });

    it("round-trips Anthropic signed thinking blocks", async () => {
        const thinkingBlock = { type: "thinking", thinking: "private", signature: "signed-state" };
        const { baseUrl, requests } = await startServer((_body, index) => ({
            content: index === 0
                ? [thinkingBlock, { type: "text", text: "first answer" }]
                : [{ type: "text", text: "second answer" }],
            usage: {
                input_tokens: 10,
                output_tokens: 12,
                output_tokens_details: { thinking_tokens: 7 },
            },
        }));
        const profile = config("anthropic", baseUrl);

        const first = await callAnthropic(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );
        assert.deepEqual(first.reasoning, {
            provider: "anthropic",
            blocks: [thinkingBlock],
            tokenCount: 7,
        });

        await callAnthropic(secondTurn(first), profile, profile.model, 1, 1024, "high");
        assert.deepEqual(requests[1].thinking, { type: "adaptive" });
        assert.deepEqual(requests[1].output_config, { effort: "high" });
        assert.deepEqual(requests[1].messages[1].content, [
            thinkingBlock,
            { type: "text", text: "first answer" },
        ]);
    });

    it("round-trips Chat reasoning_content", async () => {
        const { baseUrl, requests } = await startServer((_body, index) => ({
            choices: [{
                message: {
                    content: index === 0 ? "first answer" : "second answer",
                    reasoning_content: index === 0 ? "private reasoning" : "more reasoning",
                },
            }],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 12,
                total_tokens: 22,
                completion_tokens_details: { reasoning_tokens: 7 },
            },
        }));
        const profile = config("openai", baseUrl);

        const first = await callOpenAI(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );
        assert.deepEqual(first.reasoning, {
            provider: "openai_chat",
            content: "private reasoning",
            tokenCount: 7,
        });

        await callOpenAI(secondTurn(first), profile, profile.model, 1, 1024, "high");
        assert.equal(requests[1].messages[1].reasoning_content, "private reasoning");
    });
});
