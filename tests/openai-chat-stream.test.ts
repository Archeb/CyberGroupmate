import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { LLMConfig } from "../src/core/config.js";
import { callOpenAI } from "../src/core/llm/openai.js";
import { reasoningOriginKey } from "../src/core/llm/reasoning-origin.js";

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(error => error ? reject(error) : resolve());
    })));
});

async function startServer(handler: (res: ServerResponse, body: Record<string, any>) => void) {
    const server = createServer((req, res) => {
        let raw = "";
        req.on("data", chunk => { raw += chunk; });
        req.on("end", () => handler(res, JSON.parse(raw)));
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return {
        provider: "openai", baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-key", model: "test-model", temperature: 1, maxTokens: 1024,
        chatRequestMode: "stream",
    } satisfies LLMConfig;
}

function event(value: unknown) { return `data: ${JSON.stringify(value)}\r\n\r\n`; }
function chunk(delta: Record<string, unknown>, finish_reason: string | null = null) {
    return { choices: [{ index: 0, delta, finish_reason }] };
}
function call(profile: LLMConfig, signal?: AbortSignal) {
    return callOpenAI([{ role: "user", content: "test" }], profile, profile.model, 1, 1024,
        undefined, undefined, undefined, signal);
}

describe("OpenAI buffered Chat Completions stream", () => {
    it("decodes fragmented UTF-8/SSE, isolates choice zero, and retains trailing usage", async () => {
        let request: Record<string, any> = {};
        const profile = await startServer((res, body) => {
            request = body;
            res.writeHead(200, { "content-type": "text/event-stream" });
            const bytes = Buffer.from(": keepalive\r\n\r\n"
                + event(chunk({ role: "assistant", content: null }))
                + event({ choices: [{ index: 1, delta: { content: "ignore" }, finish_reason: "stop" }] })
                + event(chunk({ reasoning_content: "思", reasoning: "duplicate" }))
                + event(chunk({ reasoning_content: "考" }))
                + event(chunk({ content: "你好" }))
                + event(chunk({ content: "！" }, "stop"))
                + event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20,
                    prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 5 } } })
                + "data: [DONE]\r\n\r\n");
            // Split inside a multi-byte Chinese character and inside the SSE delimiter.
            const cut = bytes.indexOf(Buffer.from("你")) + 1;
            res.write(bytes.subarray(0, cut));
            setImmediate(() => {
                res.write(bytes.subarray(cut, bytes.length - 3));
                setImmediate(() => res.end(bytes.subarray(bytes.length - 3)));
            });
        });
        const result = await call({ ...profile, extraBody: { stream: false } });
        assert.equal(request.stream, true);
        assert.deepEqual(request.stream_options, { include_usage: true });
        assert.equal(result.content, "你好！");
        assert.deepEqual(result.reasoning, { provider: "openai_chat", content: "思考",
            originKey: reasoningOriginKey(profile, profile.model), tokenCount: 5 });
        assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 8, totalTokens: 20,
            cachedTokens: 4, reasoningTokens: 5 });
    });

    it("accepts reasoning alias and streams without usage, preserving the usage opt-out", async () => {
        let request: Record<string, any> = {};
        const profile = await startServer((res, body) => {
            request = body;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(event(chunk({ reasoning: "think " })) + event(chunk({ reasoning: "more" }))
                + event(chunk({ content: "OK" }, "length")) + "data: [DONE]\n\n");
        });
        const result = await call({ ...profile, extraBody: { stream_options: { include_usage: false } } });
        assert.equal(request.stream_options.include_usage, false);
        assert.equal(result.reasoning?.provider === "openai_chat" && result.reasoning.content, "think more");
        assert.equal(result.usage, undefined);
    });

    for (const [label, ending, error] of [
        ["clean EOF before finish", "", /ended before completion/],
        ["DONE before finish", "data: [DONE]\n\n", /ended before completion/],
        ["upstream error", event({ error: { message: "upstream overloaded" } }), /upstream overloaded/],
        ["error finish reason", event(chunk({}, "error")), /stream failed/],
    ] as const) {
        it(`rejects partial content on ${label}`, async () => {
            const profile = await startServer(res => {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.end(event(chunk({ content: "partial" })) + ending);
            });
            await assert.rejects(call(profile), error);
        });
    }

    it("rejects cancellation after content rather than returning partial success", async () => {
        const controller = new AbortController();
        const profile = await startServer(res => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(event(chunk({ content: "partial" })));
            const timer = setTimeout(() => controller.abort(), 30);
            res.on("close", () => clearTimeout(timer));
        });
        await assert.rejects(call(profile, controller.signal), { name: "AbortError" });
    });

    it("rejects a reasoning-only completed response as empty", async () => {
        const profile = await startServer(res => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end(event(chunk({ reasoning: "only thinking" }, "length")) + "data: [DONE]\n\n");
        });
        await assert.rejects(call(profile), /empty response/);
    });
});
