/**
 * context-engine/providers/attend-providers.ts — Main Agent Attend 层 Section Providers
 *
 * 每个 provider 对应 attend prompt 中的一个 section。
 * 数据以结构化方式存在（source of truth），渲染只在 render() 中发生一次。
 * delta 类型的 provider 自己实现 diff()，因为只有它知道自己的数据结构。
 */

import type { SectionProvider, DiffResult, ResolveContext } from "../types.js";
import type { TopicDigest, SubagentCallback, ActiveUserProfile } from "../../subagent/types.js";
import type { GroupModel, AssociatedMemory } from "../../memory-v2/types.js";
import type { RawMessage } from "../../core/message-enricher.js";
import { formatMessageLine } from "../../core/message-enricher.js";
import { getRawId, getDunbarTierLabel } from "../../core/chat-id.js";
import { formatTopicList, formatRelativeTime, type FormattableTopic } from "../prompt-renderer-utils.js";

function scopeByChatId(ctx: ResolveContext): string | undefined {
    return typeof ctx.chatId === "string" && ctx.chatId.length > 0 ? ctx.chatId : undefined;
}

// ═══ 类型定义：各 section 的结构化数据 ═══

export interface AttendHeaderData {
    chatTitle: string;
    chatId: string;
    chatType: string;
}

export interface AttendMetaData {
    stickinessLevel: string;
    snapshotTimestamp: string;
    lastAttendedAt: string;
    timeSinceLastAttend: string;
    depth: number;
    priorityMultiplier: number;
    recentFeedback?: string;
}

export interface GlobalStateData {
    sessionDigests: string;
    activeMemos: string;
}

export interface TopicDigestData {
    digests: TopicDigest[];
}

export interface MessagesData {
    messages: RawMessage[];
    newMessageCount: number;
}

export interface CallbacksData {
    callbacks: SubagentCallback[];
}

export interface GroupModelData {
    chatTitle: string;
    description: string;
    avgMessagesPerDay: number;
    engagementLevel: string;
    tonePreset: string;
}

export interface ProfilesData {
    profiles: ActiveUserProfile[];
}

export interface SchedulerTriggersData {
    triggers: Array<{ type: string; description: string }>;
}

export interface DispatchGuardData {
    dispatchedTopicIds: string[];
}

function stableStringList(values?: string[]): string {
    if (!values || values.length === 0) return "";
    return [...values].sort((left, right) => left.localeCompare(right)).join("|");
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
    const associatedMemories = digest.associatedMemories?.length
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

// ═══ Provider 实现 ═══

/** Attend 头部：chatTitle + chatId */
export const attendHeaderProvider: SectionProvider<AttendHeaderData> = {
    schema: {
        name: "attend_header",
        label: "Attend 头部",
        source: "attend.entry",
        cache: "volatile",
        history: "persistent",
    },
    resolve(ctx) {
        const chatTitle = ctx.chatTitle as string | undefined;
        const chatId = ctx.chatId as string | undefined;
        const chatType = ctx.chatType as string | undefined;
        if (!chatId) return null;
        return { chatTitle: chatTitle ?? chatId, chatId: getRawId(chatId), chatType: chatType ?? "群聊" };
    },
    render(data) {
        return `═══ 注意力切换: ${data.chatTitle} (${data.chatId}) [${data.chatType}] ═══`;
    },
};

/** 全局状态：sessionDigests + activeMemos */
export const globalStateProvider: SectionProvider<GlobalStateData> = {
    schema: {
        name: "global_state",
        label: "全局状态",
        source: "globalState",
        cache: "snapshot",
        history: "ephemeral",
    },
    resolve(ctx) {
        return {
            sessionDigests: (ctx.sessionDigests as string) ?? "（无）",
            activeMemos: (ctx.activeMemos as string) ?? "（无活跃备忘录）",
        };
    },
    render(data) {
        return `## 最近会话摘要\n${data.sessionDigests}\n\n## 当前备忘录\n${data.activeMemos}`;
    },
};

/** 本次决策上下文：stickiness, timing, depth */
export const attendMetaProvider: SectionProvider<AttendMetaData> = {
    schema: {
        name: "attend_meta",
        label: "决策元数据",
        source: "attend.entry",
        cache: "volatile",
        history: "persistent",
    },
    resolve(ctx) {
        return {
            stickinessLevel: (ctx.stickinessLevel as string) ?? "STRANGER",
            snapshotTimestamp: (ctx.snapshotTimestamp as string) ?? new Date().toISOString(),
            lastAttendedAt: (ctx.lastAttendedAt as string) ?? "无记录",
            timeSinceLastAttend: (ctx.timeSinceLastAttend as string) ?? "未知",
            depth: (ctx.depth as number) ?? 0,
            priorityMultiplier: (ctx.priorityMultiplier as number) ?? 0.2,
            recentFeedback: (ctx.recentFeedback as string) ?? undefined,
        };
    },
    render(data) {
        let text = `## 本次决策上下文\n当前粘性级别: ${data.stickinessLevel}\n当前时间: ${data.snapshotTimestamp}\n上次关注: ${data.lastAttendedAt} (${data.timeSinceLastAttend} 前)\n上下文深度: L${data.depth}\n优先级乘数: ${data.priorityMultiplier}`;
        if (data.recentFeedback) {
            text += `\n最近观察：${data.recentFeedback}`;
        }
        return text;
    },
};

/** 话题注册表：delta 追踪，按 topicId + 内容变化增量发送 */
export const topicDigestsProvider: SectionProvider<TopicDigestData> = {
    schema: {
        name: "topic_digests",
        label: "话题注册表",
        source: "pipeline.topicDigests",
        cache: "delta",
        history: "delta-only",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const digests = ctx.topicDigests as TopicDigest[] | undefined;
        return { digests: digests ?? [] };
    },
    diff(current, committed) {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.digests.length, added: current.digests.length, unchanged: 0 },
            };
        }

        const committedMap = new Map(
            committed.digests.map(digest => [digest.topicId, getTopicDigestSignature(digest)])
        );
        const deltaDigests = current.digests.filter(
            digest => committedMap.get(digest.topicId) !== getTopicDigestSignature(digest)
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
        if (data.digests.length === 0) return "## 话题注册表\n(无活跃话题)";

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
            if (digest.associatedMemories?.length) {
                extras.push("  关联记忆:");
                for (const memory of digest.associatedMemories.slice(0, 3)) {
                    if (memory.type === "core_fact") {
                        extras.push(`    - [${memory.subject} · ${memory.category}] ${memory.content}`);
                    } else {
                        extras.push(`    - [历史话题] ${memory.label} — ${memory.summary}`);
                    }
                }
            }
            return [header, ...extras].filter(Boolean).join("\n");
        });

        return `## 话题注册表\n${lines.join("\n")}`;
    },
    renderDelta(delta) {
        if (delta.digests.length === 0) return "(无话题更新)";
        const fullText = this.render(delta);
        return `═══ 话题注册表增量 ═══\n(增量: ${delta.digests.length} 个话题更新)\n${fullText}`;
    },
};

