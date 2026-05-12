/**
 * context-engine/providers/executor-providers.ts — Executor 专用 SectionProvider
 *
 * 替代旧的 renderPrompt("EXECUTION_TASK", vars) + stripVerboseSections() 逻辑。
 *
 * Task prompt 由多个结构化 section 组成，每个 section 有独立的 history 策略：
 * - persistent：保留在 session 历史中（header/decisions）
 * - delta-only：只把新增/变化部分写入 session 历史（targetMessages/personContext）
 * - ephemeral：仅在当前 turn 出现，下次 render 不进入历史（topicSummary/memoryContext）
 *
 * 这样在 session 历史积累时，不需要 stripVerboseSections 这种 regex hack，
 * 引擎会按声明式策略自动处理。
 */

import type { SectionProvider, ResolveContext, DiffResult } from "../types.js";
import { deriveChatType } from "../prompt-renderer-utils.js";

// ─── ResolveContext 扩展（executor 专用字段） ───

export interface ExecutorResolveContext extends ResolveContext {
    chatId: string;
    isDirectMessage?: boolean;
    chatTitle?: string;
    taskId: string;
    decisions: Array<{
        action: string;
        contentDirection?: string;
        reason?: string;
        topicId?: string;
        confidence: number;
    }>;
    toneGuidance?: string;
    topicSummary?: string;
    personContext?: string;
    memoryContext?: string;
    targetMessages?: string;
    availableStickers?: Array<{ emoji?: string; emojis?: string[]; description: string; uniqueFileId: string }>;
    groundingContext?: string;
    sessionDigests?: Array<{ createdAt: string; content: string }>;
    sessionDigestLimit?: number;
    imageParts?: unknown[];
}

interface ExecutorPersonContextData {
    mode: "profiles" | "raw";
    profiles: Array<Record<string, unknown>>;
    rawText: string;
}

interface ExecutorTargetMessageEntry {
    key: string;
    signature: string;
    content: string;
}

interface ExecutorTargetMessagesData {
    entries: ExecutorTargetMessageEntry[];
}

const TARGET_MESSAGE_HEADER_RE = /^\[[^\]]*\] \[msgId:([^\]]+)\] /;
const TARGET_MESSAGE_SEPARATOR_RE = /^--- \(.+\) ---$/;
const TARGET_MESSAGE_AGE_MARKER_RE = /^--- \(距今 .+\) ---$/;

function normalizeJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        if (value.every(item => typeof item === "string")) {
            return [...value].map(item => String(item)).sort((left, right) => left.localeCompare(right));
        }
        if (value.every(item => typeof item === "number")) {
            return [...value].map(item => Number(item)).sort((left, right) => left - right);
        }
        if (value.every(item => typeof item === "boolean")) {
            return [...value].map(item => Boolean(item)).sort((left, right) => Number(left) - Number(right));
        }
        return value.map(item => normalizeJsonValue(item));
    }

    if (value && typeof value === "object") {
        const normalized: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))) {
            normalized[key] = normalizeJsonValue(child);
        }
        return normalized;
    }

    return value;
}

function parsePersonContext(text: string): ExecutorPersonContextData {
    const trimmed = text.trim();
    if (!trimmed) {
        return { mode: "raw", profiles: [], rawText: "" };
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            const objectProfiles = parsed.filter(
                (item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)
            );
            if (objectProfiles.length === parsed.length) {
                const profiles = objectProfiles.filter(isRenderablePersonProfile);
                return { mode: "profiles", profiles, rawText: trimmed };
            }
        } else if (parsed && typeof parsed === "object") {
            const profile = parsed as Record<string, unknown>;
            if (isRenderablePersonProfile(profile)) {
                return { mode: "profiles", profiles: [profile], rawText: trimmed };
            }
            return { mode: "profiles", profiles: [], rawText: trimmed };
        }
    } catch {
        // 非 JSON 背景文本仍保留原样渲染，并退化为整块比较。
    }

    return { mode: "raw", profiles: [], rawText: trimmed };
}

function isRenderablePersonProfile(profile: Record<string, unknown>): boolean {
    return [
        profile.userLabel,
        profile.displayName,
        profile.userId,
    ].some(value => typeof value === "string" && value.trim().length > 0);
}

