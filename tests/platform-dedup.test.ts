import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityRegistryEnv } from "../src/sandbox/capability-registry.js";
import { createDiscordClientProxy } from "../src/sandbox/modules/discord/index.js";
import { createOneBotClientProxy } from "../src/sandbox/modules/onebot/index.js";
import { createTelegramClientProxy } from "../src/sandbox/modules/telegram/index.js";

type SendTextClient = {
    sendText(chatId: string, text: string): Promise<unknown>;
};

type PlatformCase = {
    name: string;
    chatId: string;
    sendMethod: string;
    createProxy: (
        env: CapabilityRegistryEnv,
        history: Map<string, Set<string>>,
        deduplicateSentMessages?: boolean,
    ) => unknown;
    successPayload: (args: unknown[]) => unknown;
};

const cases: PlatformCase[] = [
    {
        name: "telegram",
        chatId: "100",
        sendMethod: "telegram.sendText",
        createProxy: createTelegramClientProxy,
        successPayload: (args) => ({
            id: "tg_msg_1",
            chat: { id: String(args[0]), type: "private" },
            text: String(args[1]),
            date: "2026-05-09T00:00:00.000Z",
        }),
    },
    {
        name: "onebot",
        chatId: "onebot:100",
        sendMethod: "onebot.sendText",
        createProxy: createOneBotClientProxy,
        successPayload: () => ({ message_id: "qq_msg_1" }),
    },
    {
        name: "discord",
        chatId: "channel-100",
        sendMethod: "discord.sendText",
        createProxy: createDiscordClientProxy,
        successPayload: (args) => ({
            id: "discord_msg_1",
            channelId: String(args[0]),
            text: String(args[1]),
        }),
    },
];

describe("platform proxy duplicate tracking", () => {
    for (const platform of cases) {
        it(`records ${platform.name} text only after host send succeeds`, async () => {
            const outputs: string[] = [];
            const notifications: Array<Record<string, unknown>> = [];
            const sentHistory = new Map<string, Set<string>>();
            let attempts = 0;

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
                    assert.equal(method, platform.sendMethod);
                    attempts++;
                    if (attempts === 1) {
                        throw new Error("platform blocked");
                    }
                    return platform.successPayload(args);
                },
            };

            const client = platform.createProxy(env, sentHistory) as SendTextClient;

            await assert.rejects(
                () => client.sendText(platform.chatId, "hello"),
                /platform blocked/,
            );
            assert.equal(sentHistory.get(platform.chatId)?.has("hello") ?? false, false);

            const sent = await client.sendText(platform.chatId, "hello");
            assert.ok(sent);
            assert.equal(attempts, 2);
            assert.equal(sentHistory.get(platform.chatId)?.has("hello") ?? false, true);

            const duplicateResult = await client.sendText(platform.chatId, "hello");
            assert.equal(duplicateResult, null);
            assert.equal(attempts, 2);
            assert.ok(outputs.some((line) => line.includes("重复消息已拦截")));
            assert.ok(notifications.some((event) => event.type === "system.duplicate_message_blocked"));
        });

        it(`does not block ${platform.name} duplicates when disabled`, async () => {
            const outputs: string[] = [];
            const notifications: Array<Record<string, unknown>> = [];
            const sentHistory = new Map<string, Set<string>>();
            let attempts = 0;

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
                    assert.equal(method, platform.sendMethod);
                    attempts++;
                    return platform.successPayload(args);
                },
            };

            const client = platform.createProxy(env, sentHistory, false) as SendTextClient;

            await client.sendText(platform.chatId, "hello");
            await client.sendText(platform.chatId, "hello");

            assert.equal(attempts, 2);
            assert.equal(sentHistory.get(platform.chatId)?.has("hello") ?? false, false);
            assert.equal(outputs.some((line) => line.includes("重复消息已拦截")), false);
            assert.equal(notifications.some((event) => event.type === "system.duplicate_message_blocked"), false);
        });
    }
});
