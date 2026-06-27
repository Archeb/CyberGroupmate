/**
 * tests/quotes-privacy.test.ts — 派发引用(quote)的 target-aware 隐私兜底回归
 *
 * 回归 bug：私密群内回复时，引用「该群自己」的原文被错误拦截（boundChatId="" 把本会话也当跨界）。
 * 正确：引用目标会话自己的私密内容放行；引用别的私密会话内容才拦截。
 */

import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearConfigCache } from "../src/core/config.js";
import { resolveQuoteRefs, type ParsedQuoteRef } from "../src/meta-sandbox/meta-api/quotes.js";

const PRIV = "telegram:-100priv";

function fakeMemory(): any {
    return {
        getGroupModel: (key: string) =>
            key === PRIV
                ? { chatId: PRIV, chatTitle: "私群", markedSensitive: true, isDirectMessage: false }
                : { chatId: key, chatTitle: key },
        getRecentMessages: () => [
            { messageId: "1", chatId: PRIV, userId: "u", displayName: "U", text: "secret cat msg", timestamp: new Date(0).toISOString() },
        ],
    };
}

const chatRef: ParsedQuoteRef = { kind: "chat", raw: `@${PRIV}`, chatId: PRIV, source: "test" };

describe("quote 隐私：派发引用按目标会话 target-aware", () => {
    before(() => clearConfigCache()); // 用默认 privacy（enforce=block）；markedSensitive 使 PRIV 判私密

    it("派发到该私密会话自己 → 引用其原文放行（修复点）", async () => {
        const r = await resolveQuoteRefs([chatRef], { memory: fakeMemory(), boundChatId: PRIV });
        assert.ok(r.items[0].content.includes("secret cat msg"), "本会话内引用应保留正文");
    });

    it("派发到别的会话 → 引用私密会话原文被拦截", async () => {
        const r = await resolveQuoteRefs([chatRef], { memory: fakeMemory(), boundChatId: "telegram:-100other" });
        assert.equal(r.items[0].content, "");
        assert.ok(r.items[0].warnings.some((w) => w.includes("私密")), "应给出隐私拦截警告");
    });

    it("无派发目标(boundChatId 省略) → 最严，私密内容拦截", async () => {
        const r = await resolveQuoteRefs([chatRef], { memory: fakeMemory() });
        assert.equal(r.items[0].content, "");
    });
});
