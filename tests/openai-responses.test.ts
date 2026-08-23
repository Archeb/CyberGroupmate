import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { LLMConfig } from "../src/core/config.js";
import {
    callOpenAIResponses,
    closeOpenAIResponsesWebSockets,
    collectResponseFromStream,
    isRetryableResponsesWebSocketError,
} from "../src/core/llm/openai-responses.js";
import type { ChatMessage } from "../src/core/llm/types.js";

const websocketServers: WebSocketServer[] = [];
const httpServers: Server[] = [];

afterEach(async () => {
    closeOpenAIResponsesWebSockets();
    await Promise.all(websocketServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        for (const client of server.clients) client.terminate();
        server.close(error => error ? reject(error) : resolve());
    })));
    await Promise.all(httpServers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    })));
});

async function startResponsesWebSocketServer(): Promise<{
    baseUrl: string;
    requests: Array<Record<string, any>>;
    connections: WebSocket[];
}> {
    const requests: Array<Record<string, any>> = [];
    const connections: WebSocket[] = [];
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/v1/responses" });
    websocketServers.push(server);
    await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
    });
    server.on("connection", socket => {
        connections.push(socket);
        socket.on("message", raw => {
            const request = JSON.parse(raw.toString()) as Record<string, any>;
            requests.push(request);
            const turn = requests.length;
            const responseId = `resp_${turn}`;
            const answer = `answer ${turn}`;
            const reasoningItem = {
                id: `rs_${turn}`,
                type: "reasoning",
                summary: [],
                encrypted_content: `encrypted-${turn}`,
            };
            socket.send(JSON.stringify({ type: "response.created", response: { id: responseId } }));
            socket.send(JSON.stringify({ type: "response.output_item.done", item: reasoningItem }));
            socket.send(JSON.stringify({ type: "response.output_text.delta", delta: answer }));
            socket.send(JSON.stringify({
                type: "response.completed",
                response: {
                    id: responseId,
                    output: [{
                        id: `msg_${turn}`,
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: answer, annotations: [] }],
                    }],
                    usage: {
                        input_tokens: 3,
                        output_tokens: 5,
                        total_tokens: 8,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: turn + 10 },
                    },
                },
            }));
        });
    });
    const address = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests, connections };
}

function websocketConfig(baseUrl: string): LLMConfig {
    return {
        provider: "openai_responses",
        baseUrl,
        apiKey: "test-key",
        model: "reasoning-model",
        temperature: 1,
        maxTokens: 1024,
        responsesRequestMode: "websocket",
        omit_max_output_tokens: true,
    };
}

describe("OpenAI Responses stream collection", () => {
    it("keeps reasoning output_item.done when completed output omits it", async () => {
        const reasoningItem = {
            id: "rs_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "opaque",
        };
        async function* stream() {
            yield { type: "response.output_item.done", item: reasoningItem };
            yield {
                type: "response.completed",
                response: {
                    output_text: "answer",
                    output: [{ type: "message", role: "assistant", content: [] }],
                    usage: null,
                },
            };
        }

        const result = await collectResponseFromStream(stream() as any);

        assert.deepEqual(result.output, [
            reasoningItem,
            { type: "message", role: "assistant", content: [] },
        ]);
    });

    it("accepts Premature close after response.completed", async () => {
        async function* stream() {
            yield { type: "response.output_text.delta", delta: "hel" };
            yield { type: "response.output_text.delta", delta: "lo" };
            yield {
                type: "response.completed",
                response: {
                    output_text: "hello",
                    usage: {
                        input_tokens: 1,
                        output_tokens: 2,
                        total_tokens: 3,
                    },
                },
            };
            throw new Error("Premature close");
        }

        const result = await collectResponseFromStream(stream() as any);

        assert.equal(result.output_text, "hello");
        assert.deepEqual(result.usage, {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
        });
    });

    it("does not accept Premature close before response.completed", async () => {
        async function* stream() {
            yield { type: "response.output_text.delta", delta: "partial" };
            throw new Error("Premature close");
        }

        await assert.rejects(
            collectResponseFromStream(stream() as any),
            /Premature close/,
        );
    });
});

