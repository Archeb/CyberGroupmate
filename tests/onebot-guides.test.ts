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
    it("keeps native APIs visible and exposes guide activators for NapCat domains", () => {
        refreshModuleRegistryCache();
        const brief = loadApiTypeDefs("onebot");

        assert.ok(brief.includes("callApi"));
        assert.ok(brief.includes("send_group_msg"));
        assert.ok(brief.includes("send_private_msg"));
        assert.ok(brief.includes("sendText"));
        assert.ok(brief.includes("sendMedia"));
        assert.ok(brief.includes("downloadMedia"));
        assert.ok(brief.includes("getMessage"));
        assert.ok(brief.includes("useMessages"));
        assert.ok(brief.includes("useGroupAdministration"));
        assert.ok(brief.includes("useFiles"));
        assert.ok(brief.includes("useUsersAndProfile"));
        assert.ok(brief.includes("useSystemUtilities"));

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

    it("prints guide content and supports native callApi proxy calls", async () => {
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
            send_group_msg(params: Record<string, unknown>): Promise<unknown>;
        };

        const guide = await client.useFiles();
        const result = await client.callApi("/get_group_file_url", { group_id: 1, file_id: "f" });
        const sent = await client.send_group_msg({ group_id: 1, message: "hello native" });

        assert.ok(guide.includes("OneBotGuide: useFiles"));
        assert.ok(outputs.some(line => line.includes("get_group_file_url")));
        assert.deepEqual(result, { ok: true });
        assert.deepEqual(sent, { ok: true });
        assert.deepEqual(hostCalls, [
            {
                method: "onebot.callApi",
                args: ["get_group_file_url", { group_id: 1, file_id: "f" }],
            },
            {
                method: "onebot.send_group_msg",
                args: [{ group_id: 1, message: "hello native" }],
            },
        ]);
    });

    it("supports OneBot message segments and @ helpers in the sandbox proxy", async () => {
        const outputs: string[] = [];
        const notifications: Array<Record<string, unknown>> = [];
        const hostCalls: Array<{ method: string; args: unknown[] }> = [];
        const env: CapabilityRegistryEnv = {
            ctx: {},
            emitOutput: (line) => outputs.push(line),
            notifyHost: (event) => notifications.push(event),
            requestInput: async () => "",
            printToHost: (message) => outputs.push(message),
            spawnTask: () => {},
            killTask: () => {},
            listTasks: () => [],
            callHost: async (method, args = []) => {
                hostCalls.push({ method, args });
                return { message_id: 100 };
            },
        };

        const client = createOneBotClientProxy(env, new Map(), false) as {
            mention(userId: string | number): { type: string; data?: Record<string, unknown> };
            sendMessage(chatId: string, message: unknown, opts?: Record<string, unknown>): Promise<unknown>;
            sendAt(chatId: string, userId: string | number | Array<string | number>, text?: string, opts?: Record<string, unknown>): Promise<unknown>;
        };

        const mention = client.mention("onebot:private:778899");
        assert.deepEqual(mention, { type: "at", data: { qq: "778899" } });

        await client.sendMessage("onebot:group:42", [
            mention,
            { type: "text", data: { text: " hello" } },
        ], { replyTo: 9 });
        await client.sendAt("onebot:group:42", "onebot:778899,223344", "看下", { replyTo: 10 });

        assert.deepEqual(hostCalls, [
            {
                method: "onebot.sendMessage",
                args: [
                    "onebot:group:42",
                    [
                        { type: "at", data: { qq: "778899" } },
                        { type: "text", data: { text: " hello" } },
                    ],
                    { replyTo: 9 },
                ],
            },
            {
                method: "onebot.sendAt",
                args: ["onebot:group:42", ["778899", "223344"], "看下", { replyTo: 10 }],
            },
        ]);
        assert.ok(outputs.some(line => line.includes("[QQ] sendMessage ok")));
        assert.ok(outputs.some(line => line.includes("[QQ] sendAt ok")));
        assert.ok(notifications.some(event => event.type === "system.agent_message_sent" && event.text === "@778899 hello"));
        assert.ok(notifications.some(event => event.type === "system.agent_message_sent" && event.text === "@778899 @223344 看下"));
    });

    it("blocks excluded NapCat actions through adapter passthrough", async () => {
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

            await adapter.handleCall("onebot.send_group_msg", [{
                group_id: 931351956,
                message: "native send",
            }]);
            assert.deepEqual(calls[1], {
                action: "send_group_msg",
                params: { group_id: 931351956, message: "native send" },
            });

            // 戳一戳：群戳 + 好友戳都走 allowlist passthrough
            await adapter.handleCall("onebot.callApi", [
                "group_poke",
                { group_id: 931351956, user_id: 777 },
            ]);
            assert.deepEqual(calls[2], {
                action: "group_poke",
                params: { group_id: 931351956, user_id: 777 },
            });
            await adapter.handleCall("onebot.callApi", [
                "friend_poke",
                { user_id: 777 },
            ]);
            assert.deepEqual(calls[3], {
                action: "friend_poke",
                params: { user_id: 777 },
            });

            await assert.rejects(
                () => adapter.handleCall("onebot.callApi", ["get_credentials", {}]),
                /blocked by sandbox policy/,
            );
            await assert.rejects(
                () => adapter.handleCall("onebot.callApi", ["send_packet", {}]),
                /blocked by sandbox policy/,
            );
            await assert.rejects(
                () => adapter.handleCall("onebot.callApi", ["set_group_leave", { group_id: 1 }]),
                /blocked by sandbox policy/,
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
