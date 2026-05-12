import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MemoryStoreV2, mergeEpisodes, type MergedMemory, type InteractionEpisode } from "../src/memory-v2/index.js";
import { loadConfig, resolveComponentProfiles, type ReflectionExternalConfig } from "../src/core/config.js";
import { llmEvents, type LLMCallEvent, type LLMResponseEvent } from "../src/core/llm.js";

const USER_ID = "telegram:682932098";
const SOURCE_DB = resolve(".tmp/memory.db");
const WORK_DB = resolve(".tmp/reflection-upgrade-work.db");
const REPORT_PATH = resolve(".tmp/reflection-upgrade-report.json");

const SELECTED_CHATS = [
    "telegram:682932098",
    "telegram:-1001299801091",
    "telegram:-1001304286698",
];

interface CapturedCall {
    callId: string;
    caller: string;
    model: string;
    provider: string;
    promptChars: number;
    promptPreview: string;
    responsePreview?: string;
    responseChars?: number;
    durationMs?: number;
    error?: string;
}

const calls = new Map<string, CapturedCall>();

llmEvents.on("llm:call", (event: LLMCallEvent) => {
    const userMessage = [...event.messageSummaries].reverse().find(m => m.role === "user")?.contentPreview ?? "";
    calls.set(event.callId, {
        callId: event.callId,
        caller: event.caller,
        model: event.model,
        provider: event.provider,
        promptChars: userMessage.length,
        promptPreview: userMessage.slice(0, 1800),
    });
});

llmEvents.on("llm:response", (event: LLMResponseEvent) => {
    const existing = calls.get(event.callId);
    if (!existing) return;
    existing.responsePreview = event.contentPreview.slice(0, 1800);
    existing.responseChars = event.contentLength;
    existing.durationMs = event.durationMs;
    existing.error = event.error;
});

function parseJsonArray<T>(value: unknown): T[] {
    if (Array.isArray(value)) return value as T[];
    if (typeof value !== "string" || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
        return [];
    }
}

function sanitizeProfile(profile: any) {
    return {
        userId: profile.userId,
        chatId: profile.chatId,
        tier: profile.dunbarTier,
        affinityScore: profile.affinityScore,
        traits: profile.traits?.slice(0, 8),
        interests: profile.interests?.slice(0, 8),
        communicationStyle: profile.communicationStyle,
        relationToAgent: profile.relationToAgent,
        recentEpisodes: (profile.recentEpisodes ?? []).slice(-6).map((ep: InteractionEpisode) => ({
            date: ep.date,
            type: ep.type,
            summary: ep.summary,
            topicLabel: ep.topicLabel,
            evidence: ep.evidence?.slice(0, 2),
            agentOutcome: ep.agentOutcome,
            confidence: ep.confidence,
        })),
        mergedMemory: (profile.mergedMemory ?? []).slice(0, 4).map((m: MergedMemory) => ({
            periodStart: m.periodStart,
            periodEnd: m.periodEnd,
            granularity: m.granularity,
            overallSentiment: m.overallSentiment,
            interactionCount: m.interactionCount,
            highlights: m.highlights?.slice(0, 5),
            relationshipTrend: m.relationshipTrend,
            stablePatterns: m.stablePatterns?.slice(0, 5),
            agentPolicyHints: m.agentPolicyHints?.slice(0, 5),
            salientEvents: m.salientEvents?.slice(0, 5),
            followupCandidates: m.followupCandidates?.slice(0, 5),
        })),
    };
}

