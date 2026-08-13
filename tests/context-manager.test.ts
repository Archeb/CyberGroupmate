/**
 * tests/context-manager.test.ts — Context Manager 综合测试
 *
 * 覆盖 Phase M3 功能：
 * - estimateTokens CJK 感知估算
 * - shouldCompact 预算判断
 * - classifyMessages 消息分段
 * - identifyProtectedMessages 话题保护
 * - compact 压缩执行（含 LLM mock）
 * - mergeContextBudget 配置合并
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
    estimateTokens,
    estimateMessagesTokens,
    shouldCompact,
    classifyMessages,
    identifyProtectedMessages,
    compact,
    forceTrim,
    mergeContextBudget,
    DEFAULT_CONTEXT_BUDGET,
    FORCE_TRIM_MARKER,
    type ContextBudget,
} from "../src/memory-v2/context-manager.js";
import type { ChatMessage } from "../src/core/llm.js";
import type { LLMConfig } from "../src/core/config.js";

// ─── 辅助工具 ───

/** 生成指定长度的英文文本 */
function englishText(charCount: number): string {
    return "a".repeat(charCount);
}

/** 生成指定长度的中文文本 */
function chineseText(charCount: number): string {
    return "你".repeat(charCount);
}

/** 生成 N 条消息 */
function makeMessages(count: number, contentLength: number = 100): ChatMessage[] {
    return Array.from({ length: count }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `消息 ${i}: ${"对话内容".repeat(Math.floor(contentLength / 4))}`,
    }));
}

/** 小预算配置（用于测试触发） */
const SMALL_BUDGET: ContextBudget = {
    effectiveContextWindow: 500,
    systemPromptRatio: 0.20,
    briefingRatio: 0.15,
    recentHistoryRatio: 0.50,
    outputReserve: 50,
    minRecentMessages: 3,
    maxBriefingTokens: 200,
};

// ─── 1. estimateTokens ───

describe("estimateTokens", () => {
    it("空字符串 → 0", () => {
        assert.equal(estimateTokens(""), 0);
    });

    it("null/undefined → 0", () => {
        assert.equal(estimateTokens(null as any), 0);
        assert.equal(estimateTokens(undefined as any), 0);
    });

    it("英文 token 计数合理", () => {
        const text = englishText(100);
        const tokens = estimateTokens(text);
        // tiktoken BPE: 100 'a' ⇒ ~4 tokens（BPE 合并重复字符）
        // CJK 启发式: 100 / 4 = 25
        // 两种模式都应 > 0
        assert.ok(tokens > 0, `英文 100 chars → ${tokens} tokens`);
        assert.ok(tokens <= 30, `英文 100 chars → ${tokens} tokens, 应 <= 30`);
    });

    it("中文 token 计数合理", () => {
        const text = chineseText(50);
        const tokens = estimateTokens(text);
        // tiktoken BPE: 50 个“你”→ ~50 tokens（CJK 单字通常 1-2 tokens）
        // CJK 启发式: 50 / 1.5 ≈ 33
        assert.ok(tokens > 0, `中文 50 chars → ${tokens} tokens`);
        assert.ok(tokens <= 100, `中文 50 chars → ${tokens} tokens, 应 <= 100`);
    });

    it("混合文本合理", () => {
        const text = "Hello 你好世界 World!";
        const tokens = estimateTokens(text);
        assert.ok(tokens > 0, "混合文本应该有 token");
        // 3 CJK + ~12 non-CJK → ~2 + ~3 = ~5
        assert.ok(tokens >= 3 && tokens <= 10, `混合文本 → ${tokens} tokens`);
    });
});

// ─── 2. estimateMessagesTokens ───

describe("estimateMessagesTokens", () => {
    it("空数组 → 0", () => {
        assert.equal(estimateMessagesTokens([]), 0);
    });

    it("多条消息累加", () => {
        const msgs: ChatMessage[] = [
            { role: "system", content: englishText(100) },
            { role: "user", content: englishText(200) },
        ];
        const tokens = estimateMessagesTokens(msgs);
        // tiktoken BPE: 重复字符被大量合并，总数可能很小
        // CJK 启发式: ~75
        assert.ok(tokens > 0, `总 tokens ${tokens} > 0`);
        assert.ok(tokens <= 100, `总 tokens ${tokens} <= 100`);
    });

    it("includes native reasoning token usage", () => {
        const visibleOnly = estimateMessagesTokens([{ role: "assistant", content: "ok" }]);
        const withReasoning = estimateMessagesTokens([{
            role: "assistant",
            content: "ok",
            reasoning: {
                provider: "openai_responses",
                items: [{ type: "reasoning", encrypted_content: "opaque" }],
                tokenCount: 123,
            },
        }]);
        assert.equal(withReasoning, visibleOnly + 123);
    });
});

