/**
 * memory-v2/reflection.ts — Reflection Skill 引擎
 *
 * 对指定群组进行反思总结。读取上次反思以来的 topics 和 interactions，
 * 调用 cheap model 生成结构化 JSON，然后写入 person_group_profiles、
 * core_facts、group_models。
 *
 * 在整体架构中的位置：
 * - 被 MemoryStoreV2.reflect() 调用
 * - 被 main.ts 定时触发 / cli.ts 手动触发
 * - 消费 memory-v2.ts 的查询和写入方法
 *
 * @see memory.md §3.3 Reflection Skill
 */

import { createLogger } from "../core/logger.js";
import { getPlatform, ensureCompositeId, getRawId } from "../core/chat-id.js";
import { callLLMWithFallback, type LLMConfig, type ChatMessage } from "../core/llm.js";
import { resolveComponentTimeout } from "../core/config.js";
import { formatNowForAgent } from "../core/timezone.js";
import { formatMessages, type RawMessage } from "../core/message-enricher.js";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
    TopicNode,
    PersonGroupProfile,
    InteractionEpisode,
    MergedMemory,
    GroupModel,
    FactCategory,
    ReflectionResult,
} from "./types.js";
import type { MemoryStoreV2 } from "./memory-v2.js";

const log = createLogger("reflection");

// ─── 类型定义 ───

/** LLM 返回的结构化反思结果 */
interface ReflectionLLMOutput {
    personUpdates: Array<{
        userId: string;
        traits?: string[];
        interests?: string[];
        communicationStyle?: string;
        relationToAgent?: string;
        dunbarTier?: 1 | 2 | 3 | 4;
        dunbarReason?: string;
        interactionQuality?: "friendly" | "dependent" | "instrumental" | "hostile";
    }>;
    groupUpdates: {
        agentRole?: string;
        engagementLevel?: "high" | "medium" | "low";
        hotTopics?: string[];
        tabooTopics?: string[];
        description?: string;
        communicationNorms?: string[];
        recentFeedback?: string;
    };
    /** 事实更新（支持新增/修改/删除） */
    factUpdates: Array<{
        /** 已有 fact 的 id（更新/删除时提供，新增时不提供） */
        id?: string;
        subject: string;
        content: string;
        category: FactCategory;
        /** 操作类型：不提供或 "upsert" 为新增/更新，"delete" 为删除 */
        action?: "upsert" | "delete";
    }>;
    topicsSummary: Array<{
        label: string;
        summary: string;
        participants: string[];
        sentiment: string;
    }>;
    identityUpdates?: Array<{
        userId: string;
        displayName?: string;
        aliases?: string[];
    }>;
    insights: string;
}

/** 每位参与者的量化统计 */
interface ParticipantStats {
    userId: string;
    messageCount: number;
    topicsParticipated: number;
    activeDays: Set<string>;
    sentiments: string[];
}

/** 单个 Tier 的画像精度限制 */
export interface TierLimitEntry {
    maxTraits: number;
    maxInterests: number;
    episodeDays: number;
}

/** 4 个 Tier 的完整配置 */
export type TierLimitsConfig = Record<1 | 2 | 3 | 4, TierLimitEntry>;

/** Reflection 独立配置（从 config.yaml 的 reflection 节加载，或代码层传入） */
export type { ReflectionExternalConfig as ReflectionConfig } from "../core/config.js";
import type { ReflectionExternalConfig } from "../core/config.js";

/** 解析合并阈值，合并外部配置和默认值 */
function resolveMergeThresholds(config?: ReflectionExternalConfig) {
    const mt = config?.mergeThresholds;
    return {
        episodeToWeek: mt?.episodeToWeek ?? 7,
        weekToMonth: mt?.weekToMonth ?? 30,
        monthToQuarter: mt?.monthToQuarter ?? 90,
        quarterToYear: mt?.quarterToYear ?? 365,
    };
}

/** 解析 tierLimits，合并外部配置和默认值 */
function resolveTierLimits(config?: ReflectionExternalConfig): Partial<TierLimitsConfig> | undefined {
    if (!config?.tierLimits) return undefined;
    const result: Partial<TierLimitsConfig> = {};
    for (const [tier, limits] of Object.entries(config.tierLimits)) {
        const t = Number(tier) as 1 | 2 | 3 | 4;
        if (t >= 1 && t <= 4 && limits) {
            result[t] = {
                maxTraits: limits.maxTraits ?? DEFAULT_TIER_LIMITS[t].maxTraits,
                maxInterests: limits.maxInterests ?? DEFAULT_TIER_LIMITS[t].maxInterests,
                episodeDays: limits.episodeDays ?? DEFAULT_TIER_LIMITS[t].episodeDays,
            };
        }
    }
    return Object.keys(result).length > 0 ? result : undefined;
}

// ─── 核心函数 ───

/**
 * 执行 Reflection：5 步流程
 *
 * 1. 数据收集：查 last_reflected_at 之后的 topics / interactions
 * 2. 量化统计：每位参与者的消息数、话题数、活跃天数
 * 3. LLM 调用：构建 prompt → cheap model → 结构化 JSON
 * 4. 解析写入：person_group_profiles / core_facts / group_models
 * 5. 返回 ReflectionResult
 */