function renderMetaLine(profile: ReturnType<typeof sanitizeProfile>): string {
    const memory = [
        ...profile.recentEpisodes.map(ep => `${ep.topicLabel ? `${ep.topicLabel}: ` : ""}${ep.summary}`),
        ...profile.mergedMemory.map(m => `[${m.granularity}] ${m.relationshipTrend || m.highlights?.join("；") || ""}`),
    ].filter(Boolean).slice(0, 4);
    const hints = profile.mergedMemory.flatMap(m => m.agentPolicyHints ?? []).slice(0, 4);
    const patterns = profile.mergedMemory.flatMap(m => m.stablePatterns ?? []).slice(0, 4);
    return [
        `关系: ${profile.relationToAgent || "(无)"}`,
        profile.communicationStyle ? `风格: ${profile.communicationStyle}` : "",
        memory.length ? `关系记忆: ${memory.join("；")}` : "",
        patterns.length ? `稳定模式: ${patterns.join("；")}` : "",
        hints.length ? `互动提示: ${hints.join("；")}` : "",
    ].filter(Boolean).join(" | ");
}

function shiftEpisodeDates(episodes: InteractionEpisode[], daysAgo: number): InteractionEpisode[] {
    const base = Date.now() - daysAgo * 86400_000;
    return episodes.map((ep, index) => ({
        ...ep,
        id: `${ep.id}-verify-${daysAgo}-${index}`,
        date: new Date(base + index * 60_000).toISOString(),
    }));
}