// ─── 3. shouldCompact ───

describe("shouldCompact", () => {
    it("空消息数组 → false", () => {
        assert.equal(shouldCompact([], SMALL_BUDGET), false);
    });

    it("总 token 未超过预算 → false", () => {
        const msgs: ChatMessage[] = [
            { role: "user", content: "hi" },
        ];
        assert.equal(shouldCompact(msgs, SMALL_BUDGET), false);
    });

    it("总 token 超过预算 → true", () => {
        // SMALL_BUDGET.effectiveContextWindow = 500, threshold = 425
        // 需要 > 425 tokens 的消息
        const msgs = makeMessages(20, 200); // 20 * ~50+ tokens each
        assert.equal(shouldCompact(msgs, SMALL_BUDGET), true);
    });

    it("使用默认预算判断正确", () => {
        // 5 条短消息远低于 32000 * 0.85 = 27200
        const msgs: ChatMessage[] = [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi there" },
        ];
        assert.equal(shouldCompact(msgs), false);
    });
});

// ─── 4. classifyMessages ───

describe("classifyMessages", () => {
    it("空数组 → 所有字段为空", () => {
        const result = classifyMessages([], SMALL_BUDGET);
        assert.equal(result.systemPrompt, null);
        assert.equal(result.briefing, null);
        assert.equal(result.candidates.length, 0);
        assert.equal(result.recent.length, 0);
    });

    it("正确识别 system prompt", () => {
        const msgs: ChatMessage[] = [
            { role: "system", content: "你是一个助手" },
            { role: "user", content: "你好" },
            { role: "assistant", content: "你好！" },
        ];
        const result = classifyMessages(msgs, SMALL_BUDGET);
        assert.ok(result.systemPrompt);
        assert.equal(result.systemPrompt!.content, "你是一个助手");
    });

    it("正确识别 context-briefing", () => {
        const msgs: ChatMessage[] = [
            { role: "system", content: "system" },
            { role: "user", content: "briefing", scope: "context-briefing" },
            { role: "user", content: "msg1" },
            { role: "assistant", content: "msg2" },
        ];
        const result = classifyMessages(msgs, SMALL_BUDGET);
        assert.ok(result.briefing);
        assert.equal(result.briefing!.content, "briefing");
    });

    it("至少保留 minRecentMessages 条近期消息", () => {
        const msgs: ChatMessage[] = [
            { role: "system", content: "system" },
            ...makeMessages(10),
        ];
        const result = classifyMessages(msgs, SMALL_BUDGET);
        assert.ok(result.recent.length >= SMALL_BUDGET.minRecentMessages,
            `recent ${result.recent.length} >= ${SMALL_BUDGET.minRecentMessages}`);
    });

    it("正确分段 candidates 和 recent", () => {
        const msgs: ChatMessage[] = [
            { role: "system", content: "system" },
            ...makeMessages(10, 20),
        ];
        const result = classifyMessages(msgs, SMALL_BUDGET);
        assert.equal(
            result.candidates.length + result.recent.length,
            10, // 总消息减去 system prompt
        );
    });
});

// ─── 5. identifyProtectedMessages ───