export async function runReflection(
    chatId: string,
    memory: MemoryStoreV2,
    llmConfigs: LLMConfig[],
    reflectionConfig?: ReflectionExternalConfig,
): Promise<ReflectionResult> {
    const startTime = new Date().toISOString();

    log.info("Reflection 开始", { chatId });

    // ── Step 1: 数据收集 ──
    const groupModel = memory.getGroupModel(chatId);
    const since = groupModel?.lastReflectedAt ?? "1970-01-01T00:00:00.000Z";

    const topics = memory.getTopicsSince(chatId, since);
    const interactions = memory.getInteractionsSince(chatId, since);
    const profiles = memory.getProfilesForChat(chatId);

    if (topics.length === 0 && interactions.length === 0) {
        log.info("Reflection 跳过：无新数据", { chatId, since });
        return {
            reflectedPeriod: { from: since, to: startTime },
            topicsSummary: [],
            personUpdates: [],
            groupUpdates: "",
            newCoreFacts: [],
            mergedEpisodes: 0,
            insights: "No new topics or interactions; reflection skipped.",
        };
    }

    // ── Step 2: 量化统计 ──
    const stats = computeParticipantStats(topics, interactions);

    // ── Step 3: LLM 调用 ──
    const isDirectMessage = groupModel?.isDirectMessage ?? false;
    const prompt = buildReflectionPrompt(topics, interactions, profiles, stats, groupModel, isDirectMessage, memory);
    const messages: ChatMessage[] = [
        { role: "system", content: getReflectionSystemPrompt() },
        { role: "user", content: prompt },
    ];

    let llmOutput: ReflectionLLMOutput = {
        personUpdates: [],
        groupUpdates: {},
        factUpdates: [],
        topicsSummary: [],
        insights: "",
    };
    try {
        const response = await callLLMWithFallback(messages, llmConfigs, {
            caller: "reflection",
            timeoutMs: resolveComponentTimeout("reflection"),
        });
        const parsed = parseReflectionJSON(response.content);
        if (parsed) {
            llmOutput = parsed;
            log.info("Reflection LLM 返回解析成功", {
                personUpdates: llmOutput.personUpdates.length,
                factUpdates: llmOutput.factUpdates.length,
            });
        } else {
            log.warn("Reflection LLM 返回无法解析，使用空默认值");
        }
    } catch (err) {
        log.error("Reflection LLM 调用或解析失败", { error: String(err) });
        // 优雅降级：不崩溃，返回空结果
        return {
            reflectedPeriod: { from: since, to: startTime },
            topicsSummary: topics.map(t => ({
                label: t.label,
                summary: t.summary,
                participants: t.participants,
                sentiment: t.sentiment,
            })),
            personUpdates: [],
            groupUpdates: "",
            newCoreFacts: [],
            mergedEpisodes: 0,
            insights: `Reflection LLM call failed: ${String(err)}`,
        };
    }

    // ── Step 4: 解析 + 写入 ──
    log.debug("Reflection Step 4: 开始写入", {
        personUpdates: llmOutput.personUpdates.length,
        factUpdates: llmOutput.factUpdates.length,
        hasGroupUpdates: Object.keys(llmOutput.groupUpdates).length > 0,
    });
    const personUpdates: ReflectionResult["personUpdates"] = [];
    const newCoreFacts: string[] = [];

    // 4a′. 更新 person_identities（displayName/aliases 变化）
    if (llmOutput.identityUpdates?.length) {
        for (const iu of llmOutput.identityUpdates) {
            const idData: { displayName?: string; aliases?: string[] } = {};
            if (iu.displayName) idData.displayName = iu.displayName;
            if (iu.aliases?.length) idData.aliases = iu.aliases;
            if (Object.keys(idData).length > 0) {
                const compositeUid = ensureCompositeId(getPlatform(chatId), iu.userId);
                memory.upsertPersonIdentity(compositeUid, idData);
                log.debug("Reflection 4a′: 更新身份信息", { userId: compositeUid, ...idData });
            }
        }
    }

    // 4a. 写入画像增量（不再直接使用 LLM 的 dunbarTier，改由 affinityScore 驱动）
    for (const pu of llmOutput.personUpdates) {
        const updateData: Partial<PersonGroupProfile> = {};
        const changes: string[] = [];

        if (pu.traits?.length) { updateData.traits = pu.traits; changes.push(`traits=[${pu.traits.join(",")}]`); }
        if (pu.interests?.length) { updateData.interests = pu.interests; changes.push(`interests=[${pu.interests.join(",")}]`); }
        if (pu.communicationStyle) { updateData.communicationStyle = pu.communicationStyle; changes.push(`style=${pu.communicationStyle}`); }
        if (pu.relationToAgent) { updateData.relationToAgent = pu.relationToAgent; changes.push(`relation=${pu.relationToAgent}`); }
        if (pu.dunbarReason) { updateData.dunbarReason = pu.dunbarReason; }
        // 注意：不再写入 pu.dunbarTier，由 computeAffinityScores 统一计算

        if (changes.length > 0) {
            const compositeUid = ensureCompositeId(getPlatform(chatId), pu.userId);
            memory.upsertPersonGroupProfile(compositeUid, chatId, updateData);
            log.debug("Reflection 4a: 写入画像增量", { userId: compositeUid, changes: changes.join("; ") });
            personUpdates.push({
                userId: pu.userId,
                chatId,
                changes: changes.join("; "),
            });
        }
    }

    // 4a-score. 亲和度评分：计算 affinityScore 并派生 dunbarTier
    {
        const qualityMap = new Map<string, ReflectionLLMOutput["personUpdates"][0]["interactionQuality"]>();
        for (const pu of llmOutput.personUpdates) {
            if (pu.interactionQuality) {
                const compositeUid = ensureCompositeId(getPlatform(chatId), pu.userId);
                qualityMap.set(compositeUid, pu.interactionQuality);
            }
        }
        const updatedProfiles = memory.getProfilesForChat(chatId);
        const scores = computeAffinityScores(updatedProfiles, stats, qualityMap, isDirectMessage, memory, chatId);
        for (const [userId, { score, tier }] of scores) {
            memory.upsertPersonGroupProfile(userId, chatId, {
                affinityScore: score,
                dunbarTier: tier,
            });
            log.debug("Reflection 4a-score: 亲和度评分", { userId, score, tier });
        }
    }

    // 4a″. 将本次 interactions 转为 recentEpisodes 写入对应 profile（memory.md §3.2 情感记忆渐进合并）
    if (interactions.length > 0) {
        const interactionsByUser = new Map<string, typeof interactions>();
        for (const intr of interactions) {
            const uid = intr.userId;
            if (!uid || uid === "agent") continue;
            const arr = interactionsByUser.get(uid) ?? [];
            arr.push(intr);
            interactionsByUser.set(uid, arr);
        }
        for (const [userId, userInteractions] of interactionsByUser) {
            const profile = profiles.find(p => p.userId === userId);
            if (!profile) continue;
            const existing = profile.recentEpisodes ?? [];
            // 去重：跳过已存在的 episode id
            const existingIds = new Set(existing.map(e => e.id));
            const newEpisodes = userInteractions
                .filter(intr => !existingIds.has(intr.id))
                .map(intr => ({
                    id: intr.id,
                    date: intr.date,
                    chatId: intr.chatId,
                    userId: intr.userId,
                    topicId: intr.topicId ?? null,
                    type: intr.type,
                    summary: intr.summary,
                    sentiment: intr.sentiment ?? "neutral" as const,
                    significance: intr.significance ?? 0.5,
                }));
            if (newEpisodes.length > 0) {
                memory.upsertPersonGroupProfile(userId, chatId, {
                    recentEpisodes: [...existing, ...newEpisodes],
                });
                log.debug("Reflection 4a″: 写入 recentEpisodes", {
                    userId, count: newEpisodes.length, total: existing.length + newEpisodes.length,
                });
            }
        }
    }

    // 4b. 事实更新（支持新增/修改/删除）
    const newFactsForEmbedding: Array<{ index: number; text: string }> = [];
    for (let i = 0; i < llmOutput.factUpdates.length; i++) {
        const fact = llmOutput.factUpdates[i];
        if (fact.action === "delete" && fact.id) {
            // 删除已有 fact
            const deleted = memory.deleteFact(fact.id);
            log.debug("Reflection 4b: 删除事实", { id: fact.id, deleted });
            continue;
        }
        if (fact.id) {
            // 更新已有 fact
            memory.updateFact(fact.id, {
                content: fact.content,
                category: fact.category,
            });
            newCoreFacts.push(`[updated] ${fact.content}`);
            log.debug("Reflection 4b: 更新事实", { id: fact.id, subject: fact.subject });
        } else {
            // 新增 fact（稍后生成 embedding）
            // 确保 subject 是 composite ID（防止 LLM 写入显示名）
            const resolvedSubject = ensureCompositeId(getPlatform(chatId), fact.subject);
            fact.subject = resolvedSubject;
            newFactsForEmbedding.push({ index: i, text: `${resolvedSubject}: ${fact.content}` });
        }
    }
    // 为新增 facts 生成 embedding
    let factEmbeddings: Float32Array[] = [];
    const embCfg = memory.getEmbeddingConfig();
    if (embCfg && newFactsForEmbedding.length > 0) {
        try {
            const { embed } = await import("./embedding.js");
            factEmbeddings = await embed(newFactsForEmbedding.map(f => f.text), embCfg);
            log.debug("Reflection 4b: 事实 embedding 生成完成", { count: factEmbeddings.length });
        } catch (err) {
            log.warn("Reflection 4b: 事实 embedding 生成失败", { error: String(err) });
        }
    }
    for (let ei = 0; ei < newFactsForEmbedding.length; ei++) {
        const fact = llmOutput.factUpdates[newFactsForEmbedding[ei].index];
        memory.storeFact(
            fact.subject, fact.content, fact.category, "reflection",
            undefined,
            factEmbeddings[ei] ?? undefined,
        );
        newCoreFacts.push(fact.content);
        log.debug("Reflection 4b: 新增事实", {
            subject: fact.subject, category: fact.category,
            hasEmbedding: !!factEmbeddings[ei],
        });
    }

    // 4b′. 回写话题情感到 topics 表
    if (llmOutput.topicsSummary.length > 0) {
        const topicByLabel = new Map(topics.map(t => [t.label, t]));
        for (const ts of llmOutput.topicsSummary) {
            const topic = topicByLabel.get(ts.label);
            if (topic && ts.sentiment) {
                // 用 updateTopicById 按 SQLite id 更新，避免将 UUID 当作 pipeline_topic_id 插入重复行
                memory.updateTopicById(topic.id, {
                    sentiment: ts.sentiment as TopicNode["sentiment"],
                });
                log.debug("Reflection 4b′: 回写话题情感", { label: ts.label, sentiment: ts.sentiment });
            }
        }
    }

    // 4c. 更新群组画像 + lastReflectedAt
    // 计算近 7 天日均消息量（stickiness 升级依据，architecture_v2.md §2.2）
    const recentMsgCount = memory.countRecentMessages(chatId, 7);
    const avgMessagesPerDay = Math.round((recentMsgCount / 7) * 10) / 10;

    const gu = llmOutput.groupUpdates;
    const groupUpdateData: Partial<GroupModel> = {
        lastReflectedAt: startTime,
        avgMessagesPerDay,
    };
    if (gu.agentRole) groupUpdateData.agentRole = gu.agentRole;
    if (gu.engagementLevel) groupUpdateData.engagementLevel = gu.engagementLevel;
    if (gu.hotTopics) groupUpdateData.hotTopics = gu.hotTopics;
    if (gu.tabooTopics) groupUpdateData.tabooTopics = gu.tabooTopics;
    if (gu.description) groupUpdateData.description = gu.description;
    if (gu.communicationNorms) groupUpdateData.communicationNorms = gu.communicationNorms;
    if (gu.recentFeedback) groupUpdateData.recentFeedback = gu.recentFeedback;

    // Issue 5: 将 insights 追加到 recentFeedback，使其被 attend 上下文自动消费
    if (llmOutput.insights) {
        const existingFeedback = groupUpdateData.recentFeedback || groupModel?.recentFeedback || "";
        const insightsPrefix = "[反思洞察] ";
        groupUpdateData.recentFeedback = existingFeedback
            ? `${existingFeedback}\n${insightsPrefix}${llmOutput.insights}`
            : `${insightsPrefix}${llmOutput.insights}`;
    }

    memory.upsertGroupModel(chatId, groupUpdateData);
    log.debug("Reflection 4c: 更新群组画像", { chatId, lastReflectedAt: startTime, insightsWritten: !!llmOutput.insights });

    // 4d. 情感记忆合并（LLM 辅助分析）
    let totalMerged = 0;
    for (const profile of profiles) {
        const merged = await mergeEpisodes(profile.userId, chatId, memory, llmConfigs, reflectionConfig);
        if (merged > 0) {
            log.debug("Reflection 4d: 情感合并", { userId: profile.userId, merged });
        }
        totalMerged += merged;
    }

    // 4e. 邦巴分层精度裁剪
    for (const profile of profiles) {
        const trimmed = trimProfileByTier(profile.userId, chatId, memory, reflectionConfig?.tierLimits);
        if (trimmed) {
            log.debug("Reflection 4e: 邦巴裁剪已应用", { userId: profile.userId });
        }
    }

    // 4f. 邦巴分层人数上限检查
    const DUNBAR_COUNT_LIMITS: Record<number, number> = { 1: 15, 2: 50, 3: 150 };
    const updatedProfiles = memory.getProfilesForChat(chatId);
    const tierGroups = new Map<number, typeof updatedProfiles>();

    for (const p of updatedProfiles) {
        const tier = p.dunbarTier;
        if (!tierGroups.has(tier)) tierGroups.set(tier, []);
        tierGroups.get(tier)!.push(p);
    }

    for (const [tier, limit] of Object.entries(DUNBAR_COUNT_LIMITS)) {
        const t = Number(tier);
        const group = tierGroups.get(t);
        if (!group || group.length <= limit) continue;

        // 按 messageCount 升序排序，最不活跃的排前面
        group.sort((a, b) => a.messageCount - b.messageCount);
        const excess = group.length - limit;
        const demoted = group.slice(0, excess);

        for (const p of demoted) {
            const newTier = Math.min(t + 1, 4) as 1 | 2 | 3 | 4;
            memory.upsertPersonGroupProfile(p.userId, chatId, {
                dunbarTier: newTier,
                dunbarReason: `Tier ${t} 超出上限 ${limit}，按活跃度降级`,
            });
            log.debug("Reflection 4f: 邦巴降级", {
                userId: p.userId, from: t, to: newTier, messageCount: p.messageCount,
            });
        }
    }

    // ── Step 5: 返回结果 ──
    const result: ReflectionResult = {
        reflectedPeriod: { from: since, to: startTime },
        topicsSummary: llmOutput.topicsSummary,
        personUpdates,
        groupUpdates: JSON.stringify(gu),
        newCoreFacts,
        mergedEpisodes: totalMerged,
        insights: llmOutput.insights,
    };

    log.info("Reflection 完成", {
        chatId,
        period: `${since} → ${startTime}`,
        topicsReviewed: topics.length,
        personUpdates: personUpdates.length,
        newFacts: newCoreFacts.length,
        mergedEpisodes: totalMerged,
    });

    // ── Step 6: 追加反思记录到 agent-state ──
    try {
        const AGENT_STATE_PATH = join(process.cwd(), "workspace", "agent-state.md");

        const reflectionEntry = [
            `\n## Reflection ${startTime}`,
            `\n**群组**: ${chatId}`,
            `**周期**: ${since} → ${startTime}`,
            `**话题**: ${topics.length} | **画像更新**: ${personUpdates.length} | **新事实**: ${newCoreFacts.length} | **合并**: ${totalMerged}`,
            llmOutput.insights ? `\n**洞察**: ${llmOutput.insights}` : "",
            "",
        ].join("\n");

        let currentState = "";
        if (existsSync(AGENT_STATE_PATH)) {
            currentState = readFileSync(AGENT_STATE_PATH, "utf-8");
        }

        const newState = currentState + reflectionEntry;
        const maxChars = 3500;
        const finalState = newState.length > maxChars
            ? "# Agent State\n\n...[早期记录已省略]\n\n" + newState.slice(newState.length - maxChars)
            : newState.startsWith("# Agent State") ? newState : "# Agent State\n" + newState;

        writeFileSync(AGENT_STATE_PATH, finalState, "utf-8");
        log.debug("Reflection Step 6: agent-state 已更新");
    } catch (err) {
        log.warn("Reflection Step 6: agent-state 写入失败", { error: String(err) });
    }

    return result;
}

