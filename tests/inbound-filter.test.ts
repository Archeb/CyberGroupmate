import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { releaseChatFromFilter, shouldDropInbound } from "../src/core/inbound-filter.js";

describe("inbound access control release", () => {
    it("adds a blocked chat to a whitelist", () => {
        const config = { enabled: true, mode: "whitelist" as const, chatIds: ["telegram:allowed"] };
        assert.equal(shouldDropInbound(config, { chatId: "telegram:new" }), true);

        const released = releaseChatFromFilter(config, "telegram:new");

        assert.equal(shouldDropInbound(released, { chatId: "telegram:new" }), false);
        assert.deepEqual(released.chatIds, ["telegram:allowed", "telegram:new"]);
        assert.deepEqual(config.chatIds, ["telegram:allowed"], "input config must not be mutated");
    });

    it("removes an exact blacklist entry", () => {
        const config = { enabled: true, mode: "blacklist" as const, chatIds: ["telegram:blocked", "discord:keep"] };

        const released = releaseChatFromFilter(config, "telegram:blocked");

        assert.equal(shouldDropInbound(released, { chatId: "telegram:blocked" }), false);
        assert.deepEqual(released.chatIds, ["discord:keep"]);
    });

    it("uses a per-chat exception without deleting a wildcard blacklist", () => {
        const config = { enabled: true, mode: "blacklist" as const, chatIds: ["discord:*"] };

        const released = releaseChatFromFilter(config, "discord:channel:123");

        assert.deepEqual(released.chatIds, ["discord:*"]);
        assert.deepEqual(released.allowedChatIds, ["discord:channel:123"]);
        assert.equal(shouldDropInbound(released, { chatId: "discord:channel:123" }), false);
        assert.equal(shouldDropInbound(released, { chatId: "discord:channel:456" }), true);
    });

    it("releases the whole chat from sender blacklist rules", () => {
        const config = { enabled: true, mode: "blacklist" as const, userIds: ["telegram:bad-user"] };
        assert.equal(shouldDropInbound(config, { chatId: "telegram:chat", userId: "telegram:bad-user" }), true);

        const released = releaseChatFromFilter(config, "telegram:chat");

        assert.equal(shouldDropInbound(released, { chatId: "telegram:chat", userId: "telegram:bad-user" }), false);
        assert.equal(shouldDropInbound(released, { chatId: "telegram:other", userId: "telegram:bad-user" }), true);
    });
});