describe("identifyProtectedMessages", () => {
    it("最近 N 条消息受保护", () => {
        const msgs = makeMessages(20);
        const result = identifyProtectedMessages(msgs, { recentCount: 5 });
        // 最后 5 条应受保护
        for (let i = 15; i < 20; i++) {
            assert.ok(result.protectedIndices.has(i), `消息 ${i} 应受保护`);
        }
        assert.equal(result.protectedIndices.size, 5);
    });

    it("reply chain 整体受保护", () => {
        const msgs = makeMessages(10);
        // 消息 8（受保护，最近 N 条） reply 消息 3（应被追溯保护）
        const replyChain = new Map([[8, 3]]);
        const result = identifyProtectedMessages(msgs, {
            recentCount: 3,
            replyChain,
        });
        assert.ok(result.protectedIndices.has(3), "被回复的消息 3 应受保护");
        assert.equal(result.reasons.get(3), "reply-chain");
    });

    it("reply chain 多级追溯", () => {
        const msgs = makeMessages(10);
        // 9 reply 5, 5 reply 2
        const replyChain = new Map([[9, 5], [5, 2]]);
        const result = identifyProtectedMessages(msgs, {
            recentCount: 2,
            replyChain,
        });
        assert.ok(result.protectedIndices.has(5), "消息 5 应受保护（被 9 回复）");
        assert.ok(result.protectedIndices.has(2), "消息 2 应受保护（被 5 回复，多级追溯）");
    });

    it("ENGAGED 话题的消息受保护", () => {
        const msgs = makeMessages(10);
        const engagedIndices = new Set([2, 4, 6]);
        const result = identifyProtectedMessages(msgs, {
            recentCount: 2,
            engagedIndices,
        });
        assert.ok(result.protectedIndices.has(2), "ENGAGED 消息 2 应受保护");
        assert.ok(result.protectedIndices.has(4), "ENGAGED 消息 4 应受保护");
        assert.ok(result.protectedIndices.has(6), "ENGAGED 消息 6 应受保护");
    });

    it("空消息数组不报错", () => {
        const result = identifyProtectedMessages([]);
        assert.equal(result.protectedIndices.size, 0);
    });

    it("越界的 engaged 索引被忽略", () => {
        const msgs = makeMessages(5);
        const engagedIndices = new Set([100, -1]);
        const result = identifyProtectedMessages(msgs, {
            recentCount: 2,
            engagedIndices,
        });
        // 只有最近 2 条受保护
        assert.equal(result.protectedIndices.size, 2);
    });
});

// ─── 6. compact ───

