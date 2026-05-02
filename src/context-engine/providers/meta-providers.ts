import type { SectionProvider, DiffResult, ResolveContext } from "../types.js";
import type {
    ActiveUserProfile,
    AttentionRecentMessage,
    SubagentCallback,
    TopicDigest,
} from "../../subagent/types.js";
import type { AssociatedMemory, GroupModel } from "../../memory-v2/types.js";
import { deriveChatType, formatTopicList, type FormattableTopic } from "../prompt-renderer-utils.js";
import { formatMessageLine, type RawMessage } from "../../core/message-enricher.js";
import { getDunbarTierLabel, getRawId } from "../../core/chat-id.js";

const META_ASSOCIATED_MEMORIES_ENABLED = false;

function scopeByChatId(ctx: ResolveContext): string | undefined {
    return typeof ctx.chatId === "string" && ctx.chatId.length > 0 ? ctx.chatId : undefined;
}

interface MetaHistoricalData {
    sessionDigests: Array<{ createdAt: string; content: string }>;
}

interface MetaTodosData {
    todos: Array<{ key: string; content: string; bindingId: string; dueAt?: string | null; expired?: boolean }>;
}

interface MetaCallbacksData {
    callbacks: SubagentCallback[];
}

interface MetaAttendHeaderData {
    chatId: string;
    chatTitle: string;
    chatType: string;
}

interface MetaAttendMetaData {
    source: string;
    priority: number;
    newMessageCount: number;
    engagementScore: number;
    stickinessLevel: string;
    directAddressReason?: string;
    callbackPotential?: number;
    urgentSignals?: string[];
    schedulerTriggers?: Array<{ id: string; type: "reminder" | "cron" | "wake_condition"; description: string; bindingId?: string; callback?: string; data?: unknown }>;
}

interface MetaTopicDigestData {
    digests: TopicDigest[];
}

interface MetaMessagesData {
    messages: AttentionRecentMessage[];
    newMessageCount: number;
    fallbackToRecent?: boolean;
}

interface MetaGroupModelData {
    chatTitle: string;
    description: string;
    agentRole: string;
    engagementLevel: string;
    hotTopics: string[];
    recentFeedback?: string;
    tonePreset: string;
}

interface MetaProfilesData {
    profiles: ActiveUserProfile[];
}

function stableStringList(values?: string[]): string {
    if (!values || values.length === 0) return "";
    return [...values].map((value) => String(value)).sort((left, right) => left.localeCompare(right)).join("|");
}

function getAssociatedMemorySignature(memory: AssociatedMemory): string {
    if (memory.type === "core_fact") {
        return [
            memory.type,
            memory.factId,
            memory.subject,
            memory.category,
            memory.content,
            memory.confidence,
        ].join("::");
    }

    return [
        memory.type,
        memory.topicId,
        memory.label,
        memory.summary,
        memory.startedAt,
        memory.endedAt ?? "",
    ].join("::");
}

function getTopicDigestSignature(digest: TopicDigest): string {
    const associatedMemories = META_ASSOCIATED_MEMORIES_ENABLED && digest.associatedMemories?.length
        ? [...digest.associatedMemories]
            .map(getAssociatedMemorySignature)
            .sort((left, right) => left.localeCompare(right))
            .join("|")
        : "";

    return [
        digest.topicId,
        digest.label,
        digest.summary,
        digest.state,
        digest.messageCount,
        digest.lastActivityAt,
        digest.triageReason ?? "",
        digest.callbackPotential ?? "",
        stableStringList(digest.participants),
        stableStringList(digest.keywords),
        associatedMemories,
    ].join("::");
}

function getProfileSignature(profile: ActiveUserProfile): string {
    return [
        profile.userId,
        profile.displayName,
        profile.messageCount,
        profile.dunbarTier ?? "",
        profile.rapport ?? "",
        profile.mention ?? "",
        profile.username ?? "",
        profile.communicationStyle ?? "",
        profile.relationToAgent ?? "",
        stableStringList(profile.aliases),
        stableStringList(profile.traits),
    ].join("::");
}

