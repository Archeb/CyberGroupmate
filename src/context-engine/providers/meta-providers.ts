import type { SectionProvider, DiffResult, ResolveContext } from "../types.js";
import type {
    ActiveUserProfile,
    AttentionRecentMessage,
    SubagentCallback,
    TopicDigest,
} from "../../subagent/types.js";
import type { AssociatedMemory, GroupModel } from "../../memory-v2/types.js";
import { deriveChatType, formatTopicList, type FormattableTopic } from "../prompt-renderer-utils.js";
import { formatMessageLine, type RawMessage, type StickerDescriptionLookup } from "../../core/message-enricher.js";
import { getRawId } from "../../core/chat-id.js";
import type { VisionConfig } from "../../core/config.js";
import { formatTsForPrompt, getWeekdayLabel } from "../../core/timezone.js";
import { sanitizeTriageReason } from "../../core/triage-sanitize.js";

const META_ASSOCIATED_MEMORIES_ENABLED = false;

function scopeByChatId(ctx: ResolveContext): string | undefined {
    return typeof ctx.chatId === "string" && ctx.chatId.length > 0 ? ctx.chatId : undefined;
}

interface MetaHistoricalData {
    sessionDigests: Array<{ createdAt: string; content: string }>;
}

interface MetaTodoItem {
    key: string;
    content: string;
    bindingId: string;
    dueAt?: string | null;
    expired?: boolean;
}

interface MetaTodosData {
    todos: MetaTodoItem[];
    removedTodos?: MetaTodoItem[];
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
    weekday: string;
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
    attendMediaMode?: VisionConfig["attendMode"];
    stickerDescriptions?: Record<string, { description: string; emoji?: string; emojis?: string[] }>;
}

interface MetaGroupModelModule {
    key: string;
    label: string;
    value: string | number | string[];
}

interface MetaGroupModelData {
    modules: MetaGroupModelModule[];
}

interface MetaProfilesData {
    profiles: ActiveUserProfile[];
}

function stableStringList(values?: string[]): string {
    if (!values || values.length === 0) return "";
    return [...values].map((value) => String(value)).sort((left, right) => left.localeCompare(right)).join("|");
}

function getTodoIdentity(todo: MetaTodoItem): string {
    return `${todo.bindingId}::${todo.key}`;
}

function getTodoSignature(todo: MetaTodoItem): string {
    return [
        getTodoIdentity(todo),
        todo.content,
        todo.dueAt ?? "",
        todo.expired ? "expired" : "active",
    ].join("::");
}

function getAssociatedMemorySignature(memory: AssociatedMemory): string {
    if (memory.type === "core_fact") {
        return "";
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
            .filter(Boolean)
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
        profile.userLabel ?? "",
        profile.messageCount,
        profile.dunbarTier ?? "",
        profile.rapport ?? "",
        profile.mention ?? "",
        profile.username ?? "",
        profile.communicationStyle ?? "",
        profile.relationToAgent ?? "",
        stableStringList(profile.relationshipMemory),
        stableStringList(profile.agentPolicyHints),
        stableStringList(profile.stablePatterns),
        stableStringList(profile.followupCandidates),
        profile.globalRelationToAgent ?? "",
        profile.currentRelationToAgent ?? "",
        profile.currentChatLabel ?? "",
        stableStringList(profile.aliases),
        stableStringList(profile.traits),
    ].join("::");
}

function getGroupModelModuleSignature(module: MetaGroupModelModule): string {
    const value = Array.isArray(module.value)
        ? stableStringList(module.value)
        : String(module.value ?? "");
    return [module.key, module.label, value].join("::");
}

function formatTodoLine(item: MetaTodoItem): string {
    return `- [${item.bindingId}] ${item.key}: ${item.content}${item.dueAt ? ` (dueAt=${formatTsForPrompt(item.dueAt)})` : ""}${item.expired ? " (expired)" : ""}`;
}

