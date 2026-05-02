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
import { trimMetaSessionHistoryWindow } from "./meta-history-retention.js";

const log = createLogger("meta-session-handler");
const DEFAULT_BASE_SKILLS = ["runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "vision", "shell"];
type MetaHistoryMessage = Pick<MetaSessionHistoryEntry, "role" | "content">;
const META_HISTORY_SECTION_ALLOWLIST = new Set([
    "meta.session_digests",
    "meta.attend_header",
    "meta.topic_digests",
    "meta.messages",
]);

export interface MetaSessionHandlerDeps {
    getPersona: () => { name?: string; description?: string } | undefined;
    globalState: Pick<GlobalState, "getSessionDigests" | "getMetaSessionHistory" | "appendMetaSessionHistory">;
    memory: Pick<IMemoryStoreV2, "getGroupModel" | "getProfilesForChat" | "getPersonIdentity" | "getTopicById" | "listGroupModels" | "todoList">;
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

        const { messages, renderTrees, contextManifest, historySeedMessage } = await buildMetaMessages(deps, engine, sessionHistory, entries, callbacks);
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

        if (historySeedMessage || result.messages.length > initialMessageCount) {
            const historyMessages = collectMetaSessionHistory([
                ...(historySeedMessage ? [historySeedMessage] : []),
                ...result.messages.slice(initialMessageCount),
            ]);
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

    const historicalParts: string[] = [];
    const ephemeralParts: string[] = [];
    const renderTrees: SectionNode[][] = [];

    const isProactiveIdle = entries.some((entry) => entry.source === "PROACTIVE_IDLE");
    const globalRender = engine.render({
        sessionDigests: deps.globalState.getSessionDigests(),
        sessionDigestLimit: isProactiveIdle ? 30 : undefined,
        todos: buildGlobalTodos(deps.memory),
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

    const proactiveInstruction = isProactiveIdle
        ? loadPromptFile("meta-agent/proactive-idle.md")
        : null;
    const instructionRender = engine.render({
        currentTurnInstruction: [
            "请检查是否需要跨群检索、分派任务、写 todo 或注册 remind/cron。若无需动作，请直接结束本轮。",
            proactiveInstruction,
        ].filter(Boolean).join("\n\n"),
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
        historySeedMessage: buildHistorySeedMessage(mergeContextManifests(manifests)),
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

    trimMetaSessionHistoryWindow(history);
}

function collectMetaSessionHistory(messages: ChatMessage[]): MetaHistoryMessage[] {
    return messages.flatMap((message) => {
        if ((message.role !== "assistant" && message.role !== "user") || !message.content.trim()) {
            return [];
        }
        return [{ role: message.role, content: message.content.trim() }];
    });
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
        content: sections.map((section) => section.sentContent).join("\n\n").trim(),
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
  user?: string,         // 人名/别名/username/userId，会先解析已知身份
  userId?: string,       // 精确限定发言者 ID（如 "telegram:123456"）
  keyword?: string,      // 正文关键词；无 user 或 user 未解析时会先匹配 displayName，再匹配正文
  after?: string,        // ISO 时间下限
  before?: string,       // ISO 时间上限
  limit?: number         // 结果数上限（默认 20，最大 100）
}): Promise<{
  messages: { messageId, chatId, chatTitle, chatLabel, userId, displayName, content, timestamp }[],
  topics: { topicId, chatId, chatTitle, chatLabel, label, summary, keywords, participants, startedAt, endedAt, sentiment, callbackPotential }[],
  resolvedUsers: { userId, displayName, username?, aliases }[]
}>
\`\`\`
chatLabel 已格式化为 "[群名(compositeId)]"，打印时直接使用它，例如 \`${"${m.chatLabel}"} ${"${m.displayName}"}: ${"${m.content}"}\`。

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
  sessionDigests: { createdAt, content }[],
  coreFacts: { factId, subject, content, category, updatedAt }[],
  topicKeywords: string[]
}>
\`\`\`

## agents — 查询聊天列表/获取下属状态

\`\`\`ts
await agents.listStatus(): Promise<{
  chatId: string,
    chatTitle?: string,       // 群标题 / 私聊对象名
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
  useSkills?: string[],      // 需要额外加载的 Skill 模块名
  tracking?: {               // 可选：派发后自动记录待跟进 todo / remind
    key?: string,            // 默认 dispatch:<taskId>
    content: string,         // 待跟进内容
    remindAfterMinutes?: number,
    callback?: string,       // reminder 唤醒后给 meta 的明确动作
    data?: any               // 附带结构化数据
  }
}): Promise<{ taskId: string, trackingKey?: string, reminderId?: string }>
\`\`\`
dispatch 会自动将 context 序列化后注入 Subagent 的任务 prompt。你查到的跨群信息、事实、讨论记录都可以放在 context 里。tracking 会把待跟进项写入 todo，bindingId 为目标 chatId；如果设置 remindAfterMinutes，还会注册一次性唤醒。

## todo — 跨会话/跨绑定 Todo

\`\`\`ts
await todo.set({ key, content, bindingId?, dueAt? }): Promise<{ bindingId, key, content, dueAt, createdAt, updatedAt, expired }>
await todo.get(key: string, bindingId?: string): Promise<{ key, content, dueAt, createdAt, updatedAt, expired } | null>
await todo.list({ bindingId?, includeExpired? }?): Promise<{ bindingId, key, content, dueAt, createdAt, updatedAt, expired }[]>
await todo.delete(key: string, bindingId?: string): Promise<void>
\`\`\`
bindingId 可以是 composite chatId，也可以是 "meta"；默认 "meta"。

## remind — 一次性唤醒

\`\`\`ts
await remind.set({
  name: string,
  callback: string,      // 必填：被唤醒后要做什么
  bindingId?: string,    // composite chatId 或 "meta"，默认 "meta"
  triggerAt?: string,    // ISO 时间
  delayMinutes?: number, // 与 triggerAt 二选一
  data?: any
}): Promise<{ id, type, bindingId, name, callback, triggerAt, data }>
await remind.get(id: string): Promise<... | null>
await remind.list({ bindingId?, includeTriggered? }?): Promise<...[]>
await remind.delete(id: string): Promise<boolean>
\`\`\`

## cron — 周期唤醒

await cron.set({
  name: string,
  cronExpr: string,      // 最短间隔 1 小时
  callback: string,      // 必填：每次触发后要做什么
  bindingId?: string,    // composite chatId 或 "meta"，默认 "meta"
  data?: any
}): Promise<{ id, type, bindingId, name, callback, cronExpr, data }>
await cron.get(id: string): Promise<... | null>
await cron.list({ bindingId? }?): Promise<...[]>
await cron.delete(id: string): Promise<boolean>
\`\`\``;
}

function buildGlobalTodos(
    memory: Pick<IMemoryStoreV2, "listGroupModels" | "todoList">,
): Array<{ key: string; content: string; bindingId: string; dueAt?: string | null; expired?: boolean }> {
    const bindingIds = [...new Set(["meta", ...memory.listGroupModels().map((group) => group.chatId)])];
    return bindingIds.flatMap((bindingId) =>
        memory.todoList(bindingId, { includeExpired: false })
            .map((todo) => ({
                key: todo.key,
                content: todo.content,
                bindingId,
                dueAt: todo.dueAt,
                expired: todo.expired,
            }))
    );
}