describe("compact", () => {
    it("已在预算内不触发压缩 → 原样返回", async () => {
        const msgs: ChatMessage[] = [
            { role: "system", content: "system" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ];
        const result = await compact(msgs, {} as any, DEFAULT_CONTEXT_BUDGET);
        assert.equal(result, msgs, "应返回原数组引用（不做压缩）");
    });

    it("无候选消息时不触发压缩", async () => {
        // 只有 system + 3 条 recent（= minRecentMessages）
        const tinyBudget: ContextBudget = {
            effectiveContextWindow: 10, // 极小
            systemPromptRatio: 0.20,
            briefingRatio: 0.15,
            recentHistoryRatio: 0.99,
            outputReserve: 1,
            minRecentMessages: 3,
            maxBriefingTokens: 100,
        };
        const msgs: ChatMessage[] = [
            { role: "system", content: "s" },
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
        ];
        const result = await compact(msgs, {} as any, tinyBudget);
        // 因为所有非-system 消息都落入 recent，candidates=0，应跳过
        assert.ok(result.length <= msgs.length);
    });

    it("targetLlmConfig 控制压缩阈值，摘要模型只负责生成", async () => {
        const msgs: ChatMessage[] = [
            { role: "system", content: "system" },
            ...makeMessages(12, 300),
        ];
        const compactProfile: LLMConfig = {
            provider: "openai",
            baseUrl: "http://127.0.0.1:1/v1",
            apiKey: "test",
            model: "compact-small-window",
            temperature: 0,
            maxTokens: 100,
            maxContextTokens: 1,
        };
        const targetSessionProfile: LLMConfig = {
            ...compactProfile,
            model: "session-large-window",
            maxContextTokens: 1_000_000,
        };

        const result = await compact(msgs, [compactProfile], DEFAULT_CONTEXT_BUDGET, {
            targetLlmConfig: targetSessionProfile,
        });

        assert.equal(result, msgs, "未超过目标 session 窗口时应跳过 compact LLM 调用");
    });
});

// ─── 7. mergeContextBudget ───

describe("mergeContextBudget", () => {
    it("无 partial → 返回默认值", () => {
        const budget = mergeContextBudget();
        assert.deepEqual(budget, DEFAULT_CONTEXT_BUDGET);
    });

    it("partial 覆盖指定字段", () => {
        const budget = mergeContextBudget({
            effectiveContextWindow: 64000,
            minRecentMessages: 10,
        });
        assert.equal(budget.effectiveContextWindow, 64000);
        assert.equal(budget.minRecentMessages, 10);
        // 未覆盖的字段应保持默认值
        assert.equal(budget.systemPromptRatio, DEFAULT_CONTEXT_BUDGET.systemPromptRatio);
        assert.equal(budget.outputReserve, DEFAULT_CONTEXT_BUDGET.outputReserve);
    });

    it("undefined → 返回默认值", () => {
        const budget = mergeContextBudget(undefined);
        assert.deepEqual(budget, DEFAULT_CONTEXT_BUDGET);
    });
});

// ─── 8. Config 集成验证 ───

describe("ContextBudget 配置集成", () => {
    it("loadConfig 解析 contextBudget 字段", async () => {
        const { loadConfig, clearConfigCache } = await import("../src/core/config.js");
        clearConfigCache();
        const cfg = loadConfig();
        // contextBudget 可以是 undefined（未配置）或对象
        assert.ok(
            cfg.contextBudget === undefined || typeof cfg.contextBudget === "object",
            "contextBudget 应为 undefined 或 object"
        );
    });
});

// ─── 9. session compaction wiring 回归验证 ───

describe("session rolling truncation 已替换", () => {
    it("code-act-executor 不含 'messages.length > 25' 旧逻辑", async () => {
        const { readFileSync } = await import("node:fs");
        const executorContent = readFileSync("src/subagent/code-act-executor.ts", "utf-8");
        assert.ok(
            !executorContent.includes("messages.length > 25"),
            "code-act-executor 不应包含旧的 rolling truncation 逻辑"
        );
    });

    it("code-act-executor 包含 shouldCompact 调用", async () => {
        const { readFileSync } = await import("node:fs");
        const executorContent = readFileSync("src/subagent/code-act-executor.ts", "utf-8");
        assert.ok(
            executorContent.includes("shouldCompact"),
            "code-act-executor 应包含 shouldCompact 调用"
        );
    });

    it("code-act-executor 包含 context-manager compact 调用", async () => {
        const { readFileSync } = await import("node:fs");
        const executorContent = readFileSync("src/subagent/code-act-executor.ts", "utf-8");
        assert.ok(
            executorContent.includes("await contextManagerCompact("),
            "code-act-executor 应包含 context-manager compact 调用"
        );
    });

    it("code-act-executor 在 compact 失败时有强制裁剪兜底", async () => {
        const { readFileSync } = await import("node:fs");
        const executorContent = readFileSync("src/subagent/code-act-executor.ts", "utf-8");
        assert.ok(
            executorContent.includes("forceTrimSession"),
            "code-act-executor 应含 forceTrimSession 兜底"
        );
    });
});

// ─── 10. 强制裁剪（compact 模型不可用兜底） ───

describe("forceTrim", () => {
    /** 小窗口 session 模型：用于稳定触发超窗 */
    const smallWindowProfile: LLMConfig = {
        provider: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        model: "session-small-window",
        temperature: 0,
        maxTokens: 100,
        maxContextTokens: 800,
    };

    function oversizedMessages(): ChatMessage[] {
        return [
            { role: "system", content: "SYSTEM PROMPT" },
            ...makeMessages(20, 400),
        ];
    }

    it("丢弃未受保护的候选，保留 system prompt 和尾部", () => {
        const messages = oversizedMessages();

        const result = forceTrim(messages, undefined, { targetLlmConfig: smallWindowProfile });

        assert.ok(result.dropped > 0, "应丢弃消息");
        assert.ok(result.messages.length < messages.length, "裁剪后条数应减少");
        assert.equal(result.messages[0].role, "system");
        assert.equal(result.messages[0].content, "SYSTEM PROMPT", "system prompt 必须保留");
        // 尾部消息保留（预算极小时内容可能被截断，但不会被整条丢弃）
        assert.match(
            result.messages[result.messages.length - 1].content,
            /^消息 19: /,
            "最后一条消息（尾部）必须保留",
        );
    });

    it("插入强制裁剪占位说明，且不生成假摘要", () => {
        const result = forceTrim(oversizedMessages(), undefined, {
            targetLlmConfig: smallWindowProfile,
            reason: "compact 模型不可用",
        });

        const note = result.messages[1];
        assert.equal(note.scope, "context-briefing");
        assert.ok(note.content.includes(FORCE_TRIM_MARKER), "应含强制裁剪标记");
        assert.ok(note.content.includes("compact 模型不可用"), "应写入裁剪原因");
        assert.ok(!note.content.includes("Context Briefing"), "不应伪装成摘要");
    });

    it("裁剪后回到预算内", () => {
        const messages = oversizedMessages();
        assert.ok(shouldCompact(messages, undefined, smallWindowProfile), "前置条件：应超窗");

        const result = forceTrim(messages, undefined, { targetLlmConfig: smallWindowProfile });

        assert.equal(result.stillOverBudget, false, "裁剪后不应仍然超预算");
        assert.equal(
            shouldCompact(result.messages, undefined, smallWindowProfile),
            false,
            "裁剪后 shouldCompact 应为 false",
        );
    });

    it("未超预算时原样返回", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "s" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ];
        const result = forceTrim(messages, undefined, {
            targetLlmConfig: { ...smallWindowProfile, maxContextTokens: 100_000 },
        });

        assert.equal(result.dropped, 0);
        assert.equal(result.truncated, false);
        assert.equal(result.messages, messages, "应返回原数组引用");
    });

    it("单条超大消息会被截断而不是无限超窗", () => {
        const bulk = (word: string) => `${word} `.repeat(1_500);
        const messages: ChatMessage[] = [
            { role: "system", content: "s" },
            { role: "user", content: bulk("alpha") },
            { role: "assistant", content: bulk("beta") },
            { role: "user", content: bulk("gamma") },
        ];

        const result = forceTrim(messages, undefined, { targetLlmConfig: smallWindowProfile });

        assert.equal(result.truncated, true, "应触发内容截断");
        assert.ok(
            estimateMessagesTokens(result.messages) < estimateMessagesTokens(messages),
            "截断后 token 应减少",
        );
    });
});

