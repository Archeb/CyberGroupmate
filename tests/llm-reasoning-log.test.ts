import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toReasoningLog } from "../src/core/llm.js";

describe("Dashboard reasoning log redaction", () => {
    it("keeps Chat reasoning_content available for display", () => {
        assert.deepEqual(toReasoningLog({
            provider: "openai_chat",
            content: "visible chain of thought",
            tokenCount: 12,
        }), {
            provider: "openai_chat",
            tokenCount: 12,
            visibility: "plain",
            content: "visible chain of thought",
        });
    });

    it("shows Anthropic thinking without exposing its signature", () => {
        const result = toReasoningLog({
            provider: "anthropic",
            tokenCount: 23,
            blocks: [{ type: "thinking", thinking: "visible thinking", signature: "secret-signature" }],
        });

        assert.deepEqual(result, {
            provider: "anthropic",
            tokenCount: 23,
            visibility: "plain",
            content: "visible thinking",
        });
        assert.equal(JSON.stringify(result).includes("secret-signature"), false);
    });

    it("reports encrypted Responses reasoning without exposing ciphertext", () => {
        const result = toReasoningLog({
            provider: "openai_responses",
            tokenCount: 37,
            responseId: "resp-secret",
            websocketSessionId: "ws-secret",
            items: [{
                type: "reasoning",
                encrypted_content: "ciphertext-secret",
                summary: [],
            }],
        });

        assert.deepEqual(result, {
            provider: "openai_responses",
            tokenCount: 37,
            visibility: "encrypted",
        });
        const serialized = JSON.stringify(result);
        assert.equal(serialized.includes("ciphertext-secret"), false);
        assert.equal(serialized.includes("resp-secret"), false);
        assert.equal(serialized.includes("ws-secret"), false);
    });

    it("does not expose Responses summaries when the reasoning item is encrypted", () => {
        assert.deepEqual(toReasoningLog({
            provider: "openai_responses",
            items: [{
                type: "reasoning",
                encrypted_content: "ciphertext-secret",
                summary: [{ type: "summary_text", text: "visible summary" }],
            }],
        }, 41), {
            provider: "openai_responses",
            tokenCount: 41,
            visibility: "encrypted",
        });
    });

    it("still marks reasoning when only token usage is available", () => {
        assert.deepEqual(toReasoningLog(undefined, 9), {
            tokenCount: 9,
            visibility: "unavailable",
        });
    });
});