// ─── 量化统计 ───

function computeParticipantStats(
    topics: TopicNode[],
    interactions: InteractionEpisode[],
): Map<string, ParticipantStats> {
    const statsMap = new Map<string, ParticipantStats>();

    const getOrCreate = (userId: string): ParticipantStats => {
        let s = statsMap.get(userId);
        if (!s) {
            s = { userId, messageCount: 0, topicsParticipated: 0, activeDays: new Set(), sentiments: [] };
            statsMap.set(userId, s);
        }
        return s;
    };

    // 从 topics 统计参与者
    for (const topic of topics) {
        for (const pid of topic.participants) {
            const s = getOrCreate(pid);
            s.topicsParticipated++;
            if (topic.startedAt) {
                s.activeDays.add(topic.startedAt.substring(0, 10));
            }
        }
        // 消息数按 topic.messageRange.count 估算
        if (topic.messageRange.count > 0 && topic.participants.length > 0) {
            const perPerson = Math.ceil(topic.messageRange.count / topic.participants.length);
            for (const pid of topic.participants) {
                getOrCreate(pid).messageCount += perPerson;
            }
        }
    }

    // 从 interactions 统计情感
    for (const ep of interactions) {
        // interactions 没有直接的 userId 字段，跳过
        // 但有 sentiment 可以用于整体统计
    }

    return statsMap;
}

