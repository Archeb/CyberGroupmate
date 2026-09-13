import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelegramBotApiClient } from "../src/adapter/telegram-bot-api-client.js";
import { TelegramAdapter } from "../src/adapter/telegram-adapter.js";
import { NotificationCenter } from "../src/event/notification-center.js";
import { clearConfigCache, loadConfig, serializeConfigToYAML, validateConfig } from "../src/core/config.js";

const token = "123456:TEST_TOKEN";
const self = { id: 123456, is_bot: true, first_name: "Test", username: "TestBot" };
const message = (extra = {}) => ({
    message_id: 41, date: 1_800_000_000, text: "hello", chat: { id: -100123, type: "supergroup", title: "Group" },
    from: { id: 77, first_name: "Member", is_bot: false }, ...extra,
});
const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
function pending(signal?: AbortSignal | null): Promise<Response> {
    return new Promise((_, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
    });
}
function fakeApi(onCall?: (method: string, init: RequestInit) => Response | Promise<Response> | undefined) {
    const calls: Array<{ method: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
        const method = String(input).split("/").at(-1)!;
        calls.push({ method, init });
        const result = onCall?.(method, init);
        if (result !== undefined) return result;
        if (method === "getMe") return ok(self);
        if (method === "getWebhookInfo") return ok({ url: "" });
        if (method === "getUpdates") return pending(init.signal);
        return ok(message());
    };
    return { fetchImpl, calls };
}
async function until(check: () => boolean) {
    const deadline = Date.now() + 4_000;
    while (!check() && Date.now() < deadline) await delay(5);
    assert.ok(check(), "condition did not become true");
}