function getPersonContextKey(profile: Record<string, unknown>, index: number): string {
    const userId = typeof profile.userId === "string" ? profile.userId : "";
    const displayName = typeof profile.displayName === "string" ? profile.displayName : "";
    return userId || displayName || `index:${index}`;
}

function getPersonContextSignature(profile: Record<string, unknown>): string {
    return JSON.stringify(normalizeJsonValue(profile));
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown, limit = 6): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, limit)
        : [];
}

function pushInlineField(lines: string[], label: string, value: unknown): void {
    const text = stringValue(value);
    if (text) {
        lines.push(`- ${label}: ${text}`);
    }
}

function pushListField(lines: string[], label: string, values: string[]): void {
    if (values.length === 0) return;
    lines.push(`- ${label}:`);
    for (const value of values) {
        lines.push(`  - ${value}`);
    }
}

function renderProfileTitle(profile: Record<string, unknown>, index: number): string {
    const userLabel = stringValue(profile.userLabel);
    if (userLabel) return userLabel;

    const displayName = stringValue(profile.displayName);
    const userId = stringValue(profile.userId);
    if (displayName && userId) return `${displayName}(${userId})`;
    return displayName || userId || `人物 ${index + 1}`;
}

function renderPersonProfileMarkdown(profile: Record<string, unknown>, index: number): string {
    const lines = [`### ${renderProfileTitle(profile, index)}`];
    const identityParts = [
        stringValue(profile.currentChatLabel) ? `当前聊天: ${stringValue(profile.currentChatLabel)}` : "",
        stringList(profile.aliases, 4).length ? `别名: ${stringList(profile.aliases, 4).join("、")}` : "",
        numberValue(profile.dunbarTier) ? `Dunbar: ${numberValue(profile.dunbarTier)}` : "",
        numberValue(profile.rapport) !== undefined ? `亲近度: ${numberValue(profile.rapport)}` : "",
        numberValue(profile.messageCount) !== undefined ? `本轮相关消息数: ${numberValue(profile.messageCount)}` : "",
    ].filter(Boolean);
    if (identityParts.length > 0) {
        lines.push(`- 身份线索: ${identityParts.join("；")}`);
    }

    pushInlineField(lines, "全局关系", profile.globalRelationToAgent);
    pushInlineField(lines, "当前聊天关系", profile.currentRelationToAgent);
    if (!stringValue(profile.globalRelationToAgent) && !stringValue(profile.currentRelationToAgent)) {
        pushInlineField(lines, "关系摘要", profile.relationToAgent);
    }
    pushInlineField(lines, "沟通风格", profile.communicationStyle);

    const traits = stringList(profile.traits, 6);
    if (traits.length > 0) {
        lines.push(`- 稳定特征: ${traits.join("、")}`);
    }
    const interests = stringList(profile.interests, 8);
    if (interests.length > 0) {
        lines.push(`- 关注主题: ${interests.join("、")}`);
    }

    pushListField(lines, "当前聊天 reflection 关系记忆", stringList(profile.relationshipMemory, 4));
    pushListField(lines, "策略提示", stringList(profile.agentPolicyHints, 5));
    pushListField(lines, "稳定互动模式", stringList(profile.stablePatterns, 4));
    pushListField(lines, "可跟进事项", stringList(profile.followupCandidates, 3));

    return lines.join("\n");
}

function renderPersonContextBody(data: ExecutorPersonContextData): string {
    if (data.mode !== "profiles") {
        return data.rawText;
    }
    return data.profiles
        .filter(isRenderablePersonProfile)
        .map(renderPersonProfileMarkdown)
        .filter(text => text.trim().length > 0)
        .join("\n\n");
}

function renderPersonContextGuidance(): string[] {
    return [
        "使用原则:",
        "- 这些人物背景只主动覆盖当前上下文里直接叫住 agent 的人；未出现的人需要时可再用 memory.* 搜索。",
        "- 这些背景可能包含跨群全局画像和当前聊天的 reflection 关系记忆。全局画像用于调整语气、策略和关注点，当前聊天画像决定本群/本私聊里怎样表达。",
        "- 不要把全局画像、私聊细节或其他群事实当作当前群公开说过的话直接复述；除非任务明确要求且来源可公开，否则只把它们内化为回复策略。",
    ];
}