// ─── 亲和度评分（30 天互动驱动 + Quality Delta + 时间衰减） ───

/** 计算百分位排名 (0-100) */
function percentileRank(value: number, sortedValues: number[]): number {
    if (sortedValues.length <= 1) return 50;
    let below = 0;
    for (const v of sortedValues) {
        if (v < value) below++;
    }
    return (below / (sortedValues.length - 1)) * 100;
}

/** 线性映射（小群组 <5 人时用） */
function linearMap(value: number, median: number): number {
    if (median <= 0) return value > 0 ? 50 : 0;
    return Math.min(100, (value / median) * 50);
}

type InteractionQuality = "friendly" | "dependent" | "instrumental" | "hostile";

const QUALITY_DELTAS: Record<InteractionQuality, number> = {
    friendly: 10,
    dependent: 15,
    instrumental: 0,
    hostile: -20,
};

function scoreToTier(score: number): 1 | 2 | 3 | 4 {
    if (score >= 90) return 1;
    if (score >= 70) return 2;
    if (score >= 50) return 3;
    return 4;
}

/** 30 天滚动窗口 */
const AFFINITY_WINDOW_DAYS = 30;
/** 超过此天数无互动则开始衰减 */
const DECAY_START_DAYS = 14;
/** 衰减系数 (每天减少的分数) */
const DECAY_PER_DAY = 2;

/**
 * 计算所有参与者的亲和度分数和 Dunbar Tier
 *
 * 算法（v2 — 30天互动驱动）：
 * 1. 从 interactions 表查询最近 30 天的 DIRECT_ADDRESS 互动（direct_message / agent_mentioned / agent_replied）
 * 2. 三维度百分位排名：互动次数 50%, 互动天数 30%, 画像深度 20%
 * 3. Quality Delta 累加（friendly +10, dependent +15, instrumental ±0, hostile -20）
 * 4. 时间衰减：若最后互动超过 14 天前，每多一天 -2 分
 * 5. finalScore = clamp(baseScore + qualityDelta - decayPenalty, 0, 100)
 */
function computeAffinityScores(
    profiles: PersonGroupProfile[],
    _stats: Map<string, ParticipantStats>,
    qualityMap: Map<string, InteractionQuality | undefined>,
    isDirectMessage: boolean,
    memory: MemoryStoreV2,
    chatId: string,
): Map<string, { score: number; tier: 1 | 2 | 3 | 4 }> {
    const result = new Map<string, { score: number; tier: 1 | 2 | 3 | 4 }>();
    if (profiles.length === 0) return result;

    // 查询 30 天互动数据
    const interactionStats = memory.countInteractionsPerUser(chatId, AFFINITY_WINDOW_DAYS);
    const nowMs = Date.now();

    // 收集每个维度的值（用于百分位排名）
    const interactionCounts: number[] = [];
    const interactionDays: number[] = [];
    const depthValues: number[] = [];

    const profileDimensions = profiles.map(p => {
        const iStats = interactionStats.get(p.userId);
        const interactionCount = iStats?.interactionCount ?? 0;
        const activeDays = iStats?.activeDays ?? 0;
        const lastInteractionAt = iStats?.lastInteractionAt ?? null;
        const depth = p.traits.length + p.interests.length;

        interactionCounts.push(interactionCount);
        interactionDays.push(activeDays);
        depthValues.push(depth);

        return { userId: p.userId, interactionCount, activeDays, depth, lastInteractionAt };
    });

    // 排序用于百分位计算
    interactionCounts.sort((a, b) => a - b);
    interactionDays.sort((a, b) => a - b);
    depthValues.sort((a, b) => a - b);

    const usePercentile = profiles.length >= 5;
    const medianInteractions = interactionCounts[Math.floor(interactionCounts.length / 2)] || 1;
    const medianDays = interactionDays[Math.floor(interactionDays.length / 2)] || 1;
    const medianDepth = depthValues[Math.floor(depthValues.length / 2)] || 1;

    for (const dim of profileDimensions) {
        // 30天内零互动 → 保底 5 分或原分衰减
        if (dim.interactionCount === 0) {
            const existing = profiles.find(p => p.userId === dim.userId)?.affinityScore ?? 0;
            // 如果之前有分，按时间衰减
            const daysSilent = dim.lastInteractionAt
                ? (nowMs - new Date(dim.lastInteractionAt).getTime()) / 86400_000
                : AFFINITY_WINDOW_DAYS;
            const decay = Math.max(0, daysSilent - DECAY_START_DAYS) * DECAY_PER_DAY;
            const finalScore = Math.max(0, Math.min(100, existing - decay));
            result.set(dim.userId, { score: finalScore, tier: scoreToTier(finalScore) });
            continue;
        }

        // 三维度加权基础分
        let baseScore: number;
        if (usePercentile) {
            const interP = percentileRank(dim.interactionCount, interactionCounts);
            const dayP = percentileRank(dim.activeDays, interactionDays);
            const depthP = percentileRank(dim.depth, depthValues);
            baseScore = interP * 0.50 + dayP * 0.30 + depthP * 0.20;
        } else {
            // 小群组 / 私聊 线性映射
            const interL = linearMap(dim.interactionCount, medianInteractions);
            const dayL = linearMap(dim.activeDays, medianDays);
            const depthL = linearMap(dim.depth, medianDepth);
            baseScore = interL * 0.50 + dayL * 0.30 + depthL * 0.20;
        }

        // 私聊 / DM 额外加成（私聊本身意味着更高亲密度）
        if (isDirectMessage) {
            baseScore = Math.min(100, baseScore + 15);
        }

        // Quality delta
        const quality = qualityMap.get(dim.userId);
        const delta = quality ? (QUALITY_DELTAS[quality] ?? 0) : 0;

        // 时间衰减：最后互动超过 DECAY_START_DAYS 天前 → 减分
        let decayPenalty = 0;
        if (dim.lastInteractionAt) {
            const daysSinceLastInteraction = (nowMs - new Date(dim.lastInteractionAt).getTime()) / 86400_000;
            if (daysSinceLastInteraction > DECAY_START_DAYS) {
                decayPenalty = (daysSinceLastInteraction - DECAY_START_DAYS) * DECAY_PER_DAY;
            }
        }

        const finalScore = Math.max(0, Math.min(100,
            baseScore + delta - decayPenalty
        ));
        result.set(dim.userId, { score: finalScore, tier: scoreToTier(finalScore) });
    }

    return result;
}