describe("OpenAI Responses WebSocket mode", () => {
    it("only falls back to HTTP for transient WebSocket failures", () => {
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Responses WebSocket closed (1013): upstream websocket is busy, please retry later"),
        ), true);
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Responses WebSocket closed (1011): upstream websocket proxy failed"),
        ), true);
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Unexpected server response: 503"),
        ), true);
        assert.equal(isRetryableResponsesWebSocketError(
            new Error("Responses WebSocket closed (1000): normal closure"),
        ), false);
    });

    it("falls back to HTTP after a 1013 close and keeps encrypted reasoning", async () => {
        const httpRequests: Array<Record<string, any>> = [];
        const reasoningItem = {
            id: "rs_http_fallback",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-http-fallback",
        };
        const httpServer = createServer((req, res) => {
            let raw = "";
            req.on("data", chunk => { raw += chunk; });
            req.on("end", () => {
                httpRequests.push(JSON.parse(raw) as Record<string, any>);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({
                    id: "resp_http_fallback",
                    object: "response",
                    status: "completed",
                    output_text: "answer over http",
                    output: [reasoningItem, {
                        id: "msg_http_fallback",
                        type: "message",
                        role: "assistant",
                        status: "completed",
                        content: [{ type: "output_text", text: "answer over http", annotations: [] }],
                    }],
                    usage: {
                        input_tokens: 3,
                        output_tokens: 5,
                        total_tokens: 8,
                        input_tokens_details: { cached_tokens: 0 },
                        output_tokens_details: { reasoning_tokens: 4 },
                    },
                }));
            });
        });
        httpServers.push(httpServer);
        const wsServer = new WebSocketServer({ server: httpServer, path: "/v1/responses" });
        websocketServers.push(wsServer);
        wsServer.on("connection", socket => socket.once("message", () => {
            socket.close(1013, "upstream websocket is busy, please retry later");
        }));
        await new Promise<void>((resolve, reject) => {
            httpServer.once("error", reject);
            httpServer.listen(0, "127.0.0.1", resolve);
        });
        const address = httpServer.address() as AddressInfo;
        const profile = websocketConfig(`http://127.0.0.1:${address.port}/v1`);

        const result = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(result.content, "answer over http");
        assert.deepEqual(result.reasoning, {
            provider: "openai_responses",
            items: [reasoningItem],
            tokenCount: 4,
        });
        assert.equal(httpRequests.length, 1);
        assert.deepEqual(httpRequests[0].include, ["reasoning.encrypted_content"]);
    });

    it("continues incrementally on one connection and rebuilds after disconnect", async () => {
        const { baseUrl, requests, connections } = await startResponsesWebSocketServer();
        const profile = websocketConfig(baseUrl);
        const first = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(connections.length, 1);
        assert.equal(requests[0].type, "response.create");
        assert.equal(requests[0].stream, undefined);
        assert.equal(requests[0].background, undefined);
        assert.equal(requests[0].max_output_tokens, undefined);
        assert.equal(requests[0].previous_response_id, undefined);
        assert.deepEqual(requests[0].input, [
            { role: "user", content: [{ type: "input_text", text: "first" }] },
        ]);
        assert.equal(first.content, "answer 1");
        assert.equal(first.reasoning?.provider, "openai_responses");
        assert.deepEqual(first.reasoning && "items" in first.reasoning ? first.reasoning.items : [], [{
            id: "rs_1",
            type: "reasoning",
            summary: [],
            encrypted_content: "encrypted-1",
        }]);
        assert.equal(first.reasoning && "responseId" in first.reasoning ? first.reasoning.responseId : undefined, "resp_1");
        assert.ok(first.reasoning && "websocketSessionId" in first.reasoning && first.reasoning.websocketSessionId);

        const secondMessages: ChatMessage[] = [
            { role: "user", content: "first" },
            { role: "assistant", content: first.content, reasoning: first.reasoning },
            { role: "user", content: "second" },
        ];
        const second = await callOpenAIResponses(
            secondMessages,
            profile, profile.model, 1, 1024, "high", "prefix: ",
        );

        assert.equal(connections.length, 1);
        assert.equal(requests[1].previous_response_id, "resp_1");
        assert.deepEqual(requests[1].input, [
            { role: "user", content: [{ type: "input_text", text: "second" }] },
            { role: "assistant", content: "prefix: " },
        ]);
        assert.equal(second.reasoning && "responseId" in second.reasoning ? second.reasoning.responseId : undefined, "resp_2");

        closeOpenAIResponsesWebSockets();
        const thirdMessages: ChatMessage[] = [
            ...secondMessages,
            { role: "assistant", content: second.content, reasoning: second.reasoning },
            { role: "user", content: "third" },
        ];
        await callOpenAIResponses(
            thirdMessages,
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(connections.length, 2);
        assert.equal(requests[2].previous_response_id, undefined);
        assert.equal(requests[2].input.some((item: Record<string, unknown>) => item.type === "reasoning"), false);
        assert.deepEqual(requests[2].input.map((item: Record<string, unknown>) => item.role), [
            "user", "assistant", "user", "assistant", "user",
        ]);
    });

    it("returns partial output when the response is incomplete", async () => {
        const server = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/v1/responses" });
        websocketServers.push(server);
        await new Promise<void>((resolve, reject) => {
            server.once("listening", resolve);
            server.once("error", reject);
        });
        server.on("connection", socket => socket.once("message", () => {
            socket.send(JSON.stringify({
                type: "response.incomplete",
                response: {
                    id: "resp_incomplete",
                    output: [{
                        id: "msg_incomplete",
                        type: "message",
                        role: "assistant",
                        status: "incomplete",
                        content: [{ type: "output_text", text: "partial answer", annotations: [] }],
                    }],
                    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
                },
            }));
        }));
        const address = server.address() as AddressInfo;
        const profile = websocketConfig(`http://127.0.0.1:${address.port}/v1`);

        const result = await callOpenAIResponses(
            [{ role: "user", content: "first" }],
            profile, profile.model, 1, 1024, "high",
        );

        assert.equal(result.content, "partial answer");
        assert.equal(result.usage?.totalTokens, 5);
    });
});