function makeTargetMessageEntry(content: string, index: number): ExecutorTargetMessageEntry {
    const key = content.match(TARGET_MESSAGE_HEADER_RE)?.[1] ?? `raw:${index}:${content}`;
    return {
        key,
        signature: content,
        content,
    };
}

function parseTargetMessages(text: string): ExecutorTargetMessagesData {
    const trimmed = text.trim();
    if (!trimmed) return { entries: [] };

    const lines = trimmed.split(/\r?\n/);
    const entries: ExecutorTargetMessageEntry[] = [];
    let currentLines: string[] | null = null;
    let pendingPrefixLines: string[] = [];

    const flushCurrent = () => {
        if (!currentLines || currentLines.length === 0) return;
        const content = currentLines.join("\n").trimEnd();
        if (content) {
            entries.push(makeTargetMessageEntry(content, entries.length));
        }
        currentLines = null;
    };

    for (const line of lines) {
        if (TARGET_MESSAGE_AGE_MARKER_RE.test(line)) {
            continue;
        }

        if (TARGET_MESSAGE_HEADER_RE.test(line)) {
            flushCurrent();
            currentLines = pendingPrefixLines.length > 0 ? [...pendingPrefixLines, line] : [line];
            pendingPrefixLines = [];
            continue;
        }

        if (TARGET_MESSAGE_SEPARATOR_RE.test(line)) {
            flushCurrent();
            pendingPrefixLines.push(line);
            continue;
        }

        if (currentLines) {
            currentLines.push(line);
        } else {
            pendingPrefixLines.push(line);
        }
    }

    flushCurrent();

    if (entries.length === 0) {
        const fallback = pendingPrefixLines.join("\n").trim();
        if (fallback) {
            entries.push(makeTargetMessageEntry(fallback, 0));
        }
    }

    return { entries };
}

function renderTargetMessagesBody(data: ExecutorTargetMessagesData): string {
    return data.entries.map(entry => entry.content).join("\n");
}

function clampSessionDigestLimit(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 10;
    return Math.max(1, Math.min(30, Math.floor(value)));
}

// ═══ 0. Meta Session Digests ═══

/** Meta 历史 Session Digests — persistent（给 subagent 同步总编排者最近状态） */
export const executorSessionDigestsProvider: SectionProvider<Array<{ createdAt: string; content: string }>> = {
    schema: {
        name: "executor.session_digests",
        label: "Meta 历史 Session Digests",
        source: "globalState.sessionDigests",
        cache: "volatile",
        history: "persistent",
    },
    resolve(ctx: ExecutorResolveContext) {
        if (!ctx.sessionDigests?.length) return null;
        const limit = clampSessionDigestLimit(ctx.sessionDigestLimit);
        return ctx.sessionDigests.slice(-limit);
    },
    render(data) {
        return [
            "# 历史 Session Digests",
            ...data.map((item) => `- [${item.createdAt}] ${item.content}`),
        ].join("\n");
    },
};

// ═══ 1. Task Header ═══

/** 任务元信息 header — persistent */
export const executorHeaderProvider: SectionProvider<{
    chatId: string;
    chatType: string;
    chatTitle: string;
    taskId: string;
}> = {
    schema: {
        name: "executor.header",
        label: "任务头",
        source: "dispatch-handler.task",
        cache: "volatile",
        history: "persistent",
    },
    resolve(ctx: ExecutorResolveContext) {
        return {
            chatId: ctx.chatId,
            chatType: deriveChatType(ctx.isDirectMessage),
            chatTitle: ctx.chatTitle ?? ctx.chatId,
            taskId: ctx.taskId,
        };
    },
    render(data) {
        return [
            `═══ ${data.taskId} ═══`,
            `聊天对象: ${data.chatTitle}(${data.chatId}) [${data.chatType}]`,
        ].join("\n");
    },
};

// ═══ 2. Decisions + Tone ═══

/** 回复决策 + 语气指导 — persistent */
export const executorDecisionsProvider: SectionProvider<{
    decisions: string;
    toneGuidance: string;
}> = {
    schema: {
        name: "executor.decisions",
        label: "行动决策",
        source: "attend-handler.decisions",
        cache: "volatile",
        history: "persistent",
    },
    resolve(ctx: ExecutorResolveContext) {
        if (!ctx.decisions?.length) return null;
        const formatted = ctx.decisions.map(d =>
            `- [${d.action}] ${d.contentDirection ?? d.reason ?? ""} (topicId: ${d.topicId ?? "N/A"}, confidence: ${d.confidence})`
        ).join("\n");
        return {
            decisions: formatted,
            toneGuidance: ctx.toneGuidance ?? "",
        };
    },
    render(data) {
        return [
            "## 行动决策",
            "",
            data.decisions,
            `语气: ${data.toneGuidance}`,
        ].join("\n");
    },
};

