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
import { getPlatform, ensureCompositeId, getRawId, getGroupModelKey } from "../core/chat-id.js";
import { callLLMWithFallback, type LLMConfig, type ChatMessage } from "../core/llm.js";
import { resolveComponentTimeout } from "../core/config.js";
import { formatMessages, type RawMessage } from "../core/message-enricher.js";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadPromptFile, registerCacheClear } from "../core/prompt-loader.js";
import type {
    TopicNode,
    PersonProfile,
    PersonGroupProfile,
    InteractionEpisode,
    MergedMemory,
    GroupModel,
    FactCategory,
    ReflectionResult,
    RecentMessageEntry,
    CoreFactProvenance,
} from "./types.js";
import type { MemoryStoreV2 } from "./memory-v2.js";

const log = createLogger("reflection");

// ─── 类型定义 ───

/** LLM 返回的结构化反思结果 */
interface ReflectionLLMOutput {
    globalPersonUpdates?: Array<{
        userId: string;
        traits?: string[];
        interests?: string[];
        communicationStyle?: string;
        relationToAgent?: string;
        stablePatterns?: string[];
        agentPolicyHints?: string[];
        followupCandidates?: string[];
        confidence?: number;
    }>;
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
        sourceTopicId?: string | null;
        sourceTopicLabel?: string | null;
        sourceMessageIds?: string[];
        sourceInteractionIds?: string[];
        observedAt?: string | null;
        visibility?: CoreFactProvenance["visibility"];
        sensitivity?: CoreFactProvenance["sensitivity"];
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
    relationshipEvents?: Array<{
        userId: string;
        summary: string;
        type?: InteractionEpisode["type"] | "milestone" | "preference" | "boundary";
        sentiment?: InteractionEpisode["sentiment"];
        significance?: number;
        interactionQuality?: InteractionQuality;
        messageIds?: string[];
        topicId?: string | null;
        topicLabel?: string;
        evidence?: string[];
        agentOutcome?: string;
        confidence?: number;
    }>;
    agentFeedback?: {
        effectiveBehaviors?: string[];
        avoidBehaviors?: string[];
        toneHints?: string[];
    };
    followupCandidates?: Array<{
        userId?: string;
        topic?: string;
        reason?: string;
        suggestedAction?: string;
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
    directInteractions: number;
    agentReplies: number;
    interactionTypes: Map<string, number>;
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
            insights: "无新话题或交互，跳过反思。",
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
            insights: `Reflection LLM 调用失败: ${String(err)}`,
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

    // 4a-global. 写入跨群全局画像（同一个人在不同 chat 共享的长期认知）
    if (llmOutput.globalPersonUpdates?.length) {
        for (const gu of llmOutput.globalPersonUpdates) {
            const compositeUid = ensureCompositeId(getPlatform(chatId), gu.userId);
            const existing = memory.getPersonProfile(compositeUid);
            const updateData = mergeGlobalPersonProfile(existing, gu, chatId, startTime);
            memory.upsertPersonProfile(compositeUid, updateData);
            log.debug("Reflection 4a-global: 写入全局画像", {
                userId: compositeUid,
                fields: Object.keys(updateData),
            });
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

    const qualityMap = new Map<string, InteractionQuality | undefined>();
    for (const pu of llmOutput.personUpdates) {
        if (pu.interactionQuality) {
            const compositeUid = ensureCompositeId(getPlatform(chatId), pu.userId);
            qualityMap.set(compositeUid, pu.interactionQuality);
        }
    }

    // 4a-score. 亲和度评分：计算 affinityScore 并派生 dunbarTier
    {
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

    // 4a″. 将本次 interactions/LLM relationshipEvents 转为带证据的 recentEpisodes
    const relationshipEpisodes = buildRelationshipEpisodes({
        chatId,
        interactions,
        topics,
        memory,
        qualityMap,
        relationshipEvents: llmOutput.relationshipEvents ?? [],
    });
    if (relationshipEpisodes.length > 0) {
        const latestProfiles = memory.getProfilesForChat(chatId);
        const profilesByUserId = new Map(latestProfiles.map(p => [p.userId, p]));
        const episodesByUser = new Map<string, InteractionEpisode[]>();
        for (const ep of relationshipEpisodes) {
            if (!ep.userId || ep.userId === "agent") continue;
            const arr = episodesByUser.get(ep.userId) ?? [];
            arr.push(ep);
            episodesByUser.set(ep.userId, arr);
        }
        for (const [userId, userEpisodes] of episodesByUser) {
            const profile = profilesByUserId.get(userId);
            if (!profile) continue;
            const existing = profile.recentEpisodes ?? [];
            const existingIds = new Set(existing.map(e => e.id));
            const newEpisodes = userEpisodes.filter(ep => !existingIds.has(ep.id));
            if (newEpisodes.length > 0) {
                memory.upsertPersonGroupProfile(userId, chatId, {
                    recentEpisodes: [...existing, ...newEpisodes],
                });
                log.debug("Reflection 4a″: 写入 richer recentEpisodes", {
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
                ...buildFactProvenance(fact, topics, interactions, chatId, groupModel, isDirectMessage, startTime),
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
            fact.subject, fact.content, fact.category, `reflection:${chatId}`,
            undefined,
            factEmbeddings[ei] ?? undefined,
            undefined,
            buildFactProvenance(fact, topics, interactions, chatId, groupModel, isDirectMessage, startTime),
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

    const reflectionFeedback = [
        llmOutput.insights ? `[反思洞察] ${llmOutput.insights}` : "",
        ...(llmOutput.agentFeedback?.effectiveBehaviors?.length
            ? [`[有效互动] ${llmOutput.agentFeedback.effectiveBehaviors.join("；")}`]
            : []),
        ...(llmOutput.agentFeedback?.avoidBehaviors?.length
            ? [`[避免方式] ${llmOutput.agentFeedback.avoidBehaviors.join("；")}`]
            : []),
        ...(llmOutput.agentFeedback?.toneHints?.length
            ? [`[语气提示] ${llmOutput.agentFeedback.toneHints.join("；")}`]
            : []),
        ...(llmOutput.followupCandidates?.length
            ? [`[可回访] ${llmOutput.followupCandidates
                .slice(0, 5)
                .map(item => [item.userId, item.topic, item.suggestedAction ?? item.reason].filter(Boolean).join(" / "))
                .join("；")}`]
            : []),
    ].filter(Boolean);

    // 将 reflection 对 agent 行为的洞察追加到 recentFeedback，使其被 attend 上下文自动消费
    if (reflectionFeedback.length > 0) {
        const existingFeedback = groupUpdateData.recentFeedback || groupModel?.recentFeedback || "";
        groupUpdateData.recentFeedback = existingFeedback
            ? `${existingFeedback}\n${reflectionFeedback.join("\n")}`
            : reflectionFeedback.join("\n");
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
            s = {
                userId,
                messageCount: 0,
                topicsParticipated: 0,
                activeDays: new Set(),
                sentiments: [],
                directInteractions: 0,
                agentReplies: 0,
                interactionTypes: new Map(),
            };
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

    // 从 interactions 统计直接互动与情感
    for (const ep of interactions) {
        if (!ep.userId) continue;
        const s = getOrCreate(ep.userId);
        s.sentiments.push(ep.sentiment ?? "neutral");
        s.interactionTypes.set(ep.type, (s.interactionTypes.get(ep.type) ?? 0) + 1);
        if (ep.type === "direct_message" || ep.type === "agent_mentioned") {
            s.directInteractions++;
        }
        if (ep.type === "agent_replied") {
            s.agentReplies++;
        }
        if (ep.date) {
            s.activeDays.add(ep.date.substring(0, 10));
        }
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

// ─── Prompt 加载（统一使用 prompt-loader 支持 override）───

let _reflectionSystemPrompt: string | null = null;

function getReflectionSystemPrompt(): string {
    if (!_reflectionSystemPrompt) {
        const content = loadPromptFile("memory/reflection-system.md");
        if (content) {
            _reflectionSystemPrompt = content.trim();
            log.debug("Reflection system prompt 已加载", { length: _reflectionSystemPrompt.length });
        } else {
            log.warn("Reflection system prompt 文件未找到，使用内置默认值");
            _reflectionSystemPrompt = "你是一个聊天观察员 AI。请根据话题和交互数据，输出一个严格的 JSON 对象。";
        }
    }
    return _reflectionSystemPrompt;
}

let _mergeSystemPrompt: string | null = null;

function getMergeSystemPrompt(): string {
    if (!_mergeSystemPrompt) {
        const content = loadPromptFile("memory/merge-episodes-system.md");
        if (content) {
            _mergeSystemPrompt = content.trim();
            log.debug("Merge system prompt 已加载", { length: _mergeSystemPrompt.length });
        } else {
            log.warn("Merge system prompt 文件未找到，使用内置默认值");
            _mergeSystemPrompt = "你是一个记忆合并助手。请分析交互事件，输出 JSON 格式的 overallSentiment、highlights、relationshipTrend。";
        }
    }
    return _mergeSystemPrompt;
}

let _reflectionUserInstruction: string | null = null;

function getReflectionUserInstruction(): string {
    if (!_reflectionUserInstruction) {
        const content = loadPromptFile("memory/reflection-user-instruction.md");
        if (content) {
            _reflectionUserInstruction = content.trim();
            log.debug("Reflection user instruction 已加载", { length: _reflectionUserInstruction.length });
        } else {
            log.warn("Reflection user instruction 文件未找到，使用内置默认值");
            _reflectionUserInstruction = "请根据以上数据，输出 JSON 格式的反思结果。";
        }
    }
    return _reflectionUserInstruction;
}

let _reflectionDmUserInstruction: string | null = null;

function getReflectionDmUserInstruction(): string {
    if (!_reflectionDmUserInstruction) {
        const content = loadPromptFile("memory/reflection-dm-user-instruction.md");
        if (content) {
            _reflectionDmUserInstruction = content.trim();
            log.debug("Reflection DM user instruction 已加载", { length: _reflectionDmUserInstruction.length });
        } else {
            log.warn("Reflection DM user instruction 文件未找到，回退到群聊版本");
            _reflectionDmUserInstruction = getReflectionUserInstruction();
        }
    }
    return _reflectionDmUserInstruction;
}

let _mergeEpisodesUserTpl: string | null = null;

function getMergeEpisodesUserTpl(): string {
    if (!_mergeEpisodesUserTpl) {
        const content = loadPromptFile("memory/merge-episodes-user.md");
        if (content) {
            _mergeEpisodesUserTpl = content.trim();
            log.debug("Merge episodes user prompt 已加载", { length: _mergeEpisodesUserTpl.length });
        } else {
            log.warn("Merge episodes user prompt 文件未找到，使用内置默认值");
            _mergeEpisodesUserTpl = "用户: {{userId}}\n交互事件 ({{count}} 条):\n\n{{eventLines}}\n\n请分析以上事件，输出 JSON。";
        }
    }
    return _mergeEpisodesUserTpl;
}

let _mergeCascadeUserTpl: string | null = null;

function getMergeCascadeUserTpl(): string {
    if (!_mergeCascadeUserTpl) {
        const content = loadPromptFile("memory/merge-cascade-user.md");
        if (content) {
            _mergeCascadeUserTpl = content.trim();
            log.debug("Merge cascade user prompt 已加载", { length: _mergeCascadeUserTpl.length });
        } else {
            log.warn("Merge cascade user prompt 文件未找到，使用内置默认值");
            _mergeCascadeUserTpl = "已有的记忆摘要 ({{count}} 条):\n\n{{lines}}\n\n请综合分析这些记忆，生成更高层级的合并摘要。";
        }
    }
    return _mergeCascadeUserTpl;
}

// 注册缓存清除回调
registerCacheClear(() => {
    _reflectionSystemPrompt = null;
    _mergeSystemPrompt = null;
    _reflectionUserInstruction = null;
    _reflectionDmUserInstruction = null;
    _mergeEpisodesUserTpl = null;
    _mergeCascadeUserTpl = null;
});

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
    const MAX_TOPIC_BLOCKS = 60;
    const MAX_MESSAGES_PER_TOPIC = 30;

    // 基本信息（私聊 vs 群聊）
    if (groupModel) {
        if (isDirectMessage) {
            sections.push(`## 私聊信息
- 对话对象: ${groupModel.chatTitle}
- 当前 agent 角色: ${groupModel.agentRole || "(未定义)"}
- 活跃度: ${groupModel.engagementLevel || "(未知)"}
- 上次反思: ${groupModel.lastReflectedAt ?? "从未"}
- 聊天类型: 一对一私聊`);
        } else {
            sections.push(`## 群组信息
- 群名: ${groupModel.chatTitle}
- 当前 agent 角色: ${groupModel.agentRole}
- 活跃度: ${groupModel.engagementLevel}
- 热点话题: ${groupModel.hotTopics?.join(", ") || "无"}
- 上次反思: ${groupModel.lastReflectedAt ?? "从未"}`);
        }
    }

    // 近期话题与对话（合并）—— 获取每个话题的实际消息并格式化
    if (topics.length > 0 && memory) {
        const chatId = topics[0].chatId;
        const topicBlocks: string[] = [];
        const promptTopics = topics.length > MAX_TOPIC_BLOCKS ? topics.slice(-MAX_TOPIC_BLOCKS) : topics;

        for (let i = 0; i < promptTopics.length; i++) {
            const t = promptTopics[i];
            const header = `### 话题 ${i + 1}: ${t.label} (${t.startedAt?.substring(0, 10) ?? "?"})\n` +
                `参与者: ${t.participants.join(", ")} | 情感: ${t.sentiment} | 消息数: ${t.messageRange.count}\n` +
                `摘要: ${t.summary || "(无)"}\n` +
                `关键词: ${t.keywords.join(", ")}`;

            // 获取话题关联的实际消息
            let conversationText = "";
            if (t.messageRange.messageIds.length > 0) {
                const messageIds = t.messageRange.messageIds.slice(-MAX_MESSAGES_PER_TOPIC);
                const msgs = memory.getMessagesByIds(chatId, messageIds);
                if (msgs.length > 0) {
                    // RecentMessageEntry → RawMessage
                    const rawMsgs: RawMessage[] = msgs.map(m => ({
                        id: m.messageId,
                        sender: m.displayName ? `${m.displayName}(${m.userId})` : formatUserLabel(memory, m.userId),
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
                topicBlocks.push(`${header}\n\n对话内容:\n${conversationText}`);
            } else {
                topicBlocks.push(header);
            }
        }

        const omitted = topics.length > promptTopics.length
            ? `；仅显示最近 ${promptTopics.length} 个，每个话题最多 ${MAX_MESSAGES_PER_TOPIC} 条消息`
            : "";
        sections.push(`## 近期话题与对话 (${topics.length} 个${omitted})\n\n${topicBlocks.join("\n\n---\n\n")}`);
    } else if (topics.length > 0) {
        // fallback: 无 memory 时仅显示话题摘要
        const promptTopics = topics.length > MAX_TOPIC_BLOCKS ? topics.slice(-MAX_TOPIC_BLOCKS) : topics;
        const topicLines = promptTopics.map((t, i) =>
            `${i + 1}. **${t.label}** (${t.startedAt?.substring(0, 10) ?? "?"})\n` +
            `   摘要: ${t.summary || "(无)"}\n` +
            `   参与者: ${t.participants.join(", ")}\n` +
            `   关键词: ${t.keywords.join(", ")}\n` +
            `   情感: ${t.sentiment}\n` +
            `   消息数: ${t.messageRange.count}`
        ).join("\n\n");
        const omitted = topics.length > promptTopics.length ? `；仅显示最近 ${promptTopics.length} 个` : "";
        sections.push(`## 近期话题 (${topics.length} 个${omitted})\n\n${topicLines}`);
    }

    // 近期直接互动：这些是 recentEpisodes 和关系记忆的主要原料
    if (interactions.length > 0) {
        const interactionLines = interactions
            .slice(-80)
            .map(intr => formatInteractionForPrompt(intr, topics, memory))
            .join("\n");
        sections.push(`## 近期直接互动 (${interactions.length} 条，最多显示 80 条)\n\n${interactionLines}`);
    }

    // 参与者量化数据
    if (stats.size > 0) {
        const statLines = Array.from(stats.values()).map(s =>
            `- ${formatUserLabel(memory, s.userId)}: ${s.messageCount} 条消息, ${s.topicsParticipated} 个话题, ` +
            `${s.directInteractions} 次直呼/私聊, ${s.agentReplies} 次 agent 回复, ${s.activeDays.size} 天活跃, ` +
            `互动类型=${formatCountMap(s.interactionTypes)}`
        ).join("\n");
        sections.push(`## 参与者统计\n\n${statLines}`);
    }

    // 现有画像
    if (profiles.length > 0) {
        if (memory) {
            const globalLines = profiles.map(p => {
                const global = memory.getPersonProfile(p.userId);
                if (!global) {
                    return `- **${formatUserLabel(memory, p.userId)}**: (暂无全局画像，需从本次和跨群事实中提炼稳定认知)`;
                }
                return `- **${formatUserLabel(memory, p.userId)}**: traits=[${global.traits.join(", ")}], interests=[${global.interests.join(", ")}], ` +
                    `style="${global.communicationStyle}", relation="${global.relationToAgent}", ` +
                    `patterns=[${global.stablePatterns.join("；")}], hints=[${global.agentPolicyHints.join("；")}], ` +
                    `sources=[${global.sourceChatIds.join(", ")}], confidence=${global.confidence}`;
            }).join("\n");
            sections.push(`## 全局画像 (${profiles.length} 人，跨群共享)\n\n${globalLines}`);
        }

        const profileLines = profiles.map(p => {
            // Issue 6: 查询 PersonIdentity 获取 displayName/aliases
            const identity = memory?.getPersonIdentity(p.userId);
            const namePart = identity?.username || identity?.aliases?.length
                ? ` (${[
                    identity.username ? `@${identity.username}` : "",
                    identity.aliases?.length ? `别名: [${identity.aliases.join(", ")}]` : "",
                ].filter(Boolean).join(", ")})`
                : "";
            const relationshipMemory = formatRelationshipMemoryBrief(p);
            return `- **${formatUserLabel(memory, p.userId)}**${namePart} (Tier ${p.dunbarTier}): ` +
                `traits=[${p.traits.join(", ")}], interests=[${p.interests.join(", ")}], ` +
                `style="${p.communicationStyle}", relation="${p.relationToAgent}"` +
                (relationshipMemory ? `\n  ${relationshipMemory}` : "");
        }).join("\n");
        sections.push(`## 现有画像 (${profiles.length} 人)\n\n${profileLines}`);
    }

    // Issue 7: 已有事实（让 LLM 看到已有 facts 以便更新/删除）
    if (memory && profiles.length > 0) {
        const factLines: string[] = [];
        for (const p of profiles) {
            const result = memory.listCoreFacts({ subject: p.userId, limit: 10 });
            const facts = result.items;
            if (facts.length > 0) {
                for (const f of facts) {
                    const source = [
                        f.sourceChatId ? `来源chat=${formatChatLabel(memory, f.sourceChatId, f.sourceChatTitle)}` : f.sourceChatTitle ? `来源chat=${f.sourceChatTitle}` : "",
                        f.sourceTopicLabel || f.sourceTopicId ? `topic=${f.sourceTopicLabel || f.sourceTopicId}` : "",
                        f.observedAt ? `observedAt=${f.observedAt}` : "",
                        f.visibility ? `visibility=${f.visibility}` : "",
                        f.sensitivity ? `sensitivity=${f.sensitivity}` : "",
                    ].filter(Boolean).join(" | ");
                    factLines.push(`- [id:${f.id}] (${f.category}) ${formatUserLabel(memory, f.subject)}: ${f.content}${source ? ` (${source})` : ""}`);
                }
            }
        }
        if (factLines.length > 0) {
            sections.push(`## 已有事实 (${factLines.length} 条)\n\n${factLines.join("\n")}`);
        }
    }

    // 请求（私聊用专用 instruction，群聊用通用 instruction）
    const userInstruction = isDirectMessage
        ? getReflectionDmUserInstruction()
        : getReflectionUserInstruction();
    sections.push(`## 请求\n\n${userInstruction}`);

    return sections.join("\n\n---\n\n");
}

function formatCountMap(map: Map<string, number> | Record<string, number> | undefined): string {
    if (!map) return "{}";
    const entries = map instanceof Map ? [...map.entries()] : Object.entries(map);
    if (entries.length === 0) return "{}";
    return entries.map(([key, value]) => `${key}:${value}`).join(", ");
}

function formatUserLabel(memory: MemoryStoreV2 | undefined, userId: string, fallbackName?: string): string {
    const identity = memory?.getPersonIdentity(userId);
    const name = identity?.displayName?.trim() || fallbackName?.trim() || userId;
    return `${name}(${userId})`;
}

function formatChatLabel(memory: MemoryStoreV2 | undefined, chatId: string, fallbackTitle?: string | null): string {
    const model = memory?.getGroupModel(getGroupModelKey(chatId));
    const title = model?.chatTitle?.trim() || fallbackTitle?.trim() || chatId;
    return `${title}(${chatId})`;
}

function mergeGlobalPersonProfile(
    existing: PersonProfile | null,
    update: NonNullable<ReflectionLLMOutput["globalPersonUpdates"]>[number],
    chatId: string,
    reflectedAt: string,
): Partial<PersonProfile> {
    return {
        traits: dedupeStrings([...(existing?.traits ?? []), ...(update.traits ?? [])]).slice(0, 16),
        interests: dedupeStrings([...(existing?.interests ?? []), ...(update.interests ?? [])]).slice(0, 24),
        communicationStyle: chooseStableProfileText(existing?.communicationStyle, update.communicationStyle),
        relationToAgent: chooseStableProfileText(existing?.relationToAgent, update.relationToAgent),
        stablePatterns: dedupeStrings([...(existing?.stablePatterns ?? []), ...(update.stablePatterns ?? [])]).slice(0, 16),
        agentPolicyHints: dedupeStrings([...(existing?.agentPolicyHints ?? []), ...(update.agentPolicyHints ?? [])]).slice(0, 16),
        followupCandidates: dedupeStrings([...(existing?.followupCandidates ?? []), ...(update.followupCandidates ?? [])]).slice(0, 12),
        sourceChatIds: dedupeStrings([...(existing?.sourceChatIds ?? []), chatId]),
        confidence: Math.max(existing?.confidence ?? 0, clamp01(update.confidence ?? 0.75)),
        lastReflectedAt: reflectedAt,
    };
}

function chooseStableProfileText(existing?: string, incoming?: string): string {
    const current = existing?.trim() ?? "";
    const next = incoming?.trim() ?? "";
    if (!current) return next;
    if (!next) return current;
    return next.length > current.length * 1.15 ? next : current;
}

function formatRelationshipMemoryBrief(profile: PersonGroupProfile): string {
    const recent = (profile.recentEpisodes ?? [])
        .slice(-3)
        .map(ep => `${ep.topicLabel ? `${ep.topicLabel}: ` : ""}${ep.summary}`)
        .filter(Boolean);
    const merged = (profile.mergedMemory ?? [])
        .slice(0, 2)
        .map(m => {
            const patterns = m.stablePatterns?.length ? `；模式: ${m.stablePatterns.slice(0, 2).join(" / ")}` : "";
            const hints = m.agentPolicyHints?.length ? `；提示: ${m.agentPolicyHints.slice(0, 2).join(" / ")}` : "";
            return `[${m.granularity} ${m.periodStart.substring(0, 10)}~${m.periodEnd.substring(0, 10)}] ${m.relationshipTrend || m.highlights.join("；")}${patterns}${hints}`;
        })
        .filter(Boolean);
    const chunks: string[] = [];
    if (recent.length) chunks.push(`近期关系事件: ${recent.join("；")}`);
    if (merged.length) chunks.push(`长期关系记忆: ${merged.join("；")}`);
    return chunks.join("\n  ");
}

function buildFactProvenance(
    fact: ReflectionLLMOutput["factUpdates"][number],
    topics: TopicNode[],
    interactions: InteractionEpisode[],
    chatId: string,
    groupModel: GroupModel | null,
    isDirectMessage: boolean,
    reflectedAt: string,
): CoreFactProvenance {
    const topic = (fact.sourceTopicId
        ? topics.find(t => t.id === fact.sourceTopicId || t.pipelineTopicId === fact.sourceTopicId)
        : undefined)
        ?? (fact.sourceTopicLabel ? topics.find(t => t.label === fact.sourceTopicLabel) : undefined)
        ?? topics.find(t => t.participants.includes(fact.subject) || t.participants.includes(getRawId(fact.subject)));
    const interactionIds = fact.sourceInteractionIds?.length
        ? fact.sourceInteractionIds
        : interactions
            .filter(i => i.userId === fact.subject || getRawId(i.userId) === getRawId(fact.subject))
            .slice(-5)
            .map(i => i.id);
    const messageIds = fact.sourceMessageIds?.length
        ? fact.sourceMessageIds
        : topic?.messageRange.messageIds.slice(0, 8) ?? [];
    return {
        sourceChatId: chatId,
        sourceChatTitle: groupModel?.chatTitle ?? chatId,
        sourceTopicId: fact.sourceTopicId ?? topic?.id ?? null,
        sourceTopicLabel: fact.sourceTopicLabel ?? topic?.label ?? null,
        sourceMessageIds: messageIds,
        sourceInteractionIds: interactionIds,
        observedAt: fact.observedAt ?? topic?.startedAt ?? reflectedAt,
        visibility: fact.visibility ?? (isDirectMessage ? "private" : "contextual"),
        sensitivity: fact.sensitivity ?? "low",
    };
}

function formatInteractionForPrompt(
    interaction: InteractionEpisode,
    topics: TopicNode[],
    memory?: MemoryStoreV2,
): string {
    const topic = inferTopicForInteraction(interaction, topics, memory);
    const evidence = memory ? findEvidenceMessages(memory, interaction, topic).slice(0, 3) : [];
    const evidenceText = evidence.length
        ? ` | 证据: ${evidence.map(formatMessageEvidence).join(" / ")}`
        : "";
    const topicText = topic ? ` | 话题: ${topic.label}` : "";
    return `- [${interaction.date}] ${formatUserLabel(memory, interaction.userId)} ${interaction.type} ` +
        `(情感:${interaction.sentiment}, 重要度:${interaction.significance}) ${interaction.summary}${topicText}${evidenceText}`;
}

function buildRelationshipEpisodes(options: {
    chatId: string;
    interactions: InteractionEpisode[];
    topics: TopicNode[];
    memory: MemoryStoreV2;
    qualityMap: Map<string, InteractionQuality | undefined>;
    relationshipEvents: NonNullable<ReflectionLLMOutput["relationshipEvents"]>;
}): InteractionEpisode[] {
    const result: InteractionEpisode[] = [];
    const { chatId, interactions, topics, memory, qualityMap, relationshipEvents } = options;

    for (const intr of interactions) {
        if (!intr.userId || intr.userId === "agent") continue;
        const topic = inferTopicForInteraction(intr, topics, memory);
        const evidenceMessages = findEvidenceMessages(memory, intr, topic);
        const evidence = evidenceMessages.slice(0, 5).map(formatMessageEvidence);
        const messageIds = [...new Set(evidenceMessages.map(m => m.messageId))];
        const mediaTypes = [...new Set(evidenceMessages.map(m => m.mediaType).filter((v): v is string => !!v))];
        const replyToMessageIds = [...new Set(evidenceMessages.map(m => m.replyToMessageId).filter((v): v is string => !!v))];
        const sourceIds = [
            `interaction:${intr.id}`,
            ...(topic ? [`topic:${topic.id}`] : []),
            ...messageIds.map(id => `message:${id}`),
        ];

        result.push({
            ...intr,
            displayName: memory.getPersonIdentity(intr.userId)?.displayName,
            direction: inferDirection(intr),
            interactionQuality: qualityMap.get(intr.userId),
            topicId: intr.topicId ?? topic?.id ?? null,
            topicLabel: topic?.label,
            topicSummary: topic?.summary,
            messageIds,
            sourceIds,
            evidence,
            agentOutcome: findAgentOutcome(intr, interactions),
            confidence: evidence.length > 0 ? 0.85 : 0.55,
            mediaTypes,
            replyToMessageIds,
        });
    }

    for (let i = 0; i < relationshipEvents.length; i++) {
        const event = relationshipEvents[i];
        if (!event.userId || !event.summary) continue;
        const userId = ensureCompositeId(getPlatform(chatId), event.userId);
        const topic = event.topicId
            ? topics.find(t => t.id === event.topicId) ?? memory.getTopicById(event.topicId)
            : event.topicLabel
                ? topics.find(t => t.label === event.topicLabel)
                : null;
        const messageIds = [...new Set(event.messageIds ?? [])];
        result.push({
            id: `reflection-event-${Date.now()}-${i}`,
            date: new Date().toISOString(),
            chatId,
            userId,
            topicId: event.topicId ?? topic?.id ?? null,
            type: normalizeInteractionType(event.type),
            summary: event.summary,
            sentiment: event.sentiment ?? "neutral",
            significance: clamp01(event.significance ?? 0.75),
            displayName: memory.getPersonIdentity(userId)?.displayName,
            direction: "mixed",
            interactionQuality: event.interactionQuality,
            topicLabel: event.topicLabel ?? topic?.label,
            topicSummary: topic?.summary,
            messageIds,
            sourceIds: [
                `reflectionEvent:${i}`,
                ...(topic ? [`topic:${topic.id}`] : []),
                ...messageIds.map(id => `message:${id}`),
            ],
            evidence: event.evidence ?? [],
            agentOutcome: event.agentOutcome,
            confidence: clamp01(event.confidence ?? 0.7),
        });
    }

    return result;
}

function inferTopicForInteraction(
    interaction: InteractionEpisode,
    topics: TopicNode[],
    memory?: MemoryStoreV2,
): TopicNode | null {
    if (interaction.topicId) {
        const existing = topics.find(t => t.id === interaction.topicId) ?? memory?.getTopicById(interaction.topicId) ?? null;
        if (existing) return existing;
    }
    const interactionTime = new Date(interaction.date).getTime();
    if (!Number.isFinite(interactionTime)) return null;
    const candidates = topics
        .filter(t => t.participants.includes(interaction.userId))
        .map(t => {
            const start = new Date(t.startedAt).getTime();
            const end = t.endedAt ? new Date(t.endedAt).getTime() : start + 2 * 60 * 60_000;
            const distance = interactionTime >= start && interactionTime <= end
                ? 0
                : Math.min(Math.abs(interactionTime - start), Math.abs(interactionTime - end));
            return { topic: t, distance };
        })
        .sort((a, b) => a.distance - b.distance);
    return candidates[0]?.distance <= 6 * 60 * 60_000 ? candidates[0].topic : null;
}

function findEvidenceMessages(
    memory: MemoryStoreV2,
    interaction: InteractionEpisode,
    topic: TopicNode | null,
): RecentMessageEntry[] {
    const byId = new Map<string, RecentMessageEntry>();
    if (topic?.messageRange.messageIds.length) {
        for (const msg of memory.getMessagesByIds(interaction.chatId, topic.messageRange.messageIds)) {
            if (msg.userId === interaction.userId || topic.messageRange.messageIds.length <= 8) {
                byId.set(msg.messageId, msg);
            }
        }
    }

    const time = new Date(interaction.date).getTime();
    if (Number.isFinite(time)) {
        const after = new Date(time - 10 * 60_000).toISOString();
        const before = new Date(time + 10 * 60_000).toISOString();
        const rows = memory.queryMessages({
            chatIds: [interaction.chatId],
            ...(interaction.type === "agent_replied" ? {} : { userIds: [interaction.userId] }),
            after,
            before,
            limit: 12,
        });
        for (const row of rows) {
            byId.set(row.messageId, {
                messageId: row.messageId,
                chatId: row.chatId,
                userId: row.userId,
                displayName: row.displayName,
                text: row.content,
                timestamp: row.timestamp,
            });
        }
    }

    return [...byId.values()]
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
        .slice(0, 12);
}

function formatMessageEvidence(message: RecentMessageEntry): string {
    const media = message.mediaType ? ` [${message.mediaType}]` : "";
    const text = (message.text || "").replace(/\s+/g, " ").trim();
    const sender = message.displayName ? `${message.displayName}(${message.userId})` : message.userId;
    return `${sender}${media}: ${text.slice(0, 120)}`;
}

function inferDirection(interaction: InteractionEpisode): InteractionEpisode["direction"] {
    if (interaction.type === "direct_message" || interaction.type === "agent_mentioned") return "user_to_agent";
    if (interaction.type === "agent_replied") return "agent_to_user";
    return "ambient";
}

function findAgentOutcome(interaction: InteractionEpisode, interactions: InteractionEpisode[]): string | undefined {
    if (interaction.type === "agent_replied") return undefined;
    const time = new Date(interaction.date).getTime();
    if (!Number.isFinite(time)) return undefined;
    const reply = interactions
        .filter(i => i.type === "agent_replied")
        .map(i => ({ interaction: i, delta: new Date(i.date).getTime() - time }))
        .filter(i => i.delta >= 0 && i.delta <= 30 * 60_000)
        .sort((a, b) => a.delta - b.delta)[0]?.interaction;
    return reply ? `agent replied: ${reply.summary.slice(0, 160)}` : undefined;
}

function normalizeInteractionType(type: NonNullable<ReflectionLLMOutput["relationshipEvents"]>[number]["type"] | undefined): InteractionEpisode["type"] {
    if (type === "agent_replied" || type === "agent_mentioned" || type === "direct_message" || type === "reaction") {
        return type;
    }
    return "reaction";
}

function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
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
            globalPersonUpdates: Array.isArray(parsed.globalPersonUpdates) ? parsed.globalPersonUpdates : undefined,
            personUpdates: Array.isArray(parsed.personUpdates) ? parsed.personUpdates : [],
            groupUpdates: parsed.groupUpdates ?? {},
            factUpdates: Array.isArray((parsed as any).factUpdates) ? (parsed as any).factUpdates
                : Array.isArray((parsed as any).newFacts) ? (parsed as any).newFacts : [],
            topicsSummary: Array.isArray(parsed.topicsSummary) ? parsed.topicsSummary : [],
            identityUpdates: Array.isArray(parsed.identityUpdates) ? parsed.identityUpdates : undefined,
            relationshipEvents: Array.isArray(parsed.relationshipEvents) ? parsed.relationshipEvents : undefined,
            agentFeedback: parsed.agentFeedback,
            followupCandidates: Array.isArray(parsed.followupCandidates) ? parsed.followupCandidates : undefined,
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
                    globalPersonUpdates: Array.isArray(parsed.globalPersonUpdates) ? parsed.globalPersonUpdates : undefined,
                    personUpdates: Array.isArray(parsed.personUpdates) ? parsed.personUpdates : [],
                    groupUpdates: parsed.groupUpdates ?? {},
                    factUpdates: Array.isArray((parsed as any).factUpdates) ? (parsed as any).factUpdates
                        : Array.isArray((parsed as any).newFacts) ? (parsed as any).newFacts : [],
                    topicsSummary: Array.isArray(parsed.topicsSummary) ? parsed.topicsSummary : [],
                    identityUpdates: Array.isArray(parsed.identityUpdates) ? parsed.identityUpdates : undefined,
                    relationshipEvents: Array.isArray(parsed.relationshipEvents) ? parsed.relationshipEvents : undefined,
                    agentFeedback: parsed.agentFeedback,
                    followupCandidates: Array.isArray(parsed.followupCandidates) ? parsed.followupCandidates : undefined,
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

    // 裁剪 recentEpisodes（按天数）。最低保留到 episode->week 合并线之后，
    // 避免 Tier 3/4 的事件在有机会进入 mergedMemory 前被直接丢弃。
    const episodes = profile.recentEpisodes ?? [];
    if (episodes.length > 0) {
        const effectiveEpisodeDays = Math.max(limits.episodeDays, DEFAULT_MERGE_THRESHOLDS.episodeToWeek + 1);
        const cutoff = Date.now() - effectiveEpisodeDays * 86400_000;
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
    const baseMemoryContext = buildExistingMemoryContext({
        userId,
        chatId,
        memory,
        profile,
        referenceMemories: existingMerged,
        recentEpisodes: kept,
    });

    // ── Step 2: 将过期 episodes 按 ISO 周分组→生成 week MergedMemory ──
    if (toMerge.length > 0) {
        const weekGroups = groupByPeriod(toMerge.map(ep => ({
            id: ep.id,
            date: ep.date,
            sentiment: ep.sentiment,
            significance: ep.significance,
            summary: ep.summary,
            type: ep.type,
            topicId: ep.topicId,
            topicLabel: ep.topicLabel,
            interactionQuality: ep.interactionQuality,
            evidence: ep.evidence,
            agentOutcome: ep.agentOutcome,
            sourceIds: ep.sourceIds,
            confidence: ep.confidence,
        })), "week");

        for (const [, items] of weekGroups) {
            const dates = items.map(i => i.date).sort();

            // 使用 LLM 分析合并结果（若提供了 llmConfigs）
            const llmResult = llmConfigs?.length
                ? await analyzeMergeWithLLM(userId, items, baseMemoryContext, llmConfigs, reflectionConfig)
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
                ...buildMergedMemoryMetadata(items, llmResult),
            });
        }
    }

    // ── Step 3: 合并 week → month (>30天的 week) ──
    const monthCutoff = now - thresholds.weekToMonth * 86400_000;
    await cascadeMerge(newMergedList, "week", "month", monthCutoff, llmConfigs, reflectionConfig, {
        userId,
        chatId,
        memory,
        profile,
        recentEpisodes: kept,
    });

    // ── Step 4: 合并 month → quarter (>90天的 month) ──
    const quarterCutoff = now - thresholds.monthToQuarter * 86400_000;
    await cascadeMerge(newMergedList, "month", "quarter", quarterCutoff, llmConfigs, reflectionConfig, {
        userId,
        chatId,
        memory,
        profile,
        recentEpisodes: kept,
    });

    // ── Step 5: 合并 quarter → year (>365天的 quarter) ──
    const yearCutoff = now - thresholds.quarterToYear * 86400_000;
    await cascadeMerge(newMergedList, "quarter", "year", yearCutoff, llmConfigs, reflectionConfig, {
        userId,
        chatId,
        memory,
        profile,
        recentEpisodes: kept,
    });

    // ── Step 6: 写回 ──
    // 按 periodStart 降序排列（最近的在前）
    newMergedList.sort((a, b) =>
        new Date(b.periodStart).getTime() - new Date(a.periodStart).getTime()
    );

    memory.upsertPersonGroupProfile(userId, chatId, {
        recentEpisodes: kept,
        mergedMemory: newMergedList,
    });
    promoteMergedMemoryToGlobalProfile(userId, chatId, newMergedList, memory);

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
    id?: string;
    date: string;
    sentiment: string;
    significance: number;
    summary: string;
    type?: InteractionEpisode["type"];
    topicId?: string | null;
    topicLabel?: string;
    interactionQuality?: InteractionQuality;
    evidence?: string[];
    agentOutcome?: string;
    sourceIds?: string[];
    confidence?: number;
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
    stablePatterns?: string[];
    userPreferences?: string[];
    agentPolicyHints?: string[];
    salientEvents?: MergedMemory["salientEvents"];
    followupCandidates?: string[];
    confidence?: number;
}

interface ExistingMemoryContextOptions {
    userId: string;
    chatId: string;
    memory: MemoryStoreV2;
    profile: PersonGroupProfile;
    referenceMemories?: MergedMemory[];
    recentEpisodes?: InteractionEpisode[];
}

interface CascadeMergeContext {
    userId: string;
    chatId: string;
    memory: MemoryStoreV2;
    profile: PersonGroupProfile;
    recentEpisodes?: InteractionEpisode[];
}

function buildMergedMemoryMetadata(
    items: MergeItem[],
    llmResult: MergeAnalysisResult | null,
): Partial<MergedMemory> {
    const highValueItems = items
        .filter(i => i.significance > 0.7)
        .sort((a, b) => b.significance - a.significance);
    return {
        sourceEventIds: [...new Set(items.map(i => i.id).filter((v): v is string => !!v))],
        eventTypeCounts: countBy(items.map(i => i.type).filter(Boolean).map(String)),
        topicCounts: countBy(items.map(i => i.topicLabel ?? i.topicId ?? "").filter(Boolean).map(String)),
        activeDays: new Set(items.map(i => i.date.substring(0, 10))).size,
        qualityDistribution: countBy(items.map(i => i.interactionQuality ?? "").filter(Boolean).map(String)),
        stablePatterns: llmResult?.stablePatterns ?? [],
        userPreferences: llmResult?.userPreferences ?? [],
        agentPolicyHints: llmResult?.agentPolicyHints ?? [],
        salientEvents: llmResult?.salientEvents ?? highValueItems.slice(0, 5).map(i => ({
            summary: i.summary,
            sourceIds: [...new Set([...(i.sourceIds ?? []), ...(i.id ? [`interaction:${i.id}`] : [])])],
            confidence: i.confidence ?? Math.max(0.5, i.significance),
        })),
        followupCandidates: llmResult?.followupCandidates ?? [],
        confidence: llmResult?.confidence ?? average(items.map(i => i.confidence ?? 0.6)),
    };
}

function buildCascadedMemoryMetadata(
    items: MergedMemory[],
    llmResult: MergeAnalysisResult | null,
): Partial<MergedMemory> {
    return {
        sourceMemoryIds: items.map(i => `${i.granularity}:${i.periodStart}:${i.periodEnd}`),
        sourceEventIds: [...new Set(items.flatMap(i => i.sourceEventIds ?? []))],
        eventTypeCounts: mergeCountRecords(items.map(i => i.eventTypeCounts)),
        topicCounts: mergeCountRecords(items.map(i => i.topicCounts)),
        activeDays: items.reduce((sum, item) => sum + (item.activeDays ?? 0), 0),
        qualityDistribution: mergeCountRecords(items.map(i => i.qualityDistribution)),
        stablePatterns: llmResult?.stablePatterns ?? dedupeStrings(items.flatMap(i => i.stablePatterns ?? [])).slice(0, 8),
        userPreferences: llmResult?.userPreferences ?? dedupeStrings(items.flatMap(i => i.userPreferences ?? [])).slice(0, 8),
        agentPolicyHints: llmResult?.agentPolicyHints ?? dedupeStrings(items.flatMap(i => i.agentPolicyHints ?? [])).slice(0, 8),
        salientEvents: llmResult?.salientEvents ?? items.flatMap(i => i.salientEvents ?? []).slice(0, 8),
        followupCandidates: llmResult?.followupCandidates ?? dedupeStrings(items.flatMap(i => i.followupCandidates ?? [])).slice(0, 8),
        confidence: llmResult?.confidence ?? average(items.map(i => i.confidence ?? 0.6)),
    };
}

function promoteMergedMemoryToGlobalProfile(
    userId: string,
    chatId: string,
    mergedMemory: MergedMemory[],
    memory: MemoryStoreV2,
): void {
    if (mergedMemory.length === 0) return;
    const existing = memory.getPersonProfile(userId);
    const sorted = [...mergedMemory].sort((a, b) =>
        new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime()
    );
    const strongest = sorted.find(m => m.granularity === "month" || m.granularity === "quarter" || m.granularity === "year")
        ?? sorted[0];

    memory.upsertPersonProfile(userId, {
        interests: dedupeStrings([
            ...(existing?.interests ?? []),
            ...sorted.flatMap(m => m.userPreferences ?? []),
        ]).slice(0, 24),
        relationToAgent: existing?.relationToAgent || strongest.relationshipTrend || "",
        stablePatterns: dedupeStrings([
            ...(existing?.stablePatterns ?? []),
            ...sorted.flatMap(m => m.stablePatterns ?? []),
        ]).slice(0, 16),
        agentPolicyHints: dedupeStrings([
            ...(existing?.agentPolicyHints ?? []),
            ...sorted.flatMap(m => m.agentPolicyHints ?? []),
        ]).slice(0, 16),
        followupCandidates: dedupeStrings([
            ...(existing?.followupCandidates ?? []),
            ...sorted.flatMap(m => m.followupCandidates ?? []),
        ]).slice(0, 12),
        sourceChatIds: dedupeStrings([...(existing?.sourceChatIds ?? []), chatId]),
        confidence: Math.max(existing?.confidence ?? 0, average(sorted.map(m => m.confidence ?? 0.7))),
        lastReflectedAt: new Date().toISOString(),
    });
}

function countBy(values: string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) {
        counts[value] = (counts[value] ?? 0) + 1;
    }
    return counts;
}

function mergeCountRecords(records: Array<Record<string, number> | undefined>): Record<string, number> {
    const result: Record<string, number> = {};
    for (const record of records) {
        if (!record) continue;
        for (const [key, value] of Object.entries(record)) {
            result[key] = (result[key] ?? 0) + value;
        }
    }
    return result;
}

function average(values: number[]): number {
    const filtered = values.filter(Number.isFinite);
    if (filtered.length === 0) return 0.6;
    return Math.round((filtered.reduce((sum, value) => sum + value, 0) / filtered.length) * 100) / 100;
}

function dedupeStrings(values: string[]): string[] {
    return [...new Set(values.map(v => v.trim()).filter(Boolean))];
}

function buildExistingMemoryContext(options: ExistingMemoryContextOptions): string {
    const { userId, chatId, memory, profile } = options;
    const lines: string[] = [];
    const identity = memory.getPersonIdentity(userId);
    const global = memory.getPersonProfile(userId);

    lines.push(`用户: ${formatUserLabel(memory, userId, identity?.displayName)}`);
    lines.push(`当前 chat: ${formatChatLabel(memory, chatId)}`);

    if (global) {
        lines.push("全局画像:");
        lines.push(`- traits=[${formatBriefList(global.traits, 8)}]`);
        lines.push(`- interests=[${formatBriefList(global.interests, 10)}]`);
        if (global.communicationStyle) lines.push(`- style=${clipText(global.communicationStyle, 220)}`);
        if (global.relationToAgent) lines.push(`- relation=${clipText(global.relationToAgent, 260)}`);
        if (global.stablePatterns.length) lines.push(`- stablePatterns=[${formatBriefList(global.stablePatterns, 6)}]`);
        if (global.agentPolicyHints.length) lines.push(`- agentPolicyHints=[${formatBriefList(global.agentPolicyHints, 6)}]`);
        if (global.followupCandidates.length) lines.push(`- followupCandidates=[${formatBriefList(global.followupCandidates, 4)}]`);
        if (global.sourceChatIds.length) lines.push(`- sourceChats=[${global.sourceChatIds.slice(0, 8).join(", ")}]`);
    } else {
        lines.push("全局画像: (暂无)");
    }

    lines.push("当前场景画像:");
    lines.push(`- tier=${profile.dunbarTier}, affinity=${profile.affinityScore}`);
    if (profile.traits.length) lines.push(`- traits=[${formatBriefList(profile.traits, 8)}]`);
    if (profile.interests.length) lines.push(`- interests=[${formatBriefList(profile.interests, 10)}]`);
    if (profile.communicationStyle) lines.push(`- style=${clipText(profile.communicationStyle, 220)}`);
    if (profile.relationToAgent) lines.push(`- relation=${clipText(profile.relationToAgent, 260)}`);

    const recentEpisodes = [...(options.recentEpisodes ?? [])]
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, 5);
    if (recentEpisodes.length) {
        lines.push("近期未合并关系事件:");
        for (const ep of recentEpisodes) {
            const label = ep.topicLabel ? ` topic=${ep.topicLabel}` : "";
            lines.push(`- [${ep.date.substring(0, 10)}${label}] ${clipText(ep.summary, 220)}`);
        }
    }

    const referenceMemories = [...(options.referenceMemories ?? [])]
        .sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime())
        .slice(0, 8);
    if (referenceMemories.length) {
        lines.push("既有长期记忆摘要（参照，不是本次待合并对象）:");
        for (const memoryItem of referenceMemories) {
            lines.push(formatMergedMemoryContextLine(memoryItem));
        }
    }

    const facts = memory.listCoreFacts({ subject: userId, limit: 8 }).items;
    if (facts.length) {
        lines.push("已有 core facts（带来源，参照去重/判断边界）:");
        for (const fact of facts) {
            const source = [
                fact.sourceChatId ? `source=${formatChatLabel(memory, fact.sourceChatId, fact.sourceChatTitle)}` : fact.sourceChatTitle ? `source=${fact.sourceChatTitle}` : "",
                fact.sourceTopicLabel || fact.sourceTopicId ? `topic=${fact.sourceTopicLabel || fact.sourceTopicId}` : "",
                fact.visibility ? `visibility=${fact.visibility}` : "",
                fact.sensitivity ? `sensitivity=${fact.sensitivity}` : "",
            ].filter(Boolean).join(", ");
            lines.push(`- [${fact.category}] ${clipText(fact.content, 220)}${source ? ` (${source})` : ""}`);
        }
    }

    return lines.join("\n");
}

function formatMergedMemoryContextLine(memoryItem: MergedMemory): string {
    const parts = [
        `- [${memoryItem.granularity} ${memoryItem.periodStart.substring(0, 10)}~${memoryItem.periodEnd.substring(0, 10)}]`,
        `sentiment=${memoryItem.overallSentiment}`,
        `count=${memoryItem.interactionCount}`,
        memoryItem.relationshipTrend ? `trend=${clipText(memoryItem.relationshipTrend, 220)}` : "",
        memoryItem.highlights.length ? `highlights=[${formatBriefList(memoryItem.highlights, 3, 140)}]` : "",
        memoryItem.stablePatterns?.length ? `patterns=[${formatBriefList(memoryItem.stablePatterns, 3, 120)}]` : "",
        memoryItem.agentPolicyHints?.length ? `hints=[${formatBriefList(memoryItem.agentPolicyHints, 3, 120)}]` : "",
    ].filter(Boolean);
    return parts.join(", ");
}

function formatBriefList(values: string[] | undefined, limit: number, itemLimit = 80): string {
    if (!values?.length) return "";
    const sliced = values.slice(0, limit).map(value => clipText(value, itemLimit));
    const omitted = values.length > limit ? `; ...+${values.length - limit}` : "";
    return `${sliced.join("; ")}${omitted}`;
}

function clipText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

/**
 * 使用 cheap model 分析一组交互事件，生成综合性的情感/亮点/关系趋势摘要。
 * 失败时返回 null，调用方回退到规则合并。
 */
async function analyzeMergeWithLLM(
    userId: string,
    items: MergeItem[],
    existingMemoryContext: string,
    llmConfigs: LLMConfig[],
    reflectionConfig?: ReflectionExternalConfig,
): Promise<MergeAnalysisResult | null> {
    if (items.length === 0) return null;

    const eventLines = items.map(i => {
        const meta = [
            `情感:${i.sentiment}`,
            `重要度:${i.significance}`,
            i.type ? `类型:${i.type}` : "",
            i.topicLabel ? `话题:${i.topicLabel}` : "",
            i.interactionQuality ? `质量:${i.interactionQuality}` : "",
            typeof i.confidence === "number" ? `置信度:${i.confidence}` : "",
        ].filter(Boolean).join(", ");
        const evidence = i.evidence?.length ? `\n  证据: ${i.evidence.slice(0, 3).join(" / ")}` : "";
        const outcome = i.agentOutcome ? `\n  结果: ${i.agentOutcome}` : "";
        return `- [${i.date}] (${meta}) ${i.summary}${evidence}${outcome}`;
    }).join("\n");

    const userPrompt = applyTemplate(getMergeEpisodesUserTpl(), {
        userId,
        count: String(items.length),
        eventLines,
        existingMemoryContext,
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
            stablePatterns: Array.isArray(parsed.stablePatterns) ? parsed.stablePatterns : undefined,
            userPreferences: Array.isArray(parsed.userPreferences) ? parsed.userPreferences : undefined,
            agentPolicyHints: Array.isArray(parsed.agentPolicyHints) ? parsed.agentPolicyHints : undefined,
            salientEvents: Array.isArray(parsed.salientEvents) ? parsed.salientEvents : undefined,
            followupCandidates: Array.isArray(parsed.followupCandidates) ? parsed.followupCandidates : undefined,
            confidence: typeof parsed.confidence === "number" ? clamp01(parsed.confidence) : undefined,
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
    existingMemoryContext: string,
    llmConfigs: LLMConfig[],
    reflectionConfig?: ReflectionExternalConfig,
): Promise<MergeAnalysisResult | null> {
    if (items.length === 0) return null;

    const lines = items.map(i =>
        `- [${i.periodStart}~${i.periodEnd}] 粒度:${i.granularity}, ` +
        `情感:${i.overallSentiment}, 交互:${i.interactionCount}次, ` +
        `亮点:[${i.highlights.join("; ")}], 趋势:${i.relationshipTrend || "(无)"}, ` +
        `模式:[${(i.stablePatterns ?? []).join("; ")}], 提示:[${(i.agentPolicyHints ?? []).join("; ")}], ` +
        `话题分布:{${formatCountMap(i.topicCounts)}}, 类型分布:{${formatCountMap(i.eventTypeCounts)}}`
    ).join("\n");

    const userPrompt = applyTemplate(getMergeCascadeUserTpl(), {
        count: String(items.length),
        lines,
        existingMemoryContext,
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
            stablePatterns: Array.isArray(parsed.stablePatterns) ? parsed.stablePatterns : undefined,
            userPreferences: Array.isArray(parsed.userPreferences) ? parsed.userPreferences : undefined,
            agentPolicyHints: Array.isArray(parsed.agentPolicyHints) ? parsed.agentPolicyHints : undefined,
            salientEvents: Array.isArray(parsed.salientEvents) ? parsed.salientEvents : undefined,
            followupCandidates: Array.isArray(parsed.followupCandidates) ? parsed.followupCandidates : undefined,
            confidence: typeof parsed.confidence === "number" ? clamp01(parsed.confidence) : undefined,
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
    context?: CascadeMergeContext,
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
        const existingMemoryContext = context
            ? buildExistingMemoryContext({
                userId: context.userId,
                chatId: context.chatId,
                memory: context.memory,
                profile: context.profile,
                recentEpisodes: context.recentEpisodes,
                referenceMemories: list.filter(memoryItem => !items.includes(memoryItem)),
            })
            : "";

        // 使用 LLM 分析级联合并结果
        const llmResult = llmConfigs?.length
            ? await analyzeCascadeMergeWithLLM(items, existingMemoryContext, llmConfigs, reflectionConfig)
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
            ...buildCascadedMemoryMetadata(items, llmResult),
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
