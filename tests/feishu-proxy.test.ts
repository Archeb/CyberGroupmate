import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFeishuClientProxy } from "../src/sandbox/modules/feishu/index.js";
import { mkdtemp, readFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { installCapabilityRegistry, setPlatform, type CapabilityRegistryEnv } from "../src/sandbox/capability-registry.js";
import { parseDtsFile } from "../src/sandbox/dts-parser.js";
import { generateBriefOverview, lookupFullDocs } from "../src/sandbox/modules/module-registry.js";
import { transformNotebookCode } from "../src/sandbox/notebook-scope.js";
import { createPromiseTracker } from "../src/sandbox/promise-tracker.js";
import type { FeishuClient } from "../src/sandbox/modules/feishu/feishu.js";

function harness(callHost: CapabilityRegistryEnv["callHost"], bannedWords: string[] = [], deduplicate = true) {
    const outputs: string[] = [];
    const events: Record<string, unknown>[] = [];
    const calls: Array<{ method: string; args?: unknown[] }> = [];
    const history = new Map<string, Set<string>>();
    const env: CapabilityRegistryEnv = {
        ctx: {},
        emitOutput: line => { outputs.push(line); },
        notifyHost: event => { events.push(event); },
        requestInput: async () => "",
        printToHost: () => {},
        spawnTask: () => {},
        killTask: () => {},
        listTasks: () => [],
        callHost: async (method, args) => {
            calls.push({ method, args });
            return callHost(method, args);
        },
    };
    return { env, outputs, events, calls, history, proxy: createFeishuClientProxy(env, history, deduplicate, bannedWords) };
}

describe("Feishu proxy acknowledgement boundary", () => {
    it("rejects missing message IDs without success output, events, or dedup history", async () => {
        for (const result of [undefined, null, {}, { messageId: "" }, { messageId: "   " }, { id: "om_wrong_field" }, { messageId: 42 }, { messageId: "om_failed", ok: false }, { messageId: "om_failed", success: false }]) {
            for (const media of [false, true]) {
                const h = harness(async () => result);
                const send = () => media
                    ? h.proxy.sendMedia("feishu:oc_test", { type: "photo", path: "media/a.png", caption: "hello" })
                    : h.proxy.sendText("feishu:oc_test", "hello");
                await assert.rejects(send, /acknowledgement|messageId/);
                await assert.rejects(send, /acknowledgement|messageId/);
                assert.equal(h.calls.length, 2);
                assert.deepEqual(h.outputs, []);
                assert.deepEqual(h.events, []);
                assert.equal(h.history.size, 0);
            }
        }
    });

    it("retries failures and emits exactly one canonical success with reply context", async () => {
        let attempt = 0;
        const h = harness(async () => {
            if (++attempt === 1) throw new Error("send failed");
            return { messageId: "om_sent", chatId: "oc_test", text: "host formatted text" };
        });
        const options = { replyToMessageId: "om_parent", replyInThread: true, uuid: "request", mentions: [{ userId: "ou_user", displayName: "Name" }] };
        await assert.rejects(h.proxy.sendText("oc_test", "hello", options), /send failed/);
        assert.deepEqual(h.outputs, []);
        assert.deepEqual(h.events, []);
        const ack = await h.proxy.sendText("oc_test", "hello", options);
        assert.equal(ack?.messageId, "om_sent");
        assert.equal(ack?.chatId, "feishu:oc_test");
        assert.equal(await h.proxy.sendText("feishu:oc_test", "hello", { ...options, uuid: "another" }), null);
        assert.deepEqual(h.calls[1], { method: "feishu.sendText", args: ["feishu:oc_test", "hello", options] });
        const sent = h.events.filter(event => event.type === "system.agent_message_sent");
        assert.equal(sent.length, 1);
        assert.equal(sent[0].chatId, "feishu:oc_test");
        assert.equal(sent[0].text, "hello");
        assert.equal(sent[0].replyToMessageId, "om_parent");
        assert.equal(h.outputs.filter(line => line.includes(" ok ")).length, 1);
    });

    it("keeps different reply targets, media paths, and text separate", async () => {
        const h = harness(async () => ({ messageId: "om_sent" }));
        await h.proxy.sendText("oc_test", "caption", { replyToMessageId: "om_a", replyInThread: true });
        await h.proxy.sendText("oc_test", "caption", { replyToMessageId: "om_b", replyInThread: true });
        await h.proxy.sendText("oc_test", "caption", { replyToMessageId: "om_b", replyInThread: false });
        await h.proxy.sendText("oc_test", "caption");
        const media = { type: "photo" as const, path: "media/a.png", caption: "caption" };
        await h.proxy.sendMedia("oc_test", media);
        await h.proxy.sendMedia("oc_test", { ...media, path: "media/b.png" });
        assert.equal(await h.proxy.sendMedia("oc_test", { caption: "caption", path: "media/./a.png", type: "photo" }), null);
        assert.equal(h.calls.length, 6);
    });

    it("blocks banned text and captions without recording success or invoking host", async () => {
        const h = harness(async () => ({ messageId: "om_sent" }), ["forbidden"]);
        assert.equal(await h.proxy.sendText("oc_test", "forbidden"), null);
        assert.equal(await h.proxy.sendMedia("oc_test", { type: "document", path: "a.pdf", caption: "forbidden" }), null);
        assert.equal(h.calls.length, 0);
        assert.equal(h.history.size, 0);
        assert.equal(h.events.length, 2);
        assert.ok(h.events.every(event => event.type === "system.banned_word_blocked"));
    });

    it("serializes concurrent duplicates but allows retry after an in-flight failure", async () => {
        const h = harness(async () => ({ messageId: "om_sent" }));
        const results = await Promise.all([h.proxy.sendText("oc_test", "hello"), h.proxy.sendText("oc_test", "hello")]);
        assert.equal(results.filter(Boolean).length, 1);
        assert.equal(h.calls.length, 1);
        let attempt = 0;
        const retry = harness(async () => {
            if (++attempt === 1) throw new Error("failed");
            return { messageId: "om_sent" };
        });
        const attempts = await Promise.allSettled([retry.proxy.sendText("oc_test", "hello"), retry.proxy.sendText("oc_test", "hello")]);
        assert.deepEqual(attempts.map(result => result.status), ["rejected", "fulfilled"]);
        assert.equal(retry.events.filter(event => event.type === "system.agent_message_sent").length, 1);
    });

    it("honors disabled dedup without disabling bans", async () => {
        const h = harness(async () => ({ messageId: "om_sent" }), ["forbidden"], false);
        await h.proxy.sendText("oc_test", "hello");
        await h.proxy.sendText("oc_test", "hello");
        assert.equal(await h.proxy.sendText("oc_test", "forbidden"), null);
        assert.equal(h.calls.length, 2);
        assert.equal(h.history.size, 0);
    });
});

describe("Feishu caption acknowledgement boundary", () => {
    it("archives only the primary media when its caption fails", async () => {
        const mediaInfo = { type: "photo", fileId: "img_test" };
        const h = harness(async () => ({ messageId: "om_media", chatId: "feishu:oc_test", text: "", mediaInfo, captionError: "Feishu caption send failed" }));
        const media = { type: "photo" as const, path: "media/a.png", caption: "unsent caption" };
        const ack = await h.proxy.sendMedia("oc_test", media);
        assert.equal(ack?.captionError, "Feishu caption send failed");
        assert.equal(h.events.length, 1);
        assert.equal(h.events[0].messageId, "om_media");
        assert.equal(h.events[0].text, "");
        assert.deepEqual(h.events[0].mediaInfo, mediaInfo);
        assert.ok(h.outputs.some(line => line.includes("caption failed")));
        assert.equal(await h.proxy.sendMedia("oc_test", media), null);
        assert.equal(h.events.filter(event => event.type === "system.agent_message_sent").length, 1);
    });

    it("emits each successful caption once with its own sender, mentions and thread context", async () => {
        const caption = {
            messageId: "om_caption", chatId: "oc_test", text: "actual caption", senderUserId: "feishu:ou_bot",
            replyToMessageId: "om_media", parentId: "om_media", rootId: "om_root", threadId: "omt_thread",
            mentions: [{ userId: "feishu:ou_target" }],
        };
        const h = harness(async () => ({
            messageId: "om_media", chatId: "feishu:oc_test", text: "", senderUserId: "feishu:ou_bot",
            replyToMessageId: "om_actual_parent", rootId: "om_root", threadId: "omt_thread",
            additionalMessages: [caption, caption, { ...caption, messageId: "om_second", text: "second caption" }],
        }));
        const media = { type: "photo" as const, path: "media/a.png", caption: "requested caption" };
        const ack = await h.proxy.sendMedia("oc_test", media, { replyToMessageId: "om_requested_parent" });
        assert.deepEqual(h.events.map(event => [event.messageId, event.text]), [["om_media", ""], ["om_caption", "actual caption"], ["om_second", "second caption"]]);
        assert.equal(h.events[0].replyToMessageId, "om_actual_parent");
        for (const field of ["senderUserId", "mentions", "replyToMessageId", "parentId", "rootId", "threadId"] as const) {
            assert.deepEqual(h.events[1][field], caption[field]);
        }
        assert.equal(h.events[1].chatId, "feishu:oc_test");
        assert.equal(ack?.additionalMessages?.length, 2);
        assert.equal(ack?.senderUserId, "feishu:ou_bot");
        assert.equal(h.outputs.filter(line => line.includes(" ok ")).length, 3);
        assert.equal(await h.proxy.sendMedia("oc_test", media, { replyToMessageId: "om_requested_parent" }), null);
        assert.equal(h.events.filter(event => event.type === "system.agent_message_sent").length, 3);
    });

    it("ignores failed, cross-chat, malformed and primary-duplicate additional acknowledgements", async () => {
        const valid = { messageId: "om_caption", chatId: "feishu:oc_test", text: "caption" };
        const h = harness(async () => ({
            messageId: "om_media", chatId: "feishu:oc_test", additionalMessages: [
                null, {}, { ...valid, messageId: "fake" }, { ...valid, messageId: "om_" },
                { ...valid, chatId: "feishu:oc_other" }, { ...valid, chatId: "telegram:oc_test" },
                { ...valid, chatId: undefined }, { ...valid, text: undefined },
                { ...valid, ok: false }, { ...valid, success: false }, { ...valid, messageId: "om_media" },
                valid,
            ],
        }));
        const ack = await h.proxy.sendMedia("oc_test", { type: "document", path: "a.pdf", caption: "caption" });
        assert.deepEqual(h.events.map(event => event.messageId), ["om_media", "om_caption"]);
        assert.deepEqual(ack?.additionalMessages, [valid]);
        assert.equal(h.outputs.filter(line => line.includes(" ok ")).length, 2);
    });

    it("rejects mismatched primary targets without success history", async () => {
        const h = harness(async () => ({ messageId: "om_media", chatId: "feishu:oc_other" }));
        await assert.rejects(h.proxy.sendText("oc_test", "hello"), /chat mismatch/);
        assert.deepEqual(h.events, []);
        assert.equal(h.history.size, 0);
    });

    it("generates a request uuid per host operation without mutating options or retrying", async () => {
        const h = harness(async () => { throw new Error("failed"); });
        const options = { replyToMessageId: "om_parent" };
        await assert.rejects(h.proxy.sendText("oc_test", "hello", options), /failed/);
        assert.equal(h.calls.length, 1);
        await assert.rejects(h.proxy.sendMedia("oc_test", { type: "photo", path: "a.png" }), /failed/);
        assert.equal(h.calls.length, 2);
        const uuids = h.calls.map(call => (call.args?.[2] as { uuid: string }).uuid);
        assert.ok(uuids.every(uuid => /^[0-9a-f-]{36}$/.test(uuid)));
        assert.notEqual(uuids[0], uuids[1]);
        assert.deepEqual(options, { replyToMessageId: "om_parent" });
        await assert.rejects(h.proxy.sendText("oc_test", "hello", { uuid: "explicit" }), /failed/);
        assert.equal((h.calls[2].args?.[2] as { uuid: string }).uuid, "explicit");
    });
});

describe("Feishu local media boundary", () => {
    it("resolves outbound paths against workspace and preserves host media metadata", async () => {
        const mediaInfo = { type: "photo", fileId: "img_test", mimeType: "image/png" };
        const h = harness(async () => ({ messageId: "om_sent", mediaInfo }));
        h.env.workspace = resolve("test-workspace");
        const proxy = createFeishuClientProxy(h.env, h.history, true, []);
        await proxy.sendMedia("oc_test", { type: "photo", path: "media/a.png", caption: "caption" }, { replyToMessageId: "om_parent" });
        assert.equal((h.calls[0].args?.[1] as { path: string }).path, resolve("test-workspace/media/a.png"));
        assert.equal(h.events[0].text, "");
        assert.equal(h.events[0].replyToMessageId, "om_parent");
        assert.deepEqual(h.events[0].mediaInfo, mediaInfo);
    });

    it("saves hostile and repeated filenames as bounded unique workspace files", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "feishu-proxy-"));
        try {
            const bytes = Buffer.from([0, 255, 10, 40]);
            const h = harness(async () => ({ buffer: bytes.toString("base64"), size: bytes.length, fileName: `../../\\evil\\${"x".repeat(300)}.png` }));
            h.env.workspace = workspace;
            const proxy = createFeishuClientProxy(h.env, h.history);
            const first = await proxy.downloadMedia("img_test", "oc_test", "om_source", "unique");
            const second = await proxy.downloadMedia("img_test");
            assert.notEqual(first, second);
            assert.equal(dirname(first), join(await realpath(workspace), "Downloads"));
            assert.ok(basename(first).length <= 157);
            assert.ok(first.endsWith(".png"));
            assert.deepEqual(await readFile(first), bytes);
            assert.deepEqual(h.calls[0].args, ["img_test", "feishu:oc_test", "om_source", "unique"]);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it("rejects malformed, oversized and size-mismatched download envelopes", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "feishu-invalid-"));
        try {
            for (const result of [null, {}, { buffer: "!!!!" }, { buffer: "aGVsbG8=", size: 1 }]) {
                const h = harness(async () => result);
                h.env.workspace = workspace;
                await assert.rejects(createFeishuClientProxy(h.env, h.history).downloadMedia("img_test"), /Feishu downloadMedia/);
            }
            assert.deepEqual(await readdir(workspace), []);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it("rejects a Downloads symlink outside workspace", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "feishu-symlink-"));
        const outside = await mkdtemp(join(tmpdir(), "feishu-outside-"));
        try {
            await symlink(outside, join(workspace, "Downloads"));
            const h = harness(async () => ({ buffer: "aGVsbG8=" }));
            h.env.workspace = workspace;
            await assert.rejects(createFeishuClientProxy(h.env, h.history).downloadMedia("img_test"), /inside workspace/);
            assert.deepEqual(await readdir(outside), []);
        } finally {
            await rm(workspace, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        }
    });

    it("uses host envelope fileName and mimeType for real extensions, defaulting to .bin only when both are absent", async () => {
        const workspace = await mkdtemp(join(tmpdir(), "feishu-ext-"));
        try {
            const bytes = Buffer.from("data");
            const pdf = harness(async () => ({ buffer: bytes.toString("base64"), size: bytes.length, fileName: "report.pdf" }));
            pdf.env.workspace = workspace;
            const pdfPath = await createFeishuClientProxy(pdf.env, pdf.history).downloadMedia("file_ref");
            assert.ok(pdfPath.endsWith(".pdf"), pdfPath);
            assert.ok(!pdfPath.endsWith(".bin"));

            const image = harness(async () => ({ buffer: bytes.toString("base64"), size: bytes.length, mimeType: "image/png" }));
            image.env.workspace = workspace;
            const imagePath = await createFeishuClientProxy(image.env, image.history).downloadMedia("img_ref");
            assert.ok(imagePath.endsWith(".png"), imagePath);

            const nameless = harness(async () => ({ buffer: bytes.toString("base64"), size: bytes.length }));
            nameless.env.workspace = workspace;
            const binPath = await createFeishuClientProxy(nameless.env, nameless.history).downloadMedia("bin_ref");
            assert.ok(binPath.endsWith(".bin"), binPath);
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });
});