function formatAssociatedMemories(memories?: AssociatedMemory[]): string[] {
    if (!META_ASSOCIATED_MEMORIES_ENABLED || !memories?.length) {
        return [];
    }

    const lines = ["  关联记忆:"];
    for (const memory of memories.slice(0, 3)) {
        if (memory.type === "core_fact") {
            lines.push(`    - [${memory.subject} · ${memory.category}] ${memory.content}`);
        } else {
            lines.push(`    - [历史话题] ${memory.label} — ${memory.summary}`);
        }
    }
    return lines;
}

function formatProfileLine(profile: ActiveUserProfile): string {
    const tier = profile.dunbarTier ? getDunbarTierLabel(profile.dunbarTier) : "未知层级";
    const aliases = profile.aliases?.length ? ` [别名: ${profile.aliases.join(", ")}]` : "";
    const mention = profile.mention ? ` (提及方式: ${profile.mention})` : "";
    const rapport = typeof profile.rapport === "number" ? `, 好感${profile.rapport}` : "";
    const relation = profile.relationToAgent ? `, 关系: ${profile.relationToAgent}` : "";
    const traits = profile.traits?.length ? ` | 特征: ${profile.traits.join(", ")}` : "";
    const style = profile.communicationStyle ? ` | 风格: ${profile.communicationStyle}` : "";
    return `- ${profile.displayName}${mention}${aliases} (${tier}${rapport}${relation})${traits}${style}`;
}

function toRawMessage(message: AttentionRecentMessage): RawMessage {
    return {
        id: message.messageId,
        sender: message.displayName?.trim() || message.userId || "unknown",
        text: message.text,
        timestamp: message.timestamp,
    };
}

export const metaHistoricalProvider: SectionProvider<MetaHistoricalData> = {
    schema: {
        name: "meta.session_digests",
        label: "Meta 历史 Session Digests",
        source: "globalState.sessionDigests",
        cache: "delta",
        history: "delta-only",
    },
    resolve(ctx) {
        const sessionDigests = (ctx.sessionDigests as MetaHistoricalData["sessionDigests"] | undefined) ?? [];
        if (sessionDigests.length === 0) {
            return null;
        }
        const limit = typeof ctx.sessionDigestLimit === "number"
            ? Math.min(Math.max(Math.floor(ctx.sessionDigestLimit), 1), 30)
            : 10;
        return { sessionDigests: sessionDigests.slice(-limit) };
    },
    diff(current, committed): DiffResult<MetaHistoricalData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.sessionDigests.length, added: current.sessionDigests.length, unchanged: 0 },
            };
        }

        const committedSet = new Set(
            committed.sessionDigests.map((item) => `${item.createdAt}::${item.content}`)
        );
        const deltaDigests = current.sessionDigests.filter(
            (item) => !committedSet.has(`${item.createdAt}::${item.content}`)
        );

        return {
            full: current,
            delta: { sessionDigests: deltaDigests },
            stats: {
                total: current.sessionDigests.length,
                added: deltaDigests.length,
                unchanged: current.sessionDigests.length - deltaDigests.length,
            },
        };
    },
    render(data) {
        return [
            "# 历史 Session Digests",
            ...data.sessionDigests.map((item) => `- [${item.createdAt}] ${item.content}`),
        ].join("\n");
    },
    renderDelta(delta) {
        if (delta.sessionDigests.length === 0) {
            return "";
        }

        return [
            "# 历史 Session Digests",
            `(增量: ${delta.sessionDigests.length} 条)`,
            ...delta.sessionDigests.map((item) => `- [${item.createdAt}] ${item.content}`),
        ].join("\n");
    },
};

export const metaTodosProvider: SectionProvider<MetaTodosData> = {
    schema: {
        name: "meta.todos",
        label: "Meta Todo",
        source: "memory.todo",
        cache: "snapshot",
        history: "persistent",
    },
    resolve(ctx) {
        const todos = (ctx.todos as MetaTodosData["todos"] | undefined) ?? [];
        if (todos.length === 0) {
            return null;
        }
        return { todos };
    },
    render(data) {
        return [
            "# 当前 Todo",
            ...data.todos.map((item) =>
                `- [${item.bindingId}] ${item.key}: ${item.content}${item.dueAt ? ` (dueAt=${item.dueAt})` : ""}${item.expired ? " (expired)" : ""}`
            ),
        ].join("\n");
    },
};