/** 聊天消息：delta 追踪，按 message ID diff */
export const messagesProvider: SectionProvider<MessagesData> = {
    schema: {
        name: "messages",
        label: "聊天消息",
        source: "memory.recentMessages",
        cache: "delta",
        history: "delta-only",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const messages = ctx.rawMessages as RawMessage[] | undefined;
        const count = ctx.newMessageCount as number | undefined;
        if (!messages || messages.length === 0) return null;
        return { messages, newMessageCount: count ?? messages.length };
    },
    diff(current, committed): DiffResult<MessagesData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.messages.length, added: current.messages.length, unchanged: 0 },
            };
        }
        const committedIds = new Set(committed.messages.map(m => m.id));
        const deltaMessages = current.messages.filter(m => !committedIds.has(m.id));
        return {
            full: current,
            delta: { messages: deltaMessages, newMessageCount: deltaMessages.length },
            stats: {
                total: current.messages.length,
                added: deltaMessages.length,
                unchanged: current.messages.length - deltaMessages.length,
            },
        };
    },
    render(data) {
        const lines = data.messages.map(m => formatMessageLine(m, { includeMediaTags: true }));
        return `## 新消息 (共 ${data.newMessageCount} 条)\n${lines.join("\n")}`;
    },
    renderDelta(delta) {
        if (delta.messages.length === 0) return "(无新消息)";
        const lines = delta.messages.map(m => formatMessageLine(m, { includeMediaTags: true }));
        return `═══ Attend 消息增量 ═══\n(增量: ${delta.messages.length} 条新消息)\n${lines.join("\n")}`;
    },
};

/** Subagent 执行结果：snapshot, ephemeral */
export const callbacksProvider: SectionProvider<CallbacksData> = {
    schema: {
        name: "callbacks",
        label: "执行结果",
        source: "subagent.lastCallbacks",
        cache: "snapshot",
        history: "ephemeral",
    },
    resolve(ctx) {
        const cbs = ctx.callbacks as SubagentCallback[] | undefined;
        if (!cbs || cbs.length === 0) return null;
        return { callbacks: cbs };
    },
    render(data) {
        const lines = data.callbacks.map(cb => `- [${cb.status}] ${cb.summary}`);
        return `## 上次 Subagent 执行结果\n${lines.join("\n")}`;
    },
};