describe("Feishu sandbox API boundary", () => {
    it("binds only Feishu for its platform and tracks unawaited calls", async () => {
        const h = harness(async () => ({ messageId: "om_bound" }));
        setPlatform("feishu");
        try {
            const capabilities = installCapabilityRegistry(h.env);
            assert.equal(capabilities.telegram, undefined);
            assert.equal(capabilities.discord, undefined);
            assert.equal(capabilities.onebot, undefined);
            const tracker = createPromiseTracker();
            const proxy = tracker.wrap(capabilities.feishu as Record<string, unknown>) as unknown as FeishuClient;
            proxy.sendText("oc_binding", "hello");
            await tracker.flush();
            assert.equal(h.events.filter(event => event.type === "system.agent_message_sent").length, 1);
            assert.ok(transformNotebookCode("const feishu = 1;").errors.length > 0);
        } finally {
            setPlatform("telegram");
        }
    });

    it("forwards read and native API arguments", async () => {
        const h = harness(async () => null);
        await h.proxy.getMessage("oc_test", "om_source");
        await h.proxy.getHistory("oc_test", { pageSize: 10 });
        await h.proxy.getChat("feishu:oc_test");
        await h.proxy.callApi("feishu:oc_test", "pin.list", { params: { chat_id: "oc_test" } });
        assert.deepEqual(h.calls, [
            { method: "feishu.getMessage", args: ["feishu:oc_test", "om_source"] },
            { method: "feishu.getHistory", args: ["feishu:oc_test", { pageSize: 10 }] },
            { method: "feishu.getChat", args: ["feishu:oc_test"] },
            { method: "feishu.callApi", args: ["feishu:oc_test", "pin.list", { params: { chat_id: "oc_test" } }] },
        ]);
        assert.deepEqual(h.events, []);
        assert.deepEqual(h.outputs, []);
        await assert.rejects(h.proxy.getChat("telegram:oc_test"), /chatId/);
    });

    it("tracks and deduplicates native forwarding sends", async () => {
        let call = 0;
        const h = harness(async (_method, args) => {
            call += 1;
            const action = args?.[1];
            return action === "message.mergeForward"
                ? { data: { message: { message_id: `om_merge_${call}`, chat_id: "oc_test", sender: { id: "ou_bot" } } } }
                : { data: { message_id: `om_forward_${call}`, chat_id: "oc_test", sender: { id: "feishu:ou_bot" } } };
        });
        const forwardPayload = {
            path: { message_id: "om_source" },
            params: { receive_id_type: "chat_id" },
            data: { receive_id: "oc_test" },
        };
        const mergePayload = {
            params: { receive_id_type: "chat_id" },
            data: { receive_id: "oc_test", message_id_list: ["om_source"] },
        };

        await h.proxy.callApi("oc_test", "message.forward", forwardPayload);
        assert.equal(await h.proxy.callApi("oc_test", "message.forward", forwardPayload), null);
        await h.proxy.callApi("oc_test", "message.mergeForward", mergePayload);

        assert.equal(h.calls.length, 2);
        const sent = h.events.filter(event => event.type === "system.agent_message_sent");
        assert.deepEqual(sent.map(event => event.messageId), ["om_forward_1", "om_merge_2"]);
        assert.deepEqual(sent.map(event => event.senderUserId), ["feishu:ou_bot", "feishu:ou_bot"]);
        assert.equal(h.events.filter(event => event.type === "system.duplicate_message_blocked").length, 1);
    });

    it("blocks banned text in message and card mutations", async () => {
        const h = harness(async () => ({ updated: true }), ["forbidden"]);
        assert.equal(await h.proxy.updateTemplateCard("oc_test", "om_card", "template", { text: "forbidden" }), null);
        assert.equal(await h.proxy.updateCard("oc_test", "om_card", { elements: [{ text: "forbidden" }] }), null);
        assert.equal(await h.proxy.patchCard("oc_test", "om_card", [{ content: "forbidden" }]), null);
        assert.equal(await h.proxy.streamCardText("oc_test", "om_card", "answer", "forbidden"), null);
        assert.equal(await h.proxy.callApi("oc_test", "message.update", { path: { message_id: "om_card" }, data: { content: "forbidden" } }), null);
        assert.equal(h.calls.length, 0);
        assert.equal(h.events.length, 5);
        assert.ok(h.events.every(event => event.type === "system.banned_word_blocked"));
    });

    it("forwards sticker and card operations and archives only newly sent messages", async () => {
        let messageId = 0;
        const h = harness(async method => method.startsWith("feishu.send") ? { messageId: `om_sent_${++messageId}` } : { updated: true });
        await h.proxy.sendSticker("oc_test", "feishu-media:sticker", { replyToMessageId: "om_parent" });
        await h.proxy.sendTemplateCard("oc_test", "template_1", { title: "Hello" });
        await h.proxy.sendCard("oc_test", { schema: "2.0" });
        await h.proxy.updateTemplateCard("oc_test", "om_card", "template_2", { done: true });
        await h.proxy.updateCard("oc_test", "om_card", { schema: "2.0" }, { sequence: 10 });
        await h.proxy.patchCard("oc_test", "om_card", [{ type: "update" }], { sequence: 11 });
        await h.proxy.streamCardText("oc_test", "om_card", "answer", "partial", { sequence: 12 });

        assert.deepEqual(h.calls.map(call => call.method), [
            "feishu.sendSticker", "feishu.sendTemplateCard", "feishu.sendCard", "feishu.updateTemplateCard",
            "feishu.updateCard", "feishu.patchCard", "feishu.streamCardText",
        ]);
        assert.deepEqual(h.calls[1].args?.slice(0, 3), ["feishu:oc_test", "template_1", { title: "Hello" }]);
        assert.deepEqual(h.calls[4].args, ["feishu:oc_test", "om_card", { schema: "2.0" }, { sequence: 10 }]);
        assert.equal(h.events.filter(event => event.type === "system.agent_message_sent").length, 3);
    });

    it("provides Feishu-only execution guidance without relying on generated docs", async () => {
        const { getPlatformExecutionGuidance } = await import("../src/subagent/code-act-executor.js");
        const guidance = getPlatformExecutionGuidance("feishu");
        for (const term of ["feishu:oc_x", "om_x", "replyToMessageId", "replyInThread", "mentions", "sendMedia", "photo", "document", "audio", "video", "10 MiB", "30 MiB", "callApi", "getHistory", "sendSticker", "sendTemplateCard", "streamCardText", "forwardedMessages", "card.action.trigger", "additionalMessages", "captionError", "readUsers"]) {
            assert.ok(guidance.includes(term), term);
        }
        for (const platform of ["telegram", "discord", "onebot"]) {
            assert.equal(getPlatformExecutionGuidance(platform), "");
        }
    });

    it("extracts all Feishu interface methods for generated docs", async () => {
        const content = await readFile(new URL("../src/sandbox/modules/feishu/feishu.d.ts", import.meta.url), "utf8");
        const registry = parseDtsFile(content, "feishu/feishu.d.ts");
        const module = registry.find(entry => entry.name === "feishu");
        assert.ok(module);
        assert.deepEqual(module.methods.map(method => method.name).sort(), [
            "callApi", "downloadMedia", "getChat", "getHistory", "getMessage", "patchCard", "sendCard",
            "sendMedia", "sendMessage", "sendSticker", "sendTemplateCard", "sendText", "streamCardText", "updateCard", "updateTemplateCard",
        ]);
        assert.match(generateBriefOverview(registry), /sendText\(chatId, text, options\?\)/);
        assert.match(lookupFullDocs(registry, ["feishu.sendMedia"]), /FeishuMedia/);
        assert.match(module.typeDefs ?? "", /replyInThread\?: boolean/);
    });
});