// ─── Prompt 加载 ───

const PROMPTS_DIR = join(process.cwd(), "system-prompts", "memory");

let _reflectionSystemPromptTpl: string | null = null;

function getReflectionSystemPromptTpl(): string {
    if (!_reflectionSystemPromptTpl) {
        try {
            _reflectionSystemPromptTpl = readFileSync(
                join(PROMPTS_DIR, "reflection-system.md"), "utf-8"
            ).trim();
            log.debug("Reflection system prompt 已加载", { length: _reflectionSystemPromptTpl.length });
        } catch {
            log.warn("Reflection system prompt 文件未找到，使用内置默认值");
            _reflectionSystemPromptTpl = "You are a chat observer AI. Follow the user message and output strict JSON. Current time: {{currentTime}}";
        }
    }
    return _reflectionSystemPromptTpl;
}

function getReflectionSystemPrompt(): string {
    return applyTemplate(getReflectionSystemPromptTpl(), { currentTime: formatNowForAgent() });
}

let _mergeSystemPromptTpl: string | null = null;

function getMergeSystemPromptTpl(): string {
    if (!_mergeSystemPromptTpl) {
        try {
            _mergeSystemPromptTpl = readFileSync(
                join(PROMPTS_DIR, "merge-episodes-system.md"), "utf-8"
            ).trim();
            log.debug("Merge system prompt 已加载", { length: _mergeSystemPromptTpl.length });
        } catch {
            log.warn("Merge system prompt 文件未找到，使用内置默认值");
            _mergeSystemPromptTpl = "You merge interaction memories into JSON: overallSentiment, highlights, relationshipTrend. Current time: {{currentTime}}";
        }
    }
    return _mergeSystemPromptTpl;
}

function getMergeSystemPrompt(): string {
    return applyTemplate(getMergeSystemPromptTpl(), { currentTime: formatNowForAgent() });
}

let _reflectionUserInstruction: string | null = null;

function getReflectionUserInstruction(): string {
    if (!_reflectionUserInstruction) {
        try {
            _reflectionUserInstruction = readFileSync(
                join(PROMPTS_DIR, "reflection-user-instruction.md"), "utf-8"
            ).trim();
            log.debug("Reflection user instruction 已加载", { length: _reflectionUserInstruction.length });
        } catch {
            log.warn("Reflection user instruction 文件未找到，使用内置默认值");
            _reflectionUserInstruction = "Using the data above, output the reflection JSON per schema.";
        }
    }
    return _reflectionUserInstruction;
}

let _reflectionDmUserInstruction: string | null = null;

function getReflectionDmUserInstruction(): string {
    if (!_reflectionDmUserInstruction) {
        try {
            _reflectionDmUserInstruction = readFileSync(
                join(PROMPTS_DIR, "reflection-dm-user-instruction.md"), "utf-8"
            ).trim();
            log.debug("Reflection DM user instruction 已加载", { length: _reflectionDmUserInstruction.length });
        } catch {
            log.warn("Reflection DM user instruction 文件未找到，回退到群聊版本");
            _reflectionDmUserInstruction = getReflectionUserInstruction();
        }
    }
    return _reflectionDmUserInstruction;
}

let _mergeEpisodesUserTpl: string | null = null;

function getMergeEpisodesUserTpl(): string {
    if (!_mergeEpisodesUserTpl) {
        try {
            _mergeEpisodesUserTpl = readFileSync(
                join(PROMPTS_DIR, "merge-episodes-user.md"), "utf-8"
            ).trim();
            log.debug("Merge episodes user prompt 已加载", { length: _mergeEpisodesUserTpl.length });
        } catch {
            log.warn("Merge episodes user prompt 文件未找到，使用内置默认值");
            _mergeEpisodesUserTpl = "Current time: {{currentTime}}\n\nUser: {{userId}}\nEvents ({{count}}):\n\n{{eventLines}}\n\nAnalyze and output JSON.";
        }
    }
    return _mergeEpisodesUserTpl;
}

let _mergeCascadeUserTpl: string | null = null;

function getMergeCascadeUserTpl(): string {
    if (!_mergeCascadeUserTpl) {
        try {
            _mergeCascadeUserTpl = readFileSync(
                join(PROMPTS_DIR, "merge-cascade-user.md"), "utf-8"
            ).trim();
            log.debug("Merge cascade user prompt 已加载", { length: _mergeCascadeUserTpl.length });
        } catch {
            log.warn("Merge cascade user prompt 文件未找到，使用内置默认值");
            _mergeCascadeUserTpl = "Current time: {{currentTime}}\n\nPrior summaries ({{count}}):\n\n{{lines}}\n\nProduce a higher-level merged summary as JSON.";
        }
    }
    return _mergeCascadeUserTpl;
}

/** 简单模板替换：将 {{key}} 替换为对应值 */
function applyTemplate(tpl: string, vars: Record<string, string>): string {
    return Object.entries(vars).reduce(
        (s, [k, v]) => s.replaceAll(`{{${k}}}`, v),
        tpl,
    );
}

