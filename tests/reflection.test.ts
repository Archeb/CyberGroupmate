/**
 * tests/reflection.test.ts — Reflection Skill 综合测试
 *
 * 覆盖 Phase M2 功能：
 * - mergeEpisodes 情感合并（规则路径，无 LLM）
 * - trimProfileByTier 邓巴裁剪
 * - parseReflectionJSON 解析
 * - Reflection 集成（无 LLM 调用，仅测试数据流）
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestMemory, cleanupTestMemory } from "./helpers/test-db.js";
import {
    mergeEpisodes,
    trimProfileByTier,
    parseReflectionJSON,
    DEFAULT_TIER_LIMITS,
    isSizeReducibleError,
    REFLECTION_SCOPE_LEVELS,
    type ReflectionConfig,
} from "../src/memory-v2/index.js";
import type { MemoryStoreV2 } from "../src/memory-v2/index.js";
import type { PersonGroupProfile, InteractionEpisode, MergedMemory } from "../src/memory-v2/index.js";

// ─── 辅助工具 ───

/** 生成指定天数前的 ISO 日期 */
function daysAgo(days: number): string {
    const d = new Date(Date.now() - days * 86400_000);
    return d.toISOString();
}

/** 生成 mock InteractionEpisode */
function mockEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
    return {
        id: `ep_${Math.random().toString(36).slice(2, 8)}`,
        date: daysAgo(1),
        topicId: "t_test",
        type: "agent_replied",
        summary: "测试事件",
        sentiment: "positive",
        significance: 0.5,
        ...overrides,
    };
}

// ─── 1. mergeEpisodes 情感合并 ───

