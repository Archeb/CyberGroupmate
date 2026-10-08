import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { NotificationCenter, type NotificationInput } from "../src/event/notification-center.js";
import { Client, defaultHttpInstance, withTenantToken } from "@larksuiteoapi/node-sdk";
import { createFeishuHttpInstance, FeishuAdapter, type FeishuAdapterDependencies, type FeishuApi, type FeishuConnection, type FeishuConnectionCallbacks, type FeishuEventHandlers } from "../src/adapter/feishu-adapter.js";

const config = { appId: "cli_0123456789abcdef", appSecret: "secret-never-in-errors" };
const time = "1767225600123";

function incoming(overrides: Record<string, unknown> = {}, senderId = "ou_user") {
    return {
        sender: { sender_id: { open_id: senderId }, sender_type: "user" },
        message: { message_id: "om_one", chat_id: "oc_chat", chat_type: "group", message_type: "text", content: JSON.stringify({ text: "ordinary conversation" }), create_time: time, ...overrides },
    };
}

class FakeConnection implements FeishuConnection {
    state: "idle" | "connected" | "connecting" | "reconnecting" | "failed" = "idle";
    closed = 0;
    started = 0;
    constructor(readonly callbacks: FeishuConnectionCallbacks, readonly receive: (event: unknown) => Promise<void>, readonly handlers: FeishuEventHandlers, private autoReady: boolean) {}
    async start() { this.started++; this.state = "connecting"; if (this.autoReady) this.ready(); }
    ready() { this.state = "connected"; this.callbacks.onReady(); }
    close() { this.closed++; this.state = "idle"; }
    getConnectionStatus() { return { state: this.state, reconnectAttempts: this.state === "reconnecting" ? 2 : 0 }; }
}

function fixture(options: FeishuAdapterDependencies & { autoReady?: boolean; workspace?: string } = {}) {
    const nc = new NotificationCenter();
    const events: NotificationInput[] = [];
    nc.onPush(event => events.push(event));
    const connections: FakeConnection[] = [];
    const calls: Array<{ method: string; payload: any }> = [];
    const messages = new Map<string, any>();
    messages.set("om_parent", { message_id: "om_parent", chat_id: "oc_chat", msg_type: "text", body: { content: '{"text":"parent"}' }, sender: { id: "ou_user", id_type: "open_id" }, create_time: time });
    const client: FeishuApi = {
        request: async <T>() => ({ code: 0, bot: { open_id: "ou_bot", app_name: "Bot" } }) as T,
        im: { v1: {
            message: {
                create: async payload => {
                    calls.push({ method: "create", payload });
                    return { code: 0, data: { message_id: "om_sent", chat_id: payload!.data.receive_id } };
                },
                reply: async payload => {
                    calls.push({ method: "reply", payload });
                    return { code: 0, data: { message_id: "om_reply", chat_id: "oc_chat", parent_id: payload!.path.message_id, root_id: "om_root", thread_id: "omt_thread" } };
                },
                get: async payload => {
                    calls.push({ method: "get", payload });
                    const target = messages.get(payload!.path.message_id);
                    const descendants: any[] = [];
                    const parentIds = new Set([payload!.path.message_id]);
                    while (parentIds.size > 0) {
                        const nextParentIds = new Set<string>();
                        for (const message of messages.values()) {
                            if (!parentIds.has(message.upper_message_id) || descendants.includes(message)) continue;
                            descendants.push(message);
                            if (message.message_id) nextParentIds.add(message.message_id);
                        }
                        parentIds.clear();
                        for (const parentId of nextParentIds) parentIds.add(parentId);
                    }
                    return { code: 0, data: { items: [target, ...descendants].filter(Boolean) } };
                },
                list: async payload => {
                    calls.push({ method: "list", payload });
                    return { code: 0, data: { items: [...messages.values()], has_more: false } };
                },
                createByCard: async payload => {
                    calls.push({ method: "createByCard", payload });
                    return { code: 0, data: { message_id: "om_card", chat_id: payload!.data.receive_id } };
                },
                replyByCard: async payload => {
                    calls.push({ method: "replyByCard", payload });
                    return { code: 0, data: { message_id: "om_card_reply", chat_id: "oc_chat", parent_id: payload!.path.message_id } };
                },
                updateByCard: async payload => { calls.push({ method: "updateByCard", payload }); return { code: 0, data: {} }; },
            },
            chat: { get: async () => ({ code: 0, data: { name: "Group", chat_mode: "group", chat_type: "private" } }) },
            image: { create: async payload => { calls.push({ method: "image", payload }); return { image_key: "img_uploaded" }; } },
            file: { create: async payload => { calls.push({ method: "file", payload }); return { file_key: "file_uploaded" }; } },
            messageResource: { get: async payload => {
                calls.push({ method: "resource", payload });
                return { getReadableStream: () => Readable.from([Buffer.from("media")]), headers: {}, writeFile: async () => {} };
            } },
        } },
        contact: { v3: { user: { get: async payload => ({ code: 0, data: { user: { name: payload!.path.user_id === "ou_user" ? "Alice" : "Reactor" } } }) } } },
        cardkit: { v1: {
            card: {
                create: async payload => { calls.push({ method: "cardCreate", payload }); return { code: 0, data: { card_id: "card_1" } }; },
                idConvert: async payload => { calls.push({ method: "cardConvert", payload }); return { code: 0, data: { card_id: "card_1" } }; },
                update: async payload => { calls.push({ method: "cardUpdate", payload }); return { code: 0, data: {} }; },
                batchUpdate: async payload => { calls.push({ method: "cardPatch", payload }); return { code: 0, data: {} }; },
            },
            cardElement: { content: async payload => { calls.push({ method: "cardStream", payload }); return { code: 0, data: {} }; } },
        } },
    };
    const adapter = new FeishuAdapter(config, nc, options.workspace ?? process.cwd(), {
        readinessTimeoutMs: 100,
        requestTimeoutMs: 100,
        ...options,
        createClient: options.createClient ?? (() => client),
        createConnection: options.createConnection ?? ((callbacks, receive, handlers) => {
            const connection = new FakeConnection(callbacks, receive, handlers, options.autoReady !== false);
            connections.push(connection);
            return connection;
        }),
    });
    return { adapter, client, connections, calls, events, messages };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.ok(predicate(), "condition did not become true");
}

