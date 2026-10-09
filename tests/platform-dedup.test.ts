import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { CapabilityRegistryEnv } from "../src/sandbox/capability-registry.js";
import { createDiscordClientProxy } from "../src/sandbox/modules/discord/index.js";
import { createOneBotClientProxy } from "../src/sandbox/modules/onebot/index.js";
import { createTelegramClientProxy } from "../src/sandbox/modules/telegram/index.js";

type SendTextClient = {
    sendText(chatId: string, text: string): Promise<unknown>;
};

type DiscordReactionClient = {
    sendReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
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

    it("forwards discord reactions without touching dedup history", async () => {
        const outputs: string[] = [];
        const notifications: Array<Record<string, unknown>> = [];
        const sentHistory = new Map<string, Set<string>>();
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
                return null;
            },
        };

        const client = createDiscordClientProxy(env, sentHistory) as DiscordReactionClient;
        await client.sendReaction("channel-100", "msg-42", "😄");

        assert.deepEqual(hostCalls, [{
            method: "discord.sendReaction",
            args: ["channel-100", "msg-42", "😄"],
        }]);
        assert.ok(outputs.some((line) => line.includes("[Discord] sendReaction ok channel=channel-100 msg=msg-42 emoji=😄")));
        // 表态不进 dedup history（它不是一条消息）……
        assert.deepEqual([...sentHistory.entries()], []);
        // ……但会发一条 agent_reaction_sent 事件，供 SentMessageCollector 把"贴了表态"与"沉默跳过"区分开
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].type, "system.agent_reaction_sent");
        assert.equal(notifications[0].scene, "discord");
        assert.equal(notifications[0].chatId, "channel-100");
        assert.equal(notifications[0].messageId, "msg-42");
        assert.equal(notifications[0].emoji, "😄");
    });

    it("telegram reaction emits an action event, but removing one (emoji=null) does not", async () => {
        const notifications: Array<Record<string, unknown>> = [];
        const env: CapabilityRegistryEnv = {
            ctx: {},
            emitOutput: () => {},
            notifyHost: (event) => notifications.push(event),
            requestInput: async () => "",
            printToHost: () => {},
            spawnTask: () => {},
            killTask: () => {},
            listTasks: () => [],
            callHost: async () => null,
        };
        const client = createTelegramClientProxy(env, new Map<string, Set<string>>()) as {
            sendReaction(chatId: string, messageId: number, emoji: string | null): Promise<void>;
        };

        await client.sendReaction("100", 42, "👍");
        assert.equal(notifications.length, 1);
        assert.equal(notifications[0].type, "system.agent_reaction_sent");
        assert.equal(notifications[0].emoji, "👍");

        await client.sendReaction("100", 42, null); // 撤销表态，不算一次对外动作
        assert.equal(notifications.length, 1);
    });
});
