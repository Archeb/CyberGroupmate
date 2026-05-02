import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ChatMessage, LLMCallOptions, LLMResponse } from "../src/core/llm.js";
import type { LLMConfig } from "../src/core/config.js";
import { createMetaSessionHandler } from "../src/main-agent/meta-session-handler.js";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";
import type { AttentionQueueEntry } from "../src/subagent/types.js";

const TEST_LLM_CONFIG: LLMConfig = {
    provider: "openai",
    baseUrl: "https://example.invalid",
    apiKey: "test",
    model: "fake-model",
    temperature: 0,
    maxTokens: 1024,
};

function createEntry(): AttentionQueueEntry {
    return {
        chatId: "telegram:g1",
        source: "DIRECT_ADDRESS",
        priority: 88,
        basePriority: 88,
        enqueuedAt: 1,
        lastAttendedAt: null,
        attendCount: 0,
        blocked: false,
        newMessageCount: 1,
        topicDigests: [
            {
                topicId: "topic-1",
                label: "团建讨论",
                summary: "大家在聊团建地点",
                state: "ACTIVE",
                participants: ["telegram:u1"],
                keywords: ["团建"],
                messageCount: 1,
                lastActivityAt: "2026-05-01T14:28:01.000Z",
            },
        ],
        stickinessLevel: "FAMILIAR",
        engagementScore: 42,
        directAddressReason: "DM",
        recentMessages: [
            {
                messageId: "7305",
                userId: "telegram:u1",
                displayName: "阿喵",
                text: "在吗在吗",
                timestamp: "2026-05-01T14:28:01.000Z",
            },
        ],
    };
}

function createMemoryStub() {
    return {
        getGroupModel: () => ({
            chatId: "telegram:g1",
            chatTitle: "快乐摸鱼群",
            isDirectMessage: true,
            description: "日常闲聊打水",
            dominantLanguage: "zh-CN",
            communicationNorms: [],
            activeMembers: 3,
            avgMessagesPerDay: 12,
            peakHours: [],
            agentRole: "群友",
            engagementLevel: "medium",
            recentFeedback: "回复宜简短",
            hotTopics: ["团建"],
            tabooTopics: [],
            lastReflectedAt: null,
            updatedAt: "2026-05-01T00:00:00.000Z",
        }),
        getProfilesForChat: () => ([
            {
                userId: "telegram:u1",
                chatId: "telegram:g1",
                dunbarTier: 2,
                dunbarReason: "熟悉",
                affinityScore: 81,
                traits: ["健谈"],
                interests: ["团建"],
                communicationStyle: "轻松",
                relationToAgent: "熟人",
                recentEpisodes: [],
                mergedMemory: [],
                messageCount: 12,
                lastSeenAt: "2026-05-01T14:28:01.000Z",
                activeHours: [],
                firstSeenAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-05-01T00:00:00.000Z",
            },
        ]),
        getPersonIdentity: () => ({
            userId: "telegram:u1",
            displayName: "阿喵",
            username: "amiu",
            aliases: ["小喵"],
            totalMessageCount: 120,
            lastSeenAt: "2026-05-01T14:28:01.000Z",
            firstSeenAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
        }),
        getTopicById: () => ({
            id: "topic-1",
            chatId: "telegram:g1",
            label: "团建讨论",
            summary: "大家在聊团建地点",
            keyPoints: [],
            participants: ["telegram:u1"],
            messageRange: { messageIds: ["7305"], count: 1 },
            startedAt: "2026-05-01T14:28:01.000Z",
            endedAt: null,
            sentiment: "neutral" as const,
            relatedTopicIds: [],
            keywords: ["团建"],
            associatedMemories: [
                {
                    type: "core_fact" as const,
                    factId: "fact-1",
                    subject: "telegram:u1",
                    category: "preference" as const,
                    content: "阿喵偏好短句沟通",
                    confidence: 0.9,
                },
            ],
            callbackPotential: 55,
            createdAt: "2026-05-01T14:28:01.000Z",
            updatedAt: "2026-05-01T14:28:01.000Z",
        }),
        listGroupModels: () => [{ chatId: "telegram:g1" }],
        todoList: () => [],
    };
}

