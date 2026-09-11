/**
 * banned-words.test.ts — 禁用词检查单元测试
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findBannedWords, buildBannedWordWarning, DEFAULT_BANNED_WORDS } from "../src/core/banned-words.js";
import type { CapabilityRegistryEnv } from "../src/sandbox/capability-registry.js";
import { createTelegramClientProxy } from "../src/sandbox/modules/telegram/index.js";
import { createOneBotClientProxy } from "../src/sandbox/modules/onebot/index.js";
import { createDiscordClientProxy } from "../src/sandbox/modules/discord/index.js";

// ─── findBannedWords ───

/** 测试 fixture：3be2c6a 前的默认词表（源自 SOUL.md）。运行时默认词表已配置化（DEFAULT_BANNED_WORDS = []），匹配器与具体词表无关。 */
const WORDS = ["确实", "笑死", "还真是", "接住", "抓住", "你说得对", "说得对", "不绕", "我认了"];

describe("findBannedWords", () => {
    it("returns empty array when no banned words found", () => {
        const result = findBannedWords("这是一句正常的话", WORDS);
        assert.deepEqual(result, []);
    });

    it("detects single banned word", () => {
        const result = findBannedWords("确实有点那个味道", WORDS);
        assert.deepEqual(result, ["确实"]);
    });

    it("detects multiple banned words", () => {
        const result = findBannedWords("确实笑死我了", WORDS);
        assert.ok(result.includes("确实"));
        assert.ok(result.includes("笑死"));
        assert.equal(result.length, 2);
    });

    it("deduplicates repeated occurrences", () => {
        const result = findBannedWords("确实确实确实", WORDS);
        assert.deepEqual(result, ["确实"]);
    });

    it("returns empty when word list is empty", () => {
        const result = findBannedWords("确实笑死", []);
        assert.deepEqual(result, []);
    });

    it("does not trigger on non-matching text", () => {
        const result = findBannedWords("谢谢你对我真的很好哦", WORDS);
        assert.deepEqual(result, []);
    });

    it("detects 说得对 in context", () => {
        const result = findBannedWords("你说得对，这个方向是对的", WORDS);
        assert.ok(result.includes("说得对"));
    });

    it("default word list is empty — actual list is config/Dashboard-managed", () => {
        // 3be2c6a 起词表由配置管理，代码内默认不拦截任何词；锁定该契约防止硬编码词表回归
        assert.deepEqual(DEFAULT_BANNED_WORDS, []);
    });
});

// ─── buildBannedWordWarning ───

describe("buildBannedWordWarning", () => {
    it("includes banned words in warning", () => {
        const warning = buildBannedWordWarning(["确实", "笑死"], "确实笑死了");
        assert.ok(warning.includes("确实"));
        assert.ok(warning.includes("笑死"));
    });

    it("truncates long text in warning preview", () => {
        const longText = "确实".repeat(50);
        const warning = buildBannedWordWarning(["确实"], longText);
        assert.ok(warning.length < 500, "warning should not be excessively long");
        assert.ok(warning.includes("…"));
    });

    it("mentions block and rewrite instructions", () => {
        const warning = buildBannedWordWarning(["确实"], "确实好");
        assert.ok(warning.includes("拦截"));
        assert.ok(warning.includes("sendText"));
    });
});

// ─── Platform proxy integration ───

type PlatformCase = {
    name: string;
    chatId: string;
    createProxy: (
        env: CapabilityRegistryEnv,
        history: Map<string, Set<string>>,
        dedup?: boolean,
        bannedWords?: string[],
    ) => { sendText: (id: string, text: string) => Promise<unknown> };
};

const cases: PlatformCase[] = [
    {
        name: "telegram",
        chatId: "100",
        createProxy: createTelegramClientProxy as unknown as PlatformCase["createProxy"],
    },
    {
        name: "onebot",
        chatId: "onebot:100",
        createProxy: createOneBotClientProxy as unknown as PlatformCase["createProxy"],
    },
    {
        name: "discord",
        chatId: "channel-100",
        createProxy: createDiscordClientProxy as unknown as PlatformCase["createProxy"],
    },
];

describe("platform sendText banned-word blocking", () => {
    for (const { name, chatId, createProxy } of cases) {
        it(`${name}: blocks sendText containing banned word`, async () => {
            const outputs: string[] = [];
            const notifyEvents: Record<string, unknown>[] = [];

            const env: CapabilityRegistryEnv = {
                ctx: {},
                emitOutput: (line) => outputs.push(line),
                notifyHost: (event) => notifyEvents.push(event),
                requestInput: async () => "",
                printToHost: () => {},
                spawnTask: () => {},
                killTask: () => {},
                listTasks: () => [],
                callHost: async () => { throw new Error("should not reach callHost"); },
            };

            const proxy = createProxy(env, new Map(), true, ["确实"]);
            const result = await proxy.sendText(chatId, "确实很有意思");

            assert.equal(result, null, "should return null on blocked send");
            assert.ok(outputs.length > 0, "should emit warning output");
            assert.ok(outputs[0].includes("禁用词"), "warning should mention 禁用词");
            assert.ok(outputs[0].includes("确实"), "warning should name the offending word");
            assert.ok(
                notifyEvents.some(e => e.type === "system.banned_word_blocked"),
                "should emit system.banned_word_blocked event"
            );
        });

        it(`${name}: allows sendText without banned words`, async () => {
            let calledHost = false;

            const env: CapabilityRegistryEnv = {
                ctx: {},
                emitOutput: () => {},
                notifyHost: () => {},
                requestInput: async () => "",
                printToHost: () => {},
                spawnTask: () => {},
                killTask: () => {},
                listTasks: () => [],
                callHost: async () => {
                    calledHost = true;
                    if (name === "telegram") return { id: 1, chat: { id: chatId, type: "private" }, text: "xs 不错", date: new Date().toISOString() };
                    if (name === "onebot") return { message_id: 1 };
                    return { id: "d1", channelId: chatId, text: "xs 不错" };
                },
            };

            const proxy = createProxy(env, new Map(), true, ["确实"]);
            const result = await proxy.sendText(chatId, "xs 不错（");

            assert.ok(calledHost, "clean message should reach callHost");
            assert.notEqual(result, null);
        });

        it(`${name}: skips check when bannedWords is empty`, async () => {
            let calledHost = false;

            const env: CapabilityRegistryEnv = {
                ctx: {},
                emitOutput: () => {},
                notifyHost: () => {},
                requestInput: async () => "",
                printToHost: () => {},
                spawnTask: () => {},
                killTask: () => {},
                listTasks: () => [],
                callHost: async () => {
                    calledHost = true;
                    if (name === "telegram") return { id: 1, chat: { id: chatId, type: "private" }, text: "确实", date: new Date().toISOString() };
                    if (name === "onebot") return { message_id: 1 };
                    return { id: "d1", channelId: chatId, text: "确实" };
                },
            };

            const proxy = createProxy(env, new Map(), true, []);
            const result = await proxy.sendText(chatId, "确实");

            assert.ok(calledHost, "should pass through when bannedWords is empty");
            assert.notEqual(result, null);
        });
    }
});