async function main() {
    mkdirSync(dirname(WORK_DB), { recursive: true });
    copyFileSync(SOURCE_DB, WORK_DB);

    const cfg = loadConfig(".tmp/config.yaml", true);
    const llmConfigs = resolveComponentProfiles("reflection", cfg);
    const noCascadeConfig: ReflectionExternalConfig = {
        ...cfg.reflection,
        mergeThresholds: {
            episodeToWeek: 9999,
            weekToMonth: 9999,
            monthToQuarter: 9999,
            quarterToYear: 9999,
        },
    };

    const memory = new MemoryStoreV2(WORK_DB);
    const db = (memory as any).db;

    const reflectionRuns = [];
    for (const chatId of SELECTED_CHATS) {
        const before = db.prepare("SELECT * FROM person_group_profiles WHERE user_id = ? AND chat_id = ?").get(USER_ID, chatId);
        const result = await memory.reflect(chatId, llmConfigs, noCascadeConfig);
        const after = db.prepare("SELECT * FROM person_group_profiles WHERE user_id = ? AND chat_id = ?").get(USER_ID, chatId);
        reflectionRuns.push({
            chatId,
            chatTitle: db.prepare("SELECT chat_title FROM group_models WHERE chat_id = ?").get(chatId)?.chat_title ?? chatId,
            result,
            before: before ? sanitizeProfile({
                userId: before.user_id,
                chatId: before.chat_id,
                dunbarTier: before.dunbar_tier,
                affinityScore: before.affinity_score,
                traits: parseJsonArray(before.traits),
                interests: parseJsonArray(before.interests),
                communicationStyle: before.communication_style,
                relationToAgent: before.relation_to_agent,
                recentEpisodes: parseJsonArray(before.recent_episodes),
                mergedMemory: parseJsonArray(before.merged_memory),
            }) : null,
            after: after ? sanitizeProfile({
                userId: after.user_id,
                chatId: after.chat_id,
                dunbarTier: after.dunbar_tier,
                affinityScore: after.affinity_score,
                traits: parseJsonArray(after.traits),
                interests: parseJsonArray(after.interests),
                communicationStyle: after.communication_style,
                relationToAgent: after.relation_to_agent,
                recentEpisodes: parseJsonArray(after.recent_episodes),
                mergedMemory: parseJsonArray(after.merged_memory),
            }) : null,
        });
    }

    const mergeChatId = SELECTED_CHATS[0];
    const profile = memory.getProfilesForChat(mergeChatId).find(p => p.userId === USER_ID);
    if (!profile) throw new Error(`profile not found: ${USER_ID} ${mergeChatId}`);

    const episodeSample = (profile.recentEpisodes ?? [])
        .filter(ep => ep.userId === USER_ID)
        .slice(-8);
    if (episodeSample.length === 0) {
        throw new Error("no recent episodes available for merge sample");
    }

    memory.upsertPersonGroupProfile(USER_ID, mergeChatId, {
        recentEpisodes: shiftEpisodeDates(episodeSample, 10),
        mergedMemory: [],
    });
    const weekMergedCount = await mergeEpisodes(USER_ID, mergeChatId, memory, llmConfigs, cfg.reflection);
    const weekProfile = memory.getProfilesForChat(mergeChatId).find(p => p.userId === USER_ID)!;
    const weekMerged = weekProfile.mergedMemory ?? [];

    const baseWeek = weekMerged[0];
    if (!baseWeek) throw new Error("week merge produced no merged memory");
    const monthInputs: MergedMemory[] = [45, 38].map((days, index) => ({
        ...baseWeek,
        periodStart: new Date(Date.now() - days * 86400_000).toISOString(),
        periodEnd: new Date(Date.now() - (days - 2) * 86400_000).toISOString(),
        granularity: "week",
        highlights: [...baseWeek.highlights, `验证周记忆 ${index + 1}`],
        relationshipTrend: `${baseWeek.relationshipTrend || "互动趋势"}（验证片段 ${index + 1}）`,
    }));
    memory.upsertPersonGroupProfile(USER_ID, mergeChatId, {
        recentEpisodes: [],
        mergedMemory: monthInputs,
    });
    await mergeEpisodes(USER_ID, mergeChatId, memory, llmConfigs, cfg.reflection);
    const cascadedProfile = memory.getProfilesForChat(mergeChatId).find(p => p.userId === USER_ID)!;

    const finalProfiles = SELECTED_CHATS
        .map(chatId => memory.getProfilesForChat(chatId).find(p => p.userId === USER_ID))
        .filter(Boolean)
        .map(p => sanitizeProfile(p));

    const report = {
        userId: USER_ID,
        workDb: WORK_DB,
        llmProfiles: llmConfigs.map(p => ({ provider: p.provider, model: p.model })),
        selectedChats: SELECTED_CHATS,
        reflectionRuns,
        mergeValidation: {
            chatId: mergeChatId,
            weekMergedCount,
            weekMerged: weekMerged.map(m => sanitizeProfile({
                userId: USER_ID,
                chatId: mergeChatId,
                dunbarTier: 1,
                affinityScore: 100,
                traits: [],
                interests: [],
                communicationStyle: "",
                relationToAgent: "",
                recentEpisodes: [],
                mergedMemory: [m],
            }).mergedMemory[0]),
            cascaded: sanitizeProfile(cascadedProfile).mergedMemory,
        },
        downstreamRenderPreview: finalProfiles.map(profile => ({
            chatId: profile.chatId,
            metaActiveProfileLine: renderMetaLine(profile),
            executorPersonContext: {
                userId: USER_ID,
                relationshipMemory: [
                    ...profile.recentEpisodes.map(ep => ep.summary),
                    ...profile.mergedMemory.map(m => m.relationshipTrend),
                ].filter(Boolean).slice(0, 4),
                agentPolicyHints: profile.mergedMemory.flatMap(m => m.agentPolicyHints ?? []).slice(0, 4),
                stablePatterns: profile.mergedMemory.flatMap(m => m.stablePatterns ?? []).slice(0, 4),
                followupCandidates: profile.mergedMemory.flatMap(m => m.followupCandidates ?? []).slice(0, 4),
            },
        })),
        llmCalls: [...calls.values()],
    };

    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
    console.log(JSON.stringify({
        reportPath: REPORT_PATH,
        runs: reflectionRuns.map(run => ({
            chatId: run.chatId,
            chatTitle: run.chatTitle,
            personUpdates: run.result.personUpdates.length,
            facts: run.result.newCoreFacts.length,
            topics: run.result.topicsSummary.length,
            mergedEpisodes: run.result.mergedEpisodes,
            insights: run.result.insights,
            afterPreview: run.after ? renderMetaLine(run.after) : null,
        })),
        mergeValidation: report.mergeValidation,
        downstreamRenderPreview: report.downstreamRenderPreview,
        llmCallCount: report.llmCalls.length,
    }, null, 2));

    memory.close();
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