describe("Telegram Bot API client", () => {
    it("starts polling only after subscription, delivers before acknowledging, and aborts on stop", async t => {
        let polls = 0;
        let release!: () => void;
        const api = fakeApi((method) => method === "getUpdates" && ++polls === 1
            ? ok([{ update_id: 900, message: message() }]) : undefined);
        const client = new TelegramBotApiClient(token, api.fetchImpl);
        t.after(() => client.destroy());
        await client.start();
        assert.equal(polls, 0);
        const received: any[] = [];
        client.onNewMessage.add(async msg => {
            received.push(msg);
            await new Promise<void>(resolve => { release = resolve; });
        });
        await until(() => received.length === 1);
        assert.equal(polls, 1, "must not acknowledge while the consumer is still processing");
        assert.equal(received[0].id, 41);
        assert.equal(received[0].chat.id, -100123);
        assert.equal(received[0].sender.id, 77);
        assert.equal(received[0].date.getTime(), 1_800_000_000_000);
        release();
        await until(() => polls === 2);
        const request = api.calls.filter(c => c.method === "getUpdates")[1];
        assert.equal(JSON.parse(String(request.init.body)).offset, 901);
        await client.destroy();
        assert.equal(request.init.signal?.aborted, true);
    });

    it("retries a failed consumer without advancing offset and reports the failure", async t => {
        let polls = 0;
        const api = fakeApi(method => method === "getUpdates" && ++polls <= 2
            ? ok([{ update_id: 7, message: message() }]) : undefined);
        const client = new TelegramBotApiClient(token, api.fetchImpl);
        t.after(() => client.destroy());
        const errors: Error[] = [];
        client.onError.add(error => errors.push(error));
        await client.start();
        let attempts = 0;
        client.onNewMessage.add(() => { if (++attempts === 1) throw new Error("consumer unavailable"); });
        await until(() => polls === 3);
        const offsets = api.calls.filter(c => c.method === "getUpdates").map(c => JSON.parse(String(c.init.body)).offset);
        assert.deepEqual(offsets, [undefined, undefined, 8]);
        assert.equal(attempts, 2);
        assert.match(errors[0].message, /consumer unavailable/);
    });

    it("cancels backoff promptly and sanitizes polling errors", async t => {
        const api = fakeApi(method => {
            if (method === "getUpdates") throw new Error(`failure at https://api.telegram.org/bot${token}/getUpdates`);
        });
        const client = new TelegramBotApiClient(token, api.fetchImpl);
        t.after(() => client.destroy());
        const errors: Error[] = [];
        client.onError.add(error => errors.push(error));
        await client.start();
        client.onNewMessage.add(() => {});
        await until(() => errors.length > 0);
        const started = Date.now();
        await client.destroy();
        assert.ok(Date.now() - started < 500, "stop should cancel the retry delay");
        assert.ok(!String(errors[0]).includes(token));
        assert.equal(errors[0].cause, undefined);
    });

    it("refuses an existing webhook without deleting it or consuming updates", async () => {
        const api = fakeApi(method => method === "getWebhookInfo" ? ok({ url: "https://example.invalid/hook" }) : undefined);
        const client = new TelegramBotApiClient(token, api.fetchImpl);
        await assert.rejects(client.start(), /existing webhook/);
        assert.deepEqual(api.calls.map(c => c.method), ["getMe", "getWebhookInfo"]);
        await client.destroy();
    });

    it("does not treat replies to other people or longer usernames as mentions", async t => {
        const variants = [
            { reply_to_message: { message_id: 1, from: { id: 77 } } },
            { reply_to_message: { message_id: 1, from: self } },
            { text: "@TestBotExtra", entities: [{ type: "mention", offset: 0, length: 13 }] },
            { text: "😀 @TESTBOT", entities: [{ type: "mention", offset: 3, length: 8 }] },
            { entities: [{ type: "text_mention", offset: 0, length: 5, user: self }] },
        ];
        let delivered = false;
        const api = fakeApi(method => {
            if (method !== "getUpdates" || delivered) return;
            delivered = true;
            return ok(variants.map((extra, i) => ({ update_id: i + 1, message: message(extra) })));
        });
        const client = new TelegramBotApiClient(token, api.fetchImpl);
        t.after(() => client.destroy());
        await client.start();
        const mentions: boolean[] = [];
        client.onNewMessage.add((msg: any) => { mentions.push(msg.isMention); });
        await until(() => mentions.length === variants.length);
        assert.deepEqual(mentions, [false, true, false, true, true]);
    });

    it("maps text replies, uploads, typing, and file downloads without leaking token-bearing errors", async t => {
        const api = fakeApi((method) => {
            if (method === "getFile") return ok({ file_path: "documents/file.bin" });
            if (method === "file.bin") return new Response(new Uint8Array([1, 2, 3]));
        });
        const client = new TelegramBotApiClient(token, api.fetchImpl);
        t.after(() => client.destroy());
        const sent: any = await client.sendText("telegram:-100123", "reply", { replyTo: 41 });
        assert.equal(sent.id, 41);
        assert.deepEqual(JSON.parse(String(api.calls[0].init.body)), { chat_id: "-100123", text: "reply", reply_to_message_id: 41 });
        await client.sendMedia(-100123, { type: "document", file: Buffer.from("hello"), fileName: "original.txt", fileMime: "text/plain" });
        const form = api.calls[1].init.body as FormData;
        assert.equal(api.calls[1].method, "sendDocument");
        const upload = form.get("document") as File;
        assert.equal(upload.name, "original.txt");
        assert.equal(await upload.text(), "hello");
        await client.sendTyping(-100123);
        assert.equal(api.calls[2].method, "sendChatAction");
        assert.deepEqual(await client.downloadAsBuffer("file-id"), new Uint8Array([1, 2, 3]));
        for (const result of [
            () => { throw new Error(`fetch ${token} ${encodeURIComponent(token)}`); },
            () => new Response(JSON.stringify({ ok: false, description: `error ${token}` }), { status: 401 }),
        ]) {
            const failing = new TelegramBotApiClient(token, (async () => result()) as typeof fetch);
            await assert.rejects(failing.sendText(1, "test"), (err: Error) =>
                !err.message.includes(token) && !err.message.includes(encodeURIComponent(token)) && err.cause === undefined);
        }
    });

    it("normalizes incoming photo captions, file ids and channel senders", async t => {
        let delivered = false;
        const api = fakeApi(method => {
            if (method !== "getUpdates" || delivered) return;
            delivered = true;
            return ok([{ update_id: 1, channel_post: message({
                text: undefined, caption: "photo caption", sender_chat: { id: -100123, type: "channel", title: "Channel" },
                photo: [{ file_id: "small" }, { file_id: "large", file_unique_id: "unique", width: 1024 }],
            }) }]);
        });
        const client = new TelegramBotApiClient(token, api.fetchImpl);
        t.after(() => client.destroy());
        await client.start();
        const received: any[] = [];
        client.onNewMessage.add(msg => { received.push(msg); });
        await until(() => received.length === 1);
        assert.equal(received[0].text, "photo caption");
        assert.equal(received[0].media.fileId, "large");
        assert.equal(received[0].sender.id, -100123);
    });
});

