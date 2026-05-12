import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MemoryStoreV2, mergeEpisodes, type CoreFact, type MergedMemory, type PersonGroupProfile, type PersonProfile } from "../src/memory-v2/index.js";
import { loadConfig, resolveComponentProfiles, type ReflectionExternalConfig } from "../src/core/config.js";
import { llmEvents, type LLMCallEvent, type LLMResponseEvent } from "../src/core/llm.js";

const USER_ID = "telegram:682932098";
const SOURCE_DB = resolve(".tmp/memory.db");
const WORK_DB = resolve(".tmp/person-profile-reflection-work.db");
const REPORT_PATH = resolve(".tmp/person-profile-reflection-report.json");
const DAYS_BACK = 7;
const MIN_MESSAGES = 1;

interface CapturedCall {
    callId: string;
    caller: string;
    provider: string;
    model: string;
    promptChars: number;
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
        provider: event.provider,
        model: event.model,
        promptChars: userMessage.length,
    });
});

llmEvents.on("llm:response", (event: LLMResponseEvent) => {
    const existing = calls.get(event.callId);
    if (!existing) return;
    existing.responseChars = event.contentLength;
    existing.durationMs = event.durationMs;
    existing.error = event.error;
});

function sanitizeGroupProfile(profile: PersonGroupProfile | undefined | null) {
    if (!profile) return null;
    return {
        userId: profile.userId,
        chatId: profile.chatId,
        tier: profile.dunbarTier,
        affinityScore: profile.affinityScore,
        traits: profile.traits,
        interests: profile.interests,
        communicationStyle: profile.communicationStyle,
        relationToAgent: profile.relationToAgent,
        recentEpisodes: (profile.recentEpisodes ?? []).slice(-8).map(ep => ({
            date: ep.date,
            type: ep.type,
            summary: ep.summary,
            topicLabel: ep.topicLabel,
            evidence: ep.evidence?.slice(0, 2),
            agentOutcome: ep.agentOutcome,
            confidence: ep.confidence,
        })),
        mergedMemory: (profile.mergedMemory ?? []).slice(0, 5).map(sanitizeMergedMemory),
    };
}

function sanitizePersonProfile(profile: PersonProfile | null) {
    if (!profile) return null;
    return {
        userId: profile.userId,
        traits: profile.traits,
        interests: profile.interests,
        communicationStyle: profile.communicationStyle,
        relationToAgent: profile.relationToAgent,
        stablePatterns: profile.stablePatterns,
        agentPolicyHints: profile.agentPolicyHints,
        followupCandidates: profile.followupCandidates,
        sourceChatIds: profile.sourceChatIds,
        confidence: profile.confidence,
        lastReflectedAt: profile.lastReflectedAt,
    };
}

function sanitizeMergedMemory(memory: MergedMemory) {
    return {
        periodStart: memory.periodStart,
        periodEnd: memory.periodEnd,
        granularity: memory.granularity,
        overallSentiment: memory.overallSentiment,
        interactionCount: memory.interactionCount,
        highlights: memory.highlights?.slice(0, 5),
        relationshipTrend: memory.relationshipTrend,
        stablePatterns: memory.stablePatterns?.slice(0, 6),
        userPreferences: memory.userPreferences?.slice(0, 6),
        agentPolicyHints: memory.agentPolicyHints?.slice(0, 6),
        salientEvents: memory.salientEvents?.slice(0, 5),
        followupCandidates: memory.followupCandidates?.slice(0, 5),
        confidence: memory.confidence,
    };
}

function sanitizeFact(fact: CoreFact) {
    return {
        id: fact.id,
        category: fact.category,
        content: fact.content,
        confidence: fact.confidence,
        sourceChatId: fact.sourceChatId,
        sourceChatTitle: fact.sourceChatTitle,
        sourceTopicLabel: fact.sourceTopicLabel,
        sourceMessageIds: fact.sourceMessageIds?.slice(0, 8),
        observedAt: fact.observedAt,
        visibility: fact.visibility,
        sensitivity: fact.sensitivity,
        updatedAt: fact.updatedAt,
    };
}