describe("Feishu SDK HTTP boundary", () => {
    it("preserves SDK response interception, upload unwrapping and stream headers without network", async () => {
        const previous = defaultHttpInstance.defaults.adapter;
        const calls: Array<{ timeout?: number; maxRedirects?: number; maxContentLength?: number }> = [];
        const stream = Readable.from([Buffer.from("resource")]);
        let businessFailure = false;
        defaultHttpInstance.defaults.adapter = async request => {
            calls.push(request);
            const data = request.url?.includes("/auth/") ? { code: 0, tenant_access_token: "fixture-token", expire: 7200 } : request.responseType === "stream" ? stream : businessFailure
                ? { code: 1234, msg: config.appSecret, data: { image_key: "must_not_succeed" } }
                : { code: 0, data: { image_key: "img_real_shape", file_key: "file_real_shape" } };
            return { data, status: 200, statusText: "OK", headers: { "content-type": "application/octet-stream" }, config: request };
        };
        try {
            const httpInstance = createFeishuHttpInstance(defaultHttpInstance);
            const client = new Client({ ...config, httpInstance, logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} } });
            const auth = withTenantToken("fixture-token");
            assert.deepEqual(await client.im.v1.image.create({ data: { image_type: "message", image: Buffer.from("image") } }, auth), { image_key: "img_real_shape", file_key: "file_real_shape" });
            assert.deepEqual(await client.im.v1.file.create({ data: { file_type: "stream", file_name: "file.txt", file: Buffer.from("file") } }, auth), { image_key: "img_real_shape", file_key: "file_real_shape" });
            const resource = await client.im.v1.messageResource.get({ path: { message_id: "om_one", file_key: "file_key" }, params: { type: "file" } }, auth);
            assert.equal(resource.getReadableStream(), stream);
            assert.equal(resource.headers["content-type"], "application/octet-stream");
            businessFailure = true;
            await assert.rejects(client.im.v1.image.create({ data: { image_type: "message", image: Buffer.from("image") } }, auth), /Feishu API business failure \(1234\)/);
            assert.ok(calls.every(call => call.timeout === 15_000 && call.maxRedirects === 0 && call.maxContentLength === 100 * 1024 * 1024));
        } finally {
            defaultHttpInstance.defaults.adapter = previous;
            stream.destroy();
        }
    });
});

