import type { LLMConfig, VisionConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import { getGroupModelKey, parseChatId } from "../core/chat-id.js";
import { createLogger } from "../core/logger.js";
import { loadPromptFile } from "../core/prompt-loader.js";
import { ContextEngine } from "../context-engine/context-engine.js";
import { deriveChatType } from "../context-engine/prompt-renderer-utils.js";
import { getMetaProviders } from "../context-engine/providers/meta-providers.js";
import { renderTemplate } from "../context-engine/template-engine.js";
import type { ContextManifest, SectionNode } from "../context-engine/types.js";
import type { IMemoryStoreV2 } from "../memory-v2/index.js";
import type { MetaSandbox } from "../meta-sandbox/meta-sandbox.js";
import { runMetaSession, type MetaLLMCaller, type MetaSessionResult } from "../meta-sandbox/meta-session-runner.js";
import { buildMetaApiPrefixMap, buildMetaApiReference, lookupMetaApiDocs } from "../meta-sandbox/meta-api/module-registry.js";
import { loadConfig } from "../core/config.js";
import { sanitizePromptTimestamps } from "../core/timezone.js";
import { generateModuleRoster } from "../sandbox/modules/module-registry.js";
import type { ActiveUserProfile, AttendResult, AttentionQueueEntry, AttentionRecentMessage, MetaSessionHistoryEntry, SubagentCallback, TopicDigest } from "../subagent/types.js";
import type { GlobalState } from "./global-state.js";
import { trimMetaSessionHistoryWindow } from "./meta-history-retention.js";

const log = createLogger("meta-session-handler");
const DEFAULT_BASE_SKILLS = ["runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "privacy", "dispatch", "vision", "shell"];
const META_END_TURN_MARKER = "<end_turn>";
const META_RUNNER_NOTICE_PREFIX = "[Meta runner notice]";
type MetaHistoryMessage = Pick<MetaSessionHistoryEntry, "role" | "content">;
export interface MetaSessionHandler {
    (entries: AttentionQueueEntry[], callbacks: SubagentCallback[]): Promise<(MetaSessionResult & { attendResults?: AttendResult[] }) | null>;
    resetMetaSessionContext?: () => void;
}
const META_HISTORY_SECTION_ALLOWLIST = new Set([
    "meta.session_digests",
    "meta.todos",
    "meta.attend_header",
    "meta.topic_digests",
    "meta.messages",
    "meta.group_model",
]);

export interface MetaSessionHandlerDeps {
    getPersona: () => { name?: string; description?: string } | undefined;
    globalState: Pick<GlobalState, "getSessionDigests" | "getMetaSessionHistory" | "appendMetaSessionHistory">;
    memory: Pick<IMemoryStoreV2, "getGroupModel" | "getProfilesForChat" | "getPersonIdentity" | "getTopicById" | "todoList" | "getRecentMessages">
        & Partial<Pick<IMemoryStoreV2, "getStickerDescription">>;
    sandbox: MetaSandbox;
    setActiveUserProfilesForDispatch?: (profilesByChatId: Map<string, ActiveUserProfile[]>) => void;
    getLlmConfigs: () => LLMConfig[];
    getVisionConfig?: () => VisionConfig | undefined;
    llmCaller?: MetaLLMCaller;
    maxTurns?: number;
    codeTimeout?: number;
    llmTimeoutMs?: number;
}

export function createMetaSessionHandler(deps: MetaSessionHandlerDeps): MetaSessionHandler {
    const engine = new ContextEngine("meta-agent");
    engine.registerAll(getMetaProviders());

    const handler: MetaSessionHandler = async (
        entries: AttentionQueueEntry[],
        callbacks: SubagentCallback[],
    ): Promise<MetaSessionResult | null> => {
        if (entries.length === 0) {
            return null;
        }

        const llmConfigs = deps.getLlmConfigs();
        if (llmConfigs.length === 0) {
            throw new Error("Meta session requires at least one LLM profile");
        }

        const sessionHistory = loadMetaSessionHistory(deps);
        const { messages, renderTrees, contextManifest, historySeedMessage } = await buildMetaMessages(deps, engine, sessionHistory, entries, callbacks);
        const initialMessageCount = messages.length;
        log.info("运行 Meta session", {
            groups: entries.map((entry) => entry.chatId),
            callbacks: callbacks.length,
        });

        const result = await (async () => {
            try {
                return await runMetaSession(messages, deps.sandbox, llmConfigs, {
                    maxTurns: deps.maxTurns,
                    codeTimeout: deps.codeTimeout,
                    llmCaller: deps.llmCaller,
                    llmTimeoutMs: deps.llmTimeoutMs,
                    contextManifest,
                    twoPassConfig: {
                        getPrefixMap: buildMetaApiPrefixMap,
                        lookupDocs: lookupMetaApiDocs,
                    },
                });
            } finally {
                deps.setActiveUserProfilesForDispatch?.(new Map());
            }
        })();

        if (historySeedMessage || result.messages.length > initialMessageCount) {
            const historyMessages = collectMetaSessionHistory([
                ...(historySeedMessage ? [historySeedMessage] : []),
                ...result.messages.slice(initialMessageCount),
            ]);
            deps.globalState.appendMetaSessionHistory(historyMessages);
        }

        if (result.endReason !== "error" || result.turns.length > 0) {
            for (const tree of renderTrees) {
                engine.commit(tree);
            }
        }

        return result;
    };

    handler.resetMetaSessionContext = () => {
        engine.ledger.reset();
        deps.setActiveUserProfilesForDispatch?.(new Map());
        log.info("Meta session handler context 已重置");
    };

    return handler;
}

function loadMetaSessionHistory(deps: MetaSessionHandlerDeps): ChatMessage[] {
    const sessionHistory: ChatMessage[] = deps.globalState.getMetaSessionHistory().flatMap((message) => {
        const content = normalizeMetaSessionHistoryContent(message);
        if (!content) {
            return [];
        }
        return [{ role: message.role, content }];
    });
    trimMetaSessionHistoryWindow(sessionHistory);
    return sessionHistory;
}

async function buildMetaMessages(
    deps: MetaSessionHandlerDeps,
    engine: ContextEngine,
    sessionHistory: ChatMessage[],
    entries: AttentionQueueEntry[],
    callbacks: SubagentCallback[],
): Promise<{ messages: ChatMessage[]; renderTrees: SectionNode[][]; contextManifest: ContextManifest; historySeedMessage: MetaHistoryMessage | null }> {
    const persona = deps.getPersona() ?? {};
    const systemPrompt = await buildMetaSystemPrompt(persona);
    const messages: ChatMessage[] = [
        {
            role: "system",
            content: systemPrompt,
        },
    ];
    const manifests: ContextManifest[] = [];

    if (sessionHistory.length > 0) {
        messages.push(...sessionHistory.map((message) => ({ ...message })));
    }

    const currentParts: string[] = [];
    const renderTrees: SectionNode[][] = [];
    const activeProfilesForDispatch = new Map<string, ActiveUserProfile[]>();

    const isProactiveIdle = entries.some((entry) => entry.source === "PROACTIVE_IDLE");
    const globalRender = engine.render({
        sessionDigests: deps.globalState.getSessionDigests(),
        sessionDigestLimit: isProactiveIdle ? 30 : undefined,
        todos: buildGlobalTodos(deps.memory),
        callbacks,
    });
    renderTrees.push(globalRender.tree);
    manifests.push(globalRender.manifest);
    pushCurrentRenderPart(currentParts, globalRender.tree);

    for (const entry of entries) {
        const resolveContext = await buildMetaResolveContext(deps, entry);
        const activeUserProfiles = Array.isArray(resolveContext.activeUserProfiles)
            ? resolveContext.activeUserProfiles.filter((profile): profile is ActiveUserProfile =>
                !!profile && typeof profile === "object" && typeof (profile as ActiveUserProfile).userId === "string"
            )
            : [];
        if (activeUserProfiles.length > 0) {
            activeProfilesForDispatch.set(entry.chatId, activeUserProfiles);
        }
        const renderResult = engine.render(resolveContext);
        renderTrees.push(renderResult.tree);
        manifests.push(renderResult.manifest);
        pushCurrentRenderPart(currentParts, renderResult.tree);
    }
    deps.setActiveUserProfilesForDispatch?.(activeProfilesForDispatch);

    const proactiveInstruction = isProactiveIdle
        ? loadPromptFile("meta-agent/proactive-idle.md")
        : null;
    const instructionRender = engine.render({
        currentTurnInstruction: [
            "你可以**写代码**来跨群检索、分派任务、写 todo 或注册 remind/cron，但请勿自己执行具体任务。若无需动作，则不输出代码。",
            proactiveInstruction,
        ].filter(Boolean).join("\n\n"),
    });
    renderTrees.push(instructionRender.tree);
    manifests.push(instructionRender.manifest);
    pushCurrentRenderPart(currentParts, instructionRender.tree);

    if (currentParts.length > 0) {
        messages.push({
            role: "user",
            content: currentParts.join("\n\n"),
        });
    }

    return {
        messages,
        renderTrees,
        contextManifest: mergeContextManifests(manifests),
        historySeedMessage: buildHistorySeedMessage(mergeContextManifests(manifests)),
    };
}

function pushCurrentRenderPart(parts: string[], tree: SectionNode[]): void {
    const rendered = tree.flatMap((node) => {
        if (node.skipped || !node.fullRendered) {
            return [];
        }
        if (node.schema.history === "ephemeral") {
            return [node.fullRendered];
        }
        return node.historicalRendered ? [node.historicalRendered] : [];
    });
    if (rendered.length > 0) {
        parts.push(rendered.join("\n\n"));
    }
}

async function buildMetaSystemPrompt(persona: { name?: string; description?: string }): Promise<string> {
    const systemPrompt = loadRequiredPrompt("meta-agent/meta-system.md");
    const privacy = loadConfig().privacy;
    const allowMark = privacy?.allowLlmMarkSensitive !== false;
    return renderTemplate(systemPrompt, {
        personaName: persona.name ?? "赛博群友",
        personaDescription: persona.description ?? "跨群编排 agent",
        metaApiReference: buildMetaApiReference(allowMark),
        availableSkillsRoster: await buildAssignableSkillsRoster(),
        // 隐私 prompt 指引选择性注入（与 grounding 等可选能力一致）：fence 仅 enforce!=off 讲；markSensitive 还需 allowLlmMarkSensitive。
        privacyGuidance: privacy?.enforce !== "off",
        privacyMarkGuidance: privacy?.enforce !== "off" && allowMark,
    });
}

async function buildAssignableSkillsRoster(): Promise<string> {
    try {
        const currentConfig = loadConfig();
        const baseSkills = new Set(currentConfig.subagent?.baseSkills ?? DEFAULT_BASE_SKILLS);
        baseSkills.add("dispatch");

        if (currentConfig.telegram) baseSkills.add("telegram");
        if (currentConfig.discord) baseSkills.add("discord");
        if ((currentConfig as { onebot?: unknown }).onebot) baseSkills.add("onebot");

        const { getModuleRegistryCache } = await import("../subagent/code-act-executor.js");
        const roster = generateModuleRoster(getModuleRegistryCache(), baseSkills).trim();
        return roster || "- （当前没有可额外指派的模块）";
    } catch (error) {
        log.warn("构建可分配技能名册失败", { error: String(error) });
        return "- （技能名册暂不可用）";
    }
}

function mergeContextManifests(manifests: ContextManifest[]): ContextManifest {
    const sections = manifests.flatMap((manifest) => manifest.sections.map((section) => ({ ...section })));
    const sentSections = sections.filter((section) =>
        typeof section.sentContent === "string"
        && section.sentContent.length > 0
    );
    const historicalSections = sentSections.filter((section) => section.sentPhase === "historical");
    const ephemeralSections = sentSections.filter((section) => section.sentPhase === "ephemeral");
    const chatIds = [...new Set(manifests
        .map((manifest) => manifest.chatId)
        .filter((chatId): chatId is string => typeof chatId === "string" && chatId.length > 0))];

    sentSections.forEach((section, index) => {
        section.sentOrder = index;
    });

    const activeSections = sections.filter((section) => !section.skipped);

    return {
        timestamp: new Date().toISOString(),
        chatId: chatIds.length === 1 ? chatIds[0] : (chatIds.length > 1 ? "__meta__" : undefined),
        engineId: manifests[0]?.engineId ?? "meta-agent",
        sections,
        summary: {
            totalSections: sections.length,
            activeSections: activeSections.length,
            skippedSections: sections.length - activeSections.length,
            totalChars: activeSections.reduce((sum, section) => sum + section.renderedChars, 0),
            historicalChars: historicalSections.reduce((sum, section) => sum + (section.sentContent?.length ?? 0), 0),
            ephemeralChars: ephemeralSections.reduce((sum, section) => sum + (section.sentContent?.length ?? 0), 0),
            estimatedTokens: activeSections.reduce((sum, section) => sum + section.estimatedTokens, 0),
        },
    };
}

function collectMetaSessionHistory(messages: ChatMessage[]): MetaHistoryMessage[] {
    return messages.flatMap((message) => {
        if ((message.role !== "assistant" && message.role !== "user") || !message.content.trim()) {
            return [];
        }
        const content = normalizeMetaSessionHistoryContent(message);
        if (!content) {
            return [];
        }
        return [{ role: message.role, content }];
    });
}

function normalizeMetaSessionHistoryContent(message: Pick<ChatMessage, "role" | "content">): string {
    const content = String(message.content ?? "").trim();
    if (!content || isMetaRunnerNotice(content)) {
        return "";
    }
    if (message.role === "assistant" && content === META_END_TURN_MARKER) {
        return "";
    }
    if (
        message.role === "assistant"
        && content.includes("[SESSION_DIGEST]")
        && !content.includes(META_END_TURN_MARKER)
    ) {
        return `${content}\n${META_END_TURN_MARKER}`;
    }
    return sanitizePromptTimestamps(content);
}

function isMetaRunnerNotice(content: string): boolean {
    return content.trimStart().startsWith(META_RUNNER_NOTICE_PREFIX);
}

function buildHistorySeedMessage(contextManifest: ContextManifest): MetaHistoryMessage | null {
    const sections = contextManifest.sections
        .filter((section) =>
            section.sentPhase === "historical"
            && typeof section.sentContent === "string"
            && section.sentContent.length > 0
            && META_HISTORY_SECTION_ALLOWLIST.has(section.name)
        )
        .sort((left, right) => {
            const leftOrder = typeof left.sentOrder === "number" ? left.sentOrder : Number.MAX_SAFE_INTEGER;
            const rightOrder = typeof right.sentOrder === "number" ? right.sentOrder : Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder;
        });

    if (sections.length === 0) {
        return null;
    }

    return {
        role: "user",
        content: sanitizePromptTimestamps(sections.map((section) => section.sentContent).join("\n\n").trim()),
    };
}

async function buildMetaResolveContext(
    deps: MetaSessionHandlerDeps,
    entry: AttentionQueueEntry,
): Promise<Record<string, unknown>> {
    const isSyntheticMeta = entry.chatId === "__meta__";
    const groupModel = isSyntheticMeta
        ? null
        : deps.memory.getGroupModel(getGroupModelKey(entry.chatId));
    const topicDigests = enrichTopicDigests(entry.topicDigests, deps.memory);
    const activeUserProfiles = isSyntheticMeta ? [] : buildActiveUserProfiles(entry, deps.memory);
    const isDirectMessage = groupModel?.isDirectMessage ?? inferDirectMessageFromChatId(entry.chatId) ?? entry.directAddressReason === "DM";
    const chatType = isSyntheticMeta ? "系统" : deriveChatType(isDirectMessage);
    const recentMessageContext = buildRecentMessageContext(deps.memory, entry, isSyntheticMeta);
    const visionConfig = deps.getVisionConfig?.() ?? loadConfig().vision;

    return {
        chatId: entry.chatId,
        chatTitle: isSyntheticMeta ? "Meta 调度" : (groupModel?.chatTitle ?? entry.chatId),
        chatType,
        isDirectMessage,
        source: entry.source,
        priority: entry.priority,
        newMessageCount: entry.newMessageCount,
        engagementScore: entry.engagementScore ?? 0,
        stickinessLevel: entry.stickinessLevel,
        directAddressReason: entry.directAddressReason,
        callbackPotential: entry.callbackPotential,
        urgentSignals: entry.urgentSignals,
        schedulerTriggers: entry.schedulerTriggers,
        topicDigests,
        recentMessages: recentMessageContext.messages,
        fallbackToRecentMessages: recentMessageContext.fallbackToRecent,
        attendMediaMode: visionConfig?.attendMode,
        stickerDescriptionLookup: typeof deps.memory.getStickerDescription === "function" ? deps.memory : undefined,
        groupModel: groupModel ?? undefined,
        tonePreset: tonePresetFor(entry.stickinessLevel),
        activeUserProfiles: activeUserProfiles.length > 0 ? activeUserProfiles : undefined,
    };
}

function inferDirectMessageFromChatId(chatId: string): boolean | undefined {
    try {
        const parsed = parseChatId(chatId);
        if (parsed.platform === "onebot") {
            return parsed.rawId.startsWith("private:");
        }
        if (parsed.platform === "telegram") {
            const numericId = Number(parsed.rawId);
            return Number.isFinite(numericId) ? numericId > 0 : undefined;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

function buildRecentMessageContext(
    memory: Pick<IMemoryStoreV2, "getRecentMessages"> & Partial<Pick<IMemoryStoreV2, "getMessageById">>,
    entry: AttentionQueueEntry,
    isSyntheticMeta: boolean,
): { messages?: AttentionRecentMessage[]; fallbackToRecent: boolean } {
    const shouldFallback = !isSyntheticMeta && entry.newMessageCount <= 0;
    if (!shouldFallback) {
        return entry.recentMessages
            ? { messages: enrichAttentionRecentMessages(memory, entry.chatId, entry.recentMessages), fallbackToRecent: false }
            : { fallbackToRecent: false };
    }

    try {
        const recent = memory.getRecentMessages(entry.chatId, 20);
        if (recent.length > 0) {
            return {
                messages: enrichAttentionRecentMessages(memory, entry.chatId, [...recent].reverse().map((message) => ({
                    messageId: message.messageId,
                    userId: message.userId,
                    displayName: message.displayName,
                    text: message.text,
                    timestamp: message.timestamp,
                    replyToMessageId: message.replyToMessageId,
                    mediaType: message.mediaType,
                    mediaInfo: message.mediaInfo,
                }))),
                fallbackToRecent: true,
            };
        }
    } catch (error) {
        log.debug("读取 attention 兜底消息失败", { chatId: entry.chatId, error: String(error) });
    }

    return entry.recentMessages
        ? { messages: enrichAttentionRecentMessages(memory, entry.chatId, entry.recentMessages), fallbackToRecent: entry.recentMessages.length > 0 }
        : { fallbackToRecent: false };
}

function enrichAttentionRecentMessages(
    memory: Pick<IMemoryStoreV2, "getRecentMessages"> & Partial<Pick<IMemoryStoreV2, "getMessageById">>,
    chatId: string,
    messages: AttentionRecentMessage[],
): AttentionRecentMessage[] {
    const byId = new Map(messages.map((message) => [message.messageId, message]));

    return messages.map((message) => {
        const replyToMsgId = message.replyToMsgId ?? message.replyToMessageId;
        if (!replyToMsgId) {
            return { ...message };
        }

        const inWindow = byId.get(replyToMsgId);
        let replyTo = message.replyTo ?? inWindow?.displayName ?? inWindow?.userId;
        let replyToText = message.replyToText;

        if ((!replyTo || !replyToText) && memory.getMessageById) {
            try {
                const original = memory.getMessageById(chatId, replyToMsgId);
                if (original) {
                    replyTo = replyTo ?? original.displayName ?? original.userId;
                    if (!inWindow && !replyToText) {
                        replyToText = original.text || mediaPlaceholder(original.mediaType, original.mediaInfo);
                    }
                }
            } catch (error) {
                log.debug("解析 Meta recent reply 目标失败", { chatId, replyToMsgId, error: String(error) });
            }
        }

        return {
            ...message,
            replyToMessageId: replyToMsgId,
            replyToMsgId,
            replyTo: replyTo ?? `msg#${replyToMsgId}`,
            replyToText,
        };
    });
}

function mediaPlaceholder(mediaType?: string, mediaInfo?: string): string | undefined {
    if (!mediaType) return undefined;
    if (mediaType === "sticker") {
        try {
            const info = mediaInfo ? JSON.parse(mediaInfo) as { emoji?: string } : {};
            return info.emoji ? `[贴纸: ${info.emoji}]` : "[贴纸]";
        } catch {
            return "[贴纸]";
        }
    }
    return `[${mediaType}]`;
}

function enrichTopicDigests(
    topicDigests: TopicDigest[],
    memory: Pick<IMemoryStoreV2, "getTopicById">,
): TopicDigest[] {
    return topicDigests.map((digest) => {
        const topic = memory.getTopicById(digest.topicId);
        return {
            ...digest,
            associatedMemories: digest.associatedMemories ?? topic?.associatedMemories,
            callbackPotential: digest.callbackPotential ?? topic?.callbackPotential ?? 0,
        };
    });
}

function buildActiveUserProfiles(
    entry: AttentionQueueEntry,
    memory: Pick<IMemoryStoreV2, "getProfilesForChat" | "getPersonIdentity">
        & Partial<Pick<IMemoryStoreV2, "getPersonProfile" | "getGroupModel">>,
): ActiveUserProfile[] {
    const recentMessages = entry.recentMessages ?? [];
    const directUserIds = getDirectAddressUserIds(entry);
    if (directUserIds.size === 0) {
        return [];
    }
    const messageCounts = new Map<string, number>();
    for (const message of recentMessages) {
        if (directUserIds.has(message.userId)) {
            messageCounts.set(message.userId, (messageCounts.get(message.userId) ?? 0) + 1);
        }
    }

    const profiles = memory.getProfilesForChat(entry.chatId);
    const profilesByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
    const result: ActiveUserProfile[] = [];

    for (const userId of directUserIds) {
        const identity = memory.getPersonIdentity(userId);
        const profile = profilesByUserId.get(userId);
        const globalProfile = memory.getPersonProfile?.(userId) ?? null;
        const relationParts = [
            globalProfile?.relationToAgent ? `全局: ${globalProfile.relationToAgent}` : "",
            profile?.relationToAgent ? `当前场景: ${profile.relationToAgent}` : "",
        ].filter(Boolean);
        const fallbackName = recentMessages.find((message) => message.userId === userId)?.displayName;
        result.push({
            userId,
            displayName: identity?.displayName ?? fallbackName ?? userId,
            userLabel: formatUserLabel(memory, userId, fallbackName),
            currentChatLabel: formatChatLabel(memory, entry.chatId),
            aliases: identity?.aliases ?? [],
            dunbarTier: profile?.dunbarTier,
            rapport: typeof profile?.affinityScore === "number" ? Math.round(profile.affinityScore) : undefined,
            traits: [...new Set([...(globalProfile?.traits ?? []), ...(profile?.traits ?? [])])].slice(0, 6),
            interests: [...new Set([...(globalProfile?.interests ?? []), ...(profile?.interests ?? [])])].slice(0, 8),
            communicationStyle: [globalProfile?.communicationStyle, profile?.communicationStyle].filter((value): value is string => !!value).map(value => clipText(value, 160)).join("；") || undefined,
            relationToAgent: relationParts.join("；") || undefined,
            globalRelationToAgent: globalProfile?.relationToAgent,
            currentRelationToAgent: profile?.relationToAgent,
            relationshipMemory: profile ? summarizeRelationshipMemory(profile) : [],
            agentPolicyHints: [...new Set([...(globalProfile?.agentPolicyHints ?? []), ...(profile ? collectAgentPolicyHints(profile) : [])])].map(value => clipText(value, 140)).slice(0, 5),
            stablePatterns: [...new Set([...(globalProfile?.stablePatterns ?? []), ...(profile ? collectStablePatterns(profile) : [])])].map(value => clipText(value, 140)).slice(0, 4),
            followupCandidates: [...new Set([...(globalProfile?.followupCandidates ?? []), ...(profile ? collectFollowupCandidates(profile) : [])])].map(value => clipText(value, 140)).slice(0, 3),
            messageCount: messageCounts.get(userId) ?? 0,
            username: identity?.username,
        });
    }

    return result.sort((left, right) => {
        if (right.messageCount !== left.messageCount) {
            return right.messageCount - left.messageCount;
        }
        return left.userId.localeCompare(right.userId);
    });
}

function getDirectAddressUserIds(entry: AttentionQueueEntry): Set<string> {
    const userIds = new Set((entry.directAddressUserIds ?? []).filter(Boolean));
    if (userIds.size > 0 || entry.source !== "DIRECT_ADDRESS") {
        return userIds;
    }
    const directMessageIds = new Set(entry.directAddressMessageIds ?? []);
    if (directMessageIds.size > 0) {
        for (const message of entry.recentMessages ?? []) {
            if (directMessageIds.has(message.messageId) && message.userId) {
                userIds.add(message.userId);
            }
        }
    }
    if (userIds.size === 0) {
        const latestSender = [...(entry.recentMessages ?? [])].reverse().find(message => !!message.userId);
        if (latestSender?.userId) {
            userIds.add(latestSender.userId);
        }
    }
    return userIds;
}

function formatUserLabel(
    memory: Partial<Pick<IMemoryStoreV2, "getPersonIdentity">>,
    userId: string,
    fallbackName?: string,
): string {
    const identity = memory.getPersonIdentity?.(userId);
    const name = identity?.displayName?.trim() || fallbackName?.trim() || userId;
    return `${name}(${userId})`;
}

function formatChatLabel(
    memory: Partial<Pick<IMemoryStoreV2, "getGroupModel">>,
    chatId: string,
): string {
    const groupModel = memory.getGroupModel?.(getGroupModelKey(chatId));
    const title = groupModel?.chatTitle?.trim() || chatId;
    return `${title}(${chatId})`;
}

function summarizeRelationshipMemory(profile: { recentEpisodes?: Array<{ summary: string; topicLabel?: string }>; mergedMemory?: Array<{ relationshipTrend: string; highlights: string[]; granularity: string; periodStart: string; periodEnd: string; salientEvents?: Array<{ summary: string; confidence?: number }> }> }): string[] {
    const merged = [...(profile.mergedMemory ?? [])]
        .sort((a, b) => new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime())
        .slice(0, 2)
        .flatMap(memory => {
            const period = `${memory.periodStart?.slice(0, 10) ?? "?"}~${memory.periodEnd?.slice(0, 10) ?? "?"}`;
            const trend = memory.relationshipTrend || memory.highlights?.slice(0, 2).join("；") || "";
            const salient = memory.salientEvents?.[0]?.summary;
            return [
                trend ? `[本群${memory.granularity} ${period}] ${clipText(trend, 220)}` : "",
                salient ? `[本群关键事件] ${clipText(salient, 180)}` : "",
            ];
        });
    if (merged.length > 0) {
        return merged.filter(Boolean).slice(0, 3);
    }
    return (profile.recentEpisodes ?? [])
        .slice(-2)
        .map(ep => `[本群近期事件] ${clipText(`${ep.topicLabel ? `${ep.topicLabel}: ` : ""}${ep.summary}`, 180)}`)
        .filter(Boolean);
}

function collectAgentPolicyHints(profile: { mergedMemory?: Array<{ agentPolicyHints?: string[] }> }): string[] {
    return [...new Set((profile.mergedMemory ?? []).flatMap(m => m.agentPolicyHints ?? []))]
        .filter(Boolean)
        .slice(0, 4);
}

function collectStablePatterns(profile: { mergedMemory?: Array<{ stablePatterns?: string[] }> }): string[] {
    return [...new Set((profile.mergedMemory ?? []).flatMap(m => m.stablePatterns ?? []))]
        .filter(Boolean)
        .slice(0, 4);
}

function collectFollowupCandidates(profile: { mergedMemory?: Array<{ followupCandidates?: string[] }> }): string[] {
    return [...new Set((profile.mergedMemory ?? []).flatMap(m => m.followupCandidates ?? []))]
        .filter(Boolean)
        .slice(0, 4);
}

function clipText(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function tonePresetFor(stickinessLevel: AttentionQueueEntry["stickinessLevel"]): string {
    switch (stickinessLevel) {
        case "CORE":
            return "随意友好";
        case "FAMILIAR":
            return "轻松自然";
        case "ACQUAINTANCE":
            return "礼貌简洁";
        default:
            return "克制观察";
    }
}

function loadRequiredPrompt(relativePath: string): string {
    const content = loadPromptFile(relativePath);
    if (!content) {
        throw new Error(`Missing prompt file: ${relativePath}`);
    }
    return content;
}

function buildGlobalTodos(
    memory: Pick<IMemoryStoreV2, "todoList">,
): Array<{ key: string; content: string; bindingId: string; dueAt?: string | null; expired?: boolean }> {
    return memory.todoList("meta", { includeExpired: false })
        .map((todo) => ({
            key: todo.key,
            content: todo.content,
            bindingId: "meta",
            dueAt: todo.dueAt,
            expired: todo.expired,
        }));
}