function buildReflectionPrompt(
    topics: TopicNode[],
    interactions: InteractionEpisode[],
    profiles: PersonGroupProfile[],
    stats: Map<string, ParticipantStats>,
    groupModel: GroupModel | null,
    isDirectMessage: boolean = false,
    memory?: MemoryStoreV2,
): string {
    const sections: string[] = [];

    sections.push(`## Current time\n${formatNowForAgent()}`);

    // Group vs DM header
    if (groupModel) {
        if (isDirectMessage) {
            sections.push(`## Direct message context
- Counterpart: ${groupModel.chatTitle}
- Agent role: ${groupModel.agentRole || "(undefined)"}
- Engagement: ${groupModel.engagementLevel || "(unknown)"}
- Last reflection: ${groupModel.lastReflectedAt ?? "never"}
- Chat type: one-to-one DM`);
        } else {
            sections.push(`## Group context
- Title: ${groupModel.chatTitle}
- Agent role: ${groupModel.agentRole}
- Engagement: ${groupModel.engagementLevel}
- Hot topics: ${groupModel.hotTopics?.join(", ") || "none"}
- Last reflection: ${groupModel.lastReflectedAt ?? "never"}`);
        }
    }

    // Recent topics + transcript when memory is available
    if (topics.length > 0 && memory) {
        const chatId = topics[0].chatId;
        const topicBlocks: string[] = [];

        for (let i = 0; i < topics.length; i++) {
            const t = topics[i];
            const header = `### Topic ${i + 1}: ${t.label} (${t.startedAt?.substring(0, 10) ?? "?"})\n` +
                `Participants: ${t.participants.join(", ")} | Sentiment: ${t.sentiment} | Messages: ${t.messageRange.count}\n` +
                `Summary: ${t.summary || "(none)"}\n` +
                `Keywords: ${t.keywords.join(", ")}`;

            let conversationText = "";
            if (t.messageRange.messageIds.length > 0) {
                const msgs = memory.getMessagesByIds(chatId, t.messageRange.messageIds);
                if (msgs.length > 0) {
                    const rawMsgs: RawMessage[] = msgs.map(m => ({
                        id: m.messageId,
                        sender: m.displayName || getRawId(m.userId),
                        text: m.text,
                        timestamp: m.timestamp,
                        replyToMsgId: m.replyToMessageId,
                        mediaType: m.mediaType,
                        mediaInfo: m.mediaInfo,
                    }));
                    conversationText = formatMessages(rawMsgs, []);
                }
            }

            if (conversationText) {
                topicBlocks.push(`${header}\n\nTranscript:\n${conversationText}`);
            } else {
                topicBlocks.push(header);
            }
        }

        sections.push(`## Recent topics and transcripts (${topics.length})\n\n${topicBlocks.join("\n\n---\n\n")}`);
    } else if (topics.length > 0) {
        const topicLines = topics.map((t, i) =>
            `${i + 1}. **${t.label}** (${t.startedAt?.substring(0, 10) ?? "?"})\n` +
            `   Summary: ${t.summary || "(none)"}\n` +
            `   Participants: ${t.participants.join(", ")}\n` +
            `   Keywords: ${t.keywords.join(", ")}\n` +
            `   Sentiment: ${t.sentiment}\n` +
            `   Message count: ${t.messageRange.count}`
        ).join("\n\n");
        sections.push(`## Recent topics (${topics.length})\n\n${topicLines}`);
    }

    if (stats.size > 0) {
        const statLines = Array.from(stats.values()).map(s =>
            `- ${getRawId(s.userId)}: ${s.messageCount} messages, ${s.topicsParticipated} topics, ${s.activeDays.size} active day(s)`
        ).join("\n");
        sections.push(`## Participant stats\n\n${statLines}`);
    }

    if (profiles.length > 0) {
        const profileLines = profiles.map(p => {
            const identity = memory?.getPersonIdentity(p.userId);
            const namePart = identity?.displayName ? ` (display: ${identity.displayName}` +
                (identity.username ? `, @${identity.username}` : "") +
                (identity.aliases?.length ? `, aliases: [${identity.aliases.join(", ")}]` : "") +
                `)` : "";
            return `- **${getRawId(p.userId)}**${namePart} (Tier ${p.dunbarTier}): ` +
                `traits=[${p.traits.join(", ")}], interests=[${p.interests.join(", ")}], ` +
                `style="${p.communicationStyle}", relation="${p.relationToAgent}"`;
        }).join("\n");
        sections.push(`## Existing profiles (${profiles.length})\n\n${profileLines}`);
    }

    if (memory && profiles.length > 0) {
        const factLines: string[] = [];
        for (const p of profiles) {
            const result = memory.listCoreFacts({ subject: p.userId, limit: 10 });
            const facts = result.items;
            if (facts.length > 0) {
                for (const f of facts) {
                    factLines.push(`- [id:${f.id}] (${f.category}) ${getRawId(f.subject)}: ${f.content}`);
                }
            }
        }
        if (factLines.length > 0) {
            sections.push(`## Existing facts (${factLines.length})\n\n${factLines.join("\n")}`);
        }
    }

    const userInstruction = isDirectMessage
        ? getReflectionDmUserInstruction()
        : getReflectionUserInstruction();
    sections.push(`## Task\n\n${userInstruction}`);

    return sections.join("\n\n---\n\n");
}

// ─── JSON 解析 ───

/**
 * 解析 LLM 返回的 Reflection JSON
 * 支持纯 JSON 和 markdown 代码块包裹两种格式
 */
export function parseReflectionJSON(raw: string): ReflectionLLMOutput | null {
    // 尝试提取 markdown 代码块中的 JSON
    const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim();

    try {
        const parsed = JSON.parse(jsonStr) as Partial<ReflectionLLMOutput>;

        return {
            personUpdates: Array.isArray(parsed.personUpdates) ? parsed.personUpdates : [],
            groupUpdates: parsed.groupUpdates ?? {},
            factUpdates: Array.isArray((parsed as any).factUpdates) ? (parsed as any).factUpdates
                : Array.isArray((parsed as any).newFacts) ? (parsed as any).newFacts : [],
            topicsSummary: Array.isArray(parsed.topicsSummary) ? parsed.topicsSummary : [],
            identityUpdates: Array.isArray(parsed.identityUpdates) ? parsed.identityUpdates : undefined,
            insights: typeof parsed.insights === "string" ? parsed.insights : "",
        };
    } catch (err) {
        log.warn("Reflection JSON 解析失败，尝试宽松模式", { error: String(err) });

        // 宽松模式：尝试找到第一个 { 到最后一个 } 的范围
        const firstBrace = jsonStr.indexOf("{");
        const lastBrace = jsonStr.lastIndexOf("}");
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            try {
                const extracted = jsonStr.substring(firstBrace, lastBrace + 1);
                const parsed = JSON.parse(extracted) as Partial<ReflectionLLMOutput>;
                return {
                    personUpdates: Array.isArray(parsed.personUpdates) ? parsed.personUpdates : [],
                    groupUpdates: parsed.groupUpdates ?? {},
                    factUpdates: Array.isArray((parsed as any).factUpdates) ? (parsed as any).factUpdates
                        : Array.isArray((parsed as any).newFacts) ? (parsed as any).newFacts : [],
                    topicsSummary: Array.isArray(parsed.topicsSummary) ? parsed.topicsSummary : [],
                    identityUpdates: Array.isArray(parsed.identityUpdates) ? parsed.identityUpdates : undefined,
                    insights: typeof parsed.insights === "string" ? parsed.insights : "",
                };
            } catch {
                // 宽松模式也失败
            }
        }

        log.warn("无法解析 Reflection JSON，返回 null", { error: String(err) });
        return null;
    }
}

// ─── 邓巴分层精度裁剪 (M2.3) ───

/** 默认的各 Tier 画像精度限制（来自 memory.md §3.2.4） */
export const DEFAULT_TIER_LIMITS: TierLimitsConfig = {
    1: { maxTraits: 10, maxInterests: 15, episodeDays: 14 },
    2: { maxTraits: 6, maxInterests: 10, episodeDays: 7 },
    3: { maxTraits: 3, maxInterests: 5, episodeDays: 3 },
    4: { maxTraits: 1, maxInterests: 2, episodeDays: 1 },
};

/**
 * 根据用户的 dunbarTier 裁剪画像精度。
 *
 * Tier 越低（越不熟悉），保留的信息越少：
 * - traits / interests 截断到上限
 * - recentEpisodes 只保留 N 天内的
 *
 * @returns 是否发生了裁剪
 */