export const metaCallbacksProvider: SectionProvider<MetaCallbacksData> = {
    schema: {
        name: "meta.callbacks",
        label: "Meta Callbacks",
        source: "callbackQueue",
        cache: "snapshot",
        history: "ephemeral",
    },
    resolve(ctx) {
        const callbacks = (ctx.callbacks as SubagentCallback[] | undefined) ?? [];
        if (callbacks.length === 0) {
            return null;
        }
        return { callbacks };
    },
    render(data) {
        return [
            "# 新到达的 Subagent Callbacks",
            ...data.callbacks.map((cb) => [
                `- ${cb.chatId}: status=${cb.status}, taskId=${cb.taskId}`,
                cb.contentDirection ? `  contentDirection=${cb.contentDirection}` : "",
                cb.sessionSummary ? `  SESSION_DIGEST=${cb.sessionSummary}` : "",
                `  summary=${cb.summary}`,
            ].filter(Boolean).join("\n")),
        ].join("\n");
    },
};

export const metaAttendHeaderProvider: SectionProvider<MetaAttendHeaderData> = {
    schema: {
        name: "meta.attend_header",
        label: "Meta 聊天头部",
        source: "attention.entry",
        cache: "volatile",
        history: "persistent",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const chatId = ctx.chatId as string | undefined;
        if (!chatId) {
            return null;
        }
        const chatTitle = (ctx.chatTitle as string | undefined) ?? chatId;
        const explicitType = ctx.chatType as string | undefined;
        const chatType = explicitType ?? deriveChatType(ctx.isDirectMessage as boolean | undefined);
        return {
            chatId,
            chatTitle,
            chatType,
        };
    },
    render(data) {
        return `# 注意力切换: ${data.chatTitle} (${getRawId(data.chatId)}) [${data.chatType}]`;
    },
};

export const metaAttendMetaProvider: SectionProvider<MetaAttendMetaData> = {
    schema: {
        name: "meta.attend_meta",
        label: "Meta 决策元数据",
        source: "attention.entry",
        cache: "volatile",
        history: "ephemeral",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const source = ctx.source as string | undefined;
        if (!source) {
            return null;
        }
        return {
            source,
            priority: Number(ctx.priority ?? 0),
            newMessageCount: Number(ctx.newMessageCount ?? 0),
            engagementScore: Number(ctx.engagementScore ?? 0),
            stickinessLevel: String(ctx.stickinessLevel ?? "STRANGER"),
            directAddressReason: typeof ctx.directAddressReason === "string" ? ctx.directAddressReason : undefined,
            callbackPotential: typeof ctx.callbackPotential === "number" ? ctx.callbackPotential : undefined,
            urgentSignals: Array.isArray(ctx.urgentSignals) ? ctx.urgentSignals.map((item) => String(item)) : undefined,
            schedulerTriggers: Array.isArray(ctx.schedulerTriggers)
                ? ctx.schedulerTriggers as MetaAttendMetaData["schedulerTriggers"]
                : undefined,
        };
    },
    render(data) {
        const lines = [
            "## 当前注意力元数据",
            `- source: ${data.source}`,
            `- priority: ${data.priority}`,
            `- newMessageCount: ${data.newMessageCount}`,
            `- engagementScore: ${data.engagementScore}`,
            `- stickinessLevel: ${data.stickinessLevel}`,
        ];
        if (data.directAddressReason) {
            lines.push(`- directAddressReason: ${data.directAddressReason}`);
        }
        if (typeof data.callbackPotential === "number") {
            lines.push(`- callbackPotential: ${data.callbackPotential}`);
        }
        if (data.urgentSignals?.length) {
            lines.push(`- urgentSignals: ${data.urgentSignals.join(", ")}`);
        }
        if (data.schedulerTriggers?.length) {
            lines.push("- schedulerTriggers:");
            for (const trigger of data.schedulerTriggers) {
                const binding = trigger.bindingId ? ` bindingId=${trigger.bindingId}` : "";
                lines.push(`  - ${trigger.type}:${trigger.id}${binding} ${trigger.callback ?? trigger.description}`);
                if (trigger.data !== undefined) {
                    lines.push(`    data=${JSON.stringify(trigger.data)}`);
                }
            }
        }
        return lines.join("\n");
    },
};

