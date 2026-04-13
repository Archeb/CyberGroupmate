import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
    disconnectAll,
    initMcpBridge,
    mcpBridge,
} from "../src/sandbox/modules/mcp-bridge.js";

describe("mcp-bridge Streamable HTTP", () => {
    async function readBody(req: IncomingMessage): Promise<string> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString("utf-8");
    }

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
                writeJson(res, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: {
                        content: [
                            {
                                type: "text",
                                text: String(msg.params?.arguments?.value ?? ""),
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
});