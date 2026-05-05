import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { markChatAsRead } from "../src/adapter/read-receipts.js";
import type { PlatformAdapter } from "../src/adapter/platform-adapter.js";

function makeAdapter(platform: string, calls: string[]): PlatformAdapter {
    return {
        platform,
        start: async () => undefined,
        stop: async () => undefined,
        canHandle: () => false,
        handleCall: async () => undefined,
        getWriteMethods: () => [],
        formatMention: () => undefined,
        markAsRead: async (chatId: string) => {
            calls.push(chatId);
        },
    };
}

describe("read receipts", () => {
    it("marks a composite chat through the matching platform adapter", () => {
        const calls: string[] = [];
        const adapters = [
            makeAdapter("discord", calls),
            makeAdapter("telegram", calls),
        ];

        markChatAsRead(adapters, "telegram:12345", "test");

        assert.deepEqual(calls, ["telegram:12345"]);
    });

    it("silently ignores chats without a readable adapter", () => {
        const calls: string[] = [];

        markChatAsRead([makeAdapter("telegram", calls)], "onebot:group:12345", "test");

        assert.deepEqual(calls, []);
    });

    it("keeps read receipt failures non-critical", () => {
        const adapter = {
            ...makeAdapter("telegram", []),
            markAsRead: () => {
                throw new Error("read failed");
            },
        } as PlatformAdapter;

        assert.doesNotThrow(() => markChatAsRead([adapter], "telegram:12345", "test"));
    });
});