export const metaTopicDigestsProvider: SectionProvider<MetaTopicDigestData> = {
    schema: {
        name: "meta.topic_digests",
        label: "Meta 话题注册表",
        source: "attention.entry.topicDigests",
        cache: "delta",
        history: "delta-only",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const digests = (ctx.topicDigests as TopicDigest[] | undefined) ?? [];
        if (digests.length === 0) {
            return null;
        }
        return { digests: digests.slice(0, 10) };
    },
    diff(current, committed): DiffResult<MetaTopicDigestData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.digests.length, added: current.digests.length, unchanged: 0 },
            };
        }

        const committedMap = new Map(
            committed.digests.map((digest) => [digest.topicId, getTopicDigestSignature(digest)])
        );
        const deltaDigests = current.digests.filter(
            (digest) => committedMap.get(digest.topicId) !== getTopicDigestSignature(digest)
        );

        return {
            full: current,
            delta: { digests: deltaDigests },
            stats: {
                total: current.digests.length,
                added: deltaDigests.length,
                unchanged: current.digests.length - deltaDigests.length,
            },
        };
    },
    render(data) {
        if (data.digests.length === 0) {
            return "## 话题注册表\n(无活跃话题)";
        }

        const lines = data.digests.map((digest) => {
            const topic: FormattableTopic = {
                id: digest.topicId,
                state: digest.state,
                label: digest.label,
                summary: digest.summary,
                participants: digest.participants,
                messageCount: digest.messageCount,
                createdAt: digest.lastActivityAt,
                triageReason: digest.triageReason,
            };
            const header = formatTopicList([topic], "");
            const extras: string[] = [];
            if ((digest.callbackPotential ?? 0) > 0) {
                extras.push(`  callbackPotential: ${digest.callbackPotential}`);
            }
            extras.push(...formatAssociatedMemories(digest.associatedMemories));
            return [header, ...extras].filter(Boolean).join("\n");
        });

        return `## 话题注册表\n${lines.join("\n")}`;
    },
    renderDelta(delta) {
        if (delta.digests.length === 0) {
            return "";
        }
        return `## 话题注册表增量\n(增量: ${delta.digests.length} 个话题更新)\n${this.render(delta)}`;
    },
};

export const metaMessagesProvider: SectionProvider<MetaMessagesData> = {
    schema: {
        name: "meta.messages",
        label: "Meta 聊天消息",
        source: "attention.entry.recentMessages",
        cache: "delta",
        history: "delta-only",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const messages = (ctx.recentMessages as AttentionRecentMessage[] | undefined) ?? [];
        if (messages.length === 0) {
            return null;
        }
        return {
            messages: messages.slice(-30),
            newMessageCount: Number(ctx.newMessageCount ?? messages.length),
            fallbackToRecent: ctx.fallbackToRecentMessages === true,
        };
    },
    diff(current, committed): DiffResult<MetaMessagesData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.messages.length, added: current.messages.length, unchanged: 0 },
            };
        }

        const committedIds = new Set(committed.messages.map((message) => message.messageId));
        const deltaMessages = current.messages.filter((message) => !committedIds.has(message.messageId));
        const fallbackMessages = current.fallbackToRecent && deltaMessages.length === 0
            ? current.messages.slice(-20)
            : [];
        return {
            full: current,
            delta: {
                messages: fallbackMessages.length > 0 ? fallbackMessages : deltaMessages,
                newMessageCount: deltaMessages.length,
                fallbackToRecent: fallbackMessages.length > 0,
            },
            stats: {
                total: current.messages.length,
                added: fallbackMessages.length > 0 ? fallbackMessages.length : deltaMessages.length,
                unchanged: fallbackMessages.length > 0 ? 0 : current.messages.length - deltaMessages.length,
            },
        };
    },
    render(data) {
        const lines = data.messages.map((message) => formatMessageLine(toRawMessage(message)));
        return `## 新消息 (自上次关注以来, 共 ${data.newMessageCount} 条)\n${lines.join("\n")}`;
    },
    renderDelta(delta) {
        if (delta.messages.length === 0) {
            return "";
        }
        const lines = delta.messages.map((message) => formatMessageLine(toRawMessage(message)));
        if (delta.fallbackToRecent) {
            return `## 最近消息上下文\n(无新消息增量；attention 已触发，兜底附上最近 ${delta.messages.length} 条消息)\n${lines.join("\n")}`;
        }
        return `## 新消息增量\n(增量: ${delta.messages.length} 条新消息)\n${lines.join("\n")}`;
    },
};

