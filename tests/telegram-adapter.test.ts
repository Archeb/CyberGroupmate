/**
 * telegram-adapter.test.ts — TelegramAdapter 登录与 ingress 测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { NotificationCenter } from "../src/event/notification-center.js";
import { TelegramAdapter } from "../src/adapter/telegram-adapter.js";
import type { TelegramConfig } from "../src/core/config.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `tg-adapter-${randomUUID()}.jsonl`), false);
}

function makeConfig(overrides: Partial<TelegramConfig> = {}): TelegramConfig {
    return {
        mode: "bot",
        botToken: "bot-token",
        apiId: "12345",
        apiHash: "hash",
        phone: "",
        ...overrides,
    };
}

function hasCommand(command: string): boolean {
    try {
        execFileSync(command, ["-version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function cleanupConvertedTelegramStickers(baseName: string): void {
    const dir = join(process.cwd(), "workspace", "Downloads", "other", "tg-converted");
    try {
        for (const file of fs.readdirSync(dir)) {
            if (file.startsWith(`${baseName}_`)) {
                fs.rmSync(join(dir, file), { force: true });
            }
        }
    } catch {
        // ignore absent conversion cache
    }
}

describe("TelegramAdapter", () => {
    it("should start in bot mode without prompting OTP", async () => {
        const nc = makeNC();
        const prompts: string[] = [];
        const startCalls: Array<Record<string, unknown>> = [];

        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;
        const fakeClient = {
            async start(params: Record<string, unknown>) {
                startCalls.push(params);
                return { id: 42, displayName: "BotUser", isBot: true };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() {
                    newMessageHandler = null;
                },
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async (prompt) => {
                prompts.push(prompt);
                return "unused";
            },
            () => {},
            async () => fakeClient,
        );

        await adapter.start();

        assert.equal(startCalls.length, 1);
        assert.deepEqual(startCalls[0], { botToken: "bot-token" });
        assert.equal(prompts.length, 0);
        assert.ok(newMessageHandler);

        await adapter.stop();
        nc.dispose();
    });

    it("should support userbot OTP and password prompts", async () => {
        const nc = makeNC();
        const prompts: string[] = [];
        const printed: string[] = [];
        const startCalls: Array<Record<string, unknown>> = [];

        const fakeClient = {
            async start(params: Record<string, unknown>) {
                startCalls.push(params);

                const phone = await (params.phone as () => string)();
                const code = await (params.code as () => Promise<string>)();
                const password = await (params.password as () => Promise<string>)();
                (params.codeSentCallback as (sentCode: { type: string }) => void)({ type: "sms" });

                assert.equal(phone, "+8613800000000");
                assert.equal(code, "123456");
                assert.equal(password, "pass-2fa");

                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add() {},
                remove() {},
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig({
                mode: "userbot",
                botToken: "",
                phone: "+8613800000000",
            }),
            nc,
            async (prompt) => {
                prompts.push(prompt);
                return prompt.includes("两步验证") ? "pass-2fa" : "123456";
            },
            (message) => {
                printed.push(message);
            },
            async () => fakeClient,
        );

        await adapter.start();

        assert.equal(startCalls.length, 1);
        assert.equal(typeof startCalls[0].phone, "function");
        assert.equal(typeof startCalls[0].code, "function");
        assert.equal(typeof startCalls[0].password, "function");
        assert.equal(typeof startCalls[0].codeSentCallback, "function");
        assert.deepEqual(prompts, ["请输入 Telegram 验证码: ", "请输入 Telegram 两步验证密码: "]);
        assert.ok(printed.some(line => line.includes("验证码已发送")));
        assert.ok(printed.some(line => line.includes("TelegramAdapter 已启动")));

        await adapter.stop();
        nc.dispose();
    });

    it("should normalize incoming messages into nc.message events", async () => {
        const nc = makeNC();
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() {
                    newMessageHandler = null;
                },
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
        );

        await adapter.start();
        assert.ok(newMessageHandler);

        await newMessageHandler!({
            id: 555,
            text: "hello from telegram",
            date: new Date("2026-03-08T12:00:00.000Z"),
            isMention: true,
            chat: { id: -100123, title: "Test Group", type: "supergroup" },
            sender: { id: 777, displayName: "Alice", isBot: false },
        });

        const events = await nc.drain(0, 10);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "nc.message");
        assert.equal(events[0].scene, "telegram");
        assert.equal(events[0].chatId, "-100123");
        assert.equal(events[0].messageId, "555");
        assert.equal(events[0].displayName, "Alice");
        assert.equal(events[0].mentionsAgent, true);
        assert.equal(events[0].chatType, "supergroup");
        assert.deepEqual(events[0].source, {
            scene: "telegram",
            platform: "telegram",
            chatId: "-100123",
            userId: "777",
            chatType: "supergroup",
            messageId: "555",
            replyToMessageId: undefined,
        });

        await adapter.stop();
        nc.dispose();
    });

    it("should coerce numeric string peer ids before host calls", async () => {
        const nc = makeNC();
        const sendTextCalls: unknown[] = [];
        const getHistoryCalls: unknown[] = [];

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add() {},
                remove() {},
            },
            async sendText(chatId: unknown, text: unknown, opts?: unknown) {
                sendTextCalls.push([chatId, text, opts]);
                return {
                    id: 1,
                    text,
                    date: new Date("2026-03-08T12:00:00.000Z"),
                    chat: { id: chatId, title: "Test", type: "supergroup" },
                    sender: { id: 99, displayName: "Bot", isBot: true },
                };
            },
            async getHistory(chatId: unknown) {
                getHistoryCalls.push(chatId);
                return [];
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
        );

        await adapter.start();
        await adapter.handleCall("telegram.sendText", ["-100123", "hi", { replyTo: 7 }]);
        await adapter.handleCall("telegram.getHistory", ["682932098", { limit: 5 }]);

        assert.deepEqual(sendTextCalls[0], [-100123, "hi", { replyTo: 7 }]);
        assert.equal(getHistoryCalls[0], 682932098);

        await adapter.stop();
        nc.dispose();
    });

    it("should convert cached non-webp stickers to webp before sending", { skip: !hasCommand("ffmpeg") }, async () => {
        const nc = makeNC();
        const testDir = join(tmpdir(), `tg-sticker-${randomUUID()}`);
        fs.mkdirSync(testDir, { recursive: true });
        const fixtureName = `stolen-from-qq-${randomUUID()}`;
        const pngPath = join(testDir, `${fixtureName}.png`);
        execFileSync("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", "color=c=red:s=16x16:d=0.1",
            "-frames:v", "1",
            pngPath,
        ]);

        const sendMediaCalls: Array<[unknown, Record<string, unknown>, unknown]> = [];
        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Bot", isBot: true };
            },
            onNewMessage: {
                add() {},
                remove() {},
            },
            async sendMedia(chatId: unknown, media: Record<string, unknown>, opts?: unknown) {
                sendMediaCalls.push([chatId, media, opts]);
                return {
                    id: 2,
                    text: "",
                    date: new Date("2026-03-08T12:00:00.000Z"),
                    chat: { id: chatId, title: "Test", type: "supergroup" },
                    sender: { id: 99, displayName: "Bot", isBot: true },
                    media: { type: "sticker", mimeType: media.fileMime, fileName: media.fileName },
                };
            },
            async destroy() {},
        };
        const mediaDownloader = {
            getExistingPath(uniqueFileId: string) {
                return uniqueFileId === "qq-sticker-png" ? pngPath : null;
            },
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
            mediaDownloader as any,
        );

        try {
            await adapter.start();
            const sent = await adapter.handleCall("telegram.sendSticker", ["-100123", "qq-sticker-png", { replyTo: "7" }]) as any;

            assert.equal(sendMediaCalls.length, 1);
            const [chatId, media, opts] = sendMediaCalls[0];
            assert.equal(chatId, -100123);
            assert.equal(media.type, "sticker");
            assert.equal(media.fileMime, "image/webp");
            assert.match(String(media.fileName), /\.webp$/);
            assert.ok(Buffer.isBuffer(media.file), "converted sticker should be uploaded from a Buffer");
            const converted = media.file as Buffer;
            assert.equal(converted.subarray(0, 4).toString("ascii"), "RIFF");
            assert.equal(converted.subarray(8, 12).toString("ascii"), "WEBP");
            assert.deepEqual(opts, { replyTo: 7 });
            assert.equal(sent.mediaInfo?.type, "sticker");
            assert.equal(sent.mediaInfo?.mimeType, "image/webp");
        } finally {
            await adapter.stop();
            nc.dispose();
            cleanupConvertedTelegramStickers(fixtureName);
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("should convert cached animated gif stickers to webm video sticker media", { skip: !(hasCommand("ffmpeg") && hasCommand("ffprobe")) }, async () => {
        const nc = makeNC();
        const testDir = join(tmpdir(), `tg-sticker-${randomUUID()}`);
        fs.mkdirSync(testDir, { recursive: true });
        const fixtureName = `animated-from-qq-${randomUUID()}`;
        const gifPath = join(testDir, `${fixtureName}.gif`);
        execFileSync("ffmpeg", [
            "-hide_banner", "-loglevel", "error",
            "-f", "lavfi",
            "-i", "testsrc=size=16x16:rate=2:duration=1",
            "-plays", "0",
            gifPath,
        ]);

        const sendMediaCalls: Array<[unknown, Record<string, unknown>, unknown]> = [];
        const normalizedFiles: Array<[unknown, Record<string, unknown>]> = [];
        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Bot", isBot: true };
            },
            onNewMessage: {
                add() {},
                remove() {},
            },
            async _normalizeInputFile(input: unknown, params: Record<string, unknown>) {
                normalizedFiles.push([input, params]);
                return { _: "inputFile", id: "fake", parts: 1, name: params.fileName };
            },
            async sendMedia(chatId: unknown, media: Record<string, unknown>, opts?: unknown) {
                sendMediaCalls.push([chatId, media, opts]);
                return {
                    id: 3,
                    text: "",
                    date: new Date("2026-03-08T12:00:00.000Z"),
                    chat: { id: chatId, title: "Test", type: "supergroup" },
                    sender: { id: 99, displayName: "Bot", isBot: true },
                    media,
                };
            },
            async destroy() {},
        };
        const mediaDownloader = {
            getExistingPath(uniqueFileId: string) {
                return uniqueFileId === "qq-sticker-gif" ? gifPath : null;
            },
        };

        const adapter = new TelegramAdapter(
            makeConfig(),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
            mediaDownloader as any,
        );

        try {
            await adapter.start();
            await adapter.handleCall("telegram.sendSticker", ["-100123", "qq-sticker-gif", { replyTo: "8" }]);

            assert.equal(normalizedFiles.length, 1);
            assert.match(String(normalizedFiles[0][0]), /\.webm$/);
            assert.equal(normalizedFiles[0][1].fileMime, "video/webm");
            assert.match(String(normalizedFiles[0][1].fileName), /\.webm$/);

            assert.equal(sendMediaCalls.length, 1);
            const [chatId, media, opts] = sendMediaCalls[0];
            assert.equal(chatId, -100123);
            assert.equal(media._, "inputMediaUploadedDocument");
            assert.equal(media.mimeType, "video/webm");
            assert.equal(media.nosoundVideo, true);
            const attributes = media.attributes as Array<Record<string, unknown>>;
            assert.ok(attributes.some(attr => attr._ === "documentAttributeSticker"));
            assert.ok(attributes.some(attr => attr._ === "documentAttributeVideo"));
            assert.deepEqual(opts, { replyTo: 8 });
        } finally {
            await adapter.stop();
            nc.dispose();
            cleanupConvertedTelegramStickers(fixtureName);
            fs.rmSync(testDir, { recursive: true, force: true });
        }
    });

    it("should narrow telegram scene type defs in bot mode", async () => {
        const adapter = new TelegramAdapter(
            makeConfig({ mode: "bot" }),
            makeNC(),
            async () => "",
            () => {},
            async () => ({
                async start() {
                    return { id: 1, displayName: "BotUser", isBot: true };
                },
                onNewMessage: { add() {}, remove() {} },
                async destroy() {},
            }),
        );

        const base = `
interface TelegramClient {
  sendText(chatId: number | string, text: string): Promise<Message>;
  // [USERBOT_ONLY_BEGIN]
  getHistory(chatId: number | string, opts?: { limit?: number }): Promise<Message[]>;
  iterDialogs(opts?: { limit?: number }): AsyncIterable<Dialog>;
  // [USERBOT_ONLY_END]
}
`.trim();

        const botDefs = adapter.getSceneTypeDefs("telegram", base)!;
        assert.ok(botDefs.includes("当前 Telegram adapter 模式: bot"));
        assert.ok(!botDefs.includes("getHistory"));
        assert.ok(!botDefs.includes("iterDialogs"));
        assert.ok(botDefs.includes("sendText"));
    });

    // ─── /invisible tests ───

    it("/invisible should toggle user invisibility and send confirmation", async () => {
        const nc = makeNC();
        const sentTexts: Array<[unknown, unknown]> = [];
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Bot", isBot: true };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() { newMessageHandler = null; },
            },
            async sendText(chatId: unknown, text: unknown) {
                sentTexts.push([chatId, text]);
                return { id: 1, text, date: new Date(), chat: { id: chatId, type: "group" }, sender: { id: 99, isBot: true } };
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(), nc, async () => "", () => {},
            async () => fakeClient,
        );
        await adapter.start();
        assert.ok(newMessageHandler);

        // Send /invisible command
        await newMessageHandler!({
            id: 1, text: "/invisible", date: new Date(),
            chat: { id: -100, title: "Test", type: "group" },
            sender: { id: 42, displayName: "Alice", isBot: false },
        });

        // Should send confirmation, not push to NC
        assert.ok(sentTexts.length >= 1, "should send confirmation message");
        assert.ok(String(sentTexts[0][1]).includes("隐身"), "confirmation should mention 隐身");
        assert.ok(adapter.isUserInvisible("42"), "user should be invisible");

        // Subsequent message from user 42 should be dropped
        sentTexts.length = 0;
        await newMessageHandler!({
            id: 2, text: "hello everyone", date: new Date(),
            chat: { id: -100, title: "Test", type: "group" },
            sender: { id: 42, displayName: "Alice", isBot: false },
        });

        // No NC event for invisible user
        // (NC events are checked by checking sentTexts is empty — no confirmation for normal msgs)
        assert.equal(sentTexts.length, 0, "invisible user msg should not trigger any response");

        // Toggle off
        await newMessageHandler!({
            id: 3, text: "/invisible", date: new Date(),
            chat: { id: -100, title: "Test", type: "group" },
            sender: { id: 42, displayName: "Alice", isBot: false },
        });
        assert.ok(!adapter.isUserInvisible("42"), "user should no longer be invisible");
        assert.ok(sentTexts.length >= 1, "should send un-invisible confirmation");

        await adapter.stop();
        nc.dispose();
    });

    // ─── /mute tests ───

    it("/mute should mute chat and toggle off on second /mute", async () => {
        const nc = makeNC();
        const sentTexts: Array<[unknown, unknown]> = [];
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Bot", isBot: true };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() { newMessageHandler = null; },
            },
            async sendText(chatId: unknown, text: unknown) {
                sentTexts.push([chatId, text]);
                return { id: 1, text, date: new Date(), chat: { id: chatId, type: "group" }, sender: { id: 99, isBot: true } };
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(), nc, async () => "", () => {},
            async () => fakeClient,
        );
        await adapter.start();
        assert.ok(newMessageHandler);

        // Mute for 2 hours
        await newMessageHandler!({
            id: 1, text: "/mute 2", date: new Date(),
            chat: { id: -200, title: "Test", type: "group" },
            sender: { id: 50, displayName: "Bob", isBot: false },
        });

        assert.ok(adapter.isChatMuted("-200"), "chat should be muted");
        assert.ok(sentTexts.length >= 1);
        assert.ok(String(sentTexts[0][1]).includes("禁言"));

        // handleCall sendText should throw while muted
        await assert.rejects(
            () => adapter.handleCall("telegram.sendText", ["-200", "hi"]),
            (err: Error) => {
                assert.ok(err.message.includes("禁言中"), `Error should mention 禁言中, got: ${err.message}`);
                return true;
            },
        );

        // Toggle off with bare /mute
        sentTexts.length = 0;
        await newMessageHandler!({
            id: 2, text: "/mute", date: new Date(),
            chat: { id: -200, title: "Test", type: "group" },
            sender: { id: 50, displayName: "Bob", isBot: false },
        });
        assert.ok(!adapter.isChatMuted("-200"), "chat should be unmuted after toggle");
        assert.ok(sentTexts.length >= 1);
        assert.ok(String(sentTexts[0][1]).includes("解除"));

        await adapter.stop();
        nc.dispose();
    });

    it("/mute should clamp hours to [1, 24]", async () => {
        const nc = makeNC();
        const sentTexts: Array<[unknown, unknown]> = [];
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() { return { id: 99, displayName: "Bot", isBot: true }; },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) { newMessageHandler = handler; },
                remove() { newMessageHandler = null; },
            },
            async sendText(chatId: unknown, text: unknown) {
                sentTexts.push([chatId, text]);
                return { id: 1, text, date: new Date(), chat: { id: chatId, type: "group" }, sender: { id: 99, isBot: true } };
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(), nc, async () => "", () => {},
            async () => fakeClient,
        );
        await adapter.start();

        // /mute 48 → clamped to 24
        await newMessageHandler!({
            id: 1, text: "/mute 48", date: new Date(),
            chat: { id: -300, title: "Test", type: "group" },
            sender: { id: 60, displayName: "Carol", isBot: false },
        });
        assert.ok(adapter.isChatMuted("-300"));
        assert.ok(String(sentTexts[0][1]).includes("24"));  // should say 24 hours

        await adapter.stop();
        nc.dispose();
    });

    it("/unmute should unmute a muted chat", async () => {
        const nc = makeNC();
        const sentTexts: Array<[unknown, unknown]> = [];
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() { return { id: 99, displayName: "Bot", isBot: true }; },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) { newMessageHandler = handler; },
                remove() { newMessageHandler = null; },
            },
            async sendText(chatId: unknown, text: unknown) {
                sentTexts.push([chatId, text]);
                return { id: 1, text, date: new Date(), chat: { id: chatId, type: "group" }, sender: { id: 99, isBot: true } };
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig(), nc, async () => "", () => {},
            async () => fakeClient,
        );
        await adapter.start();

        // Mute first
        await newMessageHandler!({
            id: 1, text: "/mute 5", date: new Date(),
            chat: { id: -400, title: "Test", type: "group" },
            sender: { id: 70, displayName: "Dave", isBot: false },
        });
        assert.ok(adapter.isChatMuted("-400"));

        // Unmute
        sentTexts.length = 0;
        await newMessageHandler!({
            id: 2, text: "/unmute", date: new Date(),
            chat: { id: -400, title: "Test", type: "group" },
            sender: { id: 70, displayName: "Dave", isBot: false },
        });
        assert.ok(!adapter.isChatMuted("-400"));
        assert.ok(String(sentTexts[0][1]).includes("解除"));

        await adapter.stop();
        nc.dispose();
    });

    it("should drop group messages when whitelist enabled and group not listed", async () => {
        const nc = makeNC();
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() {
                    newMessageHandler = null;
                },
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig({
                whitelist: { enabled: true, groups: ["-999"], users: [] },
            }),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
        );

        await adapter.start();
        assert.ok(newMessageHandler);

        await newMessageHandler!({
            id: 556,
            text: "blocked",
            date: new Date("2026-03-08T12:00:00.000Z"),
            isMention: false,
            chat: { id: -100123, title: "Test Group", type: "supergroup" },
            sender: { id: 777, displayName: "Alice", isBot: false },
        });

        const events = await nc.drain(0, 10);
        assert.equal(events.length, 0);

        await adapter.stop();
        nc.dispose();
    });

    it("should allow group messages when whitelist lists the group id", async () => {
        const nc = makeNC();
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() {
                    newMessageHandler = null;
                },
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig({
                whitelist: { enabled: true, groups: ["-100123"], users: [] },
            }),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
        );

        await adapter.start();
        await newMessageHandler!({
            id: 557,
            text: "allowed",
            date: new Date("2026-03-08T12:00:00.000Z"),
            isMention: false,
            chat: { id: -100123, title: "Test Group", type: "supergroup" },
            sender: { id: 777, displayName: "Alice", isBot: false },
        });

        const events = await nc.drain(0, 10);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "nc.message");

        await adapter.stop();
        nc.dispose();
    });

    it("should allow private chat when whitelist lists user id", async () => {
        const nc = makeNC();
        let newMessageHandler: ((msg: unknown) => void | Promise<void>) | null = null;

        const fakeClient = {
            async start() {
                return { id: 99, displayName: "Userbot", isBot: false };
            },
            onNewMessage: {
                add(handler: (msg: unknown) => void | Promise<void>) {
                    newMessageHandler = handler;
                },
                remove() {
                    newMessageHandler = null;
                },
            },
            async destroy() {},
        };

        const adapter = new TelegramAdapter(
            makeConfig({
                whitelist: { enabled: true, groups: [], users: ["888888"] },
            }),
            nc,
            async () => "",
            () => {},
            async () => fakeClient,
        );

        await adapter.start();
        await newMessageHandler!({
            id: 558,
            text: "dm",
            date: new Date("2026-03-08T12:00:00.000Z"),
            isMention: false,
            chat: { id: 888888, type: "private" },
            sender: { id: 888888, displayName: "Bob", isBot: false },
        });

        const events = await nc.drain(0, 10);
        assert.equal(events.length, 1);

        await adapter.stop();
        nc.dispose();
    });
});