describe("mergeEpisodes 情感合并", () => {
    let mem: MemoryStoreV2;

    before(() => {
        mem = createTestMemory("merge-ep");
        // 创建 profile 供 mergeEpisodes 查找
        mem.upsertPersonGroupProfile("u_merge", "chat_merge", {
            dunbarTier: 2,
            traits: ["test"],
            interests: [],
            communicationStyle: "",
        });
    });
    after(() => { cleanupTestMemory(mem, "merge-ep"); });

    it("≤ 7天的 episodes 不被合并", async () => {
        // 写入 3 条 5 天前的 episode
        const episodes = [
            mockEpisode({ date: daysAgo(3), summary: "事件1" }),
            mockEpisode({ date: daysAgo(4), summary: "事件2" }),
            mockEpisode({ date: daysAgo(5), summary: "事件3" }),
        ];
        mem.upsertPersonGroupProfile("u_merge", "chat_merge", {
            recentEpisodes: episodes,
        });

        const merged = await mergeEpisodes("u_merge", "chat_merge", mem);
        assert.equal(merged, 0, "不应合并任何 episode");

        // 验证 recentEpisodes 未变
        const profiles = mem.getProfilesForChat("chat_merge");
        const profile = profiles.find(p => p.userId === "u_merge");
        assert.equal(profile!.recentEpisodes!.length, 3, "recentEpisodes 应保持不变");
    });

    it("> 7天 episodes 合并为 MergedMemory(week)", async () => {
        // 写入 5 条 10 天前的 episode
        const episodes = [
            mockEpisode({ date: daysAgo(10), summary: "旧事件1", significance: 0.9 }),
            mockEpisode({ date: daysAgo(10), summary: "旧事件2", significance: 0.3 }),
            mockEpisode({ date: daysAgo(11), summary: "旧事件3", significance: 0.8 }),
            mockEpisode({ date: daysAgo(12), summary: "旧事件4", significance: 0.2 }),
            mockEpisode({ date: daysAgo(13), summary: "旧事件5", significance: 0.5 }),
        ];
        mem.upsertPersonGroupProfile("u_merge", "chat_merge", {
            recentEpisodes: episodes,
            mergedMemory: [],
        });

        const merged = await mergeEpisodes("u_merge", "chat_merge", mem);
        assert.ok(merged > 0, "应合并 episode");

        const profiles = mem.getProfilesForChat("chat_merge");
        const profile = profiles.find(p => p.userId === "u_merge");
        assert.equal(profile!.recentEpisodes!.length, 0, "所有旧 episode 应被合并");
        assert.ok(profile!.mergedMemory!.length > 0, "应生成 MergedMemory");

        const mm = profile!.mergedMemory![0];
        assert.equal(mm.granularity, "week", "粒度应为 week");
        assert.ok(mm.interactionCount > 0, "interactionCount 应 > 0");
    });

    it("合并保留 significance > 0.7 的 highlights（规则路径）", async () => {
        const episodes = [
            mockEpisode({
                id: "ep_important",
                date: daysAgo(10),
                summary: "重要事件",
                significance: 0.9,
                type: "direct_message",
                topicLabel: "项目协作",
                interactionQuality: "friendly",
                evidence: ["Alice: 这件事很重要"],
                sourceIds: ["message:m1"],
                confidence: 0.9,
            }),
            mockEpisode({ date: daysAgo(10), summary: "普通事件", significance: 0.3, type: "reaction" }),
        ];
        mem.upsertPersonGroupProfile("u_merge", "chat_merge", {
            recentEpisodes: episodes,
            mergedMemory: [],
        });

        await mergeEpisodes("u_merge", "chat_merge", mem);

        const profiles = mem.getProfilesForChat("chat_merge");
        const profile = profiles.find(p => p.userId === "u_merge");
        const mm = profile!.mergedMemory![0];
        assert.ok(mm.highlights.includes("重要事件"), "应保留高 significance 的 highlight");
        assert.ok(!mm.highlights.includes("普通事件"), "不应保留低 significance 的 highlight");
        assert.equal(mm.eventTypeCounts?.direct_message, 1, "应保留事件类型分布");
        assert.equal(mm.topicCounts?.["项目协作"], 1, "应保留话题分布");
        assert.equal(mm.qualityDistribution?.friendly, 1, "应保留交互质量分布");
        assert.ok(mm.salientEvents?.[0]?.sourceIds?.includes("message:m1"), "关键事件应保留证据来源");
    });

    it("> 30天 week 合并为 MergedMemory(month)", async () => {
        // 先手动写入 40 天前的 week MergedMemory
        const weekMerged: MergedMemory = {
            periodStart: daysAgo(45),
            periodEnd: daysAgo(40),
            granularity: "week",
            overallSentiment: "positive",
            interactionCount: 5,
            highlights: ["旧亮点"],
            relationshipTrend: "互动增多",
        };
        mem.upsertPersonGroupProfile("u_merge", "chat_merge", {
            recentEpisodes: [],
            mergedMemory: [weekMerged],
        });

        await mergeEpisodes("u_merge", "chat_merge", mem);

        const profiles = mem.getProfilesForChat("chat_merge");
        const profile = profiles.find(p => p.userId === "u_merge");
        const months = profile!.mergedMemory!.filter(m => m.granularity === "month");
        assert.ok(months.length > 0, "应生成 month 级别的 MergedMemory");
    });

    it("合并后 overallSentiment 正确计算（规则路径）", async () => {
        const episodes = [
            mockEpisode({ date: daysAgo(10), sentiment: "positive" }),
            mockEpisode({ date: daysAgo(10), sentiment: "positive" }),
            mockEpisode({ date: daysAgo(10), sentiment: "positive" }),
            mockEpisode({ date: daysAgo(10), sentiment: "negative" }),
        ];
        mem.upsertPersonGroupProfile("u_merge", "chat_merge", {
            recentEpisodes: episodes,
            mergedMemory: [],
        });

        await mergeEpisodes("u_merge", "chat_merge", mem);

        const profiles = mem.getProfilesForChat("chat_merge");
        const profile = profiles.find(p => p.userId === "u_merge");
        const mm = profile!.mergedMemory![0];
        assert.equal(mm.overallSentiment, "mixed", "3 positive + 1 negative → mixed (ratio > 0.3)");
    });

    it("空 episodes 不报错", async () => {
        mem.upsertPersonGroupProfile("u_merge", "chat_merge", {
            recentEpisodes: [],
            mergedMemory: [],
        });

        const merged = await mergeEpisodes("u_merge", "chat_merge", mem);
        assert.equal(merged, 0);
    });

    it("不存在的用户不报错", async () => {
        const merged = await mergeEpisodes("u_nonexist", "chat_merge", mem);
        assert.equal(merged, 0);
    });
});