describe("Feishu adapter ingress edges", () => {
    it("deduplicates concurrent delivery before persisted lookup and NC side effects", async () => {
        let lookups = 0;
        let release!: (value: boolean) => void;
        const f = fixture({ hasMessage: async (chatId, messageId) => {
            lookups++;
            assert.equal(chatId, "feishu:oc_chat");
            assert.equal(messageId, "om_one");
            return new Promise(resolve => { release = resolve; });
        } });
        await f.adapter.start();
        try {
            const first = f.connections[0].receive(incoming());
            await f.connections[0].receive(incoming());
            assert.equal(lookups, 1);
            assert.equal(f.events.length, 0);
            release(false);
            await first;
            await f.connections[0].receive(incoming());
            assert.equal(f.events.length, 1);
            assert.equal(lookups, 1);
            const event = f.events[0];
            assert.equal(event.type, "nc.message");
            assert.equal(event.chatId, "feishu:oc_chat");
            assert.equal(event.userId, "feishu:ou_user");
            assert.equal(event.displayName, "Alice");
            assert.equal(event.messageId, "om_one");
            assert.equal(event.chatTitle, "Group");
            assert.equal(event.timestamp, "2026-01-01T00:00:00.123Z");
            assert.equal(event.text, "ordinary conversation");
            assert.equal(event._urgent, false);
            assert.equal((event.payload as any).text, event.text);
            assert.equal((event.source as any).platform, "feishu");
        } finally { await f.adapter.stop(); }
    });

    it("suppresses persisted IDs, ignores self, and bounds in-process dedup", async () => {
        const f = fixture({ dedupLimit: 2, hasMessage: (_, id) => id === "om_saved" });
        await f.adapter.start();
        try {
            const receive = f.connections[0].receive;
            await receive(incoming({ message_id: "om_saved" }));
            await receive(incoming({}, "ou_bot"));
            assert.equal(f.events.length, 0);
            for (const message_id of ["om_one", "om_two", "om_three", "om_one"]) await receive(incoming({ message_id }));
            assert.equal(f.events.length, 4);
        } finally { await f.adapter.stop(); }
    });

    it("marks only DM and actual bot mentions urgent, not ordinary replies", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            const receive = f.connections[0].receive;
            await receive(incoming({ parent_id: "om_parent", root_id: "om_root", thread_id: "omt_thread" }));
            assert.equal(f.events[0]._urgent, false);
            assert.equal(f.events[0].replyToMessageId, "om_parent");
            assert.equal((f.events[0].source as any).threadId, "omt_thread");
            await receive(incoming({ message_id: "om_dm", chat_type: "p2p" }));
            assert.equal(f.events[1]._urgent, true);
            await receive(incoming({ message_id: "om_at", content: '{"text":"@_user_1 hello @_user_10"}', mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Bot" }, { key: "@_user_10", id: { open_id: "ou_other" }, name: "Other" }] }));
            assert.equal(f.events[2].text, "@Bot hello @Other");
            assert.equal(f.events[2].mentionsAgent, true);
            assert.equal(f.events[2]._urgent, true);
        } finally { await f.adapter.stop(); }
    });

    it("wakes on @all, renders the everyone placeholder, and still ignores non-bot @mentions", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            const receive = f.connections[0].receive;
            await receive(incoming({ message_id: "om_all", content: '{"text":"@_all 紧急情况"}', mentions: [{ key: "@_all", id: { open_id: "all" }, name: "所有人" }] }));
            const all = f.events[0];
            assert.equal(all.text, "@所有人 紧急情况");
            assert.ok(!all.text.includes("@_all"));
            assert.equal(all.mentions[0].isAll, true);
            assert.equal(all.mentionsAgent, true);
            assert.equal(all._urgent, true);
            await receive(incoming({ message_id: "om_user", content: '{"text":"hi @_user_1"}', mentions: [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "Other" }] }));
            const other = f.events[1];
            assert.equal(other.text, "hi @Other");
            assert.equal(other.mentionsAgent, false);
            assert.equal(other._urgent, false);
        } finally { await f.adapter.stop(); }
    });

    it("renders localized post content and message-specific image references", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            const post = { en_us: { title: "Title", content: [[{ tag: "text", text: "Hello " }, { tag: "at", user_id: "ou_bot", user_name: "Bot" }], [{ tag: "img", image_key: "img_same" }]] } };
            await f.connections[0].receive(incoming({ message_type: "post", content: JSON.stringify(post) }));
            await f.connections[0].receive(incoming({ message_id: "om_two", message_type: "image", content: '{"image_key":"img_same"}' }));
            assert.equal(f.events[0].text, "Title\nHello @Bot\n[Image]");
            assert.equal(f.events[0].mentionsAgent, true);
            const media = f.events[0].mediaInfo as any;
            assert.equal(media.type, "photo");
            assert.match(media.fileId, /^feishu-media:/);
            assert.match(media.uniqueFileId, /^feishu:/);
            assert.notEqual(media.uniqueFileId, (f.events[1].mediaInfo as any).uniqueFileId);
            const decoded = JSON.parse(Buffer.from(media.fileId.slice(13), "base64url").toString());
            assert.deepEqual(decoded, { chatId: "feishu:oc_chat", messageId: "om_one", key: "img_same", type: "image" });
        } finally { await f.adapter.stop(); }
    });

    it("normalizes audio/video resources and preserves every attachment", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            await f.connections[0].receive(incoming({
                message_type: "media",
                content: '{"file_key":"video_file","image_key":"video_cover","file_name":"clip.mp4","file_size":123}',
            }));
            const event = f.events[0];
            assert.equal(event.text, "[Video]");
            assert.equal((event.mediaInfo as any).type, "video");
            assert.deepEqual((event.mediaInfos as any[]).map(item => item.type), ["video", "photo"]);
            assert.equal((event.mediaInfo as any).attachments.length, 2);
        } finally { await f.adapter.stop(); }
    });

    it("delivers card actions and reactions through the standard message pipeline", async () => {
        const f = fixture();
        f.messages.set("om_bot", { message_id: "om_bot", chat_id: "oc_chat", chat_type: "group", msg_type: "text", body: { content: '{"text":"bot message"}' }, sender: { id: "ou_bot", id_type: "open_id" }, create_time: time });
        await f.adapter.start();
        try {
            await f.connections[0].handlers["card.action.trigger"]({
                event_id: "evt_card", create_time: time,
                event: { operator: { open_id: "ou_user", name: "Alice" }, action: { name: "approve", value: { choice: "yes" } }, context: { open_chat_id: "oc_chat", open_message_id: "om_bot" } },
            });
            await f.connections[0].handlers["im.message.reaction.created_v1"]({
                event_id: "evt_reaction",
                event: { message_id: "om_bot", user_id: { open_id: "ou_reactor" }, reaction_type: { emoji_type: "THUMBSUP" }, action_time: time },
            });
            assert.deepEqual(f.events.map(event => event.type), ["nc.message", "nc.message"]);
            assert.match(String(f.events[0].text), /Card action: approve/);
            assert.equal(f.events[0].replyToMessageId, "om_bot");
            assert.equal(f.events[0]._urgent, true);
            assert.equal(f.events[1].displayName, "Reactor");
            assert.equal(f.events[1].text, "[Reaction added: THUMBSUP]");
            assert.equal(f.events[1].mentionsAgent, true);
            assert.equal((f.events[1].payload as any).platformData.originalType, "im.message.reaction.created_v1");
        } finally { await f.adapter.stop(); }
    });

    it("preserves received stickers and expands merged-forward child messages", async () => {
        const f = fixture();
        f.messages.set("om_merge", { message_id: "om_merge", chat_id: "oc_chat", chat_type: "group", msg_type: "merge_forward", body: { content: "Merged and Forwarded Message" }, sender: { id: "ou_user", id_type: "open_id", sender_name: "Alice" }, create_time: time });
        f.messages.set("om_child_text", { message_id: "om_child_text", upper_message_id: "om_merge", chat_id: "oc_chat", chat_type: "group", msg_type: "text", body: { content: '{"text":"child text"}' }, sender: { id: "ou_user", id_type: "open_id", sender_name: "Alice" }, create_time: time });
        f.messages.set("om_child_sticker", { message_id: "om_child_sticker", upper_message_id: "om_merge", chat_id: "oc_chat", chat_type: "group", msg_type: "sticker", body: { content: '{"file_key":"sticker_key"}' }, sender: { id: "ou_reactor", id_type: "open_id", sender_name: "Bob" }, create_time: time });
        await f.adapter.start();
        try {
            await f.connections[0].receive(incoming({ message_id: "om_merge", message_type: "merge_forward", content: "Merged and Forwarded Message" }));
            const event = f.events[0];
            assert.match(String(event.text), /Alice: child text/);
            assert.match(String(event.text), /Bob: \[Sticker: sticker_key\]/);
            assert.equal((event.forwardedMessages as unknown[]).length, 2);
            assert.equal(event.mediaInfo, undefined);
            assert.ok((event.forwardedMessages as any[]).every(child => child.mediaInfo === undefined && child.mediaInfos === undefined));
        } finally { await f.adapter.stop(); }
    });

    it("preserves nested merged-forward descendants in the tree and rendered text", async () => {
        const f = fixture();
        f.messages.set("om_merge", { message_id: "om_merge", chat_id: "oc_chat", chat_type: "group", msg_type: "merge_forward", body: { content: "Outer forward" }, sender: { id: "ou_user", id_type: "open_id", sender_name: "Alice" }, create_time: time });
        f.messages.set("om_nested", { message_id: "om_nested", upper_message_id: "om_merge", chat_id: "oc_chat", chat_type: "group", msg_type: "merge_forward", body: { content: "Nested forward" }, sender: { id: "ou_reactor", id_type: "open_id", sender_name: "Bob" }, create_time: time });
        f.messages.set("om_grandchild", { message_id: "om_grandchild", upper_message_id: "om_nested", chat_id: "oc_chat", chat_type: "group", msg_type: "text", body: { content: '{"text":"deep child"}' }, sender: { id: "ou_user", id_type: "open_id", sender_name: "Carol" }, create_time: time });
        await f.adapter.start();
        try {
            const merged = await f.adapter.getMessage("oc_chat", "om_merge");
            const nested = (merged.forwardedMessages as any[])[0];
            assert.equal(nested.messageId, "om_nested");
            assert.equal(nested.forwardedMessages.length, 1);
            assert.equal(nested.forwardedMessages[0].messageId, "om_grandchild");
            assert.match(String(nested.text), /Carol: deep child/);
            assert.match(String(merged.text), /Carol: deep child/);
            assert.equal(nested.forwardedMessages[0].mediaInfo, undefined);
            assert.equal(nested.forwardedMessages[0].mediaInfos, undefined);
        } finally { await f.adapter.stop(); }
    });

    it("omits unsupported downloadable references for merged-forward media", async () => {
        for (const count of [1, 2]) {
            const f = fixture();
            const base = f.messages.get("om_parent");
            f.messages.set("om_merge", { ...base, message_id: "om_merge", msg_type: "merge_forward", body: { content: "Merged and Forwarded Message" } });
            for (let i = 0; i < count; i++) {
                f.messages.set(`om_child_${i}`, { ...base, message_id: `om_child_${i}`, upper_message_id: "om_merge", msg_type: "image", body: { content: JSON.stringify({ image_key: `img_child_${i}` }) } });
            }
            await f.adapter.start();
            try {
                const merged = await f.adapter.getMessage("oc_chat", "om_merge");
                assert.equal(merged.mediaInfo, undefined);
                assert.equal(merged.mediaInfos, undefined);
                assert.ok((merged.forwardedMessages as any[]).every(child => child.mediaInfo === undefined && child.mediaInfos === undefined));
                assert.equal(f.calls.filter(call => call.method === "resource").length, 0);
            } finally { await f.adapter.stop(); }
        }
    });

    it("handles invalid timestamps and rejects malformed content without poisoning retries", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            await assert.rejects(f.connections[0].receive(incoming({ content: "not-json" })), /processing failed/);
            await f.connections[0].receive(incoming({ create_time: "Infinity" }));
            assert.equal(f.events.length, 1);
            assert.ok(Math.abs(Date.parse(String(f.events[0].timestamp)) - Date.now()) < 2000);
            await f.connections[0].receive(incoming({ message_id: "../bad", chat_id: "oc_chat" }));
            assert.equal(f.events.length, 1);
        } finally { await f.adapter.stop(); }
    });

    it("does not deliver an in-flight persisted lookup after stop", async () => {
        let release!: (exists: boolean) => void;
        const f = fixture({ hasMessage: () => new Promise(resolve => { release = resolve; }) });
        await f.adapter.start();
        const delivery = f.connections[0].receive(incoming());
        const rejected = assert.rejects(delivery, /processing failed/);
        await f.adapter.stop();
        release(false);
        await rejected;
        assert.equal(f.events.length, 0);
    });

    it("does not deliver card actions or reactions after their session stops", async () => {
        for (const eventType of ["card.action.trigger", "im.message.reaction.created_v1"] as const) {
            let release!: (value: { code: number; data: { user: { name: string } } }) => void;
            const f = fixture();
            f.client.contact!.v3!.user!.get = () => new Promise(resolve => { release = resolve; });
            f.messages.set("om_bot", { message_id: "om_bot", chat_id: "oc_chat", chat_type: "group", msg_type: "text", body: { content: '{"text":"bot message"}' }, sender: { id: "ou_bot", id_type: "open_id" }, create_time: time });
            await f.adapter.start();
            const delivery = eventType === "card.action.trigger"
                ? f.connections[0].handlers[eventType]({ event_id: "evt_card", event: { operator: { open_id: "ou_user" }, action: { name: "approve" }, context: { open_chat_id: "oc_chat", open_message_id: "om_bot" } } })
                : f.connections[0].handlers[eventType]({ event_id: "evt_reaction", event: { message_id: "om_bot", user_id: { open_id: "ou_user" }, reaction_type: { emoji_type: "THUMBSUP" }, action_time: time } });
            await waitFor(() => Boolean(release));
            await f.adapter.stop();
            release({ code: 0, data: { user: { name: "Alice" } } });
            await delivery;
            assert.equal(f.events.length, 0);
        }
    });
});

