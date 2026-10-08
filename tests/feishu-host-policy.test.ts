import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { userGate } from "../src/adapter/user-gate.js";
import { clearConfigCache, loadConfig } from "../src/core/config.js";
import type { GroupModelVisibilityFields } from "../src/core/visibility-policy.js";
import { createSandboxHostCallHandler } from "../src/sandbox/host-call-handler.js";

const BOUND = "feishu:oc_bound";
const OTHER = "feishu:oc_other";
const reference = (chatId: string, overrides: Record<string, unknown> = {}) => encode({
    chatId, messageId: "om_message", key: "img_key", type: "image", ...overrides,
});
const encode = (value: unknown) => `feishu-media:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;

function makeHandler(boundChatId = BOUND, models: Record<string, GroupModelVisibilityFields> = {}) {
    const config = loadConfig(new URL("./feishu-host-policy.missing.yaml", import.meta.url).pathname, true);
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const lookups: string[] = [];
    const adapters = ["feishu", "telegram", "discord", "onebot"].map(platform => ({
        platform,
        canHandle: (method: string) => method.startsWith(`${platform}.`),
        getWriteMethods: () => platform === "feishu" ? [
            "feishu.sendText", "feishu.sendMedia", "feishu.sendSticker", "feishu.sendTemplateCard", "feishu.sendCard",
            "feishu.updateTemplateCard", "feishu.updateCard", "feishu.patchCard", "feishu.streamCardText",
        ] : [`${platform}.sendText`, `${platform}.sendMedia`],
        handleCall: async (method: string, args: unknown[]) => {
            calls.push({ method, args });
            return { ok: true };
        },
    }));
    const handler = createSandboxHostCallHandler(boundChatId, {
        appConfig: config,
        globalState: {},
        accumulator: {},
        memory: {
            getGroupModel: (key: string) => {
                lookups.push(key);
                return models[key] ?? null;
            },
        },
        adapters,
        sandbox: {},
        sandboxPool: {},
        mcpBridge: {},
        buildEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        getCurrentEnvPlan: () => ({ hostVisible: {}, sandboxVisible: {}, managedKeys: [] }),
        setCurrentEnvPlan: () => undefined,
        applyHostManagedEnv: () => undefined,
    } as any);
    return { handler, calls, lookups, config };
}

function reads(chatId: string): Array<[string, unknown[]]> {
    return [
        ["feishu.getMessage", [chatId, "om_message"]],
        ["feishu.getHistory", [chatId, { pageSize: 10 }]],
        ["feishu.getChat", [chatId]],
        ["feishu.callApi", [chatId, "pin.list", { params: { chat_id: String(chatId).replace(/^feishu:/, "") } }]],
        ["feishu.downloadMedia", [reference(chatId), chatId]],
        ["feishu.downloadMedia", [reference(chatId)]],
    ];
}

afterEach(() => clearConfigCache());

describe("Feishu host read policy boundaries", () => {
    it("rejects global chat discovery before the adapter for every privacy setting", async () => {
        for (const enforce of ["block", "warn", "off"] as const) {
            for (const action of ["chat.list", "chat.search"]) {
                const { handler, calls, config } = makeHandler();
                config.privacy.enforce = enforce;
                await assert.rejects(handler("feishu.callApi", [BOUND, action, {}]), /global chat discovery/);
                assert.deepEqual(calls, []);
            }
        }
    });

    it("allows raw and composite bound targets even when their visibility is private", async () => {
        for (const chatId of [BOUND, "oc_bound"]) {
            for (const [method, args] of reads(chatId)) {
                const { handler, calls } = makeHandler(BOUND, { [BOUND]: { isDirectMessage: true } });
                assert.deepEqual(await handler(method, args), { ok: true });
                assert.deepEqual(calls, [{ method, args }]);
            }
        }
    });

    it("uses the existing visibility policy for DM, marked-sensitive and seeded targets", async () => {
        for (const visibility of ["dm", "marked", "seed"] as const) {
            for (const [method, args] of reads("oc_other")) {
                const models = visibility === "dm" ? { isDirectMessage: true } : { markedSensitive: visibility === "marked" };
                const { handler, calls, lookups, config } = makeHandler(BOUND, { [OTHER]: models });
                if (visibility === "seed") config.privacy.sensitiveChats = [OTHER];
                await assert.rejects(handler(method, args), /target chat is private/);
                if (visibility !== "seed") assert.ok(lookups.includes(OTHER));
                assert.deepEqual(calls, []);
            }
        }
    });

    it("denies cross-chat reads even for known shared targets and disabled privacy enforcement", async () => {
        for (const enforce of ["block", "warn", "off"] as const) {
            for (const model of [undefined, { isDirectMessage: false }, { isDirectMessage: true }]) {
                for (const [method, args] of reads(OTHER)) {
                    const { handler, calls, config } = makeHandler(BOUND, model ? { [OTHER]: model } : {});
                    config.privacy.enforce = enforce;
                    await assert.rejects(handler(method, args), /target chat is private|only allows reads from the bound chat/);
                    assert.deepEqual(calls, []);
                }
            }
        }
    });

    it("denies unknown targets from background and non-Feishu bindings", async () => {
        for (const bound of ["__background__", "telegram:oc_bound"]) {
            for (const [method, args] of reads(BOUND)) {
                const { handler, calls } = makeHandler(bound);
                await assert.rejects(handler(method, args), /only allows reads from the bound chat/);
                assert.deepEqual(calls, []);
            }
        }
    });

    it("rejects absent, malformed and wrong-platform explicit chat targets", async () => {
        for (const target of [undefined, null, "", " ", 123, {}, "oc_", "feishu:ou_user", "telegram:oc_bound", `${BOUND} `]) {
            for (const method of ["feishu.getMessage", "feishu.getChat"]) {
                const { handler, calls } = makeHandler();
                await assert.rejects(handler(method, [target, "om_message"]), /valid chatId/);
                assert.deepEqual(calls, []);
            }
        }
    });

    it("checks the encoded media chat even when an explicit bound chat is provided", async () => {
        for (const [encodedChat, explicitChat] of [[OTHER, BOUND], [BOUND, OTHER]]) {
            const { handler, calls } = makeHandler();
            await assert.rejects(handler("feishu.downloadMedia", [reference(encodedChat), explicitChat]), /media ownership mismatch/);
            assert.deepEqual(calls, []);
        }
        const { handler, calls } = makeHandler();
        const args = [reference("oc_bound", { type: "file" }), BOUND, "om_message"];
        assert.deepEqual(await handler("feishu.downloadMedia", args), { ok: true });
        assert.deepEqual(calls, [{ method: "feishu.downloadMedia", args }]);
    });

    it("rejects invalid encoded media references before the adapter regardless of explicit chat", async () => {
        const invalid = [
            undefined, null, {}, "", "img_key", "feishu-media:", "feishu-media:!",
            "feishu-media:bm90LWpzb24", `feishu-media:${"a".repeat(4096)}`,
            encode(null), encode([]), encode({}), reference("telegram:oc_bound"),
            reference(BOUND, { chatId: 42 }), reference(BOUND, { messageId: null }),
            reference(BOUND, { messageId: "oc_chat" }), reference(BOUND, { key: "" }),
            reference(BOUND, { key: 1 }), reference(BOUND, { type: "photo" }),
        ];
        for (const fileId of invalid) {
            for (const explicitChat of [undefined, BOUND]) {
                const { handler, calls } = makeHandler();
                await assert.rejects(handler("feishu.downloadMedia", [fileId, explicitChat]), /invalid media reference/);
                assert.deepEqual(calls, []);
            }
        }
    });

    it("does not treat null or empty explicit media chat as absent", async () => {
        for (const target of [null, "", 42]) {
            const { handler, calls } = makeHandler();
            await assert.rejects(handler("feishu.downloadMedia", [reference(BOUND), target]), /valid chatId/);
            assert.deepEqual(calls, []);
        }
    });

    it("requires a sticker source from the bound chat before allowing the send", async () => {
        const source = (chatId: string) => reference(chatId, { type: "file", key: "sticker_key" });
        const allowed = makeHandler();
        const allowedArgs = [BOUND, source(BOUND), {}];
        assert.deepEqual(await allowed.handler("feishu.sendSticker", allowedArgs), { ok: true });
        assert.deepEqual(allowed.calls, [{ method: "feishu.sendSticker", args: allowedArgs }]);

        const crossSource = makeHandler(BOUND, { [OTHER]: { isDirectMessage: true } });
        await assert.rejects(crossSource.handler("feishu.sendSticker", [BOUND, source(OTHER), {}]), /target chat is private|only allows reads from the bound chat/);
        assert.deepEqual(crossSource.calls, []);

        const crossTarget = makeHandler(BOUND, { [BOUND]: { isDirectMessage: true } });
        await assert.rejects(crossTarget.handler("feishu.sendSticker", [OTHER, source(BOUND), {}]), /私密.*禁止向其它 chat/);
        assert.deepEqual(crossTarget.calls, []);
    });

    it("treats template and CardKit operations as writes", async () => {
        for (const [method, args] of [
            ["feishu.sendTemplateCard", [OTHER, "template", {}, {}]],
            ["feishu.sendCard", [OTHER, { schema: "2.0" }, {}]],
            ["feishu.updateTemplateCard", [OTHER, "om_card", "template", {}]],
            ["feishu.updateCard", [OTHER, "om_card", { schema: "2.0" }, {}]],
            ["feishu.patchCard", [OTHER, "om_card", [], {}]],
            ["feishu.streamCardText", [OTHER, "om_card", "answer", "text", {}]],
        ] as Array<[string, unknown[]]>) {
            const { handler, calls } = makeHandler(BOUND, { [BOUND]: { isDirectMessage: true } });
            await assert.rejects(handler(method, args), /私密.*禁止向其它 chat/);
            assert.deepEqual(calls, []);
        }
    });

    it("leaves other platform reads unchanged", async () => {
        for (const platform of ["telegram", "discord", "onebot"]) {
            for (const method of ["getMessage", "getChat", "downloadMedia"]) {
                const { handler, calls } = makeHandler(`${platform}:bound`);
                const args = method === "downloadMedia" ? ["opaque-file", `${platform}:other`] : [`${platform}:other`, "message"];
                const fullMethod = `${platform}.${method}`;
                assert.deepEqual(await handler(fullMethod, args), { ok: true });
                assert.deepEqual(calls, [{ method: fullMethod, args }]);
            }
        }
    });

    it("keeps underscore-bearing ids through bound-chat reads and emergency block", async t => {
        const bound = "feishu:oc_a_b";
        const block = t.mock.method(userGate, "block", () => ({ newlyBlocked: true }));
        const { handler, calls } = makeHandler(bound, { [bound]: { isDirectMessage: true } });
        for (const [method, args] of [...reads("oc_a_b"), ...reads(bound)]) {
            assert.deepEqual(await handler(method, args), { ok: true });
        }
        assert.deepEqual(await handler("emergency.block", ["feishu:ou_x_y"]), { userId: "feishu:ou_x_y", blocked: true, alreadyBlocked: false, notified: true });
        assert.deepEqual(block.mock.calls[0].arguments, ["feishu:ou_x_y"]);
        assert.ok(calls.every(call => call.method.startsWith("feishu.")));
    });
});

describe("Feishu emergency.block identity boundary", () => {
    it("requires an explicit Feishu open user ID before blocking or notifying", async t => {
        const block = t.mock.method(userGate, "block", () => ({ newlyBlocked: true }));
        const { handler, calls } = makeHandler();
        for (const userId of [undefined, null, "", " ", 42, {}, BOUND, "oc_bound", "ou_user", "telegram:ou_user", "feishu:ou_", "feishu:ou_bad/id"]) {
            await assert.rejects(handler("emergency.block", [userId]), /explicit Feishu userId.*feishu:ou_.*sender's userId/);
        }
        assert.equal(block.mock.callCount(), 0);
        assert.deepEqual(calls, []);
    });

    it("accepts an explicit open user ID and keeps the notification bound to the chat", async t => {
        const block = t.mock.method(userGate, "block", () => ({ newlyBlocked: true }));
        const { handler, calls } = makeHandler();
        const result = await handler("emergency.block", [" feishu:ou_user "]);
        assert.deepEqual(block.mock.calls[0].arguments, ["feishu:ou_user"]);
        assert.deepEqual(result, { userId: "feishu:ou_user", blocked: true, alreadyBlocked: false, notified: true });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, "feishu.sendText");
        assert.equal(calls[0].args[0], BOUND);
    });

    it("preserves missing-user defaults on other platforms", async t => {
        const block = t.mock.method(userGate, "block", () => ({ newlyBlocked: false }));
        for (const bound of ["telegram:123", "discord:456", "onebot:private:789"]) {
            const { handler, calls } = makeHandler(bound);
            const result = await handler("emergency.block", []);
            assert.deepEqual(result, { userId: bound, blocked: true, alreadyBlocked: true, notified: false });
            assert.deepEqual(calls, []);
        }
        assert.deepEqual(block.mock.calls.map(call => call.arguments[0]), ["telegram:123", "discord:456", "onebot:private:789"]);
    });
});
