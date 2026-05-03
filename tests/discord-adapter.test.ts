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
        const sendCalls: Array<Record<string, any>> = [];
        const channelFetches: string[] = [];
        const userFetches: string[] = [];

        const dmChannel = {
            id: "dm-channel-1",
            isTextBased: () => true,
            async send(opts: Record<string, any>) {
                sendCalls.push(opts);
                return {
                    id: "msg-1",
                    content: opts.content ?? "",
                    channel: { id: "dm-channel-1" },
                    createdAt: new Date("2026-05-04T00:00:00.000Z"),
                };
            },
        };

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
            assert.equal(sendCalls.length, 1);
            assert.equal(sendCalls[0].content, "hello image");
            assert.equal(sendCalls[0].files.length, 1);
            assert.ok(Buffer.isBuffer(sendCalls[0].files[0].attachment));
            assert.deepEqual(sendCalls[0].files[0].attachment, image.bytes);
            assert.equal(sendCalls[0].files[0].name, "image.jpg");
        } finally {
            rmSync(image.dir, { recursive: true, force: true });
            nc.dispose();
        }
    });

    it("should support string media paths and captions passed through opts", async () => {
        const nc = makeNC();
        const adapter = new DiscordAdapter({ botToken: "token" }, nc);
        const image = makeImageFile();
        const sendCalls: Array<Record<string, any>> = [];

        const channel = {
            id: "channel-1",
            isTextBased: () => true,
            async send(opts: Record<string, any>) {
                sendCalls.push(opts);
                return {
                    id: "msg-2",
                    content: opts.content ?? "",
                    channel: { id: "channel-1" },
                    createdAt: new Date("2026-05-04T00:00:00.000Z"),
                };
            },
        };

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

            assert.equal(sendCalls.length, 1);
            assert.equal(sendCalls[0].content, "caption from opts");
            assert.deepEqual(sendCalls[0].files[0].attachment, image.bytes);
            assert.equal(sendCalls[0].files[0].name, "image.jpg");
        } finally {
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
