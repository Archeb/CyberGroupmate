import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
    disconnectAll,
    getConnectionConfigs,
    initMcpBridge,
    mcpBridge,
    replaceConnectionConfigs,
} from "../src/sandbox/modules/mcp-bridge/index.js";
import { getModuleRegistryCache, refreshModuleRegistryCache } from "../src/subagent/code-act-executor.js";

describe("mcp-bridge Streamable HTTP", () => {
    async function readBody(req: IncomingMessage): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf-8");
    }

    it("publishes connected MCP tools into the dynamic module registry", async () => {
        initMcpBridge({
            persistPath: "",
            onRegistryChange: () => {
                refreshModuleRegistryCache();
            },
        });

        let serverUrl = "";

        const server = createServer(async (req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            const body = await readBody(req);
            const msg = JSON.parse(body) as {
                id?: number;
                method?: string;
            };

            if (msg.method === "initialize") {
                writeJson(
                    res,
                    {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "mock-mcp", version: "1.0.0" },
                        },
                    },
                    { "Mcp-Session-Id": "sess-456" }
                );
                return;
            }

            if (msg.method === "notifications/initialized") {
                res.writeHead(202);
                res.end();
                return;
            }

            if (msg.method === "tools/list") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        tools: [
                            {
                                name: "search_repositories",
                                description: "Search repositories",
                                inputSchema: {
                                    type: "object",
                                    properties: { query: { type: "string" } },
                                    required: ["query"],
                                },
                            },
                        ],
                    },
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    throw new Error("Failed to bind mock MCP server");
                }
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        try {
            await mcpBridge.connect({
                name: "github",
                description: "用于搜索 GitHub 仓库和代码",
                transport: "streamable-http",
                url: serverUrl,
            });

            const registry = getModuleRegistryCache();
            const githubModule = registry.find((entry) => entry.name === "github");
            assert.ok(githubModule, "connected MCP server should appear in module registry cache");
            assert.equal(githubModule?.methods.length, 1);
            assert.equal(githubModule?.methods[0]?.name, "search_repositories");
            assert.match(githubModule?.description ?? "", /MCP Server \(1 tools\) via Streamable HTTP/);
            assert.match(githubModule?.description ?? "", /用于搜索 GitHub 仓库和代码/);
            assert.deepEqual(getConnectionConfigs(), [{
                name: "github",
                description: "用于搜索 GitHub 仓库和代码",
                transport: "streamable-http",
                url: serverUrl,
            }]);
        } finally {
            await disconnectAll();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });

    function writeJson(res: ServerResponse, body: unknown, headers?: Record<string, string>): void {
        res.writeHead(200, {
            "Content-Type": "application/json",
            ...(headers ?? {}),
        });
        res.end(JSON.stringify(body));
    }

    it("supports Streamable HTTP JSON-RPC with session headers and SSE responses", async () => {
        initMcpBridge({ persistPath: "" });

        let serverUrl = "";
        let deleteCalled = false;
        const seenSessionHeaders: string[] = [];
        const seenAuthHeaders: string[] = [];

        const server = createServer(async (req, res) => {
            const authHeader = req.headers.authorization;
            if (authHeader) seenAuthHeaders.push(String(authHeader));

            if (req.method === "DELETE") {
                deleteCalled = true;
                seenSessionHeaders.push(String(req.headers["mcp-session-id"] ?? ""));
                res.writeHead(204);
                res.end();
                return;
            }

            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            const body = await readBody(req);
            const msg = JSON.parse(body) as {
                id?: number;
                method?: string;
                params?: Record<string, unknown>;
            };

            if (msg.method !== "initialize") {
                seenSessionHeaders.push(String(req.headers["mcp-session-id"] ?? ""));
            }

            if (msg.method === "initialize") {
                writeJson(
                    res,
                    {
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                            protocolVersion: "2025-03-26",
                            capabilities: { tools: {} },
                            serverInfo: { name: "mock-mcp", version: "1.0.0" },
                        },
                    },
                    { "Mcp-Session-Id": "sess-123" }
                );
                return;
            }

            if (msg.method === "notifications/initialized") {
                res.writeHead(202);
                res.end();
                return;
            }

            if (msg.method === "tools/list") {
                res.writeHead(200, { "Content-Type": "text/event-stream" });
                res.write(
                    `event: message\nid: evt-1\ndata: ${JSON.stringify({
                        jsonrpc: "2.0",
                        id: msg.id,
                        result: {
                            tools: [
                                {
                                    name: "echo",
                                    description: "Echo input",
                                    inputSchema: {
                                        type: "object",
                                        properties: { value: { type: "string" } },
                                        required: ["value"],
                                    },
                                },
                            ],
                        },
                    })}\n\n`
                );
                res.end();
                return;
            }

            if (msg.method === "tools/call") {
                const toolArgs = (msg.params as { arguments?: { value?: unknown } } | undefined)?.arguments;
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: String(toolArgs?.value ?? ""),
                            },
                        ],
                    },
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    throw new Error("Failed to bind mock MCP server");
                }
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        try {
            const remote = await mcpBridge.connect({
                name: "remote-http",
                transport: "streamable-http",
                url: serverUrl,
                headers: { Authorization: "Bearer test-token" },
            });

            assert.equal(remote.name, "remote-http");
            assert.deepEqual(remote.tools, [{ name: "echo", description: "Echo input" }]);

            const listed = mcpBridge.list();
            assert.equal(listed.length, 1);
            assert.equal(listed[0]?.transport, "streamable-http");
            assert.equal(listed[0]?.url, serverUrl);
            assert.equal(listed[0]?.running, true);

            const result = await mcpBridge.call("remote-http", "echo", { value: "hello http" });
            assert.equal(result, "hello http");

            await mcpBridge.disconnect("remote-http");
            assert.equal(mcpBridge.list().length, 0);

            assert.deepEqual(seenSessionHeaders, ["sess-123", "sess-123", "sess-123", "sess-123"]);
            assert.ok(seenAuthHeaders.every((header) => header === "Bearer test-token"));
            assert.equal(deleteCalled, true);
        } finally {
            await disconnectAll();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });

    it("exports and replaces global MCP configs", async () => {
        initMcpBridge({ persistPath: "" });

        let serverUrl = "";

        const server = createServer(async (req, res) => {
            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }

            const body = await readBody(req);
            const msg = JSON.parse(body) as { id?: number; method?: string };

            if (msg.method === "initialize") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        protocolVersion: "2025-03-26",
                        capabilities: { tools: {} },
                        serverInfo: { name: "mock-mcp", version: "1.0.0" },
                    },
                }, { "Mcp-Session-Id": "sess-789" });
                return;
            }

            if (msg.method === "notifications/initialized") {
                res.writeHead(202);
                res.end();
                return;
            }

            if (msg.method === "tools/list") {
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        tools: [
                            { name: "ping", description: "Ping tool" },
                        ],
                    },
                });
                return;
            }

            res.writeHead(404);
            res.end();
        });

        await new Promise<void>((resolve) => {
            server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                if (!address || typeof address === "string") {
                    throw new Error("Failed to bind mock MCP server");
                }
                serverUrl = `http://127.0.0.1:${address.port}/mcp`;
                resolve();
            });
        });

        try {
            await mcpBridge.connect({
                name: "before-replace",
                transport: "streamable-http",
                url: serverUrl,
            });
            assert.equal(getConnectionConfigs().length, 1);

            await replaceConnectionConfigs([
                {
                    name: "after-replace",
                    transport: "streamable-http",
                    url: serverUrl,
                },
            ]);

            const configs = getConnectionConfigs();
            assert.deepEqual(configs, [
                {
                    name: "after-replace",
                    transport: "streamable-http",
                    url: serverUrl,
                },
            ]);
            assert.deepEqual(mcpBridge.list().map((server) => server.name), ["after-replace"]);
        } finally {
            await disconnectAll();
            await new Promise<void>((resolve, reject) => {
                server.close((err) => (err ? reject(err) : resolve()));
            });
        }
    });
});