// ═══ 3. Topic Summary ═══

/** 话题摘要 — ephemeral（当前轮可见，但不写入长期 session） */
export const executorTopicSummaryProvider: SectionProvider<string> = {
    schema: {
        name: "executor.topicSummary",
        label: "话题摘要",
        source: "topic-registry",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx: ExecutorResolveContext) {
        return ctx.topicSummary || null;
    },
    render(data) {
        return `## 话题摘要\n${data}`;
    },
};

// ═══ 4. Person Context ═══

/** 人物背景 — delta-only（按人物签名增量写入历史，当前轮不重复塞整块） */
export const executorPersonContextProvider: SectionProvider<ExecutorPersonContextData> = {
    schema: {
        name: "executor.personContext",
        label: "相关人物背景",
        source: "memory.profiles",
        cache: "delta",
        history: "delta-only",
    },
    resolve(ctx: ExecutorResolveContext) {
        if (!ctx.personContext) return null;
        const parsed = parsePersonContext(ctx.personContext);
        if (parsed.mode === "profiles" && parsed.profiles.length === 0) {
            return null;
        }
        if (parsed.mode === "raw" && !parsed.rawText.trim()) {
            return null;
        }
        return parsed;
    },
    diff(current, committed): DiffResult<ExecutorPersonContextData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: {
                    total: current.mode === "profiles" ? current.profiles.length : 1,
                    added: current.mode === "profiles" ? current.profiles.length : 1,
                    unchanged: 0,
                },
            };
        }

        if (current.mode !== "profiles" || committed.mode !== "profiles") {
            const changed = current.rawText !== committed.rawText;
            return {
                full: current,
                delta: changed ? current : { ...current, rawText: "" },
                stats: {
                    total: 1,
                    added: changed ? 1 : 0,
                    unchanged: changed ? 0 : 1,
                },
            };
        }

        const committedMap = new Map(
            committed.profiles.map((profile, index) => [
                getPersonContextKey(profile, index),
                getPersonContextSignature(profile),
            ])
        );
        const deltaProfiles = current.profiles.filter((profile, index) =>
            committedMap.get(getPersonContextKey(profile, index)) !== getPersonContextSignature(profile)
        );

        return {
            full: current,
            delta: {
                mode: "profiles",
                profiles: deltaProfiles,
                rawText: JSON.stringify(deltaProfiles),
            },
            stats: {
                total: current.profiles.length,
                added: deltaProfiles.length,
                unchanged: current.profiles.length - deltaProfiles.length,
            },
        };
    },
    render(data) {
        return [
            "## 相关人物背景",
            ...renderPersonContextGuidance(),
            renderPersonContextBody(data),
        ].join("\n");
    },
    renderDelta(delta) {
        const body = renderPersonContextBody(delta);
        return body
            ? [
                "## 相关人物背景 (更新)",
                ...renderPersonContextGuidance(),
                body,
            ].join("\n")
            : "";
    },
};

// ═══ 5. Memory Context ═══

/** 相关记忆 — ephemeral（当前轮可见，但不落入长期 session） */
export const executorMemoryContextProvider: SectionProvider<string> = {
    schema: {
        name: "executor.memoryContext",
        label: "相关记忆",
        source: "memory.search",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx: ExecutorResolveContext) {
        return ctx.memoryContext || null;
    },
    render(data) {
        return [
            "## 相关记忆",
            data,
            "",
            "使用原则：",
            "- 把这些记忆当成候选上下文，用来帮助判断和接话，不要机械复读。",
            "- 优先引用和当前目标消息强相关的事实或旧话题。",
            "- 如果事实带有 sourceChatId/sourceChatTitle/sourceTopicLabel/observedAt/visibility/sensitivity，把这些字段当成来源和披露边界；跨群引用时优先保留来源，不要裸说结论。",
            "- `private` 或高敏感记忆通常只能作为内部策略；不要在群聊里直接暴露私聊细节或其他群的敏感内容。",
            "- 历史话题带有 topicId，如果某个话题高度相关且需要更详细的上下文，可以用 `memory.searchTopics()` 或 `memory.browseHistory()` 按 topicId 获取完整对话记录。",
            "- 如果提供的记忆不够用，可以调用 memory.* 工具主动检索更多信息。",
        ].join("\n");
    },
};

