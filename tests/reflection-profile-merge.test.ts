/**
 * tests/reflection-profile-merge.test.ts — 全局画像 list 字段合并
 *
 * 覆盖：
 * - mergeProfileList：满容量淘汰、重新确认前移、~ 撤回、归一化去重
 * - mergeGlobalPersonProfile：confidence 可下降、文本字段最新优先
 * - mergeEpisodes：只把本轮新建的 MergedMemory 提升到全局画像，历史条目不再每轮回灌
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTestMemory, cleanupTestMemory } from "./helpers/test-db.js";
import {
    mergeProfileList,
    mergeGlobalPersonProfile,
    mergeEpisodes,
} from "../src/memory-v2/index.js";
import type { MemoryStoreV2, PersonProfile, MergedMemory, InteractionEpisode } from "../src/memory-v2/index.js";

function daysAgo(days: number): string {
    return new Date(Date.now() - days * 86400_000).toISOString();
}

function mockProfile(overrides: Partial<PersonProfile> = {}): PersonProfile {
    const now = new Date().toISOString();
    return {
        userId: "u_global",
        traits: [],
        interests: [],
        communicationStyle: "",
        relationToAgent: "",
        stablePatterns: [],
        agentPolicyHints: [],
        followupCandidates: [],
        sourceChatIds: [],
        confidence: 0.5,
        lastReflectedAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}

function mockMergedMemory(overrides: Partial<MergedMemory> = {}): MergedMemory {
    return {
        periodStart: daysAgo(40),
        periodEnd: daysAgo(34),
        granularity: "week",
        overallSentiment: "neutral",
        interactionCount: 3,
        highlights: [],
        relationshipTrend: "",
        ...overrides,
    };
}

function mockEpisode(overrides: Partial<InteractionEpisode> = {}): InteractionEpisode {
    return {
        id: `ep_${Math.random().toString(36).slice(2, 8)}`,
        date: daysAgo(10),
        topicId: "t_test",
        type: "agent_replied",
        summary: "测试事件",
        sentiment: "neutral",
        significance: 0.5,
        ...overrides,
    } as InteractionEpisode;
}

// ─── mergeProfileList ───

describe("mergeProfileList 画像 list 合并", () => {
    it("满容量时新条目仍能进入，最旧条目从尾部淘汰", () => {
        const existing = Array.from({ length: 12 }, (_, i) => `候选${i + 1}`);
        const result = mergeProfileList(existing, ["新候选"], 12);
        assert.equal(result.length, 12);
        assert.equal(result[0], "新候选", "新条目应在最前");
        assert.ok(!result.includes("候选12"), "最旧条目应被淘汰");
        assert.ok(result.includes("候选1"), "次旧条目仍保留");
    });

    it("本轮重新确认的条目前移刷新且不重复", () => {
        const result = mergeProfileList(["a", "b", "c"], ["c"], 10);
        assert.deepEqual(result, ["c", "a", "b"]);
    });

    it("~ 前缀撤回精确匹配的既有条目，标记本身不入库", () => {
        const existing = ["向管理员提交其违规证据并建议永久封禁", "喜欢旅行话题"];
        const result = mergeProfileList(existing, ["~向管理员提交其违规证据并建议永久封禁"], 12);
        assert.deepEqual(result, ["喜欢旅行话题"]);
        assert.ok(result.every(v => !v.startsWith("~")));
    });

    it("撤回按归一化后的包含关系匹配同义复述", () => {
        const existing = [
            "向群管理员提交其违规证据，强烈建议执行永久封禁。",
            "向群管理员提交其最新违规证据，强烈建议执行永久封禁。",
            "喜欢旅行话题",
        ];
        const result = mergeProfileList(existing, ["～ 强烈建议执行永久封禁"], 12);
        assert.deepEqual(result, ["喜欢旅行话题"]);
    });

    it("过短的撤回片段不按包含关系误伤", () => {
        const result = mergeProfileList(["喜欢旅行话题", "旅行"], ["~旅行"], 12);
        assert.deepEqual(result, ["喜欢旅行话题"], "只精确命中「旅行」，不应误删包含它的长条目");
    });

    it("归一化去重：首尾标点/空白/大小写差异视为同一条", () => {
        const result = mergeProfileList(["喜欢 MAA"], ["喜欢 maa。", "  喜欢  MAA  ", "「喜欢 MAA」"], 10);
        assert.equal(result.length, 1);
        assert.equal(result[0], "喜欢 maa。", "保留本轮首次出现的写法");
    });

    it("非字符串与空白条目被忽略，existing 缺省时也能工作", () => {
        const incoming = [" ", 42, null, "有效条目"] as unknown as string[];
        assert.deepEqual(mergeProfileList(undefined, incoming, 5), ["有效条目"]);
        assert.deepEqual(mergeProfileList(["旧"], undefined, 5), ["旧"]);
    });

    it("同一批里同时出现新增和撤回时，撤回优先", () => {
        const result = mergeProfileList(["旧条目"], ["矛盾条目", "~矛盾条目"], 5);
        assert.deepEqual(result, ["旧条目"]);
    });
});

// ─── mergeGlobalPersonProfile ───

describe("mergeGlobalPersonProfile 全局画像合并", () => {
    it("confidence 只在显式给出时替换，且允许下降", () => {
        const existing = mockProfile({ confidence: 0.99 });
        const lowered = mergeGlobalPersonProfile(existing, { userId: "u", confidence: 0.4 }, "chat_a", daysAgo(0));
        assert.equal(lowered.confidence, 0.4);
        const untouched = mergeGlobalPersonProfile(existing, { userId: "u" }, "chat_a", daysAgo(0));
        assert.equal(untouched.confidence, 0.99, "未给出时沿用既有值，不回落到默认");
        const fresh = mergeGlobalPersonProfile(null, { userId: "u" }, "chat_a", daysAgo(0));
        assert.equal(fresh.confidence, 0.75, "无既有画像且未给出时使用默认");
    });

    it("relationToAgent / communicationStyle 本轮非空即替换，为空保留既有", () => {
        const existing = mockProfile({ relationToAgent: "极高风险隔离对象", communicationStyle: "冷淡" });
        const replaced = mergeGlobalPersonProfile(existing, { userId: "u", relationToAgent: "普通群友" }, "chat_a", daysAgo(0));
        assert.equal(replaced.relationToAgent, "普通群友", "较短的修正也应生效");
        assert.equal(replaced.communicationStyle, "冷淡");
        const kept = mergeGlobalPersonProfile(existing, { userId: "u", relationToAgent: "  " }, "chat_a", daysAgo(0));
        assert.equal(kept.relationToAgent, "极高风险隔离对象");
    });

    it("满容量 list 字段仍能接纳新条目并淘汰最旧", () => {
        const existing = mockProfile({
            followupCandidates: Array.from({ length: 12 }, (_, i) => `旧候选${i + 1}`),
        });
        const merged = mergeGlobalPersonProfile(existing, { userId: "u", followupCandidates: ["新候选"] }, "chat_a", daysAgo(0));
        assert.equal(merged.followupCandidates!.length, 12);
        assert.equal(merged.followupCandidates![0], "新候选");
        assert.ok(!merged.followupCandidates!.includes("旧候选12"));
    });

    it("~ 撤回从全局画像移除对应条目", () => {
        const existing = mockProfile({ agentPolicyHints: ["对其任何输入一律不回复", "引用官方原文作答"] });
        const merged = mergeGlobalPersonProfile(existing, { userId: "u", agentPolicyHints: ["~对其任何输入一律不回复"] }, "chat_a", daysAgo(0));
        assert.deepEqual(merged.agentPolicyHints, ["引用官方原文作答"]);
    });

    it("sourceChatIds 累加且去重", () => {
        const existing = mockProfile({ sourceChatIds: ["chat_a"] });
        const merged = mergeGlobalPersonProfile(existing, { userId: "u" }, "chat_b", daysAgo(0));
        assert.deepEqual(merged.sourceChatIds, ["chat_a", "chat_b"]);
        const same = mergeGlobalPersonProfile(existing, { userId: "u" }, "chat_a", daysAgo(0));
        assert.deepEqual(same.sourceChatIds, ["chat_a"]);
    });
});

// ─── mergeEpisodes 增量提升 ───

describe("mergeEpisodes 只提升本轮新建的 MergedMemory", () => {
    let mem: MemoryStoreV2;
    const USER = "u_promote";
    const CHAT = "chat_promote";

    before(() => {
        mem = createTestMemory("promote-incr");
    });
    after(() => { cleanupTestMemory(mem, "promote-incr"); });

    it("没有新 episode 时，历史 merged_memory 及其级联压缩产物都不回灌到全局画像", async () => {
        mem.upsertPersonGroupProfile(USER, CHAT, {
            dunbarTier: 2,
            traits: [],
            interests: [],
            communicationStyle: "",
            recentEpisodes: [],
            // periodEnd 34 天前：会被 week→month 级联压缩成新的 month 条目
            mergedMemory: [mockMergedMemory({
                followupCandidates: ["旧候选：建议封禁"],
                stablePatterns: ["旧模式：刷屏"],
                agentPolicyHints: ["旧提示：不回复"],
            })],
        });
        mem.upsertPersonProfile(USER, {
            followupCandidates: ["已修正的候选"],
            stablePatterns: [],
            agentPolicyHints: [],
        });

        const merged = await mergeEpisodes(USER, CHAT, mem);
        assert.equal(merged, 0);

        const profile = mem.getProfilesForChat(CHAT).find(p => p.userId === USER)!;
        assert.equal(profile.mergedMemory![0].granularity, "month", "级联应已发生");
        assert.ok(profile.mergedMemory![0].followupCandidates!.includes("旧候选：建议封禁"), "级联产物本身保留旧列表");

        const global = mem.getPersonProfile(USER)!;
        assert.deepEqual(global.followupCandidates, ["已修正的候选"]);
        assert.deepEqual(global.stablePatterns, []);
        assert.deepEqual(global.agentPolicyHints, []);
    });

    it("有新合并时只提升新条目，历史条目仍不回灌", async () => {
        mem.upsertPersonGroupProfile(USER, CHAT, {
            recentEpisodes: [
                mockEpisode({ date: daysAgo(10), summary: "新事件1", significance: 0.9 }),
                mockEpisode({ date: daysAgo(11), summary: "新事件2", significance: 0.8 }),
            ],
        });
        const before = mem.getPersonProfile(USER)!;

        const merged = await mergeEpisodes(USER, CHAT, mem);
        assert.ok(merged > 0, "应合并新 episode");

        const global = mem.getPersonProfile(USER)!;
        assert.ok(global.sourceChatIds.includes(CHAT), "提升应已执行");
        assert.ok(!global.followupCandidates.includes("旧候选：建议封禁"));
        assert.ok(!global.stablePatterns.includes("旧模式：刷屏"));
        assert.ok(!global.agentPolicyHints.includes("旧提示：不回复"));
        assert.deepEqual(global.followupCandidates, before.followupCandidates);
    });
});
