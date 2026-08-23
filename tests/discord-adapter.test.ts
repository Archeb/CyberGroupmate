import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NotificationCenter } from "../src/event/notification-center.js";
import { DiscordAdapter } from "../src/adapter/discord-adapter.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `discord-adapter-${randomUUID()}.jsonl`), false);
}

function makeImageFile(): { dir: string; path: string; bytes: Buffer } {
    const dir = mkdtempSync(join(tmpdir(), "discord-adapter-media-"));
    const path = join(dir, "image.jpg");
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);
    writeFileSync(path, bytes);
    return { dir, path, bytes };
}

function makeIncomingMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: "message-1",
        content: "hello",
        createdAt: new Date("2026-05-20T00:00:00.000Z"),
        system: false,
        author: {
            id: "sender-1",
            username: "sender",
            displayName: "Sender",
        },
        member: {
            displayName: "Sender",
        },
        channel: {
            id: "channel-1",
            name: "general",
            isDMBased: () => false,
        },
        guild: {
            id: "guild-1",
            name: "Guild",
        },
        mentions: {
            has: () => false,
            members: { get: () => undefined },
            users: { get: () => undefined },
        },
        attachments: { size: 0 },
        embeds: [],
        ...overrides,
    };
}

class FakeDiscordClient extends EventEmitter {
    loginCalls = 0;
    destroyCalls = 0;
    readonly user: { id: string; username: string };
    readonly guilds = { cache: { size: 0 } };

    constructor(id: string) {
        super();
        this.user = { id, username: id };
    }

    async login(_token: string): Promise<string> {
        this.loginCalls++;
        queueMicrotask(() => this.emit("ready"));
        return "logged-in";
    }

    async destroy(): Promise<void> {
        this.destroyCalls++;
    }
}

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (assertion()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(assertion(), "timed out waiting for condition");
}