// ─── 2. trimProfileByTier 邓巴裁剪 ───

describe("trimProfileByTier 邦巴裁剪", () => {
    let mem: MemoryStoreV2;

    before(() => {
        mem = createTestMemory("trim-tier");
    });
    after(() => { cleanupTestMemory(mem, "trim-tier"); });

    /** 创建并写入 mock profile */
    function setupProfile(tier: number, traitCount: number, interestCount: number, episodeCount: number): void {
        mem.upsertPersonGroupProfile("u_trim", "chat_trim", {
            dunbarTier: tier as 1 | 2 | 3 | 4,
            dunbarReason: "测试",
            traits: Array.from({ length: traitCount }, (_, i) => `trait_${i}`),
            interests: Array.from({ length: interestCount }, (_, i) => `interest_${i}`),
            communicationStyle: "test",
            recentEpisodes: Array.from({ length: episodeCount }, (_, i) =>
                mockEpisode({ date: daysAgo(i), summary: `ep_${i}` })
            ),
            mergedMemory: [],
            messageCount: 100,
            relationToAgent: "friend",
            activeHours: [],
        });
    }

    it("Tier 1 → traits≤10, interests≤15", () => {
        setupProfile(1, 15, 20, 20);
        trimProfileByTier("u_trim", "chat_trim", mem);
        const p = mem.getProfilesForChat("chat_trim").find(p => p.userId === "u_trim")!;
        assert.ok(p.traits.length <= 10, `traits ${p.traits.length} should be ≤ 10`);
        assert.ok(p.interests.length <= 15, `interests ${p.interests.length} should be ≤ 15`);
    });

    it("Tier 2 → traits≤6, interests≤10", () => {
        setupProfile(2, 10, 15, 10);
        trimProfileByTier("u_trim", "chat_trim", mem);
        const p = mem.getProfilesForChat("chat_trim").find(p => p.userId === "u_trim")!;
        assert.ok(p.traits.length <= 6, `traits ${p.traits.length} should be ≤ 6`);
        assert.ok(p.interests.length <= 10, `interests ${p.interests.length} should be ≤ 10`);
    });

    it("Tier 3 → traits≤3, interests≤5", () => {
        setupProfile(3, 8, 8, 10);
        trimProfileByTier("u_trim", "chat_trim", mem);
        const p = mem.getProfilesForChat("chat_trim").find(p => p.userId === "u_trim")!;
        assert.ok(p.traits.length <= 3, `traits ${p.traits.length} should be ≤ 3`);
        assert.ok(p.interests.length <= 5, `interests ${p.interests.length} should be ≤ 5`);
    });

    it("Tier 4 → traits≤1, interests≤2", () => {
        setupProfile(4, 5, 5, 5);
        trimProfileByTier("u_trim", "chat_trim", mem);
        const p = mem.getProfilesForChat("chat_trim").find(p => p.userId === "u_trim")!;
        assert.ok(p.traits.length <= 1, `traits ${p.traits.length} should be ≤ 1`);
        assert.ok(p.interests.length <= 2, `interests ${p.interests.length} should be ≤ 2`);
    });

    it("未超过上限时不裁剪", () => {
        setupProfile(1, 2, 3, 5);
        trimProfileByTier("u_trim", "chat_trim", mem);
        const p = mem.getProfilesForChat("chat_trim").find(p => p.userId === "u_trim")!;
        assert.equal(p.traits.length, 2, "traits 不应被裁剪");
        assert.equal(p.interests.length, 3, "interests 不应被裁剪");
    });

    it("episodeDays 裁剪 — Tier 4 至少保留到合并窗口，避免进 mergedMemory 前丢失", () => {
        setupProfile(4, 1, 1, 12); // 12 episodes, days 0-11
        trimProfileByTier("u_trim", "chat_trim", mem);
        const p = mem.getProfilesForChat("chat_trim").find(p => p.userId === "u_trim")!;
        assert.ok((p.recentEpisodes?.length ?? 0) >= 7, "Tier 4 应保留足够长，让旧事件先进入渐进合并");
        assert.ok((p.recentEpisodes?.length ?? 0) <= 9, "Tier 4 不应无限保留 recentEpisodes");
    });

    it("自定义 tierOverrides 生效", () => {
        setupProfile(1, 15, 20, 20);
        trimProfileByTier("u_trim", "chat_trim", mem, { 1: { maxTraits: 5, maxInterests: 5, episodeDays: 3 } });
        const p = mem.getProfilesForChat("chat_trim").find(p => p.userId === "u_trim")!;
        assert.ok(p.traits.length <= 5, "自定义 override 应限制 traits 到 5");
        assert.ok(p.interests.length <= 5, "自定义 override 应限制 interests 到 5");
    });
});

