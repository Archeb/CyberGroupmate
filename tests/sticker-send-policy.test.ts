import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StickerSendPolicy, type StickerPolicyStore, type StickerSendingMode } from "../src/core/sticker-send-policy.js";

function createStore(): StickerPolicyStore {
    return {
        getStickerDescription(uniqueFileId: string) {
            const entry = STICKERS.find(item => item.uniqueFileId === uniqueFileId);
            if (!entry) return null;
            return {
                description: entry.description,
                emoji: entry.emojis[0],
                emojis: entry.emojis,
                enabled: entry.enabled,
            };
        },
        getAllStickerDescriptions() {
            return STICKERS.map(item => ({ ...item }));
        },
    };
}

const STICKERS = [
    { uniqueFileId: "sticker-enabled", description: "一只开心的猫在打滚", emojis: ["😂", "🐱"], enabled: true },
    { uniqueFileId: "sticker-disabled", description: "一只难过的猫在哭", emojis: ["😢", "🐱"], enabled: false },
    { uniqueFileId: "sticker-party", description: "庆祝派对的狗狗", emojis: ["🎉", "🐶"], enabled: true },
];

function createPolicy(mode: StickerSendingMode): StickerSendPolicy {
    return new StickerSendPolicy(createStore(), () => mode);
}

describe("StickerSendPolicy.assertSendAllowed", () => {
    it("allow_all does not restrict sending", () => {
        const policy = createPolicy("allow_all");
        policy.assertSendAllowed("sticker-disabled");
        policy.assertSendAllowed("not-in-library");
        policy.assertSendAllowed(undefined);
    });

    it("allow_listed permits enabled stickers only", () => {
        const policy = createPolicy("allow_listed");
        policy.assertSendAllowed("sticker-enabled");
        assert.throws(() => policy.assertSendAllowed("sticker-disabled"));
        assert.throws(() => policy.assertSendAllowed("not-in-library"));
    });

    it("allow_listed rejects missing uniqueFileId (sendMedia bypass)", () => {
        const policy = createPolicy("allow_listed");
        assert.throws(
            () => policy.assertSendAllowed(undefined),
            /uniqueFileId/,
        );
    });

    it("rejection message guides the agent to searchStickers", () => {
        const policy = createPolicy("allow_listed");
        assert.throws(
            () => policy.assertSendAllowed("sticker-disabled", { method: "telegram.sendSticker", searchApi: "telegram.searchStickers" }),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.match(err.message, /telegram\.sendSticker/);
                assert.match(err.message, /不在允许列表/);
                assert.match(err.message, /telegram\.searchStickers/);
                return true;
            },
        );
    });

    it("disallow_all rejects everything", () => {
        const policy = createPolicy("disallow_all");
        assert.throws(() => policy.assertSendAllowed("sticker-enabled"), /disallow_all/);
        assert.throws(() => policy.assertSendAllowed("anything"), /disallow_all/);
    });
});

describe("StickerSendPolicy.searchStickers", () => {
    it("allow_listed returns only enabled stickers", () => {
        const policy = createPolicy("allow_listed");
        const results = policy.searchStickers({});
        assert.equal(results.length, 2);
        assert.ok(results.every(item => item.enabled));
    });

    it("filters by emoji", () => {
        const policy = createPolicy("allow_listed");
        const results = policy.searchStickers({ emoji: "🐱" });
        assert.deepEqual(results.map(item => item.uniqueFileId), ["sticker-enabled"]);
    });

    it("filters by keywords with AND semantics (case-insensitive)", () => {
        const policy = createPolicy("allow_all");
        const results = policy.searchStickers({ keywords: "猫 难过" });
        assert.deepEqual(results.map(item => item.uniqueFileId), ["sticker-disabled"]);
    });

    it("returns empty in disallow_all mode", () => {
        const policy = createPolicy("disallow_all");
        assert.deepEqual(policy.searchStickers({ emoji: "😂" }), []);
    });

    it("respects the limit cap", () => {
        const policy = createPolicy("allow_listed");
        assert.equal(policy.searchStickers({ limit: 1 }).length, 1);
        assert.equal(policy.searchStickers({ limit: 999 }).length, 2);
    });
});