/** 聊天画像：当前轮可见，但不写入历史以避免重复堆叠 */
export const groupModelProvider: SectionProvider<GroupModelData> = {
    schema: {
        name: "group_model",
        label: "聊天画像",
        source: "memory.groupModel",
        cache: "static",
        history: "ephemeral",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const gm = ctx.groupModel as GroupModel | undefined;
        if (!gm) return null;
        return {
            chatTitle: gm.chatTitle ?? "",
            description: gm.description ?? "",
            avgMessagesPerDay: gm.avgMessagesPerDay ?? 0,
            engagementLevel: gm.engagementLevel ?? "",
            tonePreset: (ctx.tonePreset as string) ?? "礼貌得体",
        };
    },
    render(data) {
        return `## 聊天画像\n- 标题: ${data.chatTitle}\n- 描述: ${data.description}\n- 日均消息: ${data.avgMessagesPerDay}\n- 参与度: ${data.engagementLevel}\n- 语气预设: ${data.tonePreset}`;
    },
    hash(data) {
        return `${data.chatTitle}|${data.description}|${data.avgMessagesPerDay}|${data.engagementLevel}|${data.tonePreset}`;
    },
};

/** 活跃参与者画像：delta 追踪，按 userId diff */
export const profilesProvider: SectionProvider<ProfilesData> = {
    schema: {
        name: "active_persons",
        label: "活跃参与者",
        source: "memory.profiles",
        cache: "delta",
        history: "delta-only",
    },
    scopeKey(ctx) {
        return scopeByChatId(ctx);
    },
    resolve(ctx) {
        const profiles = ctx.activeUserProfiles as ActiveUserProfile[] | undefined;
        if (!profiles || profiles.length === 0) return null;
        return { profiles };
    },
    diff(current, committed): DiffResult<ProfilesData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.profiles.length, added: current.profiles.length, unchanged: 0 },
            };
        }
        // 按 userId 做稳定签名比较，忽略对象字段构造顺序和别名/特征数组顺序。
        const committedMap = new Map(
            committed.profiles.map(p => [p.userId, getProfileSignature(p)])
        );
        const deltaProfiles = current.profiles.filter(
            p => committedMap.get(p.userId) !== getProfileSignature(p)
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
        const lines = data.profiles.map(formatProfileLine);
        return `## 活跃参与者\n${lines.join("\n")}`;
    },
    renderDelta(delta) {
        if (delta.profiles.length === 0) return "";
        const lines = delta.profiles.map(formatProfileLine);
        return `## 活跃参与者 (更新)\n${lines.join("\n")}`;
    },
};

/** 定时任务触发：volatile, persistent */
export const schedulerTriggersProvider: SectionProvider<SchedulerTriggersData> = {
    schema: {
        name: "scheduler_triggers",
        label: "定时触发",
        source: "globalState.scheduler",
        cache: "volatile",
        history: "persistent",
    },
    resolve(ctx) {
        const triggers = ctx.schedulerTriggers as Array<{ type: string; description: string }> | undefined;
        if (!triggers || triggers.length === 0) return null;
        return { triggers };
    },
    render(data) {
        const lines = data.triggers.map(t => `- [${t.type}] ${t.description}`);
        return `## ⏰ 定时任务触发\n以下定时任务已到期，请立即为每个任务生成 REPLY 决策，将任务描述作为 contentDirection 传递给执行器：\n${lines.join("\n")}`;
    },
};

/** 分派防重：volatile, ephemeral */
export const dispatchGuardProvider: SectionProvider<DispatchGuardData> = {
    schema: {
        name: "dispatch_guard",
        label: "分派防重",
        source: "subagent.dispatched",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx) {
        const ids = ctx.dispatchedTopicIds as string[] | undefined;
        if (!ids || ids.length === 0) return null;
        return { dispatchedTopicIds: ids };
    },
    render(data) {
        return `## ⚠️ 已分派回复任务的话题\n以下话题已有进行中或已完成的回复任务，请勿重复分派: ${data.dispatchedTopicIds.join(", ")}`;
    },
};

/** 决策指令（静态文本） */
export const decisionPromptProvider: SectionProvider<string> = {
    schema: {
        name: "decision_prompt",
        label: "决策指令",
        source: "static",
        cache: "static",
        history: "ephemeral",
    },
    resolve() {
        return "## 请决策\n基于以上信息，输出你的决策（JSON 格式的 AttendResult）。";
    },
    render(data) { return data; },
    hash(data) { return `${data.length}`; },
};

// ═══ 辅助渲染函数 ═══

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

/**
 * 获取所有 attend providers（按渲染顺序）。
 * 调用者直接 engine.registerAll(getAttendProviders()) 即可。
 */
export function getAttendProviders(): SectionProvider[] {
    return [
        attendHeaderProvider,
        globalStateProvider,
        attendMetaProvider,
        topicDigestsProvider,
        messagesProvider,
        callbacksProvider,
        groupModelProvider,
        profilesProvider,
        schedulerTriggersProvider,
        dispatchGuardProvider,
        decisionPromptProvider,
    ];
}