describe("Feishu adapter lifecycle edges", () => {
    it("does not treat start completion as real readiness and coalesces starts", async () => {
        const f = fixture({ autoReady: false });
        const starting = f.adapter.start();
        assert.equal(f.adapter.start(), starting);
        await waitFor(() => f.connections.length === 1);
        assert.equal(f.adapter.getConnectionStatus().state, "connecting");
        f.connections[0].ready();
        await starting;
        assert.equal(f.adapter.getConnectionStatus().state, "connected");
        await f.adapter.stop();
        f.connections[0].callbacks.onReconnected();
        assert.equal(f.adapter.getConnectionStatus().state, "stopped");
        assert.equal(f.connections[0].closed, 1);
    });

    it("times out and closes an SDK connection that never becomes ready", async () => {
        const f = fixture({ autoReady: false, readinessTimeoutMs: 10 });
        await assert.rejects(f.adapter.start(), /startup failed/);
        assert.equal(f.connections[0].closed, 1);
        assert.equal(f.adapter.getConnectionStatus().state, "error");
        f.connections[0].ready();
        assert.equal(f.adapter.getConnectionStatus().state, "error");
        await f.adapter.stop();
    });

    it("stop cancels startup and old callbacks cannot overwrite a new session", async () => {
        const f = fixture({ autoReady: false });
        const starting = f.adapter.start();
        const rejection = assert.rejects(starting, /cancelled/);
        await waitFor(() => f.connections.length === 1);
        await f.adapter.stop();
        await rejection;
        const restarted = f.adapter.start();
        await waitFor(() => f.connections.length === 2);
        f.connections[0].callbacks.onError(new Error(config.appSecret));
        f.connections[0].ready();
        assert.equal(f.adapter.getConnectionStatus().state, "connecting");
        f.connections[1].ready();
        await restarted;
        await f.adapter.stop();
    });

    it("closes connections whose asynchronous factory finishes after stop", async () => {
        let finish!: (connection: FeishuConnection) => void;
        let connection!: FakeConnection;
        const f = fixture({ createConnection: (callbacks, receive, handlers) => {
            connection = new FakeConnection(callbacks, receive, handlers, true);
            return new Promise(resolve => { finish = resolve; });
        } });
        const starting = f.adapter.start();
        const rejection = assert.rejects(starting);
        await waitFor(() => Boolean(finish));
        await f.adapter.stop();
        finish(connection);
        await rejection;
        await new Promise(resolve => setImmediate(resolve));
        assert.ok(connection.closed >= 1);
        assert.equal(connection.started, 0);
    });

    it("reads SDK reconnect status and rebuilds rather than calling private reConnect", async () => {
        const f = fixture();
        await f.adapter.start();
        f.connections[0].state = "reconnecting";
        f.connections[0].callbacks.onReconnecting();
        assert.equal(f.adapter.getConnectionStatus().reconnectAttempts, 2);
        await f.adapter.reconnect();
        assert.equal(f.connections[0].closed, 1);
        assert.equal(f.connections.length, 2);
        await f.adapter.stop();
    });
});