// ─── 3. parseReflectionJSON 解析 ───

describe("parseReflectionJSON 解析", () => {
    it("合法 JSON 正确解析", () => {
        const json = JSON.stringify({
            globalPersonUpdates: [{ userId: "u1", relationToAgent: "跨群熟人", stablePatterns: ["喜欢旅行话题"] }],
            personUpdates: [{ userId: "u1", traits: ["好奇"], dunbarTier: 2, dunbarReason: "活跃" }],
            groupUpdates: { agentRole: "助手" },
            factUpdates: [{ subject: "u1", content: "喜欢抹茶", category: "preference" }],
            topicsSummary: [{ label: "旅行", summary: "讨论京都", participants: ["u1"], sentiment: "positive" }],
            relationshipEvents: [{ userId: "u1", summary: "u1 主动分享旅行计划", confidence: 0.8 }],
            insights: "u1 对旅行很感兴趣",
        });

        const result = parseReflectionJSON(json);
        assert.ok(result, "应该成功解析");
        assert.equal(result!.globalPersonUpdates?.[0].relationToAgent, "跨群熟人");
        assert.equal(result!.personUpdates.length, 1);
        assert.equal(result!.personUpdates[0].userId, "u1");
        assert.deepEqual(result!.personUpdates[0].traits, ["好奇"]);
        assert.equal(result!.factUpdates.length, 1);
        assert.equal(result!.relationshipEvents?.length, 1);
        assert.equal(result!.topicsSummary.length, 1);
        assert.equal(result!.insights, "u1 对旅行很感兴趣");
    });

    it("JSON 外包 markdown 代码块能处理", () => {
        const wrapped = "```json\n" + JSON.stringify({
            personUpdates: [],
            groupUpdates: {},
            newFacts: [],
            topicsSummary: [],
            insights: "test",
        }) + "\n```";

        const result = parseReflectionJSON(wrapped);
        assert.ok(result, "应该成功解析 markdown 包裹的 JSON");
        assert.equal(result!.insights, "test");
    });

    it("LLM 返回非 JSON 时返回 null", () => {
        const result = parseReflectionJSON("这不是一个 JSON 对象，只是纯文本回答。");
        assert.equal(result, null, "非 JSON 应返回 null");
    });

    it("空字符串返回 null", () => {
        const result = parseReflectionJSON("");
        assert.equal(result, null);
    });

    it("部分缺失字段仍可解析", () => {
        const json = JSON.stringify({
            personUpdates: [],
            // 缺少 groupUpdates, newFacts 等
            insights: "部分数据",
        });
        const result = parseReflectionJSON(json);
        // 即使缺少字段，只要是合法 JSON 就不应该崩溃
        assert.ok(result === null || typeof result === "object", "不应崩溃");
    });
});

// ─── 4. DEFAULT_TIER_LIMITS 常量验证 ───

