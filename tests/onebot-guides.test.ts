import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { loadApiTypeDefs, refreshModuleRegistryCache } from "../src/subagent/code-act-executor.js";
import { loadModuleRegistry, lookupFullDocs } from "../src/sandbox/modules/module-registry.js";
import { createOneBotClientProxy } from "../src/sandbox/modules/onebot/index.js";
import type { CapabilityRegistryEnv } from "../src/sandbox/capability-registry.js";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import type { OneBotConfig } from "../src/core/config.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `onebot-guides-${randomUUID()}.jsonl`), false);
}

function makeConfig(overrides: Partial<OneBotConfig> = {}): OneBotConfig {
    return {
        wsUrl: "ws://127.0.0.1:6700/onebot",
        selfId: "123456789",
        ...overrides,
    };
}

describe("OneBot NapCat builtin guides", () => {
    it("keeps one-step APIs visible and exposes guide activators for NapCat domains", () => {
        refreshModuleRegistryCache();
        const brief = loadApiTypeDefs("onebot");

        assert.ok(brief.includes("sendText"));
        assert.ok(brief.includes("sendMedia"));
        assert.ok(brief.includes("downloadMedia"));
        assert.ok(brief.includes("getMessage"));
        assert.ok(brief.includes("useMessages"));
        assert.ok(brief.includes("useGroupAdministration"));
        assert.ok(brief.includes("useFiles"));
        assert.ok(brief.includes("useUsersAndProfile"));
        assert.ok(brief.includes("useSystemUtilities"));

        assert.equal(brief.includes("callApi"), false);
        assert.equal(brief.includes("set_group_ban"), false);
        assert.equal(brief.includes("get_credentials"), false);
        assert.equal(brief.includes("send_packet"), false);
        assert.equal(brief.includes("set_group_leave"), false);
    });

    it("injects OneBot guide docs without type definition bloat", () => {
        const registry = loadModuleRegistry();
        const docs = lookupFullDocs(registry, ["onebot.useGroupAdministration"]);

        assert.ok(docs.includes("### onebot.useGroupAdministration"));
        assert.ok(docs.includes("onebot.callApi(\"get_group_info\""));
        assert.ok(docs.includes("set_group_ban"));
        assert.ok(docs.includes("set_group_leave"));
        assert.ok(docs.includes("不通过 guide 暴露"));
        assert.equal(docs.includes("#### onebot 相关类型定义"), false);
    });

    it("prints guide content and supports hidden callApi proxy calls", async () => {
        const outputs: string[] = [];
        const hostCalls: Array<{ method: string; args: unknown[] }> = [];
        const env: CapabilityRegistryEnv = {
            ctx: {},
            emitOutput: (line) => outputs.push(line),
            notifyHost: () => {},
            requestInput: async () => "",
            printToHost: (message) => outputs.push(message),
            spawnTask: () => {},
            killTask: () => {},
            listTasks: () => [],
            callHost: async (method, args = []) => {
                hostCalls.push({ method, args });
                return { ok: true };
            },
        };

        const client = createOneBotClientProxy(env, new Map(), false) as {
            useFiles(): Promise<string>;
            callApi(action: string, params?: Record<string, unknown>): Promise<unknown>;
        };

        const guide = await client.useFiles();
        const result = await client.callApi("/get_group_file_url", { group_id: 1, file_id: "f" });

        assert.ok(guide.includes("OneBotGuide: useFiles"));
        assert.ok(outputs.some(line => line.includes("get_group_file_url")));
        assert.deepEqual(result, { ok: true });
        assert.deepEqual(hostCalls, [{
            method: "onebot.callApi",
            args: ["get_group_file_url", { group_id: 1, file_id: "f" }],
        }]);
    });

    it("allows only curated NapCat actions through adapter passthrough", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { ok: true };
        };

        try {
            const result = await adapter.handleCall("onebot.callApi", [
                "get_group_info",
                { group_id: 931351956 },
            ]);

            assert.deepEqual(result, { ok: true });
            assert.deepEqual(calls, [{
                action: "get_group_info",
                params: { group_id: 931351956 },
            }]);

            await assert.rejects(
                () => adapter.handleCall("onebot.callApi", ["get_credentials", {}]),
                /not exposed through built-in guides/,
            );
            await assert.rejects(
                () => adapter.handleCall("onebot.callApi", ["send_packet", {}]),
                /not exposed through built-in guides/,
            );
            await assert.rejects(
                () => adapter.handleCall("onebot.callApi", ["set_group_leave", { group_id: 1 }]),
                /not exposed through built-in guides/,
            );
        } finally {
            nc.dispose();
        }
    });

    it("applies muted-chat guardrails to guide-only write actions", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method; should not be called
        adapter.callAction = async () => {
            throw new Error("callAction should be blocked before dispatch");
        };
        adapter.muteChat("onebot:group:42", 1);

        try {
            await assert.rejects(
                () => adapter.handleCall("onebot.callApi", [
                    "set_group_ban",
                    { group_id: 42, user_id: 7, duration: 60 },
                ]),
                /禁言中/,
            );
        } finally {
            nc.dispose();
        }
    });
});
