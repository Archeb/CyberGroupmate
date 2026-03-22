/**
 * chat-id.test.ts — Composite ChatId 工具函数 单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    composeChatId,
    parseChatId,
    getPlatform,
    isDiscord,
    isTelegram,
    chatIdToFileName,
    fileNameToChatId,
    getGroupChatId,
    isValidCompositeChatId,
} from "../src/core/chat-id.js";

describe("Composite ChatId 工具函数", () => {

    // ─── composeChatId ───

    describe("composeChatId", () => {
        it("Telegram 二段式", () => {
            assert.equal(composeChatId("telegram", "-1001234567"), "telegram:-1001234567");
        });

        it("Discord 三段式 (guild + channel)", () => {
            assert.equal(
                composeChatId("discord", "guild123", "chan456"),
                "discord:guild123:chan456",
            );
        });

        it("Discord 二段式 DM", () => {
            assert.equal(composeChatId("discord", "user789"), "discord:user789");
        });

        it("空 rawId 抛出", () => {
            assert.throws(() => composeChatId("telegram", ""), /rawId 不能为空/);
        });

        it("无效平台抛出", () => {
            assert.throws(() => composeChatId("whatsapp" as any, "123"), /无效的平台名/);
        });
    });

    // ─── parseChatId ───

    describe("parseChatId", () => {
        it("Telegram 二段式", () => {
            const result = parseChatId("telegram:-1001234567");
            assert.equal(result.platform, "telegram");
            assert.equal(result.rawId, "-1001234567");
            assert.equal(result.groupId, undefined);
            assert.equal(result.channelId, undefined);
        });

        it("Discord 三段式", () => {
            const result = parseChatId("discord:guild123:chan456");
            assert.equal(result.platform, "discord");
            assert.equal(result.rawId, "guild123:chan456");
            assert.equal(result.groupId, "guild123");
            assert.equal(result.channelId, "chan456");
        });

        it("Discord 二段式 DM", () => {
            const result = parseChatId("discord:user789");
            assert.equal(result.platform, "discord");
            assert.equal(result.rawId, "user789");
            assert.equal(result.groupId, undefined);
            assert.equal(result.channelId, undefined);
        });

        it("空字符串抛出", () => {
            assert.throws(() => parseChatId(""), /不能为空/);
        });

        it("无前缀抛出", () => {
            assert.throws(() => parseChatId("-1001234567"), /缺少平台前缀/);
        });

        it("未知平台抛出", () => {
            assert.throws(() => parseChatId("line:12345"), /未知平台/);
        });

        it("空 rawId 抛出", () => {
            assert.throws(() => parseChatId("telegram:"), /rawId 部分为空/);
        });
    });

    // ─── getPlatform ───

    describe("getPlatform", () => {
        it("Telegram", () => {
            assert.equal(getPlatform("telegram:-1001234567"), "telegram");
        });

        it("Discord", () => {
            assert.equal(getPlatform("discord:guild:chan"), "discord");
        });

        it("无效输入抛出", () => {
            assert.throws(() => getPlatform("12345"), /不是有效的 composite chatId/);
        });
    });

    // ─── isDiscord / isTelegram ───

    describe("isDiscord / isTelegram", () => {
        it("isDiscord 正确判断", () => {
            assert.equal(isDiscord("discord:guild:chan"), true);
            assert.equal(isDiscord("telegram:-100"), false);
        });

        it("isTelegram 正确判断", () => {
            assert.equal(isTelegram("telegram:-100"), true);
            assert.equal(isTelegram("discord:guild:chan"), false);
        });
    });

    // ─── chatIdToFileName / fileNameToChatId ───

    describe("chatIdToFileName / fileNameToChatId", () => {
        it("Telegram 往返转换", () => {
            const chatId = "telegram:-1001234567";
            const fileName = chatIdToFileName(chatId);
            assert.equal(fileName, "telegram_-1001234567");
            assert.equal(fileNameToChatId(fileName), chatId);
        });

        it("Discord 三段式往返转换", () => {
            const chatId = "discord:guild123:chan456";
            const fileName = chatIdToFileName(chatId);
            assert.equal(fileName, "discord_guild123_chan456");
            assert.equal(fileNameToChatId(fileName), chatId);
        });

        it("Discord 二段式 DM 往返转换", () => {
            const chatId = "discord:user789";
            const fileName = chatIdToFileName(chatId);
            assert.equal(fileName, "discord_user789");
            assert.equal(fileNameToChatId(fileName), chatId);
        });

        it("带 .json 扩展名的文件名", () => {
            assert.equal(
                fileNameToChatId("telegram_-1001234567.json"),
                "telegram:-1001234567",
            );
        });

        it("无效文件名抛出", () => {
            assert.throws(() => fileNameToChatId("noplatform"), /缺少 _ 分隔符/);
        });

        it("未知平台文件名抛出", () => {
            assert.throws(() => fileNameToChatId("line_12345"), /未知平台/);
        });
    });

    // ─── getGroupChatId ───

    describe("getGroupChatId", () => {
        it("Telegram: 自身即 group", () => {
            assert.equal(
                getGroupChatId("telegram:-1001234567"),
                "telegram:-1001234567",
            );
        });

        it("Discord 三段式: 取 guild 级别", () => {
            assert.equal(
                getGroupChatId("discord:guild123:chan456"),
                "discord:guild123",
            );
        });

        it("Discord DM: 自身即 group", () => {
            assert.equal(
                getGroupChatId("discord:user789"),
                "discord:user789",
            );
        });
    });

    // ─── isValidCompositeChatId ───

    describe("isValidCompositeChatId", () => {
        it("有效的 composite key", () => {
            assert.equal(isValidCompositeChatId("telegram:-1001234567"), true);
            assert.equal(isValidCompositeChatId("discord:guild:chan"), true);
        });

        it("无效的输入", () => {
            assert.equal(isValidCompositeChatId(""), false);
            assert.equal(isValidCompositeChatId("-1001234567"), false);
            assert.equal(isValidCompositeChatId("line:12345"), false);
        });
    });
});