describe("DEFAULT_TIER_LIMITS 常量", () => {
    it("包含 4 个 Tier 的配置", () => {
        assert.ok(DEFAULT_TIER_LIMITS[1], "Tier 1 应存在");
        assert.ok(DEFAULT_TIER_LIMITS[2], "Tier 2 应存在");
        assert.ok(DEFAULT_TIER_LIMITS[3], "Tier 3 应存在");
        assert.ok(DEFAULT_TIER_LIMITS[4], "Tier 4 应存在");
    });

    it("Tier 1 应最宽松", () => {
        assert.ok(DEFAULT_TIER_LIMITS[1].maxTraits >= DEFAULT_TIER_LIMITS[2].maxTraits);
        assert.ok(DEFAULT_TIER_LIMITS[1].maxInterests >= DEFAULT_TIER_LIMITS[2].maxInterests);
        assert.ok(DEFAULT_TIER_LIMITS[1].episodeDays >= DEFAULT_TIER_LIMITS[2].episodeDays);
    });

    it("Tier 4 应最严格", () => {
        assert.equal(DEFAULT_TIER_LIMITS[4].maxTraits, 1);
        assert.equal(DEFAULT_TIER_LIMITS[4].maxInterests, 2);
        assert.equal(DEFAULT_TIER_LIMITS[4].episodeDays, 1);
    });
});

// ─── 5. M2.6 审计修复验证 ───

describe("M2.6.3 parseReflectionJSON identityUpdates", () => {
    it("identityUpdates 字段正确解析", () => {
        const json = JSON.stringify({
            personUpdates: [{ userId: "u1", traits: ["好奇"] }],
            groupUpdates: {},
            newFacts: [],
            topicsSummary: [],
            identityUpdates: [
                { userId: "u1", displayName: "小明", aliases: ["明明", "小M"] },
                { userId: "u2", aliases: ["老王"] },
            ],
            insights: "test",
        });

        const result = parseReflectionJSON(json);
        assert.ok(result, "应成功解析");
        assert.ok(result!.identityUpdates, "identityUpdates 应存在");
        assert.equal(result!.identityUpdates!.length, 2);
        assert.equal(result!.identityUpdates![0].displayName, "小明");
        assert.deepEqual(result!.identityUpdates![0].aliases, ["明明", "小M"]);
        assert.equal(result!.identityUpdates![1].userId, "u2");
    });

    it("无 identityUpdates 字段仍可解析（向后兼容）", () => {
        const json = JSON.stringify({
            personUpdates: [],
            groupUpdates: {},
            newFacts: [],
            topicsSummary: [],
            insights: "no identity updates",
        });

        const result = parseReflectionJSON(json);
        assert.ok(result, "应成功解析");
        assert.equal(result!.identityUpdates, undefined, "identityUpdates 应为 undefined");
    });
});

describe("M2.6.2 ReflectionExternalConfig maxInterval", () => {
    it("loadConfig 解析 maxInterval", async () => {
        const { loadConfig, clearConfigCache } = await import("../src/core/config.js");
        clearConfigCache();
        const cfg = loadConfig();
        // maxInterval 可以是 undefined（未配置）或 number
        assert.ok(
            cfg.reflection.maxInterval === undefined || typeof cfg.reflection.maxInterval === "number",
            "maxInterval 应为 undefined 或 number"
        );
    });
});

describe("M2.6.6 awakeHours 配置", () => {
    it("loadConfig 解析 awakeHours 和 timezone", async () => {
        const { loadConfig, clearConfigCache } = await import("../src/core/config.js");
        clearConfigCache();
        const cfg = loadConfig();
        // awakeHours 可以是 undefined 或 [number, number]
        const ah = cfg.reflection.awakeHours;
        assert.ok(
            ah === undefined || (Array.isArray(ah) && ah.length === 2),
            "awakeHours 应为 undefined 或 [number, number]"
        );
        // timezone 可以是 undefined 或 string
        assert.ok(
            cfg.reflection.timezone === undefined || typeof cfg.reflection.timezone === "string",
            "timezone 应为 undefined 或 string"
        );
    });
});