function renderUsePreview(globalProfile: ReturnType<typeof sanitizePersonProfile>, groupProfile: ReturnType<typeof sanitizeGroupProfile>) {
    if (!groupProfile) return "";
    const global = globalProfile
        ? [
            globalProfile.relationToAgent ? `全局关系: ${globalProfile.relationToAgent}` : "",
            globalProfile.communicationStyle ? `全局风格: ${globalProfile.communicationStyle}` : "",
            globalProfile.stablePatterns?.length ? `跨群模式: ${globalProfile.stablePatterns.slice(0, 3).join("；")}` : "",
            globalProfile.agentPolicyHints?.length ? `长期提示: ${globalProfile.agentPolicyHints.slice(0, 3).join("；")}` : "",
        ].filter(Boolean).join(" | ")
        : "";
    const context = [
        groupProfile.relationToAgent ? `当前场景关系: ${groupProfile.relationToAgent}` : "",
        groupProfile.communicationStyle ? `当前场景风格: ${groupProfile.communicationStyle}` : "",
        groupProfile.mergedMemory?.flatMap(m => m.agentPolicyHints ?? []).length
            ? `场景提示: ${groupProfile.mergedMemory.flatMap(m => m.agentPolicyHints ?? []).slice(0, 3).join("；")}`
            : "",
    ].filter(Boolean).join(" | ");
    return [global, context].filter(Boolean).join(" || ");
}

