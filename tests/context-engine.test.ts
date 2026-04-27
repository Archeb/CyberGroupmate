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
import {
    groupModelProvider,
    topicDigestsProvider,
} from "../src/context-engine/providers/attend-providers.js";
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
            const prevIds = new Set((committed ?? []).map((m: TestMessage) => m.id));
            const delta = current.filter(m => !prevIds.has(m.id));
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
            return data.map(m => `[${m.id}] ${m.text}`).join("\n");
        },
        renderDelta(delta) {
            if (delta.length === 0) return "(无新消息)";
            return `(新增 ${delta.length} 条)\n` + delta.map(m => `[${m.id}] ${m.text}`).join("\n");
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

// ═══ 1. ContextLedger ═══

describe("ContextLedger", () => {
    let ledger: ContextLedger;

    beforeEach(() => {
        ledger = new ContextLedger();
    });

    it("初始状态为空", () => {
        assert.equal(ledger.getCommitted("test"), null);
    });

    it("commit 后可获取", () => {
        ledger.commit("messages", [1, 2, 3], "hash1");
        const section = ledger.getCommitted("messages");
        assert.ok(section);
        assert.deepEqual(section.data, [1, 2, 3]);
        assert.equal(section.hash, "hash1");
        assert.ok(section.committedAt > 0);
    });

    it("commit 覆盖旧值", () => {
        ledger.commit("x", "old", "h1");
        ledger.commit("x", "new", "h2");
        assert.equal(ledger.getCommitted("x")!.data, "new");
        assert.equal(ledger.getCommitted("x")!.hash, "h2");
    });

    it("reset 清空所有状态", () => {
        ledger.commit("a", 1, "h1");
        ledger.commit("b", 2, "h2");
        ledger.reset();
        assert.equal(ledger.getCommitted("a"), null);
        assert.equal(ledger.getCommitted("b"), null);
    });
});

// ═══ 2. ContextEngine Core ═══

describe("ContextEngine", () => {
    let engine: ContextEngine;

    beforeEach(() => {
        engine = new ContextEngine("test-engine");
    });

    it("无 provider 时 render 返回空", () => {
        const result = engine.render({});
        assert.equal(result.historicalContent, "");
        assert.equal(result.ephemeralContent, "");
        assert.equal(result.tree.length, 0);
    });

    it("static provider 正确渲染 + omit history", () => {
        engine.register(makeStaticProvider("greeting", "你好世界"));
        const result = engine.render({});

        assert.equal(result.tree.length, 1);
        assert.equal(result.tree[0].fullRendered, "你好世界");
        assert.equal(result.tree[0].historicalRendered, "[Static: greeting: 见最新版本]");
        assert.ok(!result.tree[0].skipped);
    });

    it("volatile/ephemeral provider 正确进入 ephemeralContent", () => {
        engine.register(makeVolatileProvider("search", () => "搜索结果: xxx"));
        const result = engine.render({});

        assert.ok(result.ephemeralContent.includes("搜索结果: xxx"));
        // ephemeral 不应进入 historicalContent
        assert.equal(result.historicalContent, "");
    });

    it("snapshot/persistent provider 正确进入 historicalContent", () => {
        engine.register(makeSnapshotProvider("status"));
        const result = engine.render({ status: "在线" });

        assert.ok(result.historicalContent.includes("在线"));
    });

    it("resolve 返回 null 时 section 被 skipped", () => {
        engine.register(makeVolatileProvider("maybe", () => null));
        const result = engine.render({});

        assert.equal(result.tree.length, 1);
        assert.ok(result.tree[0].skipped);
        assert.equal(result.ephemeralContent, "");
    });

    it("多 provider 按注册顺序渲染", () => {
        engine
            .register(makeSnapshotProvider("first"))
            .register(makeSnapshotProvider("second"));
        const result = engine.render({ first: "AAA", second: "BBB" });

        const idx1 = result.historicalContent.indexOf("AAA");
        const idx2 = result.historicalContent.indexOf("BBB");
        assert.ok(idx1 < idx2, "first 应在 second 之前");
    });
});

// ═══ 3. Delta Tracking ═══

describe("ContextEngine Delta Tracking", () => {
    let engine: ContextEngine;

    beforeEach(() => {
        engine = new ContextEngine("delta-test");
        engine.register(makeDeltaProvider("messages"));
    });

    it("首次 render 全量输出", () => {
        const messages: TestMessage[] = [
            { id: "1", text: "你好" },
            { id: "2", text: "世界" },
        ];
        const result = engine.render({ messages });

        assert.ok(result.tree[0].fullRendered.includes("[1] 你好"));
        assert.ok(result.tree[0].fullRendered.includes("[2] 世界"));
        assert.equal(result.tree[0].deltaStats!.total, 2);
        assert.equal(result.tree[0].deltaStats!.added, 2);
    });

    it("commit 后第二次只有 delta", () => {
        const messages1: TestMessage[] = [
            { id: "1", text: "你好" },
            { id: "2", text: "世界" },
        ];
        const r1 = engine.render({ messages: messages1 });
        engine.commit(r1.tree);

        const messages2: TestMessage[] = [
            { id: "1", text: "你好" },
            { id: "2", text: "世界" },
            { id: "3", text: "新消息" },
        ];
        const r2 = engine.render({ messages: messages2 });

        // fullRendered 包含全部 3 条
        assert.ok(r2.tree[0].fullRendered.includes("[1]"));
        assert.ok(r2.tree[0].fullRendered.includes("[3] 新消息"));

        // historicalRendered 只包含 delta
        assert.ok(r2.tree[0].historicalRendered!.includes("新增 1 条"));
        assert.ok(r2.tree[0].historicalRendered!.includes("[3] 新消息"));
        assert.ok(!r2.tree[0].historicalRendered!.includes("[1]"));

        assert.equal(r2.tree[0].deltaStats!.total, 3);
        assert.equal(r2.tree[0].deltaStats!.added, 1);
        assert.equal(r2.tree[0].deltaStats!.unchanged, 2);
    });

    it("无新消息时 historicalRendered 为 null", () => {
        const messages: TestMessage[] = [{ id: "1", text: "你好" }];
        const r1 = engine.render({ messages });
        engine.commit(r1.tree);

        const r2 = engine.render({ messages });
        assert.equal(r2.tree[0].historicalRendered, null);
        assert.equal(r2.tree[0].deltaStats!.added, 0);
    });

    it("reset 后恢复全量", () => {
        const messages: TestMessage[] = [{ id: "1", text: "你好" }];
        const r1 = engine.render({ messages });
        engine.commit(r1.tree);
        engine.ledger.reset();

        const r2 = engine.render({ messages });
        assert.equal(r2.tree[0].deltaStats!.added, 1);
        assert.ok(r2.tree[0].historicalRendered!.includes("[1] 你好"));
    });

    it("带 chat 作用域的 delta provider 不会被其他聊天覆盖", () => {
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

describe("Attend Providers", () => {
    it("group_model 在当前轮发送完整画像而不是 omit 占位符", () => {
        const engine = new ContextEngine("attend-group-model-test");
        engine.register(groupModelProvider);

        const result = engine.render({
            chatId: "telegram:test",
            groupModel: {
                chatTitle: "测试群",
                description: "一个会讨论技术和日常的群",
                avgMessagesPerDay: 42,
                engagementLevel: "HIGH",
            },
            tonePreset: "轻松",
        });

        assert.equal(result.historicalContent, "");
        assert.ok(result.ephemeralContent.includes("## 聊天画像"));
        assert.ok(result.ephemeralContent.includes("测试群"));
        assert.equal(result.manifest.sections[0].sentContent, result.tree[0].fullRendered);
        assert.equal(result.manifest.sections[0].sentPhase, "ephemeral");
    });

    it("topic_digests provider 在 commit 后只输出增量话题更新", () => {
        const engine = new ContextEngine("attend-topic-digests-test");
        engine.register(topicDigestsProvider);

        const first = engine.render({
            chatId: "telegram:test",
            topicDigests: [
                {
                    topicId: "topic_1",
                    label: "话题一",
                    summary: "第一版摘要",
                    state: "active",
                    participants: ["Alice"],
                    keywords: ["alpha"],
                    messageCount: 3,
                    lastActivityAt: "2026-04-27T12:00:00.000Z",
                },
            ],
        });
        engine.commit(first.tree);

        const second = engine.render({
            chatId: "telegram:test",
            topicDigests: [
                {
                    topicId: "topic_1",
                    label: "话题一",
                    summary: "第二版摘要",
                    state: "active",
                    participants: ["Alice", "Bob"],
                    keywords: ["alpha", "beta"],
                    messageCount: 5,
                    lastActivityAt: "2026-04-27T12:05:00.000Z",
                },
                {
                    topicId: "topic_2",
                    label: "话题二",
                    summary: "新话题摘要",
                    state: "active",
                    participants: ["Carol"],
                    keywords: ["gamma"],
                    messageCount: 1,
                    lastActivityAt: "2026-04-27T12:06:00.000Z",
                },
            ],
        });

        assert.equal(second.tree[0].deltaStats!.added, 2);
        assert.ok(second.tree[0].historicalRendered!.includes("═══ 话题注册表增量 ═══"));
        assert.ok(second.tree[0].historicalRendered!.includes("话题二"));
        assert.ok(second.tree[0].historicalRendered!.includes("第二版摘要"));
        assert.ok(!second.tree[0].historicalRendered!.includes("第一版摘要"));
        assert.equal(second.manifest.sections[0].sentPhase, "historical");
    });
});

// ═══ 5. Pipeline Providers ═══

describe("Pipeline Providers", () => {
    it("callbackProvider 渲染包含所有要素", () => {
        const data = {
            chatId: "test-123",
            chatType: "群聊",
            chatTitle: "测试群",
            taskId: "task-1",
            executionType: "CODEACT_REPLY",
            status: "COMPLETED",
            durationMs: 1500,
            isCompleted: true,
            sentMessages: '- "你好世界"',
            summary: "成功发送消息",
        };
        const rendered = callbackProvider.render(data);

        assert.ok(rendered.includes("测试群"));
        assert.ok(rendered.includes("test-123"));
        assert.ok(rendered.includes("task-1"));
        assert.ok(rendered.includes("COMPLETED"));
        assert.ok(rendered.includes("1500ms"));
        assert.ok(rendered.includes("你好世界"));
        assert.ok(rendered.includes("成功发送消息"));
        assert.ok(rendered.includes("OOC"), "应包含 OOC 自检提示");
    });

    it("callbackProvider 含 error 时渲染错误信息", () => {
        const data = {
            chatId: "test-123",
            chatType: "群聊",
            chatTitle: "测试群",
            taskId: "task-1",
            executionType: "CODEACT_REPLY",
            status: "ERROR",
            durationMs: 100,
            isCompleted: false,
            sentMessages: "（无）",
            summary: "执行失败",
            error: "LLM timeout",
        };
        const rendered = callbackProvider.render(data);
        assert.ok(rendered.includes("LLM timeout"));
    });

    it("topicClusteringProvider 渲染包含完整指令", () => {
        const data = {
            existingTopics: "- topic_1: 聊天",
            messages: "[msg1] Alice: 你好",
        };
        const rendered = topicClusteringProvider.render(data);

        assert.ok(rendered.includes("话题分析器"));
        assert.ok(rendered.includes("topic_1"));
        assert.ok(rendered.includes("Alice"));
        assert.ok(rendered.includes("JSON"));
        assert.ok(rendered.includes("NEW_"), "应包含 NEW_ 前缀说明");
        assert.ok(rendered.includes("assignments"));
        assert.ok(rendered.includes("evolutions"));
    });

    it("topicTriageProvider 渲染包含人设", () => {
        const data = {
            personaName: "Miu",
            persona: "温柔的赛博少女",
            rules: "",
        };
        const rendered = topicTriageProvider.render(data);

        assert.ok(rendered.includes("Miu"));
        assert.ok(rendered.includes("温柔的赛博少女"));
        assert.ok(rendered.includes("should_intervene"));
        assert.ok(rendered.includes("triage") || rendered.includes("判断"));
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

    it("targetMessages provider 使用 ephemeral history", () => {
        assert.equal(executorTargetMessagesProvider.schema.history, "ephemeral");
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

    it("personContext provider 使用 ephemeral history", () => {
        assert.equal(executorPersonContextProvider.schema.history, "ephemeral");
    });

    it("topicSummary provider 使用 omit history", () => {
        assert.equal(executorTopicSummaryProvider.schema.history, "omit");
    });

    it("memoryContext provider 使用 omit history", () => {
        assert.equal(executorMemoryContextProvider.schema.history, "omit");
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

    it("完整 engine 渲染：ephemeral 部分不进入 historicalContent", () => {
        const engine = new ContextEngine("exec-test");
        engine.registerAll(getExecutorTaskProviders());

        const ctx: ExecutorResolveContext = {
            chatId: "telegram:-100999",
            taskId: "task-full",
            decisions: [{ action: "REPLY", contentDirection: "测试", confidence: 0.8, topicId: "t1" }],
            toneGuidance: "温柔",
            topicSummary: "测试话题",
            personContext: '{"name":"Alice"}',
            memoryContext: "相关记忆内容",
            targetMessages: "Alice: 你好",
            groundingContext: "查证结果",
        };

        const result = engine.render(ctx);

        // historicalContent 包含 persistent + omit 部分
        assert.ok(result.historicalContent.includes("task-full"), "header 应在 historical");
        assert.ok(result.historicalContent.includes("REPLY"), "decisions 应在 historical");
        assert.ok(result.historicalContent.includes("请根据以上任务信息"), "footer 应在 historical");
        // omit sections 应在 historical 中以占位符形式出现
        assert.ok(result.historicalContent.includes("见最新版本"), "omit section 应有占位符");

        // ephemeralContent 包含 ephemeral 部分
        assert.ok(result.ephemeralContent.includes("Alice"), "targetMessages 应在 ephemeral");
        assert.ok(result.ephemeralContent.includes("查证结果"), "grounding 应在 ephemeral");
        assert.ok(result.ephemeralContent.includes("Alice"), "personContext 应在 ephemeral");

        // ephemeral 部分不应在 historicalContent 中
        assert.ok(!result.historicalContent.includes("目标消息"), "目标消息不应在 historical");
        assert.ok(!result.historicalContent.includes("查证结果"), "grounding 不应在 historical");
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