export function trimProfileByTier(
    userId: string,
    chatId: string,
    memory: MemoryStoreV2,
    tierOverrides?: Partial<TierLimitsConfig>,
): boolean {
    const profiles = memory.getProfilesForChat(chatId);
    const profile = profiles.find(p => p.userId === userId);
    if (!profile) return false;

    const tier = profile.dunbarTier ?? 4;
    const defaults = DEFAULT_TIER_LIMITS[tier];
    const overridden = tierOverrides?.[tier];
    const limits: TierLimitEntry = {
        maxTraits: overridden?.maxTraits ?? defaults.maxTraits,
        maxInterests: overridden?.maxInterests ?? defaults.maxInterests,
        episodeDays: overridden?.episodeDays ?? defaults.episodeDays,
    };
    const updateData: Partial<PersonGroupProfile> = {};
    let changed = false;

    // 裁剪 traits
    if (profile.traits.length > limits.maxTraits) {
        updateData.traits = profile.traits.slice(0, limits.maxTraits);
        changed = true;
    }

    // 裁剪 interests
    if (profile.interests.length > limits.maxInterests) {
        updateData.interests = profile.interests.slice(0, limits.maxInterests);
        changed = true;
    }

    // 裁剪 recentEpisodes（按天数）
    const episodes = profile.recentEpisodes ?? [];
    if (episodes.length > 0) {
        const cutoff = Date.now() - limits.episodeDays * 86400_000;
        const filtered = episodes.filter(ep =>
            new Date(ep.date).getTime() >= cutoff
        );
        if (filtered.length < episodes.length) {
            updateData.recentEpisodes = filtered;
            changed = true;
        }
    }

    if (changed) {
        memory.upsertPersonGroupProfile(userId, chatId, updateData);
        log.debug("trimProfileByTier 裁剪完成", {
            userId, chatId, tier,
            traits: updateData.traits?.length,
            interests: updateData.interests?.length,
            episodes: updateData.recentEpisodes?.length,
        });
    }

    return changed;
}

// ─── 情感记忆合并 (M2.2) ───

/** 默认合并阈值（天）—— 可通过 config.yaml reflection.merge_thresholds 覆盖 */
const DEFAULT_MERGE_THRESHOLDS = {
    episodeToWeek: 7,
    weekToMonth: 30,
    monthToQuarter: 90,
    quarterToYear: 365,
} as const;

/**
 * 对指定用户的情感记忆执行渐进合并。
 *
 * 策略（memory.md §3.2）：
 * - >7 天的 InteractionEpisode → MergedMemory(week)
 * - >30 天的 week → MergedMemory(month)
 * - >90 天的 month → MergedMemory(quarter)
 * - >365 天的 quarter → MergedMemory(year)
 *
 * 只保留 significance > 0.7 的 highlights。
 *
 * @returns 合并的 episode 数量
 */
export async function mergeEpisodes(
    userId: string,
    chatId: string,
    memory: MemoryStoreV2,
    llmConfigs?: LLMConfig[],
    reflectionConfig?: ReflectionExternalConfig,
): Promise<number> {
    const profiles = memory.getProfilesForChat(chatId);
    const profile = profiles.find(p => p.userId === userId);
    if (!profile) return 0;

    const now = Date.now();
    const recentEpisodes = profile.recentEpisodes ?? [];
    const existingMerged = profile.mergedMemory ?? [];
    const thresholds = resolveMergeThresholds(reflectionConfig);

    // ── Step 1: 分割 recentEpisodes → 保留近7天 + 待合并 ──
    const cutoff = now - thresholds.episodeToWeek * 86400_000;
    const kept: InteractionEpisode[] = [];
    const toMerge: InteractionEpisode[] = [];

    for (const ep of recentEpisodes) {
        const epTime = new Date(ep.date).getTime();
        if (epTime >= cutoff) {
            kept.push(ep);
        } else {
            toMerge.push(ep);
        }
    }

    if (toMerge.length === 0 && existingMerged.length === 0) {
        log.debug("mergeEpisodes: 无需合并", { userId, chatId });
        return 0; // 无需合并
    }

    let mergedCount = toMerge.length;
    const newMergedList = [...existingMerged];

    // ── Step 2: 将过期 episodes 按 ISO 周分组→生成 week MergedMemory ──
    if (toMerge.length > 0) {
        const weekGroups = groupByPeriod(toMerge.map(ep => ({
            date: ep.date,
            sentiment: ep.sentiment,
            significance: ep.significance,
            summary: ep.summary,
        })), "week");

        for (const [, items] of weekGroups) {
            const dates = items.map(i => i.date).sort();

            // 使用 LLM 分析合并结果（若提供了 llmConfigs）
            const llmResult = llmConfigs?.length
                ? await analyzeMergeWithLLM(userId, items, llmConfigs, reflectionConfig)
                : null;

            newMergedList.push({
                periodStart: dates[0],
                periodEnd: dates[dates.length - 1],
                granularity: "week",
                overallSentiment: llmResult?.overallSentiment
                    ?? computeOverallSentiment(items.map(i => i.sentiment)),
                interactionCount: items.length,
                highlights: llmResult?.highlights
                    ?? items.filter(i => i.significance > 0.7).map(i => i.summary),
                relationshipTrend: llmResult?.relationshipTrend ?? "",
            });
        }
    }

    // ── Step 3: 合并 week → month (>30天的 week) ──
    const monthCutoff = now - thresholds.weekToMonth * 86400_000;
    await cascadeMerge(newMergedList, "week", "month", monthCutoff, llmConfigs, reflectionConfig);

    // ── Step 4: 合并 month → quarter (>90天的 month) ──
    const quarterCutoff = now - thresholds.monthToQuarter * 86400_000;
    await cascadeMerge(newMergedList, "month", "quarter", quarterCutoff, llmConfigs, reflectionConfig);

    // ── Step 5: 合并 quarter → year (>365天的 quarter) ──
    const yearCutoff = now - thresholds.quarterToYear * 86400_000;
    await cascadeMerge(newMergedList, "quarter", "year", yearCutoff, llmConfigs, reflectionConfig);

    // ── Step 6: 写回 ──
    // 按 periodStart 降序排列（最近的在前）
    newMergedList.sort((a, b) =>
        new Date(b.periodStart).getTime() - new Date(a.periodStart).getTime()
    );

    memory.upsertPersonGroupProfile(userId, chatId, {
        recentEpisodes: kept,
        mergedMemory: newMergedList,
    });

    if (mergedCount > 0) {
        log.debug("mergeEpisodes 完成", {
            userId, chatId,
            episodesMerged: mergedCount,
            recentKept: kept.length,
            mergedEntries: newMergedList.length,
        });
    }

    return mergedCount;
}

// ─── 合并辅助函数 ───

interface MergeItem {
    date: string;
    sentiment: string;
    significance: number;
    summary: string;
}

/** 按粒度分组 MergeItem */
function groupByPeriod(items: MergeItem[], granularity: MergedMemory["granularity"]): Map<string, MergeItem[]> {
    const groups = new Map<string, MergeItem[]>();
    for (const item of items) {
        const key = getPeriodKey(item.date, granularity);
        const arr = groups.get(key) ?? [];
        arr.push(item);
        groups.set(key, arr);
    }
    return groups;
}

/** LLM 分析合并的返回结果 */
interface MergeAnalysisResult {
    overallSentiment: MergedMemory["overallSentiment"];
    highlights: string[];
    relationshipTrend: string;
}

/**
 * 使用 cheap model 分析一组交互事件，生成综合性的情感/亮点/关系趋势摘要。
 * 失败时返回 null，调用方回退到规则合并。
 */
