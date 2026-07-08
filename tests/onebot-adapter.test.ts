import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { NotificationCenter } from "../src/event/notification-center.js";
import type { NotificationEvent } from "../src/event/notification-center.js";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import type { OneBotConfig } from "../src/core/config.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `onebot-adapter-${randomUUID()}.jsonl`), false);
}

function makeConfig(overrides: Partial<OneBotConfig> = {}): OneBotConfig {
    return {
        wsUrl: "ws://127.0.0.1:6700/onebot",
        selfId: "123456789",
        ...overrides,
    };
}

function captureEvents(nc: NotificationCenter): NotificationEvent[] {
    const events: NotificationEvent[] = [];
    nc.onPush(event => events.push(event));
    return events;
}

async function waitForAsyncHandlers(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
}

describe("OneBotAdapter", () => {
    it("should normalize array at segments into readable mentions and direct attention", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for focused ingress test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            if (action === "get_group_member_info") {
                assert.deepEqual(params, { group_id: 42, user_id: 123456789, no_cache: false });
                return { user_id: 123456789, card: "BotName", nickname: "BotNick" };
            }
            if (action === "get_group_info") {
                return { group_id: 42, group_name: "Test QQ Group" };
            }
            throw new Error(`unexpected action: ${action}`);
        };

        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 777,
            message_id: 9001,
            time: 1770000000,
            sender: { user_id: 777, nickname: "Alice", card: "" },
            message: [
                { type: "text", data: { text: "hi " } },
                { type: "at", data: { qq: "123456789" } },
                { type: "text", data: { text: " ping" } },
            ],
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 1);
        assert.equal(events[0].type, "nc.message");
        assert.equal(events[0].scene, "onebot");
        assert.equal(events[0].chatId, "onebot:group:42");
        assert.equal(events[0].userId, "onebot:777");
        assert.equal(events[0].displayName, "Alice");
        assert.equal(events[0].text, "hi @BotName ping");
        assert.equal(events[0].mentionsAgent, true);
        assert.equal(events[0].chatTitle, "Test QQ Group");
        assert.deepEqual(events[0].mentions, [{
            userId: "onebot:123456789",
            rawUserId: "123456789",
            displayName: "BotName",
            isAll: false,
            isSelf: true,
        }]);
        assert.deepEqual(events[0].messageSegments, [
            { type: "text", data: { text: "hi " } },
            { type: "at", data: { qq: "123456789" } },
            { type: "text", data: { text: " ping" } },
        ]);
        assert.deepEqual(events[0].source, {
            scene: "onebot",
            platform: "onebot",
            chatId: "onebot:group:42",
            userId: "onebot:777",
            chatType: "group",
            messageId: "9001",
            replyToMessageId: undefined,
        });

        nc.dispose();
    });

    it("should parse CQ at-all strings and unescape text", async () => {
        const nc = makeNC();
        const events = captureEvents(nc);
        const adapter = new OneBotAdapter(makeConfig(), nc);

        // @ts-expect-error - override private method for focused ingress test
        adapter.callAction = async (action: string) => {
            if (action === "get_group_info") return { group_id: 42, group_name: "Test QQ Group" };
            throw new Error(`unexpected action: ${action}`);
        };

        // @ts-expect-error - invoke private websocket handler for ingress normalization
        adapter.handleWsMessage(JSON.stringify({
            post_type: "message",
            self_id: "123456789",
            message_type: "group",
            group_id: 42,
            user_id: 777,
            message_id: 9002,
            sender: { user_id: 777, nickname: "Alice" },
            raw_message: "look &#91;x&#93;[CQ:at,qq=all] done",
        }));
        await waitForAsyncHandlers();

        assert.equal(events.length, 1);
        assert.equal(events[0].text, "look [x]@全体成员 done");
        assert.equal(events[0].mentionsAgent, true);
        assert.deepEqual(events[0].mentions, [{
            userId: "onebot:all",
            rawUserId: "all",
            displayName: "全体成员",
            isAll: true,
            isSelf: false,
        }]);

        nc.dispose();
    });

    it("should send at messages as OneBot segment arrays", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 3 };
        };

        await adapter.handleCall("onebot.sendAt", [
            "onebot:group:42",
            "onebot:private:778899,223344",
            "看一下",
            { replyTo: 9001 },
        ]);

        assert.deepEqual(calls, [{
            action: "send_group_msg",
            params: {
                group_id: 42,
                message: [
                    { type: "reply", data: { id: "9001" } },
                    { type: "at", data: { qq: "778899" } },
                    { type: "text", data: { text: " " } },
                    { type: "at", data: { qq: "223344" } },
                    { type: "text", data: { text: " 看一下" } },
                ],
            },
        }]);

        nc.dispose();
    });

    it("should send structured OneBot messages and normalize mention targets", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 4 };
        };

        await adapter.handleCall("onebot.sendMessage", [
            "onebot:group:42",
            [
                { type: "text", data: { text: "cc " } },
                { type: "at", data: { qq: "onebot:778899" } },
                { type: "text", data: { text: " 已处理" } },
            ],
        ]);

        assert.deepEqual(calls, [{
            action: "send_group_msg",
            params: {
                group_id: 42,
                message: [
                    { type: "text", data: { text: "cc " } },
                    { type: "at", data: { qq: "778899" } },
                    { type: "text", data: { text: " 已处理" } },
                ],
            },
        }]);

        nc.dispose();
    });

    it("should resolve numeric download refs through get_msg image URLs", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const originalFetch = globalThis.fetch;

        // @ts-expect-error - fake connected websocket for handleCall guard
        adapter.ws = { readyState: 1 };
        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            if (action === "get_msg") {
                return {
                    message_id: 794582600,
                    message: [
                        {
                            type: "image",
                            data: {
                                file: "cached-image.jpg",
                                file_unique: "unique-image",
                                url: "https://cdn.example.test/image.png",
                            },
                        },
                    ],
                };
            }
            throw new Error(`unexpected action: ${action}`);
        };
        globalThis.fetch = async (url) => {
            assert.equal(String(url), "https://cdn.example.test/image.png");
            return new Response(bytes, { status: 200 });
        };

        try {
            const result = await adapter.handleCall("onebot.downloadMedia", ["794582600"]) as { buffer: string; size: number };
            assert.deepEqual(calls, [{ action: "get_msg", params: { message_id: 794582600 } }]);
            assert.equal(result.buffer, bytes.toString("base64"));
            assert.equal(result.size, bytes.length);
        } finally {
            globalThis.fetch = originalFetch;
            nc.dispose();
        }
    });

    it("should use get_image base64 instead of remote local paths", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const bytes = Buffer.from("image-bytes");

        // @ts-expect-error - override private method for focused download test
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            assert.equal(action, "get_image");
            assert.deepEqual(params, { file: "cached-image.jpg" });
            return {
                file: "/remote/napcat/cache/cached-image.jpg",
                base64: bytes.toString("base64"),
            };
        };

        try {
            // @ts-expect-error - invoke private-ish adapter API directly for focused transport test
            const result = await adapter.downloadMedia(null, "cached-image.jpg");
            assert.deepEqual(result, bytes);
        } finally {
            nc.dispose();
        }
    });

    it("should drop replyTo for group voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 1 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:group:979200391",
            { type: "audio", file: "media/mimo_tts_1777522996493.ogg" },
            { replyTo: 1805758077 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_group_msg");
        assert.equal(calls[0].params.group_id, 979200391);
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/mimo_tts_1777522996493.ogg")}` } },
        ]);

        nc.dispose();
    });

    it("should drop replyTo for private voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 2 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:private:12345678",
            { type: "audio", file: "media/private_voice.ogg" },
            { replyTo: 99887766 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_private_msg");
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/private_voice.ogg")}` } },
        ]);

        nc.dispose();
    });

    it("should preserve fileName as OneBot file segment name", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 3 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:group:979200391",
            { type: "document", file: "media/report.pdf", fileName: "report.pdf" },
            {},
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_group_msg");
        assert.equal(calls[0].params.group_id, 979200391);
        assert.deepEqual(calls[0].params.message, [
            { type: "file", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/report.pdf")}`, name: "report.pdf" } },
        ]);

        nc.dispose();
    });

    it("should fall back to file basename when fileName is omitted", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 4 };
        };

        // Mirrors how the agent actually sends files: sendMedia with a bare
        // { type: "file", file } and no fileName. Without the basename fallback,
        // NapCat drops the name and shows a UUID.
        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:private:1751431516",
            { type: "file", file: "media/Hello World.txt" },
            {},
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_private_msg");
        assert.deepEqual(calls[0].params.message, [
            { type: "file", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/Hello World.txt")}`, name: "Hello World.txt" } },
        ]);

        nc.dispose();
    });
});