describe("compact 在摘要模型不可用时强制裁剪", () => {
    const targetProfile: LLMConfig = {
        provider: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        model: "session-small-window",
        temperature: 0,
        maxTokens: 100,
        maxContextTokens: 800,
    };

    function oversizedMessages(): ChatMessage[] {
        return [
            { role: "system", content: "SYSTEM PROMPT" },
            ...makeMessages(20, 400),
        ];
    }

    it("没有配置 compact 模型 → 强制裁剪而不是原样返回超窗上下文", async () => {
        const messages = oversizedMessages();

        const result = await compact(messages, [], undefined, { targetLlmConfig: targetProfile });

        assert.notEqual(result, messages, "不应原样返回");
        assert.ok(result.length < messages.length, "应已裁剪");
        assert.ok(
            result.some((m) => m.content.includes(FORCE_TRIM_MARKER)),
            "应含强制裁剪标记",
        );
        assert.equal(
            shouldCompact(result, undefined, targetProfile),
            false,
            "裁剪后应回到预算内",
        );
    });

    it("compact 模型调用失败 → 强制裁剪并保留尾部", async () => {
        const messages = oversizedMessages();

        // 起一个立刻返回 400 的假 endpoint，模拟"compact 模型坏了"
        // （400 属于不可重试错误，测试不会卡在退避上）
        const { createServer } = await import("node:http");
        const server = createServer((_req, res) => {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "compact model is broken" } }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as { port: number }).port;

        let result: ChatMessage[];
        try {
            const brokenCompactProfile: LLMConfig = {
                ...targetProfile,
                model: "broken-compact-model",
                baseUrl: `http://127.0.0.1:${port}/v1`,
            };
            result = await compact(messages, [brokenCompactProfile], undefined, {
                targetLlmConfig: targetProfile,
            });
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        assert.ok(result.length < messages.length, "应已裁剪");
        assert.ok(
            result.some((m) => m.content.includes(FORCE_TRIM_MARKER)),
            "应含强制裁剪标记",
        );
        assert.match(result[result.length - 1].content, /^消息 19: /, "尾部消息必须保留");
        assert.equal(
            shouldCompact(result, undefined, targetProfile),
            false,
            "裁剪后应回到预算内",
        );
    });
});
