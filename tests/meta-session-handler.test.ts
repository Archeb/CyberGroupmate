import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ChatMessage, LLMResponse } from "../src/core/llm.js";
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
                memoList: () => [],
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
        const secondPrompt = llmCalls[1]
            ?.filter((message) => message.role === "user")
            .map((message) => message.content)
            .join("\n\n") ?? "";

        assert.match(firstPrompt, /## 新消息/);
        assert.match(firstPrompt, /在吗在吗/);
        assert.match(firstPrompt, /## 话题注册表增量/);
        assert.match(firstPrompt, /阿喵偏好短句沟通/);
        assert.match(firstPrompt, /## 活跃参与者 \(更新\)/);
        assert.match(firstPrompt, /## 聊天画像/);

        assert.doesNotMatch(secondPrompt, /## 新消息/);
        assert.doesNotMatch(secondPrompt, /## 话题注册表增量/);
        assert.doesNotMatch(secondPrompt, /## 活跃参与者 \(更新\)/);
        assert.match(secondPrompt, /## 聊天画像/);
        assert.match(secondPrompt, /## 当前注意力元数据/);
    });
});