function formatRemovedTodoLine(item: MetaTodoItem): string {
    const previous = item.content ? ` (原: ${item.content})` : "";
    return `- [${item.bindingId}] ${item.key}: 已移除${previous}`;
}

function formatGroupModelValue(module: MetaGroupModelModule): string {
    if (Array.isArray(module.value)) {
        return module.value.length > 0 ? module.value.join(", ") : "无";
    }
    if (typeof module.value === "number") {
        return Number.isFinite(module.value) ? String(module.value) : "(未知)";
    }
    return String(module.value ?? "").trim() || "(无)";
}

function formatGroupModelModuleLine(module: MetaGroupModelModule): string {
    return `- ${module.label}: ${formatGroupModelValue(module)}`;
}

function formatAssociatedMemories(memories?: AssociatedMemory[]): string[] {
    if (!META_ASSOCIATED_MEMORIES_ENABLED || !memories?.length) {
        return [];
    }

    const renderedMemories = memories.filter(memory => memory.type !== "core_fact");
    if (renderedMemories.length === 0) {
        return [];
    }

    const lines = ["  关联记忆:"];
    for (const memory of renderedMemories.slice(0, 3)) {
        lines.push(`    - [历史话题] ${memory.label} — ${memory.summary}`);
    }
    return lines;
}

function formatProfileLine(profile: ActiveUserProfile): string {
    const aliases = profile.aliases?.length ? ` [别名: ${profile.aliases.join(", ")}]` : "";
    const mention = profile.mention ? ` (提及方式: ${profile.mention})` : "";
    const relation = profile.globalRelationToAgent ?? (
        profile.relationToAgent?.startsWith("全局: ")
            ? profile.relationToAgent.split("；")[0]?.replace(/^全局:\s*/, "")
            : undefined
    );
    return `- ${profile.userLabel ?? profile.displayName}${mention}${aliases}${relation ? ` | 总体关系: ${relation}` : ""}`;
}

function toRawMessage(message: AttentionRecentMessage, messagesById?: Map<string, AttentionRecentMessage>): RawMessage {
    const replyToMsgId = message.replyToMsgId ?? message.replyToMessageId;
    const replyTarget = replyToMsgId ? messagesById?.get(replyToMsgId) : undefined;
    return {
        id: message.messageId,
        sender: message.displayName?.trim() || message.userId || "unknown",
        text: message.text,
        timestamp: message.timestamp,
        replyTo: message.replyTo ?? (replyToMsgId
            ? (replyTarget?.displayName?.trim() || replyTarget?.userId || `msg#${replyToMsgId}`)
            : undefined),
        replyToMsgId,
        replyToText: message.replyToText,
        mediaType: message.mediaType,
        mediaInfo: message.mediaInfo,
    };
}

function formatMetaMessages(data: MetaMessagesData): string[] {
    const messagesById = new Map(data.messages.map((message) => [message.messageId, message]));
    const stickerDescriptionLookup: StickerDescriptionLookup | undefined = data.attendMediaMode === "enrich"
        ? {
            getStickerDescription(uniqueFileId) {
                return data.stickerDescriptions?.[uniqueFileId] ?? null;
            },
        }
        : undefined;

    return data.messages.map((message) =>
        formatMessageLine(toRawMessage(message, messagesById), {
            includeMediaTags: true,
            stickerDescriptionLookup,
        })
    );
}

function collectStickerDescriptions(
    messages: AttentionRecentMessage[],
    lookup?: StickerDescriptionLookup,
): MetaMessagesData["stickerDescriptions"] | undefined {
    if (!lookup) return undefined;
    const descriptions: NonNullable<MetaMessagesData["stickerDescriptions"]> = {};
    for (const message of messages) {
        if (message.mediaType !== "sticker" || !message.mediaInfo) continue;
        try {
            const info = JSON.parse(message.mediaInfo) as { uniqueFileId?: string; fileId?: string };
            const uniqueFileId = info.uniqueFileId ?? info.fileId;
            if (!uniqueFileId || descriptions[uniqueFileId]) continue;
            const cached = lookup.getStickerDescription(uniqueFileId);
            if (cached) {
                descriptions[uniqueFileId] = cached;
            }
        } catch {
            /* ignore malformed mediaInfo */
        }
    }

    return Object.keys(descriptions).length > 0 ? descriptions : undefined;
}

