import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAgentsApi } from "../src/meta-sandbox/meta-api/agents.js";

describe("createAgentsApi", () => {
    it("lists subagent runtime status from manager state", async () => {
        const api = createAgentsApi({
            getAllSubagents: () => [
                {
                    chatId: "telegram:-1002",
                    lastActivityAt: Date.parse("2026-01-02T10:00:00Z"),
                    stickiness: { level: "CORE" as const } as any,
                    codeActExecutor: {
                        getQueueSize: () => 3,
                        isProcessing: () => true,
                    },
                },
                {
                    chatId: "telegram:-1001",
                    lastActivityAt: Date.parse("2026-01-01T10:00:00Z"),
                    stickiness: { level: "FAMILIAR" as const } as any,
                    codeActExecutor: {
                        getQueueSize: () => 1,
                        isProcessing: () => false,
                    },
                },
            ],
        }, {
            getGroupModel: (chatId: string) => ({
                chatId,
                chatTitle: chatId === "telegram:-1002" ? "项目群" : "闲聊群",
            } as any),
        });

        const rows = await api.listStatus();

        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((row) => row.chatId), ["telegram:-1002", "telegram:-1001"]);
        assert.deepEqual(rows.map((row) => row.chatTitle), ["项目群", "闲聊群"]);
        assert.equal(rows[0].queueSize, 3);
        assert.equal(rows[0].isProcessing, true);
        assert.equal(rows[0].stickinessLevel, "CORE");
        assert.equal(rows[0].lastActiveAt, "2026-01-02T10:00:00.000Z");
    });

    it("falls back to safe defaults when executor is missing", async () => {
        const api = createAgentsApi({
            getAllSubagents: () => [
                {
                    chatId: "discord:42",
                    lastActivityAt: 0,
                    stickiness: undefined as any,
                    codeActExecutor: null,
                },
            ],
        }, {
            getGroupModel: () => null,
        });

        const [row] = await api.listStatus();

        assert.equal(row.chatTitle, undefined);
        assert.equal(row.queueSize, 0);
        assert.equal(row.isProcessing, false);
        assert.equal(row.stickinessLevel, "STRANGER");
        assert.equal(row.lastActiveAt, "1970-01-01T00:00:00.000Z");
    });
});