describe("DiscordAdapter", () => {
    it("should keep retrying initial login failures with a delay capped at one minute", async () => {
        const nc = makeNC();
        const clients: FakeDiscordClient[] = [];
        const adapter = new DiscordAdapter({ botToken: "token" }, nc, undefined, async () => {
            const client = new FakeDiscordClient(`bot-${clients.length + 1}`);
            if (clients.length === 0) {
                client.login = async () => {
                    client.loginCalls++;
                    throw new Error("gateway unavailable");
                };
            }
            clients.push(client);
            return client;
        });

        try {
            assert.equal((adapter as any).getReconnectDelayMs(1), 1_000);
            assert.equal((adapter as any).getReconnectDelayMs(7), 60_000);
            assert.equal((adapter as any).getReconnectDelayMs(20), 60_000);
            (adapter as any).getReconnectDelayMs = () => 1;

            await assert.rejects(adapter.start(), /gateway unavailable/);
            const status = adapter.getConnectionStatus();
            assert.equal(status.state, "disconnected");
            assert.equal(status.reconnectAttempts, 1);
            assert.ok(status.nextRetryAt);

            await waitFor(() => clients.length === 2 && clients[1].loginCalls === 1);
            assert.equal(adapter.getConnectionStatus().state, "connected");
        } finally {
            await adapter.stop();
            nc.dispose();
        }
    });

    it("should recreate the Discord client after session invalidation", async () => {
        const nc = makeNC();
        const clients: FakeDiscordClient[] = [];
        const adapter = new DiscordAdapter({ botToken: "token" }, nc, undefined, async () => {
            const client = new FakeDiscordClient(`bot-${clients.length + 1}`);
            clients.push(client);
            return client;
        });

        (adapter as any).getReconnectDelayMs = () => 1;

        try {
            await adapter.start();
            assert.equal(clients.length, 1);
            assert.equal(clients[0].loginCalls, 1);

            clients[0].emit("invalidated");

            await waitFor(() => clients.length === 2 && clients[1].loginCalls === 1);
            assert.equal(clients[0].destroyCalls, 1);
        } finally {
            await adapter.stop();
            nc.dispose();
        }
    });

    it("should arm forced recovery when a shard errors without reconnecting", async () => {
        const nc = makeNC();
        const clients: FakeDiscordClient[] = [];
        const adapter = new DiscordAdapter({ botToken: "token" }, nc, undefined, async () => {
            const client = new FakeDiscordClient(`bot-${clients.length + 1}`);
            clients.push(client);
            return client;
        });
        let watchdogClient: FakeDiscordClient | undefined;
        let watchdogShardId: number | undefined;
        (adapter as any).armGatewayRecoveryWatchdog = (client: FakeDiscordClient, shardId: number) => {
            watchdogClient = client;
            watchdogShardId = shardId;
        };

        try {
            await adapter.start();
            clients[0].emit("shardError", new Error("gateway socket failed"), 3);

            assert.equal(watchdogClient, clients[0]);
            assert.equal(watchdogShardId, 3);
            assert.equal(adapter.getConnectionStatus().lastError, "Error: gateway socket failed");
        } finally {
            await adapter.stop();
            nc.dispose();
        }
    });

    it("should append known display names to inbound Discord user mentions", () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc, {
            getPersonIdentity(userId: string) {
                assert.equal(userId, "discord:1485835320535810058");
                return { displayName: "Miu" } as any;
            },
        });

        try {
            const normalized = (adapter as any).normalizeIncomingMessage(makeIncomingMessage({
                content: "<@1485835320535810058> 试试去搜一下",
            }));

            assert.equal(normalized.text, "<@1485835320535810058>(Miu) 试试去搜一下");
        } finally {
            nc.dispose();
        }
    });

    it("should fall back to Discord mention metadata when memory has no display name", () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc, {
            getPersonIdentity() {
                return null;
            },
        });

        try {
            const normalized = (adapter as any).normalizeIncomingMessage(makeIncomingMessage({
                content: "ping <@123456789012345678>",
                mentions: {
                    has: () => false,
                    members: { get: () => ({ displayName: "Orion" }) },
                    users: { get: () => ({ username: "orion-zhen" }) },
                },
            }));

            assert.equal(normalized.text, "ping <@123456789012345678>(Orion)");
        } finally {
            nc.dispose();
        }
    });

    it("should strip mention display labels before sending text", async () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc);
        let sentOptions: Record<string, unknown> | undefined;

        (adapter as any).client = {
            channels: {
                async fetch(id: string) {
                    assert.equal(id, "channel-1");
                    return {
                        id: "channel-1",
                        isTextBased: () => true,
                        async send(opts: Record<string, unknown>) {
                            sentOptions = opts;
                            return {
                                id: "msg-text-1",
                                content: opts.content,
                                channel: { id: "channel-1" },
                                createdAt: new Date("2026-05-20T00:00:00.000Z"),
                            };
                        },
                    };
                },
            },
        };

        try {
            await adapter.handleCall("discord.sendText", [
                "discord:channel-1",
                "<@1485835320535810058>(Miu) 收到",
            ]);

            assert.equal(sentOptions?.content, "<@1485835320535810058> 收到");
        } finally {
            nc.dispose();
        }
    });

    it("should expose native discord send options", async () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc);
        let sentOptions: Record<string, unknown> | string | undefined;

        (adapter as any).client = {
            channels: {
                async fetch(id: string) {
                    assert.equal(id, "channel-1");
                    return {
                        id: "channel-1",
                        isTextBased: () => true,
                        async send(opts: Record<string, unknown> | string) {
                            sentOptions = opts;
                            return {
                                id: "msg-native-1",
                                content: typeof opts === "string" ? opts : opts.content,
                                channel: { id: "channel-1" },
                                createdAt: new Date("2026-05-20T00:00:00.000Z"),
                            };
                        },
                    };
                },
            },
        };

        try {
            await adapter.handleCall("discord.send", [
                "discord:channel-1",
                {
                    content: "<@1485835320535810058>(Miu) 收到",
                    embeds: [{ title: "ok" }],
                    reply: { messageReference: "msg-0" },
                },
            ]);

            assert.deepEqual(sentOptions, {
                content: "<@1485835320535810058> 收到",
                embeds: [{ title: "ok" }],
                reply: { messageReference: "msg-0" },
            });
        } finally {
            nc.dispose();
        }
    });

    it("should react to fetched Discord messages", async () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc);
        const fetchedMessageIds: string[] = [];
        const reactions: string[] = [];

        (adapter as any).client = {
            channels: {
                async fetch(id: string) {
                    assert.equal(id, "channel-1");
                    return {
                        id: "channel-1",
                        isTextBased: () => true,
                        messages: {
                            async fetch(messageId: string) {
                                fetchedMessageIds.push(messageId);
                                return {
                                    id: messageId,
                                    async react(emoji: string) {
                                        reactions.push(emoji);
                                    },
                                };
                            },
                        },
                    };
                },
            },
        };

        try {
            await adapter.handleCall("discord.sendReaction", [
                "discord:channel-1",
                "msg-42",
                "<:blobreach:123456789012345678>",
            ]);

            assert.deepEqual(fetchedMessageIds, ["msg-42"]);
            assert.deepEqual(reactions, ["<:blobreach:123456789012345678>"]);
        } finally {
            nc.dispose();
        }
    });

    it("should fall back from a user id to a DM channel and upload local files as buffers", async () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc);
        const image = makeImageFile();
        const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
        const channelFetches: string[] = [];
        const userFetches: string[] = [];
        const originalFetch = globalThis.fetch;

        const dmChannel = {
            id: "dm-channel-1",
            isTextBased: () => true,
        };

        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ input, init });
            return new Response(JSON.stringify({
                id: "msg-1",
                content: "hello image",
                channel_id: "dm-channel-1",
                timestamp: "2026-05-04T00:00:00.000Z",
            }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;

        (adapter as any).client = {
            channels: {
                async fetch(id: string) {
                    channelFetches.push(id);
                    throw new Error("Unknown Channel");
                },
            },
            users: {
                async fetch(id: string) {
                    userFetches.push(id);
                    return { createDM: async () => dmChannel };
                },
            },
        };

        try {
            const sent = await adapter.handleCall("discord.sendMedia", [
                "discord:517557024935116800",
                { file: image.path, caption: "hello image" },
            ]);

            assert.equal((sent as Record<string, unknown>).id, "msg-1");
            assert.deepEqual(channelFetches, ["517557024935116800"]);
            assert.deepEqual(userFetches, ["517557024935116800"]);
            assert.equal(fetchCalls.length, 1);
            assert.equal(String(fetchCalls[0].input), "https://discord.com/api/v10/channels/dm-channel-1/messages");
            assert.equal(fetchCalls[0].init?.method, "POST");
            assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Authorization, "Bot token");
            assert.ok(fetchCalls[0].init?.signal instanceof AbortSignal);

            const form = fetchCalls[0].init?.body as FormData;
            const payload = JSON.parse(String(form.get("payload_json")));
            assert.equal(payload.content, "hello image");
            assert.deepEqual(payload.attachments, [{ id: "0", filename: "image.jpg" }]);
            const uploadedFile = form.get("files[0]") as unknown as { name: string; arrayBuffer: () => Promise<ArrayBuffer> };
            assert.equal(uploadedFile.name, "image.jpg");
            assert.deepEqual(Buffer.from(await uploadedFile.arrayBuffer()), image.bytes);
        } finally {
            globalThis.fetch = originalFetch;
            rmSync(image.dir, { recursive: true, force: true });
            nc.dispose();
        }
    });

    it("should support string media paths and captions passed through opts", async () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc);
        const image = makeImageFile();
        const fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
        const originalFetch = globalThis.fetch;

        const channel = {
            id: "channel-1",
            isTextBased: () => true,
        };

        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({ input, init });
            return new Response(JSON.stringify({
                id: "msg-2",
                content: "<@123456789012345678> caption from opts",
                channel_id: "channel-1",
                timestamp: "2026-05-04T00:00:00.000Z",
            }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch;

        (adapter as any).client = {
            channels: {
                async fetch(id: string) {
                    assert.equal(id, "channel-1");
                    return channel;
                },
            },
            users: { async fetch() { throw new Error("should not fetch user"); } },
        };

        try {
            await adapter.handleCall("discord.sendMedia", [
                "discord:channel-1",
                image.path,
                { caption: "<@123456789012345678>(Alice) caption from opts" },
            ]);

            assert.equal(fetchCalls.length, 1);
            assert.equal(String(fetchCalls[0].input), "https://discord.com/api/v10/channels/channel-1/messages");
            const form = fetchCalls[0].init?.body as FormData;
            const payload = JSON.parse(String(form.get("payload_json")));
            assert.equal(payload.content, "<@123456789012345678> caption from opts");
            assert.deepEqual(payload.attachments, [{ id: "0", filename: "image.jpg" }]);
            const uploadedFile = form.get("files[0]") as unknown as { name: string; arrayBuffer: () => Promise<ArrayBuffer> };
            assert.equal(uploadedFile.name, "image.jpg");
            assert.deepEqual(Buffer.from(await uploadedFile.arrayBuffer()), image.bytes);
        } finally {
            globalThis.fetch = originalFetch;
            rmSync(image.dir, { recursive: true, force: true });
            nc.dispose();
        }
    });

    it("should not treat guild channel ids as user ids when channel fetch fails", async () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc);
        let userFetchCount = 0;

        (adapter as any).client = {
            channels: {
                async fetch() {
                    throw new Error("Unknown Channel");
                },
            },
            users: {
                async fetch() {
                    userFetchCount++;
                    throw new Error("should not fetch user");
                },
            },
        };

        await assert.rejects(
            () => adapter.handleCall("discord.sendText", ["discord:guild-1:channel-1", "hi"]),
            /sendText: channel channel-1 is not available/,
        );
        assert.equal(userFetchCount, 0);
        nc.dispose();
    });
});
