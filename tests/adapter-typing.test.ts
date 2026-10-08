import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PlatformAdapter } from "../src/adapter/platform-adapter.js";
import { createTypingSender } from "../src/adapter/typing.js";

function adapter(platform: string, supported: boolean, calls: Array<{ method: string; args: unknown[] }>): PlatformAdapter {
    return {
        platform,
        start: async () => undefined,
        stop: async () => undefined,
        canHandle: method => supported && method === `${platform}.sendTyping`,
        handleCall: async (method, args) => { calls.push({ method, args }); },
        getWriteMethods: () => [],
        formatMention: () => undefined,
    };
}

describe("adapter typing capability", () => {
    it("does not create a typing callback for an unsupported adapter", () => {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        assert.equal(createTypingSender(adapter("feishu", false, calls)), undefined);
        assert.deepEqual(calls, []);
    });

    it("routes typing through an adapter that declares the capability", async () => {
        const calls: Array<{ method: string; args: unknown[] }> = [];
        const sendTyping = createTypingSender(adapter("telegram", true, calls));
        await sendTyping!("telegram:123");
        assert.deepEqual(calls, [{ method: "telegram.sendTyping", args: ["telegram:123"] }]);
    });
});
