/**
 * feishu-emoji.test.ts — 飞书 emoji_type 语义化单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { feishuEmojiName, formatFeishuEmoji, formatFeishuReaction } from "../src/core/feishu-emoji.js";

describe("feishuEmojiName", () => {
    it("resolves official enum names", () => {
        assert.equal(feishuEmojiName("THUMBSUP"), "赞");
        assert.equal(feishuEmojiName("SPITBLOOD"), "吐血");
    });

    it("resolves client emoji names including Lark_Emoji_ form", () => {
        assert.equal(feishuEmojiName("Lark_Emoji_FingerHeart_0"), "比心");
        assert.equal(feishuEmojiName("Lark_Emoji_Facepalm_0"), "捂脸");
        assert.equal(feishuEmojiName("Lark_Emoji_haughty_0"), "酷拽");
    });

    it("is case insensitive for enum names", () => {
        assert.equal(feishuEmojiName("thumbsup"), "赞");
    });

    it("labels unknown numeric ids as custom", () => {
        assert.equal(feishuEmojiName("7600608696380558562"), "自定义表情 7600608696380558562");
    });

    it("derives a readable name from an unmapped client emoji name", () => {
        assert.equal(feishuEmojiName("Lark_Emoji_SomeNewThing_0"), "Some New Thing");
    });

    it("keeps unknown short names opaque", () => {
        assert.equal(feishuEmojiName("WHATEVER"), "WHATEVER");
        assert.equal(feishuEmojiName("  "), "");
    });

    it("covers documented-only emoji missing from the client table", () => {
        assert.equal(feishuEmojiName("LGTM"), "LGTM");
        assert.equal(feishuEmojiName("OKR"), "OKR");
        assert.equal(feishuEmojiName("TV"), "电视");
    });
});

describe("formatFeishuEmoji", () => {
    it("renders a model-readable tag", () => {
        assert.equal(formatFeishuEmoji("Lark_Emoji_FingerHeart_0"), "[🎭 飞书表情:比心]");
        assert.equal(formatFeishuEmoji("7600608696380558562"), "[🎭 飞书表情:7600608696380558562]");
        assert.equal(formatFeishuEmoji(""), "[🎭 飞书表情]");
    });
});

describe("formatFeishuReaction", () => {
    it("renders Chinese reaction text", () => {
        assert.equal(formatFeishuReaction("added", "THUMBSUP"), "[👍 表态] 给消息点了「赞」");
        assert.equal(formatFeishuReaction("removed", "Lark_Emoji_FingerHeart_0"), "[👍 表态] 撤回了「比心」");
        assert.equal(formatFeishuReaction("added", "7600608696380558562"), "[👍 表态] 给消息点了「自定义表情 7600608696380558562」");
    });
});