async function main() {
    mkdirSync(dirname(WORK_DB), { recursive: true });
    copyFileSync(SOURCE_DB, WORK_DB);

    const cfg = loadConfig(".tmp/config.yaml", true);
    const llmConfigs = resolveComponentProfiles("reflection", cfg);
    const reflectionOnlyConfig: ReflectionExternalConfig = {
        ...cfg.reflection,
        mergeThresholds: {
            episodeToWeek: 9999,
            weekToMonth: 9999,
            monthToQuarter: 9999,
            quarterToYear: 9999,
        },
    };
    const weekConfig: ReflectionExternalConfig = {
        ...cfg.reflection,
        mergeThresholds: {
            episodeToWeek: 0,
            weekToMonth: 9999,
            monthToQuarter: 9999,
            quarterToYear: 9999,
        },
    };
    const monthConfig: ReflectionExternalConfig = {
        ...cfg.reflection,
        mergeThresholds: {
            episodeToWeek: 9999,
            weekToMonth: 0,
            monthToQuarter: 9999,
            quarterToYear: 9999,
        },
    };

    const memory = new MemoryStoreV2(WORK_DB);
    const db = (memory as unknown as { db: import("better-sqlite3").Database }).db;
    const maxTimestamp = (db.prepare("SELECT max(timestamp) AS max FROM message_log").get() as { max?: string }).max;
    if (!maxTimestamp) throw new Error("message_log is empty");
    const since = new Date(new Date(maxTimestamp).getTime() - DAYS_BACK * 86400_000).toISOString();

    const recentChats = db.prepare(`
        SELECT m.chat_id AS chatId,
               COALESCE(g.chat_title, m.chat_id) AS chatTitle,
               COUNT(*) AS messageCount,
               MIN(m.timestamp) AS firstAt,
               MAX(m.timestamp) AS lastAt
        FROM message_log m
        LEFT JOIN group_models g ON g.chat_id = m.chat_id
        WHERE m.user_id = ? AND m.timestamp >= ?
        GROUP BY m.chat_id
        HAVING COUNT(*) >= ?
        ORDER BY COUNT(*) DESC
    `).all(USER_ID, since, MIN_MESSAGES) as Array<{
        chatId: string;
        chatTitle: string;
        messageCount: number;
        firstAt: string;
        lastAt: string;
    }>;

    for (const chat of recentChats) {
        memory.upsertGroupModel(chat.chatId, {
            chatTitle: chat.chatTitle,
            lastReflectedAt: since,
        });
    }

    const reflectionRuns = [];
    for (const chat of recentChats) {
        const beforeGlobal = sanitizePersonProfile(memory.getPersonProfile(USER_ID));
        const beforeGroup = sanitizeGroupProfile(memory.getProfilesForChat(chat.chatId).find(p => p.userId === USER_ID));
        const result = await memory.reflect(chat.chatId, llmConfigs, reflectionOnlyConfig);
        const afterGlobal = sanitizePersonProfile(memory.getPersonProfile(USER_ID));
        const afterGroup = sanitizeGroupProfile(memory.getProfilesForChat(chat.chatId).find(p => p.userId === USER_ID));
        reflectionRuns.push({
            chat,
            result: {
                topics: result.topicsSummary.length,
                personUpdates: result.personUpdates.length,
                facts: result.newCoreFacts.length,
                mergedEpisodes: result.mergedEpisodes,
                insights: result.insights,
            },
            beforeGlobal,
            afterGlobal,
            beforeGroup,
            afterGroup,
        });
    }

    const mergeRuns = [];
    for (const chat of recentChats) {
        const weekMerged = await mergeEpisodes(USER_ID, chat.chatId, memory, llmConfigs, weekConfig);
        const monthMerged = await mergeEpisodes(USER_ID, chat.chatId, memory, llmConfigs, monthConfig);
        const profile = memory.getProfilesForChat(chat.chatId).find(p => p.userId === USER_ID);
        mergeRuns.push({
            chat,
            weekMerged,
            monthMerged,
            groupProfile: sanitizeGroupProfile(profile),
            globalAfterMerge: sanitizePersonProfile(memory.getPersonProfile(USER_ID)),
        });
    }

    const finalGlobalProfile = sanitizePersonProfile(memory.getPersonProfile(USER_ID));
    const finalGroupProfiles = recentChats.map(chat => {
        const profile = sanitizeGroupProfile(memory.getProfilesForChat(chat.chatId).find(p => p.userId === USER_ID));
        return {
            chat,
            profile,
            usePreview: renderUsePreview(finalGlobalProfile, profile),
        };
    });
    const facts = memory.listCoreFacts({ subject: USER_ID, limit: 80 }).items.map(sanitizeFact);

    const report = {
        userId: USER_ID,
        sourceDb: SOURCE_DB,
        workDb: WORK_DB,
        daysBack: DAYS_BACK,
        maxTimestamp,
        since,
        llmProfiles: llmConfigs.map(p => ({ provider: p.provider, model: p.model })),
        recentChats,
        reflectionRuns,
        mergeRuns,
        finalGlobalProfile,
        finalGroupProfiles,
        coreFactsWithSources: facts,
        llmCalls: [...calls.values()],
    };

    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
    console.log(JSON.stringify({
        reportPath: REPORT_PATH,
        workDb: WORK_DB,
        recentChats,
        finalGlobalProfile,
        groupProfileCount: finalGroupProfiles.filter(p => p.profile).length,
        groupProfiles: finalGroupProfiles.map(p => ({
            chatTitle: p.chat.chatTitle,
            chatId: p.chat.chatId,
            messageCount: p.chat.messageCount,
            relationToAgent: p.profile?.relationToAgent,
            communicationStyle: p.profile?.communicationStyle,
            traits: p.profile?.traits,
            interests: p.profile?.interests,
            mergedMemory: p.profile?.mergedMemory?.slice(0, 2),
            usePreview: p.usePreview,
        })),
        factCount: facts.length,
        factSamples: facts.slice(0, 12),
        llmCallCount: report.llmCalls.length,
        llmCalls: report.llmCalls.map(c => ({
            caller: c.caller,
            provider: c.provider,
            model: c.model,
            promptChars: c.promptChars,
            responseChars: c.responseChars,
            durationMs: c.durationMs,
            error: c.error,
        })),
    }, null, 2));

    memory.close();
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