// ═══ 6. Target Messages ═══

/** 目标消息 — delta-only（按消息块增量写入历史，忽略“距今”尾注抖动） */
export const executorTargetMessagesProvider: SectionProvider<ExecutorTargetMessagesData> = {
    schema: {
        name: "executor.targetMessages",
        label: "目标消息",
        source: "message-enricher",
        cache: "delta",
        history: "delta-only",
    },
    resolve(ctx: ExecutorResolveContext) {
        return ctx.targetMessages ? parseTargetMessages(ctx.targetMessages) : null;
    },
    diff(current, committed): DiffResult<ExecutorTargetMessagesData> {
        if (!committed) {
            return {
                full: current,
                delta: current,
                stats: { total: current.entries.length, added: current.entries.length, unchanged: 0 },
            };
        }

        const committedMap = new Map(committed.entries.map(entry => [entry.key, entry.signature]));
        const deltaEntries = current.entries.filter(entry => committedMap.get(entry.key) !== entry.signature);

        return {
            full: current,
            delta: { entries: deltaEntries },
            stats: {
                total: current.entries.length,
                added: deltaEntries.length,
                unchanged: current.entries.length - deltaEntries.length,
            },
        };
    },
    render(data) {
        return `## 目标消息\n${renderTargetMessagesBody(data)}`;
    },
    renderDelta(delta) {
        const body = renderTargetMessagesBody(delta);
        return body ? `## 目标消息 (更新)\n${body}` : "";
    },
};

// ═══ 7. Available Stickers ═══

/** 可用贴纸 — ephemeral */
export const executorStickersProvider: SectionProvider<string> = {
    schema: {
        name: "executor.stickers",
        label: "可用贴纸",
        source: "sticker-cache",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx: ExecutorResolveContext) {
        if (!ctx.availableStickers?.length) return null;
        return ctx.availableStickers
            .map(s => {
                const emojis = s.emojis?.length ? s.emojis : (s.emoji ? [s.emoji] : []);
                const emojiText = emojis.length ? `${emojis.join(" ")} ` : "";
                return `- ${emojiText}${s.description} (uniqueFileId: ${s.uniqueFileId})`;
            })
            .join("\n");
    },
    render(data) {
        return [
            "## 可用贴纸",
            "以下贴纸可通过 sendSticker 发送（适合用贴纸表达情绪或活跃气氛时使用，不要强行发送）：",
            data,
        ].join("\n");
    },
};

// ═══ 8. Grounding Context ═══

/** 事实查证 — ephemeral */
export const executorGroundingProvider: SectionProvider<string> = {
    schema: {
        name: "executor.grounding",
        label: "事实查证",
        source: "grounding-util",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx: ExecutorResolveContext) {
        return ctx.groundingContext || null;
    },
    render(data) {
        return [
            "## 事实查证",
            "以下是通过联网搜索获得的相关事实信息，请在回复中参考（如涉及事实性内容）：",
            data,
        ].join("\n");
    },
};

// ═══ 9. Footer ═══

/** 任务结尾指令 — persistent */
export const executorFooterProvider: SectionProvider<true> = {
    schema: {
        name: "executor.footer",
        label: "任务指令",
        source: "static",
        cache: "static",
        history: "persistent",
    },
    resolve() { return true; },
    render() {
        return "请根据以上任务信息，编写代码完成任务。先做事（下载/查询/处理），确认结果后再 sendMessage。";
    },
    hash() { return "footer-v1"; },
};

// ═══ Barrel Export ═══

/** 获取 executor task prompt 的全部 providers（有序） */
export function getExecutorTaskProviders(): SectionProvider[] {
    return [
        executorSessionDigestsProvider,
        executorHeaderProvider,
        executorTopicSummaryProvider,
        executorPersonContextProvider,
        executorMemoryContextProvider,
        executorTargetMessagesProvider,
        executorDecisionsProvider,
        executorStickersProvider,
        executorGroundingProvider,
        executorFooterProvider,
    ];
}