export const metaGroupModelProvider: SectionProvider<MetaGroupModelData> = {
    schema: {
        name: "meta.group_model",
        label: "Meta 聊天画像",
        source: "memory.groupModel",
        cache: "static",
        history: "ephemeral",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const groupModel = ctx.groupModel as GroupModel | undefined;
        if (!groupModel) {
            return null;
        }
        return {
            chatTitle: groupModel.chatTitle,
            description: groupModel.description,
            agentRole: groupModel.agentRole,
            engagementLevel: groupModel.engagementLevel,
            hotTopics: groupModel.hotTopics ?? [],
            recentFeedback: groupModel.recentFeedback,
            tonePreset: typeof ctx.tonePreset === "string" ? ctx.tonePreset : "礼貌得体",
        };
    },
    render(data) {
        const lines = [
            "## 聊天画像",
            `- 标题: ${data.chatTitle}`,
            `- 描述: ${data.description || "(无)"}`,
            `- 当前 agent 角色: ${data.agentRole || "(未定义)"}`,
            `- 活跃度: ${data.engagementLevel || "(未知)"}`,
            `- 热点话题: ${data.hotTopics.length > 0 ? data.hotTopics.join(", ") : "无"}`,
            `- 语气预设: ${data.tonePreset}`,
        ];
        if (data.recentFeedback) {
            lines.push(`- 最近反馈: ${data.recentFeedback}`);
        }
        return lines.join("\n");
    },
    hash(data) {
        return [
            data.chatTitle,
            data.description,
            data.agentRole,
            data.engagementLevel,
            stableStringList(data.hotTopics),
            data.recentFeedback ?? "",
            data.tonePreset,
        ].join("::");
    },
};

export const metaProfilesProvider: SectionProvider<MetaProfilesData> = {
    schema: {
        name: "meta.profiles",
        label: "Meta 活跃参与者",
        source: "memory.profiles",
        cache: "delta",
        history: "delta-only",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const profiles = (ctx.activeUserProfiles as ActiveUserProfile[] | undefined) ?? [];
        if (profiles.length === 0) {
            return null;
        }
        return { profiles };
    },
    diff(current, committed): DiffResult<MetaProfilesData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.profiles.length, added: current.profiles.length, unchanged: 0 },
            };
        }

        const committedMap = new Map(
            committed.profiles.map((profile) => [profile.userId, getProfileSignature(profile)])
        );
        const deltaProfiles = current.profiles.filter(
            (profile) => committedMap.get(profile.userId) !== getProfileSignature(profile)
        );

        return {
            full: current,
            delta: { profiles: deltaProfiles },
            stats: {
                total: current.profiles.length,
                added: deltaProfiles.length,
                unchanged: current.profiles.length - deltaProfiles.length,
            },
        };
    },
    render(data) {
        return `## 活跃参与者\n${data.profiles.map(formatProfileLine).join("\n")}`;
    },
    renderDelta(delta) {
        if (delta.profiles.length === 0) {
            return "";
        }
        return `## 活跃参与者 (更新)\n${delta.profiles.map(formatProfileLine).join("\n")}`;
    },
};

export const metaDecisionPromptProvider: SectionProvider<string> = {
    schema: {
        name: "meta.decision_prompt",
        label: "Meta 决策指令",
        source: "static",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx) {
        const instruction = ctx.currentTurnInstruction;
        if (typeof instruction !== "string" || instruction.trim().length === 0) {
            return null;
        }
        return instruction.trim();
    },
    render(data) {
        return data;
    },
};

export function getMetaProviders(): SectionProvider[] {
    return [
        metaHistoricalProvider,
        metaTodosProvider,
        metaCallbacksProvider,
        metaAttendHeaderProvider,
        metaAttendMetaProvider,
        metaTopicDigestsProvider,
        metaMessagesProvider,
        metaGroupModelProvider,
        metaProfilesProvider,
        metaDecisionPromptProvider,
    ];
}
