import type { LLMConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import { getGroupModelKey } from "../core/chat-id.js";
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
import { loadConfig } from "../core/config.js";
import { generateModuleRoster } from "../sandbox/modules/module-registry.js";
import type { ActiveUserProfile, AttentionQueueEntry, MetaSessionHistoryEntry, SubagentCallback, TopicDigest } from "../subagent/types.js";
import type { GlobalState } from "./global-state.js";

const log = createLogger("meta-session-handler");
const DEFAULT_BASE_SKILLS = ["runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "vision", "shell"];
const MAX_META_SESSION_HISTORY_MESSAGES = 12;
type MetaHistoryMessage = Pick<MetaSessionHistoryEntry, "role" | "content">;

export interface MetaSessionHandlerDeps {
    getPersona: () => { name?: string; description?: string } | undefined;
    globalState: Pick<GlobalState, "getSessionDigests" | "memoList" | "getMetaSessionHistory" | "appendMetaSessionHistory">;
    memory: Pick<IMemoryStoreV2, "getGroupModel" | "getProfilesForChat" | "getPersonIdentity" | "getTopicById">;
    sandbox: MetaSandbox;
    getLlmConfigs: () => LLMConfig[];
    llmCaller?: MetaLLMCaller;
    maxTurns?: number;
    codeTimeout?: number;
    llmTimeoutMs?: number;
}

export function createMetaSessionHandler(deps: MetaSessionHandlerDeps) {
    const engine = new ContextEngine("meta-agent");
    engine.registerAll(getMetaProviders());
    const sessionHistory: ChatMessage[] = deps.globalState.getMetaSessionHistory().map((message) => ({
        role: message.role,
        content: message.content,
    }));

    return async (
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

        const { messages, renderTrees, contextManifest } = await buildMetaMessages(deps, engine, sessionHistory, entries, callbacks);
        const initialMessageCount = messages.length;
        log.info("运行 Meta session", {
            groups: entries.map((entry) => entry.chatId),
            callbacks: callbacks.length,
        });

        const result = await runMetaSession(messages, deps.sandbox, llmConfigs, {
            maxTurns: deps.maxTurns,
            codeTimeout: deps.codeTimeout,
            llmCaller: deps.llmCaller,
            llmTimeoutMs: deps.llmTimeoutMs,
            contextManifest,
        });

        if (result.messages.length > initialMessageCount) {
            const historyMessages = collectMetaSessionHistory(result.messages.slice(initialMessageCount));
            appendMetaSessionHistory(sessionHistory, historyMessages);
            deps.globalState.appendMetaSessionHistory(historyMessages);
        }

        if (result.endReason !== "error" || result.turns.length > 0) {
            for (const tree of renderTrees) {
                engine.commit(tree);
            }
        }

        return result;
    };
}

async function buildMetaMessages(
    deps: MetaSessionHandlerDeps,
    engine: ContextEngine,
    sessionHistory: ChatMessage[],
    entries: AttentionQueueEntry[],
    callbacks: SubagentCallback[],
): Promise<{ messages: ChatMessage[]; renderTrees: SectionNode[][]; contextManifest: ContextManifest }> {
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

    const historicalParts: string[] = [];
    const ephemeralParts: string[] = [];
    const renderTrees: SectionNode[][] = [];

    const globalRender = engine.render({
        sessionDigests: deps.globalState.getSessionDigests(),
        memos: deps.globalState.memoList(),
        callbacks,
    });
    renderTrees.push(globalRender.tree);
    manifests.push(globalRender.manifest);
    if (globalRender.historicalContent) {
        historicalParts.push(globalRender.historicalContent);
    }
    if (globalRender.ephemeralContent) {
        ephemeralParts.push(globalRender.ephemeralContent);
    }

    for (const entry of entries) {
        const renderResult = engine.render(await buildMetaResolveContext(deps, entry));
        renderTrees.push(renderResult.tree);
        manifests.push(renderResult.manifest);
        if (renderResult.historicalContent) {
            historicalParts.push(renderResult.historicalContent);
        }
        if (renderResult.ephemeralContent) {
            ephemeralParts.push(renderResult.ephemeralContent);
        }
    }

    const instructionRender = engine.render({
        currentTurnInstruction: "请检查是否需要跨群检索、分派任务、写 memo 或注册 wake condition。若无需动作，请直接结束本轮。",
    });
    renderTrees.push(instructionRender.tree);
    manifests.push(instructionRender.manifest);
    if (instructionRender.ephemeralContent) {
        ephemeralParts.push(instructionRender.ephemeralContent);
    }

    if (historicalParts.length > 0) {
        messages.push({
            role: "user",
            content: historicalParts.join("\n\n"),
        });
    }

    if (ephemeralParts.length > 0) {
        messages.push({
            role: "user",
            content: ephemeralParts.join("\n\n"),
        });
    }

    return {
        messages,
        renderTrees,
        contextManifest: mergeContextManifests(manifests),
    };
}

async function buildMetaSystemPrompt(persona: { name?: string; description?: string }): Promise<string> {
    const systemPrompt = loadRequiredPrompt("meta-agent/meta-system.md");
    return renderTemplate(systemPrompt, {
        personaName: persona.name ?? "赛博群友",
        personaDescription: persona.description ?? "跨群编排 agent",
        metaApiReference: buildMetaApiReference(),
        availableSkillsRoster: await buildAssignableSkillsRoster(),
    });
}

async function buildAssignableSkillsRoster(): Promise<string> {
    try {
        const currentConfig = loadConfig();
        const baseSkills = new Set(currentConfig.subagent?.baseSkills ?? DEFAULT_BASE_SKILLS);

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
    const historicalSections = sections.filter((section) =>
        section.sentPhase === "historical"
        && typeof section.sentContent === "string"
        && section.sentContent.length > 0
    );
    const ephemeralSections = sections.filter((section) =>
        section.sentPhase === "ephemeral"
        && typeof section.sentContent === "string"
        && section.sentContent.length > 0
    );
    const chatIds = [...new Set(manifests
        .map((manifest) => manifest.chatId)
        .filter((chatId): chatId is string => typeof chatId === "string" && chatId.length > 0))];

    historicalSections.forEach((section, index) => {
        section.sentOrder = index;
    });
    ephemeralSections.forEach((section, index) => {
        section.sentOrder = historicalSections.length + index;
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

function appendMetaSessionHistory(history: ChatMessage[], messages: MetaHistoryMessage[]): void {
    for (const message of messages) {
        if (!message.content.trim()) {
            continue;
        }
        history.push({ role: message.role, content: message.content.trim() });
    }

    if (history.length > MAX_META_SESSION_HISTORY_MESSAGES) {
        history.splice(0, history.length - MAX_META_SESSION_HISTORY_MESSAGES);
    }
}

function collectMetaSessionHistory(messages: ChatMessage[]): MetaHistoryMessage[] {
    return messages.flatMap((message) => {
        if ((message.role !== "assistant" && message.role !== "user") || !message.content.trim()) {
            return [];
        }
        return [{ role: message.role, content: message.content.trim() }];
    });
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
    const isDirectMessage = groupModel?.isDirectMessage ?? entry.directAddressReason === "DM";
    const chatType = isSyntheticMeta ? "系统" : deriveChatType(isDirectMessage);

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
        recentMessages: entry.recentMessages,
        groupModel: groupModel ?? undefined,
        tonePreset: tonePresetFor(entry.stickinessLevel),
        activeUserProfiles: activeUserProfiles.length > 0 ? activeUserProfiles : undefined,
    };
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
    memory: Pick<IMemoryStoreV2, "getProfilesForChat" | "getPersonIdentity">,
): ActiveUserProfile[] {
    const recentMessages = entry.recentMessages ?? [];
    const senderCounts = new Map<string, number>();

    for (const message of recentMessages) {
        if (!message.userId) continue;
        senderCounts.set(message.userId, (senderCounts.get(message.userId) ?? 0) + 1);
    }

    if (senderCounts.size === 0) {
        for (const participant of entry.topicDigests.flatMap((digest) => digest.participants)) {
            if (!participant) continue;
            senderCounts.set(participant, 0);
        }
    }

    const profiles = memory.getProfilesForChat(entry.chatId);
    const profilesByUserId = new Map(profiles.map((profile) => [profile.userId, profile]));
    const result: ActiveUserProfile[] = [];

    for (const [userId, messageCount] of senderCounts) {
        const identity = memory.getPersonIdentity(userId);
        const profile = profilesByUserId.get(userId);
        result.push({
            userId,
            displayName: identity?.displayName ?? recentMessages.find((message) => message.userId === userId)?.displayName ?? userId,
            aliases: identity?.aliases ?? [],
            dunbarTier: profile?.dunbarTier,
            rapport: typeof profile?.affinityScore === "number" ? Math.round(profile.affinityScore) : undefined,
            traits: profile?.traits ?? [],
            communicationStyle: profile?.communicationStyle,
            relationToAgent: profile?.relationToAgent,
            messageCount,
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

function buildMetaApiReference(): string {
    return `## conversations — 跨群检索

\`\`\`ts
await conversations.query(filters?: {
  chatIds?: string[],    // 限定群组 ID，空则搜索全部
  keywords?: string[],   // 全文关键词，支持多个（OR 逻辑）
  userId?: string,       // 限定发言者 ID（如 "telegram:123456"）
  after?: string,        // ISO 时间下限
  before?: string,       // ISO 时间上限
  limit?: number         // 结果数上限（默认 20，最大 100）
}): Promise<{
  messages: { messageId, chatId, userId, displayName, content, timestamp }[],
  topics: { topicId, chatId, label, summary, keywords, participants, startedAt, endedAt, sentiment, callbackPotential }[]
}>
\`\`\`

## memory — 跨群实体检索

\`\`\`ts
await memory.searchEntities(query: string, options?: {
  chatId?: string,             // 限定群组
  after?: string,              // ISO 时间下限
  before?: string,             // ISO 时间上限
  categories?: string[],       // 事实分类过滤
  limit?: number               // 默认 10，最大 50
}): Promise<{
  identities: { identity: { userId, aliases, displayName }, profile: { recentFacts, dunbarTier } }[],
  recentSessions: { topicId, chatId, label, summary, keywords, participants }[],
  coreFacts: { factId, subject, content, category, updatedAt }[],
  topicKeywords: string[]
}>
\`\`\`

## agents — 下属状态

\`\`\`ts
await agents.listStatus(): Promise<{
  chatId: string,
  queueSize: number,        // Q4 积压任务数
  isProcessing: boolean,    // 当前是否在执行
  lastActiveAt: string,     // 最后活跃时间
  stickinessLevel: "CORE" | "FAMILIAR" | "ACQUAINTANCE" | "STRANGER"
}[]>
\`\`\`

## dispatch — 任务派发

\`\`\`ts
await dispatch.taskToGroup(chatId: string, taskSpec: {
  contentDirection: string,  // 必填：行动方向，告诉 Subagent 往哪个方向回复
  toneGuidance?: string,     // 语气指导（轻松 / 正式 / 简短等）
  context?: any,             // 跨群上下文，直接注入给 Subagent 的 prompt
  useSkills?: string[]       // 需要额外加载的 Skill 模块名
}): Promise<{ taskId: string }>
\`\`\`
dispatch 会自动将 context 序列化后注入 Subagent 的任务 prompt。你查到的跨群信息、事实、讨论记录都可以放在 context 里。

## memo — 跨会话备忘录

\`\`\`ts
await memo.set(key: string, value: any, ttlMinutes?: number): Promise<void>
await memo.get(key: string): Promise<any | null>
await memo.delete(key: string): Promise<void>
await memo.list(): Promise<{ key, value, expiresAt? }[]>
\`\`\`
memo 用于跨会话状态管理。设置 ttlMinutes 可自动过期。

## schedule — 唤醒调度

\`\`\`ts
// 延迟唤醒：ms 毫秒后系统将唤醒你
await schedule.wakeOnCondition({ type: "delay", ms: number }): Promise<{ conditionId, reminderId }>

// 等待回调：Subagent 完成指定 taskId 后唤醒你
await schedule.wakeOnCondition({ type: "callback_received", taskId: string }): Promise<{ conditionId }>

// 取消唤醒条件
await schedule.cancel(conditionId: string): Promise<{ removedWakeCondition, removedReminderIds }>
\`\`\``;
}