function getMessageSignature(message: AttentionRecentMessage, data: MetaMessagesData): string {
    let cachedStickerDescription = "";
    if (data.attendMediaMode === "enrich" && message.mediaType === "sticker" && message.mediaInfo) {
        try {
            const info = JSON.parse(message.mediaInfo) as { uniqueFileId?: string; fileId?: string };
            const uniqueFileId = info.uniqueFileId ?? info.fileId;
            const cached = uniqueFileId ? data.stickerDescriptions?.[uniqueFileId] : undefined;
            cachedStickerDescription = cached
                ? [cached.description, stableStringList(cached.emojis ?? (cached.emoji ? [cached.emoji] : []))].join("::")
                : "";
        } catch {
            cachedStickerDescription = "";
        }
    }

    return [
        message.messageId,
        message.userId,
        message.displayName,
        message.text,
        message.timestamp,
        message.replyToMessageId ?? message.replyToMsgId ?? "",
        message.replyTo ?? "",
        message.replyToText ?? "",
        message.mediaType ?? "",
        message.mediaInfo ?? "",
        data.attendMediaMode ?? "",
        cachedStickerDescription,
    ].join("::");
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
            ...data.sessionDigests.map((item) => `- [${formatTsForPrompt(item.createdAt)}] ${item.content}`),
        ].join("\n");
    },
    renderDelta(delta) {
        if (delta.sessionDigests.length === 0) {
            return "";
        }

        return [
            "# 历史 Session Digests",
            `(增量: ${delta.sessionDigests.length} 条)`,
            ...delta.sessionDigests.map((item) => `- [${formatTsForPrompt(item.createdAt)}] ${item.content}`),
        ].join("\n");
    },
};