describe("createMetaSessionHandler", () => {
    it("uses ContextEngine sections and only replays deltas for messages/topics/profiles", async () => {
        const sandbox = new MetaSandbox({});
        const llmCalls: ChatMessage[][] = [];
        const handler = createMetaSessionHandler({
            getPersona: () => ({ name: "测试编排者", description: "验证 meta context engine" }),
            globalState: {
                getSessionDigests: () => [],
                getMetaSessionHistory: () => [],
                appendMetaSessionHistory: () => undefined,
            },
            memory: createMemoryStub() as any,
            sandbox,
            getLlmConfigs: () => [TEST_LLM_CONFIG],
            llmCaller: async (messages): Promise<LLMResponse> => {
                llmCalls.push(messages.map((message) => ({ ...message })));
                return {
                    content: "[SESSION_DIGEST]noop[/SESSION_DIGEST]\n<end_turn>",
                };
            },
        });

        const entry = createEntry();

        await handler([entry], []);
        await handler([entry], []);

        const firstPrompt = llmCalls[0]
            ?.filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n\n") ?? "";
        const secondUserMessages = llmCalls[1]
            ?.filter((message) => message.role === "user")
            .map((message) => message.content) ?? [];
        const secondPrompt = secondUserMessages.join("\n\n");
        const replayedHistoricalPrompt = secondUserMessages[0] ?? "";
        const currentHistoricalPrompt = secondUserMessages.at(-2) ?? "";
        const currentEphemeralPrompt = secondUserMessages.at(-1) ?? "";

        assert.match(firstPrompt, /## 新消息/);
        assert.match(firstPrompt, /在吗在吗/);
        assert.match(firstPrompt, /## 话题注册表增量/);
        assert.doesNotMatch(firstPrompt, /阿喵偏好短句沟通/);
        assert.match(firstPrompt, /## 活跃参与者 \(更新\)/);
        assert.match(firstPrompt, /## 聊天画像/);

        assert.match(replayedHistoricalPrompt, /## 新消息/);
        assert.match(replayedHistoricalPrompt, /## 话题注册表增量/);
        assert.doesNotMatch(currentHistoricalPrompt, /## 新消息/);
        assert.doesNotMatch(currentHistoricalPrompt, /## 话题注册表增量/);
        assert.doesNotMatch(currentHistoricalPrompt, /## 活跃参与者 \(更新\)/);
        assert.match(currentHistoricalPrompt, /# 注意力切换:/);
        assert.match(currentEphemeralPrompt, /## 聊天画像/);
        assert.match(currentEphemeralPrompt, /## 当前注意力元数据/);
    });

    it("replays prior meta assistant history, exposes assignable skills, and forwards merged manifests", async () => {
        const sandbox = new MetaSandbox({});
        const persistedHistory: Array<{ role: "assistant" | "user"; content: string; timestamp: string }> = [];
        const llmCalls: Array<{ messages: ChatMessage[]; options?: LLMCallOptions }> = [];
        const responses: LLMResponse[] = [
            {
                content: [
                    "先做一次查询。",
                    "",
                    "```ts",
                    "console.log(\"meta-history\");",
                    "```",
                    "",
                    "[SESSION_DIGEST]stored history[/SESSION_DIGEST]",
                    "<end_turn>",
                ].join("\n"),
            },
            {
                content: [
                    "[SESSION_DIGEST]reused prior history[/SESSION_DIGEST]",
                    "<end_turn>",
                ].join("\n"),
            },
        ];

        const globalStateStub = {
            getSessionDigests: () => ([
                { createdAt: "2026-05-01T00:00:00.000Z", content: "meta digest 1" },
                { createdAt: "2026-05-01T01:00:00.000Z", content: "meta digest 2" },
            ]),
            getMetaSessionHistory: () => [...persistedHistory],
            appendMetaSessionHistory: (messages: Array<{ role: "assistant" | "user"; content: string }>) => {
                const timestamp = new Date().toISOString();
                for (const message of messages) {
                    persistedHistory.push({ ...message, timestamp });
                }
            },
        };

        const createHandler = () => createMetaSessionHandler({
            getPersona: () => ({ name: "测试编排者", description: "验证 meta session history + manifest" }),
            globalState: globalStateStub,
            memory: createMemoryStub() as any,
            sandbox,
            getLlmConfigs: () => [TEST_LLM_CONFIG],
            llmCaller: async (messages, _configs, options): Promise<LLMResponse> => {
                llmCalls.push({
                    messages: messages.map((message) => ({ ...message })),
                    options,
                });
                const next = responses.shift();
                assert.ok(next);
                return next;
            },
        });

        const entry = createEntry();

        await createHandler()([entry], []);
        assert.ok(persistedHistory.length >= 2);
        const persistedPrompt = persistedHistory.find((message) =>
            message.role === "user" && message.content.includes("# 注意力切换:")
        );
        assert.ok(persistedPrompt);
        assert.match(persistedPrompt.content, /# 历史 Session Digests/);
        assert.match(persistedPrompt.content, /# 注意力切换:/);
        assert.match(persistedPrompt.content, /## 话题注册表/);
        assert.match(persistedPrompt.content, /## 新消息/);
        assert.doesNotMatch(persistedPrompt.content, /## 当前注意力元数据/);
        assert.doesNotMatch(persistedPrompt.content, /## 聊天画像/);
        assert.doesNotMatch(persistedPrompt.content, /请检查是否需要跨群检索/);

        await createHandler()([entry], []);

        const firstSystemPrompt = String(llmCalls[0]?.messages[0]?.content ?? "");
        assert.match(firstSystemPrompt, /可分配技能模块/);
        assert.ok(llmCalls[0]?.options?.contextManifest);
        assert.ok((llmCalls[0]?.options?.contextManifest?.sections?.length ?? 0) > 0);

        const secondCallMessages = llmCalls[1]?.messages ?? [];
        const priorPrompt = secondCallMessages.find((message) =>
            message.role === "user" && message.content.includes("# 注意力切换:")
        );
        assert.ok(priorPrompt);
        assert.match(priorPrompt.content, /# 历史 Session Digests/);
        assert.doesNotMatch(priorPrompt.content, /## 当前注意力元数据/);
        const priorAssistant = secondCallMessages.find((message) => message.role === "assistant");
        assert.ok(priorAssistant);
        assert.match(priorAssistant.content, /先做一次查询/);
        assert.match(priorAssistant.content, /\[执行代码已剥离\]/);
        assert.doesNotMatch(priorAssistant.content, /console\.log/);
        assert.doesNotMatch(priorAssistant.content, /<end_turn>/);

        const priorObservation = secondCallMessages.find((message) =>
            message.role === "user" && /MetaSandbox observation/.test(message.content)
        );
        assert.ok(priorObservation);
    });
});
