import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { LLMConfig } from "../src/core/config.js";
import { callAnthropic } from "../src/core/llm/anthropic.js";
import { callOpenAI } from "../src/core/llm/openai.js";
import { callOpenAIResponses } from "../src/core/llm/openai-responses.js";
import { reasoningOriginKey } from "../src/core/llm/reasoning-origin.js";
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
            originKey: reasoningOriginKey(profile, profile.model),
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
            originKey: reasoningOriginKey(profile, profile.model),
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
            originKey: reasoningOriginKey(profile, profile.model),
            tokenCount: 7,
        });

        await callOpenAI(secondTurn(first), profile, profile.model, 1, 1024, "high");
        assert.equal(requests[1].messages[1].reasoning_content, "private reasoning");
    });
});

describe("cross-profile reasoning isolation", () => {
    it("drops Responses reasoning items produced by another profile", async () => {
        // 别的网关返回的 reasoning item id 不在本网关的命名空间里（例如 sub2api 的
        // `item_…` 回传给 opencode zen 会 400 Invalid reasoning item id format）。
        const foreignItem = {
            id: "item_from_another_gateway",
            type: "reasoning",
            summary: [],
        };
        const { baseUrl, requests } = await startServer(() => ({
            id: "resp_0",
            object: "response",
            status: "completed",
            output_text: "answer",
            output: [{
                id: "msg_0",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "answer", annotations: [] }],
            }],
        }));
        const profile = config("openai_responses", baseUrl);
        const messages: ChatMessage[] = [
            { role: "user", content: "first" },
            {
                role: "assistant",
                content: "first answer",
                reasoning: {
                    provider: "openai_responses",
                    items: [foreignItem],
                    originKey: "another-profile",
                },
            },
            { role: "user", content: "second" },
        ];

        await callOpenAIResponses(messages, profile, profile.model, 1, 1024, "high");

        assert.deepEqual(requests[0].input, [
            { role: "user", content: [{ type: "input_text", text: "first" }] },
            { role: "assistant", content: "first answer" },
            { role: "user", content: [{ type: "input_text", text: "second" }] },
        ]);
    });

    it("drops Responses reasoning items with no origin (legacy history)", async () => {
        const { baseUrl, requests } = await startServer(() => ({
            id: "resp_0",
            object: "response",
            status: "completed",
            output_text: "answer",
            output: [{
                id: "msg_0",
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "answer", annotations: [] }],
            }],
        }));
        const profile = config("openai_responses", baseUrl);

        await callOpenAIResponses([
            { role: "user", content: "first" },
            {
                role: "assistant",
                content: "first answer",
                reasoning: {
                    provider: "openai_responses",
                    items: [{ id: "rs_legacy", type: "reasoning", summary: [] }],
                },
            },
            { role: "user", content: "second" },
        ], profile, profile.model, 1, 1024, "high");

        assert.equal(
            requests[0].input.some((item: Record<string, unknown>) => item.type === "reasoning"),
            false,
        );
    });

    it("drops Anthropic thinking blocks signed by another profile", async () => {
        const { baseUrl, requests } = await startServer(() => ({
            content: [{ type: "text", text: "answer" }],
            usage: { input_tokens: 10, output_tokens: 12 },
        }));
        const profile = config("anthropic", baseUrl);

        await callAnthropic([
            { role: "user", content: "first" },
            {
                role: "assistant",
                content: "first answer",
                reasoning: {
                    provider: "anthropic",
                    blocks: [{ type: "thinking", thinking: "private", signature: "foreign-signature" }],
                    originKey: "another-profile",
                },
            },
            { role: "user", content: "second" },
        ], profile, profile.model, 1, 1024, "high");

        assert.deepEqual(requests[0].messages[1], { role: "assistant", content: "first answer" });
    });

    it("drops Chat reasoning_content produced by another profile", async () => {
        const { baseUrl, requests } = await startServer(() => ({
            choices: [{ message: { content: "answer" } }],
            usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
        }));
        const profile = config("openai", baseUrl);

        await callOpenAI([
            { role: "user", content: "first" },
            {
                role: "assistant",
                content: "first answer",
                reasoning: {
                    provider: "openai_chat",
                    content: "foreign reasoning",
                    originKey: "another-profile",
                },
            },
            { role: "user", content: "second" },
        ], profile, profile.model, 1, 1024, "high");

        assert.equal(requests[0].messages[1].reasoning_content, undefined);
    });
});