export const metaTodosProvider: SectionProvider<MetaTodosData> = {
    schema: {
        name: "meta.todos",
        label: "Meta Todo",
        source: "memory.todo",
        cache: "delta",
        history: "delta-only",
    },
    resolve(ctx) {
        if (!Object.prototype.hasOwnProperty.call(ctx, "todos")) {
            return null;
        }
        const todos = Array.isArray(ctx.todos) ? ctx.todos as MetaTodosData["todos"] : [];
        return { todos };
    },
    diff(current, committed): DiffResult<MetaTodosData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.todos.length, added: current.todos.length, unchanged: 0 },
            };
        }

        const committedMap = new Map(
            committed.todos.map((todo) => [getTodoIdentity(todo), todo])
        );
        const committedSignatures = new Map(
            committed.todos.map((todo) => [getTodoIdentity(todo), getTodoSignature(todo)])
        );
        const currentIds = new Set(current.todos.map(getTodoIdentity));
        const deltaTodos = current.todos.filter(
            (todo) => committedSignatures.get(getTodoIdentity(todo)) !== getTodoSignature(todo)
        );
        const removedTodos = [...committedMap.entries()]
            .filter(([id]) => !currentIds.has(id))
            .map(([, todo]) => todo);
        const changedCount = deltaTodos.length + removedTodos.length;

        return {
            full: current,
            delta: { todos: deltaTodos, removedTodos },
            stats: {
                total: current.todos.length,
                added: changedCount,
                unchanged: Math.max(0, current.todos.length - deltaTodos.length),
            },
        };
    },
    render(data) {
        return [
            "# 当前 Todo",
            ...(data.todos.length > 0 ? data.todos.map(formatTodoLine) : ["(无)"]),
        ].join("\n");
    },
    renderDelta(delta) {
        const changedTodos = delta.todos;
        const removedTodos = delta.removedTodos ?? [];
        if (changedTodos.length === 0 && removedTodos.length === 0) {
            return "";
        }

        return [
            "# 当前 Todo 增量",
            `(增量: ${changedTodos.length} 条新增/更新${removedTodos.length > 0 ? `, ${removedTodos.length} 条移除` : ""})`,
            ...changedTodos.map(formatTodoLine),
            ...removedTodos.map(formatRemovedTodoLine),
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
                cb.sentMessages?.length
                    ? `  sentMessages=${cb.sentMessages.map((msg) => `"${msg.text}"`).join(" / ")}`
                    : "",
                cb.postTaskMessages?.length
                    ? [
                        `  postTaskWindow=${cb.postTaskWindow?.durationMs ?? ""}ms, messages=${cb.postTaskMessages.length}, direct=${cb.postTaskWindow?.directMessageCount ?? 0}`,
                        ...cb.postTaskMessages.map((msg) =>
                            `    - [${formatTsForPrompt(msg.timestamp)}] ${msg.sender}${msg.isDirectAttention ? ` (${msg.directReason ?? "direct"})` : ""}: ${msg.text}${msg.replyToMessageId ? ` (replyTo=${msg.replyToMessageId})` : ""}`
                        ),
                    ].join("\n")
                    : "",
                cb.postTaskFollowUpCallbacks?.length
                    ? [
                        `  postTaskFollowUps=${cb.postTaskFollowUpCallbacks.length}`,
                        ...cb.postTaskFollowUpCallbacks.map((follow) => [
                            `    - taskId=${follow.taskId}, status=${follow.status}, durationMs=${follow.durationMs}`,
                            follow.sentMessages?.length
                                ? `      sentMessages=${follow.sentMessages.map((msg) => `"${msg.text}"`).join(" / ")}`
                                : "",
                            follow.error ? `      error=${follow.error}` : "",
                            follow.summary ? `      thinkingTranscript=${follow.summary}` : "",
                        ].filter(Boolean).join("\n")),
                    ].join("\n")
                    : "",
                cb.error ? `  error=${cb.error}` : "",
                typeof cb.durationMs === "number" ? `  durationMs=${cb.durationMs}` : "",
                cb.summary ? `  thinkingTranscript=${cb.summary}` : "",
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
        return `# 注意力切换: ${data.chatTitle} (composite chatId: ${data.chatId}) [${data.chatType}]`;
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
            weekday: getWeekdayLabel(),
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
            ...(data.weekday ? [`- 今天: ${data.weekday}`] : []),
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
                // 兜底：Meta 看到的 triageReason 不含预写金句，杜绝照搬进 contentDirection
                triageReason: sanitizeTriageReason(digest.triageReason),
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
        const sliced = messages.slice(-30);
        const attendMediaMode = ctx.attendMediaMode as VisionConfig["attendMode"] | undefined;
        const stickerDescriptionLookup = ctx.stickerDescriptionLookup as StickerDescriptionLookup | undefined;
        return {
            messages: sliced,
            newMessageCount: Number(ctx.newMessageCount ?? messages.length),
            fallbackToRecent: ctx.fallbackToRecentMessages === true,
            attendMediaMode,
            stickerDescriptions: attendMediaMode === "enrich"
                ? collectStickerDescriptions(sliced, stickerDescriptionLookup)
                : undefined,
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

        const committedSignatures = new Map(
            committed.messages.map((message) => [message.messageId, getMessageSignature(message, committed)])
        );
        const deltaMessages = current.messages.filter(
            (message) => committedSignatures.get(message.messageId) !== getMessageSignature(message, current)
        );
        const fallbackMessages = current.fallbackToRecent && deltaMessages.length === 0
            ? current.messages.slice(-20)
            : [];
        return {
            full: current,
            delta: {
                messages: fallbackMessages.length > 0 ? fallbackMessages : deltaMessages,
                newMessageCount: deltaMessages.length,
                fallbackToRecent: fallbackMessages.length > 0,
                attendMediaMode: current.attendMediaMode,
                stickerDescriptions: current.stickerDescriptions,
            },
            stats: {
                total: current.messages.length,
                added: fallbackMessages.length > 0 ? fallbackMessages.length : deltaMessages.length,
                unchanged: fallbackMessages.length > 0 ? 0 : current.messages.length - deltaMessages.length,
            },
        };
    },
    render(data) {
        const lines = formatMetaMessages(data);
        return `## 新消息 (自上次关注以来, 共 ${data.newMessageCount} 条)\n${lines.join("\n")}`;
    },
    renderDelta(delta) {
        if (delta.messages.length === 0) {
            return "";
        }
        const lines = formatMetaMessages(delta);
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
        cache: "delta",
        history: "delta-only",
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
            modules: [
                { key: "description", label: "描述", value: groupModel.description },
                { key: "dominantLanguage", label: "主要语言", value: groupModel.dominantLanguage },
                { key: "communicationNorms", label: "交流规范", value: groupModel.communicationNorms ?? [] },
                { key: "activeMembers", label: "活跃成员数", value: groupModel.activeMembers },
                { key: "avgMessagesPerDay", label: "日均消息量", value: groupModel.avgMessagesPerDay },
                { key: "peakHours", label: "活跃高峰时段", value: (groupModel.peakHours ?? []).map((hour) => `${hour}:00`) },
                { key: "agentRole", label: "当前 agent 角色", value: groupModel.agentRole },
                { key: "engagementLevel", label: "活跃度", value: groupModel.engagementLevel },
                { key: "hotTopics", label: "热点话题", value: groupModel.hotTopics ?? [] },
                { key: "tabooTopics", label: "不宜讨论的话题", value: groupModel.tabooTopics ?? [] },
                { key: "recentFeedback", label: "最近反馈", value: groupModel.recentFeedback },
                { key: "tonePreset", label: "语气预设", value: typeof ctx.tonePreset === "string" ? ctx.tonePreset : "礼貌得体" },
            ],
        };
    },
    diff(current, committed): DiffResult<MetaGroupModelData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.modules.length, added: current.modules.length, unchanged: 0 },
            };
        }

        const committedMap = new Map(
            committed.modules.map((module) => [module.key, getGroupModelModuleSignature(module)])
        );
        const deltaModules = current.modules.filter(
            (module) => committedMap.get(module.key) !== getGroupModelModuleSignature(module)
        );

        return {
            full: current,
            delta: { modules: deltaModules },
            stats: {
                total: current.modules.length,
                added: deltaModules.length,
                unchanged: current.modules.length - deltaModules.length,
            },
        };
    },
    render(data) {
        const lines = [
            "## 聊天画像",
            ...data.modules.map(formatGroupModelModuleLine),
        ];
        return lines.join("\n");
    },
    renderDelta(delta) {
        if (delta.modules.length === 0) {
            return "";
        }
        return [
            "## 聊天画像增量",
            `(增量: ${delta.modules.length} 个模块更新)`,
            ...delta.modules.map(formatGroupModelModuleLine),
        ].join("\n");
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
        return [
            "## 活跃参与者",
            ...formatProfileUseGuidance(),
            ...data.profiles.map(formatProfileLine),
        ].join("\n");
    },
    renderDelta(delta) {
        if (delta.profiles.length === 0) {
            return "";
        }
        return [
            "## 活跃参与者 (更新)",
            ...formatProfileUseGuidance(),
            ...delta.profiles.map(formatProfileLine),
        ].join("\n");
    },
};

function formatProfileUseGuidance(): string[] {
    return [
        "使用原则:",
        "- 这里只显示当前 L0 直接叫住 agent 的人物身份和全局总体关系，用于判断优先级和是否需要派发。",
        "- 详细关系记忆会交给 Subagent；需要事实或跨群细节时主动调用 memory/conversations 搜索，不要凭这段身份摘要补全结论。",
    ];
}

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