async function analyzeMergeWithLLM(
    userId: string,
    items: MergeItem[],
    llmConfigs: LLMConfig[],
    reflectionConfig?: ReflectionExternalConfig,
): Promise<MergeAnalysisResult | null> {
    if (items.length === 0) return null;

    const eventLines = items.map(i =>
        `- [${i.date}] (sentiment:${i.sentiment}, significance:${i.significance}) ${i.summary}`
    ).join("\n");

    const userPrompt = applyTemplate(getMergeEpisodesUserTpl(), {
        userId,
        count: String(items.length),
        eventLines,
        currentTime: formatNowForAgent(),
    });

    try {
        const messages: ChatMessage[] = [
            { role: "system", content: getMergeSystemPrompt() },
            { role: "user", content: userPrompt },
        ];
        const response = await callLLMWithFallback(messages, llmConfigs, {
            caller: "reflection",
            timeoutMs: resolveComponentTimeout("reflection"),
        });

        const parsed = JSON.parse(
            response.content.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?```/, "$1").trim()
        );

        log.debug("analyzeMergeWithLLM 成功", { userId, sentiment: parsed.overallSentiment });

        return {
            overallSentiment: parsed.overallSentiment ?? "neutral",
            highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
            relationshipTrend: typeof parsed.relationshipTrend === "string" ? parsed.relationshipTrend : "",
        };
    } catch (err) {
        log.warn("analyzeMergeWithLLM 失败，回退到规则合并", { userId, error: String(err) });
        return null;
    }
}

/**
 * 使用 cheap model 分析级联合并中的 MergedMemory 条目。
 */
async function analyzeCascadeMergeWithLLM(
    items: MergedMemory[],
    llmConfigs: LLMConfig[],
    reflectionConfig?: ReflectionExternalConfig,
): Promise<MergeAnalysisResult | null> {
    if (items.length === 0) return null;

    const lines = items.map(i =>
        `- [${i.periodStart}~${i.periodEnd}] granularity:${i.granularity}, ` +
        `sentiment:${i.overallSentiment}, interactions:${i.interactionCount}, ` +
        `highlights:[${i.highlights.join("; ")}], trend:${i.relationshipTrend || "(none)"}`
    ).join("\n");

    const userPrompt = applyTemplate(getMergeCascadeUserTpl(), {
        count: String(items.length),
        lines,
        currentTime: formatNowForAgent(),
    });

    try {
        const messages: ChatMessage[] = [
            { role: "system", content: getMergeSystemPrompt() },
            { role: "user", content: userPrompt },
        ];
        const response = await callLLMWithFallback(messages, llmConfigs, {
            caller: "reflection",
            timeoutMs: resolveComponentTimeout("reflection"),
        });

        const parsed = JSON.parse(
            response.content.replace(/```(?:json)?\s*\n?([\s\S]*?)\n?```/, "$1").trim()
        );

        log.debug("analyzeCascadeMergeWithLLM 成功", { itemCount: items.length, sentiment: parsed.overallSentiment });

        return {
            overallSentiment: parsed.overallSentiment ?? "neutral",
            highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
            relationshipTrend: typeof parsed.relationshipTrend === "string" ? parsed.relationshipTrend : "",
        };
    } catch (err) {
        log.warn("analyzeCascadeMergeWithLLM 失败，回退到规则合并", { error: String(err) });
        return null;
    }
}

/**
 * 将 MergedMemory 条目从 sourceGranularity 升级为 targetGranularity
 * 对于 periodEnd 早于 cutoffTime 的 source 条目，按目标粒度分组合并
 */
async function cascadeMerge(
    list: MergedMemory[],
    sourceGranularity: MergedMemory["granularity"],
    targetGranularity: MergedMemory["granularity"],
    cutoffTime: number,
    llmConfigs?: LLMConfig[],
    reflectionConfig?: ReflectionExternalConfig,
): Promise<void> {
    const toUpgrade: MergedMemory[] = [];
    const remaining: number[] = []; // indices to keep

    for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (m.granularity === sourceGranularity &&
            new Date(m.periodEnd).getTime() < cutoffTime) {
            toUpgrade.push(m);
        } else {
            remaining.push(i);
        }
    }

    if (toUpgrade.length === 0) return;

    log.debug("cascadeMerge 开始", {
        source: sourceGranularity, target: targetGranularity,
        upgradeCount: toUpgrade.length,
    });

    // 按 periodStart 分组（用目标粒度的 period key）
    const groups = new Map<string, MergedMemory[]>();
    for (const m of toUpgrade) {
        const key = getPeriodKey(m.periodStart, targetGranularity);
        const arr = groups.get(key) ?? [];
        arr.push(m);
        groups.set(key, arr);
    }

    // 生成新的合并条目
    const newEntries: MergedMemory[] = [];
    for (const [, items] of groups) {
        const starts = items.map(i => i.periodStart).sort();
        const ends = items.map(i => i.periodEnd).sort();
        const allHighlights = items.flatMap(i => i.highlights);
        const totalCount = items.reduce((sum, i) => sum + i.interactionCount, 0);
        const sentiments = items.map(i => i.overallSentiment);

        // 使用 LLM 分析级联合并结果
        const llmResult = llmConfigs?.length
            ? await analyzeCascadeMergeWithLLM(items, llmConfigs, reflectionConfig)
            : null;

        newEntries.push({
            periodStart: starts[0],
            periodEnd: ends[ends.length - 1],
            granularity: targetGranularity,
            overallSentiment: llmResult?.overallSentiment
                ?? computeOverallSentiment(sentiments),
            interactionCount: totalCount,
            highlights: llmResult?.highlights ?? allHighlights,
            relationshipTrend: llmResult?.relationshipTrend
                ?? (items.map(i => i.relationshipTrend).filter(Boolean).join("; ") || ""),
        });
    }

    // 就地替换 list：保留 remaining indices + 添加 newEntries
    const kept = remaining.map(i => list[i]);
    list.length = 0;
    list.push(...kept, ...newEntries);
}

/** 根据粒度计算 period key */
function getPeriodKey(dateStr: string, granularity: MergedMemory["granularity"]): string {
    const d = new Date(dateStr);
    const year = d.getFullYear();
    const month = d.getMonth(); // 0-based

    switch (granularity) {
        case "week": {
            // ISO week: year-Wxx
            const jan1 = new Date(year, 0, 1);
            const days = Math.floor((d.getTime() - jan1.getTime()) / 86400_000);
            const week = Math.ceil((days + jan1.getDay() + 1) / 7);
            return `${year}-W${String(week).padStart(2, "0")}`;
        }
        case "month":
            return `${year}-${String(month + 1).padStart(2, "0")}`;
        case "quarter":
            return `${year}-Q${Math.floor(month / 3) + 1}`;
        case "year":
            return `${year}`;
    }
}

/** 从情感列表中计算总体情感 */
function computeOverallSentiment(
    sentiments: string[],
): MergedMemory["overallSentiment"] {
    if (sentiments.length === 0) return "neutral";

    const counts = { positive: 0, neutral: 0, negative: 0 };
    for (const s of sentiments) {
        if (s === "positive") counts.positive++;
        else if (s === "negative") counts.negative++;
        else counts.neutral++;
    }

    // 如果正面和负面都有且差距不大→mixed
    if (counts.positive > 0 && counts.negative > 0) {
        const ratio = Math.min(counts.positive, counts.negative) /
            Math.max(counts.positive, counts.negative);
        if (ratio > 0.3) return "mixed"; // 双方都占 >30% 时算 mixed
    }

    // 否则取多数
    if (counts.positive >= counts.negative && counts.positive >= counts.neutral) return "positive";
    if (counts.negative >= counts.positive && counts.negative >= counts.neutral) return "negative";
    return "neutral";
}