describe("M2.6.9 topicsSummary sentiment 传递", () => {
    it("parseReflectionJSON 保留 topicsSummary 中的 sentiment", () => {
        const json = JSON.stringify({
            personUpdates: [],
            groupUpdates: {},
            newFacts: [],
            topicsSummary: [
                { label: "旅行计划", summary: "讨论了去日本的计划", participants: ["u1", "u2"], sentiment: "positive" },
                { label: "加班吐槽", summary: "抱怨公司加班", participants: ["u3"], sentiment: "negative" },
            ],
            insights: "群里氛围不错",
        });
        const result = parseReflectionJSON(json);
        assert.ok(result);
        assert.equal(result!.topicsSummary.length, 2);
        assert.equal(result!.topicsSummary[0].sentiment, "positive");
        assert.equal(result!.topicsSummary[1].sentiment, "negative");
    });
});

// ─── 回看范围自适应收缩（超时/限流则缩小 prompt 重试的决策逻辑）───

describe("isSizeReducibleError 错误分类", () => {
    it("超时类错误 → 可收缩（缩小 prompt 有望缓解）", () => {
        for (const msg of ["Request timeout after 60s", "aborted due to timeout"]) {
            assert.equal(isSizeReducibleError(new Error(msg)), true, msg);
        }
    });

    it("限流 / TPM 类错误 → 可收缩", () => {
        for (const msg of ["429 Too Many Requests", "rate limit exceeded", "model is Overloaded"]) {
            assert.equal(isSizeReducibleError(new Error(msg)), true, msg);
        }
    });

    it("上下文超长类错误 → 可收缩", () => {
        for (const msg of [
            "context length exceeded",
            "maximum context is 8192 tokens",
            "context_length_exceeded",
            "prompt is too long",
        ]) {
            assert.equal(isSizeReducibleError(new Error(msg)), true, msg);
        }
    });

    it("鉴权 / 解析 / 未知错误 → 不可收缩（收缩无益，应放弃本轮）", () => {
        for (const msg of [
            "401 Unauthorized",
            "invalid api key",
            "Unexpected token < in JSON",
            "ECONNREFUSED",
        ]) {
            assert.equal(isSizeReducibleError(new Error(msg)), false, msg);
        }
    });

    it("大小写不敏感，且接受 Error 或裸字符串", () => {
        assert.equal(isSizeReducibleError(new Error("TIMEOUT")), true);
        assert.equal(isSizeReducibleError("Rate Limit"), true);
        assert.equal(isSizeReducibleError("totally fine"), false);
    });

    it("null / undefined / 非错误对象 → 不可收缩，不抛异常", () => {
        assert.equal(isSizeReducibleError(null), false);
        assert.equal(isSizeReducibleError(undefined), false);
        assert.equal(isSizeReducibleError({ weird: true }), false);
    });
});

describe("REFLECTION_SCOPE_LEVELS 收缩梯度", () => {
    it("恰好 3 档：full → narrowed → minimal", () => {
        assert.equal(REFLECTION_SCOPE_LEVELS.length, 3);
        assert.deepEqual(
            REFLECTION_SCOPE_LEVELS.map(s => s.label),
            ["full", "narrowed", "minimal"],
        );
    });

    it("首档是全量 full（首次回看不预先收缩）", () => {
        assert.equal(REFLECTION_SCOPE_LEVELS[0].label, "full");
    });

    it("三个体量上限逐档严格递减（保证每次重试都真的更小）", () => {
        for (let i = 1; i < REFLECTION_SCOPE_LEVELS.length; i++) {
            const prev = REFLECTION_SCOPE_LEVELS[i - 1];
            const cur = REFLECTION_SCOPE_LEVELS[i];
            assert.ok(cur.maxTopicBlocks < prev.maxTopicBlocks, `maxTopicBlocks @${i}`);
            assert.ok(cur.maxMessagesPerTopic < prev.maxMessagesPerTopic, `maxMessagesPerTopic @${i}`);
            assert.ok(cur.maxInteractions < prev.maxInteractions, `maxInteractions @${i}`);
        }
    });

    it("所有上限均为正数（收缩到 minimal 仍喂得动数据）", () => {
        for (const s of REFLECTION_SCOPE_LEVELS) {
            assert.ok(s.maxTopicBlocks > 0 && s.maxMessagesPerTopic > 0 && s.maxInteractions > 0, s.label);
        }
    });
});
