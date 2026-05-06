import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

describe("DiscordAdapter", () => {
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
                content: "caption from opts",
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
                { caption: "caption from opts" },
            ]);

            assert.equal(fetchCalls.length, 1);
            assert.equal(String(fetchCalls[0].input), "https://discord.com/api/v10/channels/channel-1/messages");
            const form = fetchCalls[0].init?.body as FormData;
            const payload = JSON.parse(String(form.get("payload_json")));
            assert.equal(payload.content, "caption from opts");
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
