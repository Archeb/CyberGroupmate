/**
 * tests/context-engine.test.ts — Context Engine 综合测试
 *
 * 覆盖：
 * 1. ContextEngine render / commit / reset 核心流程
 * 2. ContextLedger delta 追踪
 * 3. 各种 cache/history 策略组合
 * 4. SectionProvider diff/render/renderDelta 联动
 * 5. ContextManifest 结构完整性
 * 6. Pipeline providers 输出要素验证
 * 7. Template engine 渲染一致性
 * 8. 旧 prompt-renderer 已移除的回归验证
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ContextEngine } from "../src/context-engine/context-engine.js";
import { ContextLedger } from "../src/context-engine/context-ledger.js";
import type { SectionProvider, ResolveContext, DeltaStats, RenderResult } from "../src/context-engine/types.js";
import { renderTemplate, renderPrompt, setPromptDirectory, clearTemplateCache } from "../src/context-engine/template-engine.js";
import {
    callbackProvider,
    topicClusteringProvider,
    topicTriageProvider,
    groundingProvider,
} from "../src/context-engine/providers/pipeline-providers.js";
import {
    formatRelativeTime,
    formatTopicList,
    deriveChatType,
    type FormattableTopic,
} from "../src/context-engine/prompt-renderer-utils.js";
import {
    getExecutorTaskProviders,
    executorHeaderProvider,
    executorDecisionsProvider,
    executorTopicSummaryProvider,
    executorPersonContextProvider,
    executorMemoryContextProvider,
    executorTargetMessagesProvider,
    executorStickersProvider,
    executorGroundingProvider,
    executorFooterProvider,
    type ExecutorResolveContext,
} from "../src/context-engine/providers/executor-providers.js";
import { existsSync } from "node:fs";

// ═══ Test Helpers ═══

function makeStaticProvider(name: string, value: string): SectionProvider<string> {
    return {
        schema: {
            name,
            label: `Static: ${name}`,
            source: `test.static.${name}`,
            cache: "static",
            history: "omit",
        },
        resolve() { return value; },
        render(data) { return data; },
        hash(data) { return `${data.length}:${data}`; },
    };
}

function makeVolatileProvider(name: string, resolver: (ctx: ResolveContext) => string | null): SectionProvider<string> {
    return {
        schema: {
            name,
            label: `Volatile: ${name}`,
            source: `test.volatile.${name}`,
            cache: "volatile",
            history: "ephemeral",
        },
        resolve: resolver,
        render(data) { return data; },
    };
}

interface TestMessage { id: string; text: string }

function makeDeltaProvider(
    name: string,
    options?: { scopeByChatId?: boolean },
): SectionProvider<TestMessage[]> {
    const provider: SectionProvider<TestMessage[]> = {
        schema: {
            name,
            label: `Delta: ${name}`,
            source: `test.delta.${name}`,
            cache: "delta",
            history: "delta-only",
        },
        resolve(ctx) {
            return (ctx.messages as TestMessage[] | undefined) ?? null;
        },
        diff(current, committed) {
            const prevIds = new Set((committed ?? []).map((message: TestMessage) => message.id));
            const delta = current.filter((message) => !prevIds.has(message.id));
            return {
                full: current,
                delta,
                stats: {
                    total: current.length,
                    added: delta.length,
                    unchanged: current.length - delta.length,
                },
            };
        },
        render(data) {
            return data.map((message) => `[${message.id}] ${message.text}`).join("\n");
        },
        renderDelta(delta) {
            if (delta.length === 0) {
                return "(no new messages)";
            }
            return `(added ${delta.length})\n${delta.map((message) => `[${message.id}] ${message.text}`).join("\n")}`;
        },
    };

    if (options?.scopeByChatId) {
        provider.scopeKey = (ctx) =>
            typeof ctx.chatId === "string" && ctx.chatId.length > 0 ? ctx.chatId : undefined;
    }

    return provider;
}

function makeSnapshotProvider(name: string): SectionProvider<string> {
    return {
        schema: {
            name,
            label: `Snapshot: ${name}`,
            source: `test.snapshot.${name}`,
            cache: "snapshot",
            history: "persistent",
        },
        resolve(ctx) {
            return (ctx[name] as string | undefined) ?? null;
        },
        render(data) { return `== ${name} ==\n${data}`; },
    };
}

describe("ContextLedger", () => {
    let ledger: ContextLedger;

    beforeEach(() => {
        ledger = new ContextLedger();
    });

    it("starts empty", () => {
        assert.equal(ledger.getCommitted("test"), null);
    });

    it("returns committed data", () => {
        ledger.commit("messages", [1, 2, 3], "hash1");
        const section = ledger.getCommitted("messages");

        assert.ok(section);
        assert.deepEqual(section.data, [1, 2, 3]);
        assert.equal(section.hash, "hash1");
        assert.ok(section.committedAt > 0);
    });

    it("overwrites an existing commit", () => {
        ledger.commit("x", "old", "h1");
        ledger.commit("x", "new", "h2");

        assert.equal(ledger.getCommitted("x")!.data, "new");
        assert.equal(ledger.getCommitted("x")!.hash, "h2");
    });

    it("reset clears all committed state", () => {
        ledger.commit("a", 1, "h1");
        ledger.commit("b", 2, "h2");
        ledger.reset();

        assert.equal(ledger.getCommitted("a"), null);
        assert.equal(ledger.getCommitted("b"), null);
    });
});

describe("ContextEngine", () => {
    let engine: ContextEngine;

    beforeEach(() => {
        engine = new ContextEngine("test-engine");
    });

    it("returns empty output when no providers are registered", () => {
        const result = engine.render({});

        assert.equal(result.historicalContent, "");
        assert.equal(result.ephemeralContent, "");
        assert.equal(result.tree.length, 0);
    });

    it("renders static omit-history providers", () => {
        engine.register(makeStaticProvider("greeting", "hello world"));
        const result = engine.render({});

        assert.equal(result.tree.length, 1);
        assert.equal(result.tree[0].fullRendered, "hello world");
        assert.equal(result.tree[0].historicalRendered, "[Static: greeting: 见最新版本]");
        assert.ok(!result.tree[0].skipped);
    });

    it("puts ephemeral providers into ephemeralContent", () => {
        engine.register(makeVolatileProvider("search", () => "search result: xxx"));
        const result = engine.render({});

        assert.ok(result.ephemeralContent.includes("search result: xxx"));
        assert.equal(result.historicalContent, "");
    });

    it("puts persistent snapshot providers into historicalContent", () => {
        engine.register(makeSnapshotProvider("status"));
        const result = engine.render({ status: "online" });

        assert.ok(result.historicalContent.includes("online"));
    });

    it("marks null sections as skipped", () => {
        engine.register(makeVolatileProvider("maybe", () => null));
        const result = engine.render({});

        assert.equal(result.tree.length, 1);
        assert.ok(result.tree[0].skipped);
        assert.equal(result.ephemeralContent, "");
    });

    it("renders providers in registration order", () => {
        engine
            .register(makeSnapshotProvider("first"))
            .register(makeSnapshotProvider("second"));
        const result = engine.render({ first: "AAA", second: "BBB" });

        const firstIndex = result.historicalContent.indexOf("AAA");
        const secondIndex = result.historicalContent.indexOf("BBB");
        assert.ok(firstIndex < secondIndex, "first should render before second");
    });
});

describe("ContextEngine Delta Tracking", () => {
    let engine: ContextEngine;

    beforeEach(() => {
        engine = new ContextEngine("delta-test");
        engine.register(makeDeltaProvider("messages"));
    });

    it("renders the full payload on the first pass", () => {
        const messages: TestMessage[] = [
            { id: "1", text: "hello" },
            { id: "2", text: "world" },
        ];
        const result = engine.render({ messages });

        assert.ok(result.tree[0].fullRendered.includes("[1] hello"));
        assert.ok(result.tree[0].fullRendered.includes("[2] world"));
        assert.equal(result.tree[0].deltaStats!.total, 2);
        assert.equal(result.tree[0].deltaStats!.added, 2);
    });

    it("only renders the delta after commit", () => {
        const firstMessages: TestMessage[] = [
            { id: "1", text: "hello" },
            { id: "2", text: "world" },
        ];
        const first = engine.render({ messages: firstMessages });
        engine.commit(first.tree);

        const secondMessages: TestMessage[] = [
            { id: "1", text: "hello" },
            { id: "2", text: "world" },
            { id: "3", text: "new message" },
        ];
        const second = engine.render({ messages: secondMessages });

        assert.ok(second.tree[0].fullRendered.includes("[1]"));
        assert.ok(second.tree[0].fullRendered.includes("[3] new message"));
        assert.ok(second.tree[0].historicalRendered!.includes("added 1"));
        assert.ok(second.tree[0].historicalRendered!.includes("[3] new message"));
        assert.ok(!second.tree[0].historicalRendered!.includes("[1] hello"));
        assert.equal(second.tree[0].deltaStats!.total, 3);
        assert.equal(second.tree[0].deltaStats!.added, 1);
        assert.equal(second.tree[0].deltaStats!.unchanged, 2);
    });

    it("emits no historical delta when nothing changed", () => {
        const messages: TestMessage[] = [{ id: "1", text: "hello" }];
        const first = engine.render({ messages });
        engine.commit(first.tree);

        const second = engine.render({ messages });
        assert.equal(second.tree[0].historicalRendered, null);
        assert.equal(second.tree[0].deltaStats!.added, 0);
    });

    it("returns to full delta after reset", () => {
        const messages: TestMessage[] = [{ id: "1", text: "hello" }];
        const first = engine.render({ messages });
        engine.commit(first.tree);
        engine.ledger.reset();

        const second = engine.render({ messages });
        assert.equal(second.tree[0].deltaStats!.added, 1);
        assert.ok(second.tree[0].historicalRendered!.includes("[1] hello"));
    });

    it("keeps delta state isolated when scoped by chat id", () => {
        const scopedEngine = new ContextEngine("scoped-delta-test");
        scopedEngine.register(makeDeltaProvider("messages", { scopeByChatId: true }));

        const chatAFirst = scopedEngine.render({
            chatId: "telegram:a",
            messages: [{ id: "a1", text: "A-1" }],
        });
        scopedEngine.commit(chatAFirst.tree);

        const chatBFirst = scopedEngine.render({
            chatId: "telegram:b",
            messages: [{ id: "b1", text: "B-1" }],
        });
        scopedEngine.commit(chatBFirst.tree);

        const chatASecond = scopedEngine.render({
            chatId: "telegram:a",
            messages: [
                { id: "a1", text: "A-1" },
                { id: "a2", text: "A-2" },
            ],
        });

        assert.equal(chatASecond.tree[0].deltaStats!.added, 1);
        assert.ok(chatASecond.tree[0].historicalRendered!.includes("[a2] A-2"));
        assert.ok(!chatASecond.tree[0].historicalRendered!.includes("[a1] A-1"));
    });
});

// ═══ 4. ContextManifest ═══

describe("ContextManifest", () => {
    it("manifest 结构完整", () => {
        const engine = new ContextEngine("manifest-test");
        engine
            .register(makeStaticProvider("s1", "content"))
            .register(makeVolatileProvider("v1", () => "volatile"));

        const result = engine.render({});
        const { manifest } = result;

        assert.ok(manifest.timestamp);
        assert.equal(manifest.engineId, "manifest-test");
        assert.equal(manifest.sections.length, 2);

        const s1 = manifest.sections.find(s => s.name === "s1")!;
        assert.equal(s1.cache, "static");
        assert.equal(s1.history, "omit");
        assert.ok(s1.renderedChars > 0);
        assert.ok(s1.estimatedTokens > 0);
        assert.ok(!s1.skipped);

        assert.ok(manifest.summary.totalSections === 2);
        assert.ok(manifest.summary.activeSections === 2);
        assert.ok(manifest.summary.estimatedTokens > 0);
    });

    it("skipped section 在 manifest 中标记", () => {
        const engine = new ContextEngine("skip-test");
        engine.register(makeVolatileProvider("maybe", () => null));

        const result = engine.render({});
        assert.equal(result.manifest.sections[0].skipped, true);
        assert.equal(result.manifest.summary.skippedSections, 1);
    });
});

describe("Pipeline Providers", () => {
    it("callbackProvider 渲染包含任务与总结信息", () => {
        const rendered = callbackProvider.render({
            chatId: "telegram:test",
            chatType: "group",
            chatTitle: "测试群",
            taskId: "task-1",
            executionType: "CODEACT",
            status: "COMPLETED",
            durationMs: 1234,
            isCompleted: true,
            sentMessages: '- "你好"',
            summary: "任务已完成",
        });

        assert.ok(rendered.includes("消息回复结果"));
        assert.ok(rendered.includes("task-1"));
        assert.ok(rendered.includes("任务已完成"));
    });

    it("topicClusteringProvider 渲染包含已有话题与新消息", () => {
        const rendered = topicClusteringProvider.render({
            existingTopics: "topic_1: 旧话题",
            messages: "[1] Alice: hello",
        });

        assert.ok(rendered.includes("已有话题列表"));
        assert.ok(rendered.includes("topic_1"));
        assert.ok(rendered.includes("Alice: hello"));
        assert.ok(rendered.includes("NEW_1"));
    });

    it("topicTriageProvider 渲染包含 persona 与 JSON 输出要求", () => {
        const rendered = topicTriageProvider.render({
            personaName: "Miu",
            persona: "温柔的赛博少女",
            rules: "保持克制",
        });

        assert.ok(rendered.includes("Miu"));
        assert.ok(rendered.includes("温柔的赛博少女"));
        assert.ok(rendered.includes("不要输出是否介入的二元判断"));
        assert.ok(rendered.includes("JSON"));
    });

    it("groundingProvider 渲染包含搜索指令", () => {
        const data = { sanitizedText: "User 1: GPT-5 发布了吗" };
        const rendered = groundingProvider.render(data);

        assert.ok(rendered.includes("事实查证"));
        assert.ok(rendered.includes("GPT-5"));
        assert.ok(rendered.includes("搜索"));
    });
});

// ═══ 6. Template Engine ═══

describe("Template Engine", () => {
    it("renderTemplate 简单变量替换", () => {
        const result = renderTemplate("你好 {{name}}", { name: "世界" });
        assert.equal(result, "你好 世界");
    });

    it("renderTemplate 条件块 — 真值", () => {
        const result = renderTemplate("{{#show}}内容{{/show}}", { show: true });
        assert.equal(result, "内容");
    });

    it("renderTemplate 条件块 — 假值", () => {
        const result = renderTemplate("前{{#show}}内容{{/show}}后", { show: false });
        assert.equal(result, "前后");
    });

    it("renderTemplate 缺失变量 → 空字符串", () => {
        const result = renderTemplate("a{{missing}}b", {});
        assert.equal(result, "ab");
    });

    it("renderTemplate 对象变量 → JSON", () => {
        const result = renderTemplate("{{data}}", { data: { a: 1 } });
        assert.ok(result.includes('"a": 1'));
    });
});

// ═══ 7. Prompt Renderer Utils ═══

describe("Prompt Renderer Utils", () => {
    it("deriveChatType 群聊/私聊", () => {
        assert.equal(deriveChatType(true), "私聊");
        assert.equal(deriveChatType(false), "群聊");
        assert.equal(deriveChatType(undefined), "群聊");
    });

    it("formatRelativeTime 各区间", () => {
        const now = Date.now();
        assert.equal(formatRelativeTime(now), "刚刚");
        assert.equal(formatRelativeTime(now - 5 * 60000), "5分钟前");
        assert.equal(formatRelativeTime(now - 3 * 3600000), "3小时前");
        assert.equal(formatRelativeTime(now - 2 * 86400000), "2天前");
        assert.equal(formatRelativeTime(null), "");
        assert.equal(formatRelativeTime(undefined), "");
    });

    it("formatTopicList 渲染话题列表", () => {
        const topics: FormattableTopic[] = [
            {
                id: "t1",
                label: "测试话题",
                summary: "讨论测试",
                participants: ["Alice", "Bob"],
                createdAt: Date.now() - 1800000,
            },
        ];
        const result = formatTopicList(topics);

        assert.ok(result.includes("测试话题"));
        assert.ok(result.includes("讨论测试"));
        assert.ok(result.includes("Alice"));
        assert.ok(result.includes("{t1}"));
    });

    it("formatTopicList 空列表", () => {
        assert.equal(formatTopicList([]), "(无活跃话题)");
        assert.equal(formatTopicList([], "nothing"), "nothing");
    });

    it("formatTopicList triageReason 渲染", () => {
        const topics: FormattableTopic[] = [{
            label: "重要话题",
            triageReason: "有人求助",
        }];
        const result = formatTopicList(topics);
        assert.ok(result.includes("建议介入"));
        assert.ok(result.includes("有人求助"));
    });
});

// ═══ 8. Provider 验证约束 ═══

describe("ContextEngine Provider 验证", () => {
    it("delta provider 无 diff 时抛错", () => {
        const engine = new ContextEngine("validate");
        assert.throws(() => {
            engine.register({
                schema: { name: "bad", label: "Bad", source: "test", cache: "delta", history: "persistent" },
                resolve() { return "x"; },
                render(data: unknown) { return data as string; },
                // 缺少 diff
            } as unknown as SectionProvider);
        }, /diff/);
    });

    it("delta-only history 无 renderDelta 时抛错", () => {
        const engine = new ContextEngine("validate");
        assert.throws(() => {
            engine.register({
                schema: { name: "bad", label: "Bad", source: "test", cache: "delta", history: "delta-only" },
                resolve() { return "x"; },
                render(data: unknown) { return data as string; },
                diff(current: unknown, _committed: unknown) {
                    return { full: current, delta: current, stats: { total: 1, added: 1, unchanged: 0 } };
                },
                // 缺少 renderDelta
            } as unknown as SectionProvider);
        }, /renderDelta/);
    });

    it("static cache 无 hash 时抛错", () => {
        const engine = new ContextEngine("validate");
        assert.throws(() => {
            engine.register({
                schema: { name: "bad", label: "Bad", source: "test", cache: "static", history: "omit" },
                resolve() { return "x"; },
                render(data: unknown) { return data as string; },
                // 缺少 hash
            } as unknown as SectionProvider);
        }, /hash/);
    });
});

// ═══ 9. 回归验证 ═══

describe("Regression: prompt-renderer.ts 已删除", () => {
    it("旧 prompt-renderer.ts 文件不存在", () => {
        assert.ok(
            !existsSync("src/main-agent/prompt-renderer.ts"),
            "prompt-renderer.ts 应已被删除"
        );
    });

    it("旧模板文件已删除", () => {
        const deletedTemplates = [
            "system-prompts/main-agent/mainagent-attention.md",
            "system-prompts/main-agent/mainagent-callback.md",
            "system-prompts/main-agent/mainagent-grounding.md",
            "system-prompts/recording/recording-topic-clustering.md",
            "system-prompts/recording/recording-topic-triage.md",
        ];
        for (const tmpl of deletedTemplates) {
            assert.ok(!existsSync(tmpl), `${tmpl} 应已被删除`);
        }
    });

    it("保留的模板文件仍存在", () => {
        const keptTemplates = [
            "system-prompts/main-agent/mainagent-main-system.md",
            "system-prompts/executor/subagent-execution.md",
        ];
        for (const tmpl of keptTemplates) {
            assert.ok(existsSync(tmpl), `${tmpl} 应保留`);
        }
    });

    it("旧 execution-task 模板已删除", () => {
        assert.ok(
            !existsSync("system-prompts/executor/subagent-execution-task.md"),
            "subagent-execution-task.md 应已被删除（由 executor providers 替代）"
        );
    });
});

// ═══ 10. Executor Providers ═══

describe("Executor Providers", () => {
    it("getExecutorTaskProviders 返回 9 个 provider", () => {
        const providers = getExecutorTaskProviders();
        assert.equal(providers.length, 9);
        const names = providers.map(p => p.schema.name);
        assert.ok(names.includes("executor.header"));
        assert.ok(names.includes("executor.decisions"));
        assert.ok(names.includes("executor.targetMessages"));
        assert.ok(names.includes("executor.footer"));
    });

    it("header provider 渲染包含 taskId 和 chatId", () => {
        const ctx: ExecutorResolveContext = {
            chatId: "telegram:-100123456",
            taskId: "task-001",
            decisions: [],
        };
        const data = executorHeaderProvider.resolve(ctx);
        assert.ok(data);
        const rendered = executorHeaderProvider.render(data);
        assert.ok(rendered.includes("task-001"));
        assert.ok(rendered.includes("-100123456"));
        assert.ok(rendered.includes("群聊"));
    });

    it("decisions provider 渲染包含决策和语气", () => {
        const ctx: ExecutorResolveContext = {
            chatId: "test",
            taskId: "t1",
            decisions: [
                { action: "REPLY", contentDirection: "回复问题", topicId: "topic_1", confidence: 0.9 },
            ],
            toneGuidance: "随意友好",
        };
        const data = executorDecisionsProvider.resolve(ctx);
        assert.ok(data);
        const rendered = executorDecisionsProvider.render(data);
        assert.ok(rendered.includes("REPLY"));
        assert.ok(rendered.includes("回复问题"));
        assert.ok(rendered.includes("topic_1"));
        assert.ok(rendered.includes("随意友好"));
    });

    it("targetMessages provider 使用 delta-only history", () => {
        assert.equal(executorTargetMessagesProvider.schema.history, "delta-only");
        assert.equal(executorTargetMessagesProvider.schema.cache, "delta");
        const ctx: ExecutorResolveContext = {
            chatId: "test",
            taskId: "t1",
            decisions: [],
            targetMessages: "Alice: 你好\nBob: 世界",
        };
        const data = executorTargetMessagesProvider.resolve(ctx);
        assert.ok(data);
        const rendered = executorTargetMessagesProvider.render(data);
        assert.ok(rendered.includes("目标消息"));
        assert.ok(rendered.includes("Alice"));
    });

    it("personContext provider 使用 delta-only history 且渲染为紧凑 JSON", () => {
        assert.equal(executorPersonContextProvider.schema.history, "delta-only");
        assert.equal(executorPersonContextProvider.schema.cache, "delta");

        const ctx: ExecutorResolveContext = {
            chatId: "test",
            taskId: "t1",
            decisions: [],
            personContext: '[\n  {"userId":"u1","displayName":"Alice","traits":["冷静","直接"]}\n]',
        };
        const data = executorPersonContextProvider.resolve(ctx);
        assert.ok(data);
        const rendered = executorPersonContextProvider.render(data);
        assert.ok(rendered.includes('[{"userId":"u1","displayName":"Alice","traits":["冷静","直接"]}]'));
        assert.ok(!rendered.includes("\n  {"), "人物背景应改为紧凑 JSON");
    });

    it("topicSummary provider 使用 ephemeral history", () => {
        assert.equal(executorTopicSummaryProvider.schema.history, "ephemeral");
    });

    it("memoryContext provider 使用 ephemeral history", () => {
        assert.equal(executorMemoryContextProvider.schema.history, "ephemeral");
    });

    it("stickers provider 无贴纸时 resolve 返回 null", () => {
        const ctx: ExecutorResolveContext = {
            chatId: "test",
            taskId: "t1",
            decisions: [],
        };
        assert.equal(executorStickersProvider.resolve(ctx), null);
    });

    it("grounding provider 无查证结果时 resolve 返回 null", () => {
        const ctx: ExecutorResolveContext = {
            chatId: "test",
            taskId: "t1",
            decisions: [],
        };
        assert.equal(executorGroundingProvider.resolve(ctx), null);
    });

    it("完整 engine 渲染：任务摘要与记忆仅当前轮可见，delta section 只记录增量", () => {
        const engine = new ContextEngine("exec-test");
        engine.registerAll(getExecutorTaskProviders());

        const ctx: ExecutorResolveContext = {
            chatId: "telegram:-100999",
            taskId: "task-full",
            decisions: [{ action: "REPLY", contentDirection: "测试", confidence: 0.8, topicId: "t1" }],
            toneGuidance: "温柔",
            topicSummary: "测试话题",
            personContext: '[{"userId":"u1","displayName":"Alice"}]',
            memoryContext: "相关记忆内容",
            targetMessages: "[10:00] [msgId:1] Alice: 你好\n--- (距今 1 分钟) ---",
            groundingContext: "查证结果",
        };

        const first = engine.render(ctx);

        // historicalContent 包含 persistent + 首次 delta sections
        assert.ok(first.historicalContent.includes("task-full"), "header 应在 historical");
        assert.ok(first.historicalContent.includes("REPLY"), "decisions 应在 historical");
        assert.ok(first.historicalContent.includes("请根据以上任务信息"), "footer 应在 historical");
        assert.ok(first.historicalContent.includes("## 目标消息 (更新)"), "首次 targetMessages delta 应进入 historical");
        assert.ok(first.historicalContent.includes("## 相关人物背景 (更新)"), "首次 personContext delta 应进入 historical");
        assert.ok(!first.historicalContent.includes("测试话题"), "topicSummary 不应进入 historical");
        assert.ok(!first.historicalContent.includes("相关记忆内容"), "memoryContext 不应进入 historical");

        // ephemeralContent 包含当前轮可见但不持久化的 section
        assert.ok(first.ephemeralContent.includes("测试话题"), "topicSummary 应在 ephemeral");
        assert.ok(first.ephemeralContent.includes("相关记忆内容"), "memoryContext 应在 ephemeral");
        assert.ok(first.ephemeralContent.includes("查证结果"), "grounding 应在 ephemeral");

        engine.commit(first.tree);

        const second = engine.render(ctx);
        assert.ok(!second.historicalContent.includes("## 目标消息"), "无变化的 targetMessages 不应重复进入 historical");
        assert.ok(!second.historicalContent.includes("## 相关人物背景"), "无变化的 personContext 不应重复进入 historical");
        assert.ok(second.ephemeralContent.includes("测试话题"), "topicSummary 后续仍应在 ephemeral");
        assert.ok(second.ephemeralContent.includes("相关记忆内容"), "memoryContext 后续仍应在 ephemeral");
        assert.ok(!second.historicalContent.includes("查证结果"), "grounding 不应在 historical");
    });

    it("personContext delta 按人物签名比较并忽略顺序变化", () => {
        const engine = new ContextEngine("exec-person-delta-test");
        engine.register(executorPersonContextProvider);

        const first = engine.render({
            chatId: "test",
            taskId: "t1",
            decisions: [],
            personContext: '[{"userId":"u1","displayName":"Alice","traits":["冷静","直接"]},{"userId":"u2","displayName":"Bob","aliases":["Bobby","Bob"]}]',
        });
        assert.ok(first.historicalContent.includes("Alice"));
        engine.commit(first.tree);

        const second = engine.render({
            chatId: "test",
            taskId: "t2",
            decisions: [],
            personContext: '[{"displayName":"Bob","userId":"u2","aliases":["Bob","Bobby"]},{"traits":["直接","冷静"],"displayName":"Alice","userId":"u1"}]',
        });
        assert.equal(second.historicalContent, "");
    });

    it("targetMessages delta 忽略距今尾注并只输出新增消息", () => {
        const engine = new ContextEngine("exec-target-delta-test");
        engine.register(executorTargetMessagesProvider);

        const first = engine.render({
            chatId: "test",
            taskId: "t1",
            decisions: [],
            targetMessages: "[10:00] [msgId:1] Alice: 你好\n--- (距今 1 分钟) ---",
        });
        assert.ok(first.historicalContent.includes("msgId:1"));
        engine.commit(first.tree);

        const sameMessages = engine.render({
            chatId: "test",
            taskId: "t2",
            decisions: [],
            targetMessages: "[10:00] [msgId:1] Alice: 你好\n--- (距今 2 分钟) ---",
        });
        assert.equal(sameMessages.historicalContent, "");

        const withNewMessage = engine.render({
            chatId: "test",
            taskId: "t3",
            decisions: [],
            targetMessages: "[10:00] [msgId:1] Alice: 你好\n[10:01] [msgId:2] Bob: 世界\n--- (距今 1 分钟) ---",
        });
        assert.ok(withNewMessage.historicalContent.includes("msgId:2"));
        assert.ok(!withNewMessage.historicalContent.includes("msgId:1"));
    });

    it("executor engine manifest 包含所有 section", () => {
        const engine = new ContextEngine("exec-manifest");
        engine.registerAll(getExecutorTaskProviders());

        const ctx: ExecutorResolveContext = {
            chatId: "test",
            taskId: "t1",
            decisions: [{ action: "REPLY", contentDirection: "x", confidence: 0.5 }],
            targetMessages: "msg",
        };

        const result = engine.render(ctx);
        // header + decisions + targetMessages + footer = 4 active, rest skipped
        assert.ok(result.manifest.sections.length === 9, `应有 9 个 section，实际: ${result.manifest.sections.length}`);
        assert.ok(result.manifest.summary.activeSections >= 3, `active sections >= 3`);
    });
});

// ═══ 11. Provider 错误隔离 ═══

describe("ContextEngine Error Isolation", () => {
    it("单个 provider 抛错不影响其他 provider", () => {
        const engine = new ContextEngine("error-test");

        engine.register(makeSnapshotProvider("good1"));
        engine.register({
            schema: { name: "bad", label: "Bad", source: "test", cache: "volatile", history: "ephemeral" },
            resolve() { throw new Error("boom"); },
            render() { return ""; },
        });
        engine.register(makeSnapshotProvider("good2"));

        const result = engine.render({ good1: "AAA", good2: "BBB" });

        // bad provider 被 skipped
        const badNode = result.tree.find(n => n.schema.name === "bad")!;
        assert.ok(badNode.skipped);

        // 其他 provider 正常工作
        assert.ok(result.historicalContent.includes("AAA"));
        assert.ok(result.historicalContent.includes("BBB"));
    });
});