describe("Feishu adapter host boundary edges", () => {
    it("blocks muted native writes while allowing native reads", async () => {
        const f = fixture();
        const nativeCalls: unknown[] = [];
        const native = async (payload: unknown) => { nativeCalls.push(payload); return { code: 0, data: {} }; };
        f.client.im.v1.pin = { create: native, list: native };
        await f.adapter.start();
        try {
            f.adapter.muteChat("oc_chat", 1);
            await assert.rejects(f.adapter.callApi("oc_chat", "pin.create", { data: { message_id: "om_parent" } }), /chat is muted/);
            assert.equal(nativeCalls.length, 0);
            await f.adapter.callApi("oc_chat", "pin.list", { params: { chat_id: "oc_chat" } });
            assert.deepEqual(nativeCalls, [{ params: { chat_id: "oc_chat" } }]);
        } finally { await f.adapter.stop(); }
    });

    it("rejects unscoped forwarding and checks every native message owner before mutation", async () => {
        const f = fixture();
        f.messages.set("om_other", { ...f.messages.get("om_parent"), message_id: "om_other", chat_id: "oc_other" });
        const nativeCalls: unknown[] = [];
        const native = async (payload: unknown) => { nativeCalls.push(payload); return { code: 0, data: {} }; };
        f.client.im.v1.message.forward = native;
        f.client.im.v1.message.mergeForward = native;
        f.client.im.v1.pin = { create: native };
        f.client.im.v1.messageReaction = { batchQuery: native };
        await f.adapter.start();
        try {
            for (const action of ["message.forward", "message.mergeForward"]) {
                const payload = { path: { message_id: "om_parent" }, params: { receive_id_type: "chat_id" }, data: { receive_id: "oc_chat", message_id_list: ["om_parent"] } };
                for (const receive_id_type of ["open_id", "user_id", "union_id", "email", "thread_id", undefined]) {
                    await assert.rejects(f.adapter.callApi("oc_chat", action, { ...payload, params: { receive_id_type } }), /requires receive_id_type chat_id/);
                }
                await assert.rejects(f.adapter.callApi("oc_chat", action, { ...payload, data: { ...payload.data, receive_id: "oc_other" } }), /chat mismatch/);
                await assert.rejects(f.adapter.callApi("oc_chat", action, { ...payload, path: { message_id: "om_other" }, data: { ...payload.data, message_id_list: ["om_parent", "om_other"] } }), /chat mismatch/);
                assert.equal(nativeCalls.length, 0);
                await f.adapter.callApi("oc_chat", action, payload);
                assert.deepEqual(nativeCalls.pop(), payload);
            }
            for (const messageId of ["om_other", undefined, 42, "invalid"]) {
                await assert.rejects(f.adapter.callApi("oc_chat", "pin.create", { data: { message_id: messageId } }));
                await assert.rejects(f.adapter.callApi("oc_chat", "messageReaction.batchQuery", { data: { queries: [{ message_id: "om_parent" }, { message_id: messageId }] } }));
            }
            assert.equal(nativeCalls.length, 0);
            for (const [action, data] of [
                ["pin.create", { message_id: "om_parent" }],
                ["messageReaction.batchQuery", { queries: [{ message_id: "om_parent", page_token: "next" }] }],
            ] as const) {
                await f.adapter.callApi("oc_chat", action, { data });
                assert.deepEqual(nativeCalls.pop(), { data });
            }
            for (const action of ["chat.list", "chat.search"]) {
                await assert.rejects(f.adapter.callApi("oc_chat", action, {}), /Unsupported/);
            }
        } finally { await f.adapter.stop(); }
    });

    it("uses chat_mode for chat metadata and cached history classification", async () => {
        const f = fixture();
        f.client.im.v1.chat.get = async () => ({ code: 0, data: { name: "Direct", chat_mode: "p2p", chat_type: "private" } });
        await f.adapter.start();
        try {
            assert.equal((await f.adapter.getChat("oc_chat")).chatType, "private");
            const history = await f.adapter.getHistory("oc_chat");
            const item = (history.items as any[])[0];
            assert.equal(item.chatType, "private");
            assert.equal(item.isDirectMessage, true);
        } finally { await f.adapter.stop(); }
    });

    it("backfills beyond filtered pages and the SDK page limit from the later cutoff", async () => {
        for (const watermarkTimestamp of ["2026-01-01T00:00:00.123Z", "2025-12-30T00:00:00.123Z"]) {
            const f = fixture();
            const since = new Date("2025-12-31T00:00:00.000Z");
            const start = Math.max(since.getTime(), Date.parse(watermarkTimestamp));
            const base = f.messages.get("om_parent");
            const rows = [
                { ...base, message_id: "om_old", create_time: String(start - 1) },
                { ...base, message_id: "om_bot", create_time: String(start + 1), sender: { id: "ou_bot", id_type: "open_id" } },
                ...Array.from({ length: 70 }, (_, i) => ({ ...base, message_id: `om_new_${i}`, create_time: String(start + 1000 + i) })),
            ];
            const requests: any[] = [];
            f.client.im.v1.message.list = async payload => {
                const params = payload!.params;
                requests.push(params);
                const offset = Number(params.page_token ?? 0);
                const end = offset + (offset === 0 ? 2 : params.page_size!);
                return { code: 0, data: { items: rows.slice(offset, end), has_more: end < rows.length, page_token: String(end) } };
            };
            await f.adapter.start();
            try {
                const delivered: Record<string, unknown>[] = [];
                const result = await f.adapter.fetchMissedMessages({
                    maxMessagesPerChat: 60, maxChats: 1, since, knownChatIds: ["feishu:oc_chat"],
                    getWatermark: () => ({ messageId: "om_old", timestamp: watermarkTimestamp }),
                    deliver: event => delivered.push(event),
                });
                assert.deepEqual(result, { chats: 1, messages: 60, notes: undefined });
                assert.deepEqual(delivered.map(item => item.messageId), Array.from({ length: 60 }, (_, i) => `om_new_${i}`));
                assert.deepEqual(requests.map(params => params.page_size), [50, 50, 10]);
                assert.deepEqual(requests.map(params => params.page_token), [undefined, "2", "52"]);
                assert.ok(requests.every(params => params.start_time === String(Math.floor(start / 1000))));
            } finally { await f.adapter.stop(); }
        }
    });

    it("backfills history after the timestamp watermark through the normal NC shape", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            const delivered: Record<string, unknown>[] = [];
            const result = await f.adapter.fetchMissedMessages({
                maxMessagesPerChat: 20,
                maxChats: 5,
                since: new Date("2025-12-31T00:00:00.000Z"),
                knownChatIds: ["feishu:oc_chat"],
                getWatermark: () => ({ messageId: "om_old", timestamp: "2025-12-31T23:59:00.000Z" }),
                deliver: event => delivered.push(event),
            });
            assert.deepEqual(result, { chats: 1, messages: 1, notes: undefined });
            assert.equal(delivered[0].type, "nc.message");
            assert.equal(delivered[0].chatId, "feishu:oc_chat");
            assert.equal((delivered[0].payload as any).platformData.originalType, "im.message.list");
        } finally { await f.adapter.stop(); }
    });

    it("rejects wrong-chat get and reply targets before any send or upload", async () => {
        const f = fixture();
        f.messages.get("om_parent").chat_id = "oc_other";
        await f.adapter.start();
        try {
            await assert.rejects(f.adapter.getMessage("feishu:oc_chat", "om_parent"), /chat mismatch/);
            await assert.rejects(f.adapter.sendText("feishu:oc_chat", "hello", { replyToMessageId: "om_parent" }), /chat mismatch/);
            await assert.rejects(f.adapter.sendMedia("feishu:oc_chat", { type: "photo", path: "not-needed.png" }, { replyToMessageId: "om_parent" }), /chat mismatch/);
            assert.ok(f.calls.every(call => call.method === "get"));
        } finally { await f.adapter.stop(); }
    });

    it("uses reply path/data contract and plain acknowledgements without NC sent emission", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            const ack = await f.adapter.sendText("feishu:oc_chat", "hello", { replyToMessageId: "om_parent", replyInThread: true, uuid: "stable-id", mentions: [{ userId: "feishu:ou_user", displayName: "A < B" }] });
            assert.equal(ack.messageId, "om_reply");
            assert.equal(ack.chatId, "feishu:oc_chat");
            assert.equal(ack.threadId, "omt_thread");
            assert.equal(ack.senderUserId, "feishu:ou_bot");
            const reply = f.calls.find(call => call.method === "reply")!.payload;
            assert.deepEqual(reply.path, { message_id: "om_parent" });
            assert.equal(reply.data.reply_in_thread, true);
            assert.equal(reply.data.uuid, "stable-id");
            assert.equal(JSON.parse(reply.data.content).text, '<at user_id="ou_user">A &lt; B</at> hello');
            assert.equal(f.events.length, 0);
            assert.doesNotThrow(() => JSON.stringify(ack));
        } finally { await f.adapter.stop(); }
    });

    it("rejects business failures and strips secrets from transport errors", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            f.client.im.v1.message.create = async () => ({ code: 99991663, msg: config.appSecret });
            await assert.rejects(f.adapter.sendText("oc_chat", "hello"), error => {
                assert.equal((error as Error).message, "Feishu API business failure (99991663)");
                return true;
            });
            f.client.im.v1.message.create = async () => { throw new Error(config.appSecret); };
            await assert.rejects(f.adapter.sendText("oc_chat", "hello"), error => !String(error).includes(config.appSecret));
        } finally { await f.adapter.stop(); }
    });

    it("enforces mutes, text bounds, identifiers and explicit method allowlist", async () => {
        const f = fixture();
        await f.adapter.start();
        try {
            f.adapter.muteChat("oc_chat", 1);
            await assert.rejects(f.adapter.sendText("feishu:oc_chat", "hello"), /muted/);
            for (const mutate of [
                () => f.adapter.updateTemplateCard("oc_chat", "om_parent", "template_1"),
                () => f.adapter.updateCard("oc_chat", "om_parent", {}),
                () => f.adapter.patchCard("oc_chat", "om_parent", []),
                () => f.adapter.streamCardText("oc_chat", "om_parent", "answer", "text"),
            ]) await assert.rejects(mutate(), /muted/);
            assert.equal(f.calls.length, 0);
            assert.equal(f.adapter.getMutedChats().length, 1);
            f.adapter.unmuteChat("feishu:oc_chat");
            await assert.rejects(f.adapter.sendText("oc_chat", " "), /empty/);
            await assert.rejects(f.adapter.sendText("oc_chat", "x".repeat(21 * 1024)), /too large/);
            await assert.rejects(f.adapter.sendText("discord:oc_chat", "hello"), /identifier/);
            await assert.rejects(f.adapter.sendText("oc_chat", "hello", { replyInThread: true }), /parent/);
            assert.equal(f.adapter.canHandle("feishu.callApi"), true);
            assert.equal(f.adapter.canHandle("feishu.searchMessages"), false);
            assert.equal(f.adapter.canHandle("feishu.addReaction"), false);
            assert.deepEqual(f.adapter.getWriteMethods(), [
                "feishu.sendText", "feishu.sendMessage", "feishu.sendMedia", "feishu.sendSticker",
                "feishu.sendTemplateCard", "feishu.sendCard", "feishu.updateTemplateCard", "feishu.updateCard", "feishu.patchCard", "feishu.streamCardText",
            ]);
            await assert.rejects(f.adapter.handleCall("feishu.callApi", ["oc_chat", "unknown", {}]), /Unsupported/);
            assert.equal(f.calls.length, 0);
        } finally { await f.adapter.stop(); }
    });

    it("reuses received stickers and supports template, full, partial and streaming card updates", async () => {
        const f = fixture();
        f.messages.set("om_sticker", { message_id: "om_sticker", chat_id: "oc_chat", msg_type: "sticker", body: { content: '{"file_key":"sticker_key"}' }, sender: { id: "ou_user", id_type: "open_id" }, create_time: time });
        f.messages.set("om_card", { message_id: "om_card", chat_id: "oc_chat", msg_type: "interactive", body: { content: '{"elements":[]}' }, sender: { id: "ou_bot", id_type: "open_id" }, create_time: time });
        await f.adapter.start();
        try {
            const stickerMessage = await f.adapter.getMessage("oc_chat", "om_sticker");
            const sticker = await f.adapter.sendSticker("oc_chat", (stickerMessage.mediaInfo as any).fileId);
            assert.equal((sticker.mediaInfo as any).type, "sticker");
            assert.deepEqual(JSON.parse(f.calls.find(call => call.method === "create")!.payload.data.content), { file_key: "sticker_key" });

            assert.equal((await f.adapter.sendTemplateCard("oc_chat", "template_1", { title: "Hello" })).messageId, "om_card");
            const card = await f.adapter.sendCard("oc_chat", { schema: "2.0", body: { elements: [] } });
            assert.equal(card.cardId, "card_1");
            assert.deepEqual(JSON.parse(f.calls.filter(call => call.method === "create").at(-1)!.payload.data.content), { type: "card", data: { card_id: "card_1" } });

            await f.adapter.updateTemplateCard("oc_chat", "om_card", "template_2", { done: true });
            await f.adapter.updateCard("oc_chat", "om_card", { schema: "2.0" }, { sequence: 10 });
            await f.adapter.patchCard("oc_chat", "om_card", [{ type: "update", element_id: "status" }], { sequence: 11 });
            await f.adapter.streamCardText("oc_chat", "om_card", "answer", "partial answer", { sequence: 12 });
            assert.ok(f.calls.some(call => call.method === "updateByCard"));
            assert.equal(f.calls.find(call => call.method === "cardUpdate")!.payload.data.sequence, 10);
            assert.equal(f.calls.find(call => call.method === "cardPatch")!.payload.data.sequence, 11);
            assert.equal(f.calls.find(call => call.method === "cardStream")!.payload.data.content, "partial answer");
            await assert.rejects(f.adapter.streamCardText("oc_chat", "om_card", "answer", "stale", { sequence: 12 }), /sequence must increase/);
            assert.equal(f.calls.filter(call => call.method === "cardStream").length, 1);
        } finally { await f.adapter.stop(); }
    });

    it("confines uploads to workspace, follows safe symlinks, and rejects empty or oversized files", async () => {
        const root = mkdtempSync(join(tmpdir(), "feishu-boundary-"));
        const workspace = join(root, "workspace");
        mkdirSync(workspace);
        writeFileSync(join(root, "outside"), "outside");
        writeFileSync(join(workspace, "inside"), "inside");
        writeFileSync(join(workspace, "empty"), "");
        writeFileSync(join(workspace, "large"), Buffer.alloc(10 * 1024 * 1024 + 1));
        symlinkSync(join(root, "outside"), join(workspace, "escape"));
        symlinkSync(join(workspace, "inside"), join(workspace, "safe"));
        const f = fixture({ workspace });
        await f.adapter.start();
        try {
            for (const file of ["../outside", join(root, "outside"), "escape", "empty", "large", "https://example.invalid/file", "file:///etc/passwd"]) {
                await assert.rejects(f.adapter.sendMedia("oc_chat", { type: "photo", path: file }), /workspace|size-limited/);
            }
            assert.equal(f.calls.length, 0);
            await f.adapter.sendMedia("oc_chat", { type: "photo", path: "safe" });
            const upload = f.calls.find(call => call.method === "image")!;
            assert.equal(upload.payload.data.image.toString(), "inside");
            assert.equal(upload.payload.data.image_type, "message");
            assert.deepEqual(JSON.parse(f.calls.find(call => call.method === "create")!.payload.data.content), { image_key: "img_uploaded" });
        } finally { await f.adapter.stop(); rmSync(root, { recursive: true, force: true }); }
    });

    it("returns own-media references and archives captions only as separate successful messages", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "feishu-caption-"));
        writeFileSync(join(workspace, "upload"), "bytes");
        const f = fixture({ workspace });
        await f.adapter.start();
        try {
            for (const type of ["photo", "document"] as const) {
                const msgType = type === "photo" ? "image" : "file";
                const body = type === "photo" ? { image_key: "img_uploaded" } : { file_key: "file_uploaded" };
                f.messages.set("om_sent", { message_id: "om_sent", chat_id: "oc_chat", msg_type: msgType, body: { content: JSON.stringify(body) }, sender: { id: "ou_bot", id_type: "open_id" }, create_time: time });
                const ack = await f.adapter.sendMedia("oc_chat", { type, path: "upload", fileName: "test.bin", caption: "caption text" }, { uuid: "media-id" });
                assert.equal(f.calls.filter(call => call.method === "create").at(-1)!.payload.data.msg_type, msgType);
                assert.equal(ack.text, "");
                assert.equal(ack.messageId, "om_sent");
                assert.equal(ack.captionMessageId, undefined);
                assert.equal(ack.captionError, undefined);
                const media = ack.mediaInfo as any;
                assert.equal(media.type, type);
                assert.equal(media.fileName, "test.bin");
                assert.equal(media.fileSize, 5);
                assert.equal((await f.adapter.downloadMedia(media.fileId, "oc_chat", "om_sent", media.uniqueFileId)).toString(), "media");
                const extra = ack.additionalMessages as any[];
                assert.equal(extra.length, 1);
                assert.equal(extra[0].messageId, "om_reply");
                assert.equal(extra[0].chatId, "feishu:oc_chat");
                assert.equal(extra[0].text, "caption text");
                assert.equal(extra[0].replyToMessageId, "om_sent");
                const reply = f.calls.filter(call => call.method === "reply").at(-1)!;
                assert.notEqual(reply.payload.data.uuid, "media-id");
                assert.equal(JSON.parse(reply.payload.data.content).text, extra[0].text);
            }
            assert.equal(f.events.length, 0);
        } finally { await f.adapter.stop(); rmSync(workspace, { recursive: true, force: true }); }
    });

    it("keeps the media ack without unsent caption text on business failure or caption target mismatch", async () => {
        const workspace = mkdtempSync(join(tmpdir(), "feishu-caption-failure-"));
        writeFileSync(join(workspace, "upload"), "bytes");
        const f = fixture({ workspace });
        await f.adapter.start();
        try {
            f.messages.set("om_sent", { message_id: "om_sent", chat_id: "oc_other", msg_type: "image", body: { content: '{"image_key":"img_uploaded"}' }, create_time: time });
            const mismatch = await f.adapter.sendMedia("oc_chat", { type: "photo", path: "upload", caption: "unsent" });
            assert.equal(mismatch.text, "");
            assert.equal(mismatch.messageId, "om_sent");
            assert.ok(mismatch.mediaInfo);
            assert.equal(mismatch.additionalMessages, undefined);
            assert.equal(mismatch.captionError, "Feishu caption send failed");
            assert.equal(f.calls.filter(call => call.method === "reply").length, 0);
            f.messages.get("om_sent").chat_id = "oc_chat";
            f.client.im.v1.message.reply = async () => ({ code: 1234, msg: config.appSecret });
            const failed = await f.adapter.sendMedia("oc_chat", { type: "photo", path: "upload", caption: "unsent" });
            assert.equal(failed.text, "");
            assert.equal(failed.additionalMessages, undefined);
            assert.equal(failed.captionError, "Feishu caption send failed");
            assert.ok(!JSON.stringify(failed).includes("unsent"));
            assert.ok(!JSON.stringify(failed).includes(config.appSecret));
            const plain = await f.adapter.sendMedia("oc_chat", { type: "photo", path: "upload" });
            assert.equal(plain.text, "");
            assert.equal(plain.additionalMessages, undefined);
            assert.equal(plain.captionError, undefined);
            f.client.im.v1.image.create = async () => null;
            await assert.rejects(f.adapter.sendMedia("oc_chat", { type: "photo", path: "upload" }), /upload failed/);
            assert.equal(f.events.length, 0);
        } finally { await f.adapter.stop(); rmSync(workspace, { recursive: true, force: true }); }
    });

    it("checks resource ownership before downloading and supports buffer/base64 returns", async () => {
        const f = fixture();
        const event = incoming({ message_type: "file", content: '{"file_key":"file_attachment","file_name":"report.pdf"}' });
        f.messages.set("om_one", { message_id: "om_one", chat_id: "oc_chat", msg_type: "file", body: { content: event.message.content }, sender: { id: "ou_user", id_type: "open_id" }, create_time: time });
        await f.adapter.start();
        try {
            await f.connections[0].receive(event);
            const media = f.events[0].mediaInfo as any;
            assert.equal(media.type, "document");
            assert.equal(media.fileName, "report.pdf");
            await assert.rejects(f.adapter.downloadMedia(media.fileId, "oc_other"), /ownership/);
            await assert.rejects(f.adapter.downloadMedia(media.fileId, "oc_chat", "om_wrong"), /ownership/);
            await assert.rejects(f.adapter.downloadMedia(media.fileId, "oc_chat", "om_one", "wrong"), /ownership/);
            assert.equal(f.calls.length, 0);
            assert.equal((await f.adapter.downloadMedia(null, media.fileId)).toString(), "media");
            const envelope = await f.adapter.handleCall("feishu.downloadMedia", [media.fileId, "oc_chat", "om_one", media.uniqueFileId]) as Record<string, unknown>;
            assert.deepEqual(envelope, { buffer: Buffer.from("media").toString("base64"), size: 5, fileName: "report.pdf" });
            f.messages.get("om_one").body.content = '{"file_key":"file_other"}';
            await assert.rejects(f.adapter.downloadMedia(media.fileId), /does not belong/);
            assert.equal(f.calls.filter(call => call.method === "resource").length, 2);
        } finally { await f.adapter.stop(); }
    });

    it("destroys oversized download streams", async () => {
        const f = fixture();
        const stream = Readable.from([Buffer.from("small")]);
        f.client.im.v1.messageResource.get = async () => ({ getReadableStream: () => stream, headers: { "content-length": String(100 * 1024 * 1024 + 1) }, writeFile: async () => {} });
        const event = incoming({ message_type: "image", content: '{"image_key":"img_one"}' });
        f.messages.set("om_one", { message_id: "om_one", chat_id: "oc_chat", msg_type: "image", body: { content: event.message.content }, create_time: time });
        await f.adapter.start();
        try {
            await f.connections[0].receive(event);
            await assert.rejects(f.adapter.downloadMedia((f.events[0].mediaInfo as any).fileId), /exceeded limits/);
            assert.equal(stream.destroyed, true);
        } finally { await f.adapter.stop(); }
    });

    it("enriches the download envelope with fileName, content-type and sniffed image mime", async () => {
        const f = fixture();
        const seed = (messageId: string, chatType: "image" | "file", content: string) => {
            const event = incoming({ message_id: messageId, message_type: chatType, content });
            f.messages.set(messageId, { message_id: messageId, chat_id: "oc_chat", msg_type: chatType, body: { content }, sender: { id: "ou_user", id_type: "open_id" }, create_time: time });
            return event;
        };
        await f.adapter.start();
        try {
            // inbound document: octet-stream carries no mime, but the original file name is preserved
            f.client.im.v1.messageResource.get = async () => ({ getReadableStream: () => Readable.from([Buffer.from("%PDF-1.4")]), headers: { "content-type": "application/octet-stream" } });
            const fileEvent = seed("om_pdf", "file", '{"file_key":"file_report","file_name":"report.pdf"}');
            await f.connections[0].receive(fileEvent);
            const fileMedia = f.events[0].mediaInfo as any;
            const fileEnv = await f.adapter.handleCall("feishu.downloadMedia", [fileMedia.fileId, "oc_chat", "om_pdf", fileMedia.uniqueFileId]) as Record<string, unknown>;
            assert.equal(fileEnv.fileName, "report.pdf");
            assert.equal(fileEnv.mimeType, undefined);

            // image with a real content-type keeps it (parameters stripped) even with no file name
            f.client.im.v1.messageResource.get = async () => ({ getReadableStream: () => Readable.from([Buffer.from("x")]), headers: { "content-type": "image/webp; charset=binary" } });
            const typedEvent = seed("om_webp", "image", '{"image_key":"img_typed"}');
            await f.connections[0].receive(typedEvent);
            const typedMedia = f.events[1].mediaInfo as any;
            const typedEnv = await f.adapter.handleCall("feishu.downloadMedia", [typedMedia.fileId, "oc_chat", "om_webp", typedMedia.uniqueFileId]) as Record<string, unknown>;
            assert.equal(typedEnv.mimeType, "image/webp");
            assert.equal(typedEnv.fileName, undefined);

            // image with no usable content-type falls back to a tiny magic-byte sniff
            const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("DATA")]);
            f.client.im.v1.messageResource.get = async () => ({ getReadableStream: () => Readable.from([png]), headers: {} });
            const sniffEvent = seed("om_png", "image", '{"image_key":"img_sniff"}');
            await f.connections[0].receive(sniffEvent);
            const sniffMedia = f.events[2].mediaInfo as any;
            const sniffEnv = await f.adapter.handleCall("feishu.downloadMedia", [sniffMedia.fileId, "oc_chat", "om_png", sniffMedia.uniqueFileId]) as Record<string, unknown>;
            assert.equal(sniffEnv.mimeType, "image/png");

            // documents are never sniffed: PNG magic on a nameless file must not become an image mime
            f.client.im.v1.messageResource.get = async () => ({ getReadableStream: () => Readable.from([png]), headers: {} });
            const docEvent = seed("om_noname", "file", '{"file_key":"file_noname"}');
            await f.connections[0].receive(docEvent);
            const docMedia = f.events[3].mediaInfo as any;
            const docEnv = await f.adapter.handleCall("feishu.downloadMedia", [docMedia.fileId, "oc_chat", "om_noname", docMedia.uniqueFileId]) as Record<string, unknown>;
            assert.equal(docEnv.mimeType, undefined);
            assert.equal(docEnv.fileName, undefined);
        } finally { await f.adapter.stop(); }
    });

    it("round-trips underscore-bearing Feishu chat, user and message identifiers", async () => {
        const f = fixture();
        f.messages.set("om_under", { message_id: "om_under", chat_id: "oc_a_b", msg_type: "text", body: { content: '{"text":"hi"}' }, sender: { id: "ou_x_y", id_type: "open_id" }, create_time: time });
        await f.adapter.start();
        try {
            await f.connections[0].receive(incoming({ message_id: "om_under", chat_id: "oc_a_b", content: '{"text":"@_user_1 hi"}', mentions: [{ key: "@_user_1", id: { open_id: "ou_x_y" }, name: "X Y" }] }));
            const event = f.events[0];
            assert.equal(event.chatId, "feishu:oc_a_b");
            assert.equal((event.mentions as Array<{ userId: string }>)[0].userId, "feishu:ou_x_y");
            assert.equal(event.text, "@X Y hi");
            const fetched = await f.adapter.getMessage("feishu:oc_a_b", "om_under");
            assert.equal(fetched.chatId, "feishu:oc_a_b");
            assert.equal(f.adapter.formatMention("feishu:ou_x_y", "X"), '<at user_id="ou_x_y">X</at>');
        } finally { await f.adapter.stop(); }
    });
});