describe("explicit Telegram connection modes", () => {
    it("uses HTTP even with MTProto credentials present and exposes capability errors", async t => {
        const api = fakeApi();
        t.mock.method(globalThis, "fetch", api.fetchImpl);
        const nc = new NotificationCenter();
        const adapter = new TelegramAdapter({ mode: "bot_api", botToken: token, apiId: "123", apiHash: "hash", phone: "" }, nc,
            async () => { throw new Error("must not prompt for user login"); }, () => {});
        t.after(async () => { await adapter.stop(); nc.dispose(); });
        await adapter.start();
        assert.equal(api.calls[0].method, "getMe");
        await adapter.handleCall("telegram.sendText", [-100123, "test"]);
        assert.ok(api.calls.some(c => c.method === "sendMessage"));
        await assert.rejects(adapter.handleCall("telegram.getHistory", [-100123]), /not supported in Telegram Bot API mode/);
        await assert.rejects(adapter.handleCall("telegram.mtcute", ["getMe"]), /not supported in Telegram Bot API mode/);
        assert.match(adapter.getSceneTypeDefs("telegram", "")!, /bot_api/);
    });

    it("accepts token-only bot_api but never silently downgrades legacy bot or userbot", async t => {
        for (const mode of ["bot_api", "bot", "userbot"] as const) {
            const nc = new NotificationCenter();
            let created = false;
            const adapter = new TelegramAdapter({ mode, botToken: token, apiId: "", apiHash: "", phone: "" }, nc,
                async () => { throw new Error("unexpected prompt"); }, () => {}, async () => {
                    created = true;
                    return { start: async () => self, onNewMessage: { add() {}, remove() {} }, destroy: async () => {} };
                });
            t.after(async () => { await adapter.stop(); nc.dispose(); });
            if (mode === "bot_api") await adapter.start();
            else await assert.rejects(adapter.start(), /API credentials are missing/);
            assert.equal(created, mode === "bot_api");
            await adapter.stop();
        }
    });

    it("round-trips all modes and retains the legacy default when mode is omitted", () => {
        const dir = mkdtempSync(join(tmpdir(), "tg-mode-test-"));
        try {
            const file = join(dir, "config.yaml");
            for (const mode of ["bot_api", "bot", "userbot", undefined]) {
                writeFileSync(file, `persona:\n  name: Test\ntelegram:\n  bot_token: ${token}\n${mode ? `  mode: ${mode}\n` : ""}`);
                const config = loadConfig(file, true);
                assert.equal(config.telegram?.mode, mode ?? "bot");
                assert.ok(!validateConfig(config).errors.some(e => e.startsWith("telegram.mode")));
                writeFileSync(file, serializeConfigToYAML(config));
                assert.equal(loadConfig(file, true).telegram?.mode, mode ?? "bot");
            }
        } finally {
            clearConfigCache();
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
