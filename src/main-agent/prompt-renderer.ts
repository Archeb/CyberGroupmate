/**
 * prompt-renderer.ts — Prompt 模板渲染系统
 *
 * 7 个结构化 prompt 注入点（subagent.md §12）：
 * ➊ MainAgent.AttentionPrompt — 主循环注意力切换
 * ➋ MainAgent.DecisionPrompt — 决策生成
 * ➌ Observer.TriagePrompt — 话题分类（Observer 端）   [复用已有]
 * ➍ Observer.EngagementPrompt — engagement 告警描述   [复用已有]
 * ➎ CodeAct.ExecutionPrompt — CodeAct 执行上下文
 * ➏ FastPath.ReplyPrompt — FastPath 快速回复
 * ➐ MainAgent.CallbackPrompt — 回调处理
 *
 * 模板以 .md 文件存放在 system-prompts/ 目录下。
 * 使用 Mustache-like 变量（{{variable}}）和条件块（{{#flag}}...{{/flag}}）。
 *
 * 参考设计：subagent.md §12, subtask.md S5.5
 */

import type { GroupContextPackage, TopicDigest, SubagentCallback, FastPathConfig } from "../subagent/types.js";
import type { GlobalState } from "./global-state.js";
import type { GroupModel } from "../memory-v2/types.js";
import { createLogger } from "../core/logger.js";
import { getRawId, getDunbarTierLabel } from "../core/chat-id.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("prompt-renderer");

/**
 * 根据 isDirectMessage 推断聊天类型（平台无关）
 */
export function deriveChatType(isDirectMessage?: boolean): string {
    if (isDirectMessage === true) return "私聊";
    return "群聊";
}

// ─── 模板文件映射 ───

/** Prompt 类型 → 文件名映射 */
const PROMPT_FILE_MAP: Record<string, string> = {
    ATTENTION: "main-agent/mainagent-attention.md",
    DECISION: "main-agent/mainagent-decision.md",
    EXECUTION: "executor/subagent-execution.md",
    EXECUTION_TASK: "executor/subagent-execution-task.md",
    FAST_PATH_TASK: "fast-path/subagent-fast-path-task.md",
    CALLBACK: "main-agent/mainagent-callback.md",
    MAIN_SYSTEM: "main-agent/mainagent-main-system.md",
    TOPIC_CLUSTERING: "recording/recording-topic-clustering.md",
    TOPIC_TRIAGE: "recording/recording-topic-triage.md",
};

export type PromptType = keyof typeof PROMPT_FILE_MAP;

// ─── 模板缓存 ───

const _templateCache = new Map<string, string>();
let _promptDir: string | null = null;

/**
 * 设置 prompt 模板目录（用于测试或自定义路径）
 */
export function setPromptDirectory(dir: string): void {
    _promptDir = dir;
    _templateCache.clear();
}

/**
 * 获取 prompt 模板目录
 * 默认为项目根目录下的 system-prompts/
 */
function getPromptDir(): string {
    if (_promptDir) return _promptDir;

    // 默认：从当前文件向上两级找到项目根目录
    try {
        const thisFile = fileURLToPath(import.meta.url);
        const projectRoot = join(dirname(thisFile), "..", "..");
        return join(projectRoot, "system-prompts");
    } catch {
        // fallback
        return "system-prompts";
    }
}

/**
 * 读取 prompt 模板文件（带缓存）
 */
export function loadTemplate(type: PromptType): string {
    const cached = _templateCache.get(type);
    if (cached) return cached;

    const filename = PROMPT_FILE_MAP[type];
    if (!filename) {
        throw new Error(`Unknown prompt type: ${type}`);
    }

    const filePath = join(getPromptDir(), filename);

    if (!existsSync(filePath)) {
        log.warn("loadTemplate: 文件不存在, 使用空模板", { type, filePath });
        return "";
    }

    const content = readFileSync(filePath, "utf-8");
    _templateCache.set(type, content);
    log.debug("loadTemplate: 已加载", { type, filePath, length: content.length });
    return content;
}

/**
 * 清除模板缓存（用于测试或热重载）
 */
export function clearTemplateCache(): void {
    _templateCache.clear();
}

/**
 * 渲染 prompt 模板
 *
 * 支持：
 * - {{variable}} — 简单变量替换
 * - {{#flag}}...{{/flag}} — 条件块（flag 为真时显示）
 */
export function renderPrompt(type: PromptType, variables: Record<string, unknown>): string {
    const template = loadTemplate(type);
    return renderTemplate(template, variables);
}

/**
 * 渲染任意模板字符串（用于外部自定义模板）
 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
    let result = template;

    // 条件块处理：{{#flag}}content{{/flag}}
    result = result.replace(
        /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
        (_, flag: string, content: string) => {
            return variables[flag] ? content : "";
        }
    );

    // 变量替换：{{variable}}
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const val = variables[key];
        if (val === undefined || val === null) return "";
        if (typeof val === "object") return JSON.stringify(val, null, 2);
        return String(val);
    });

    return result.trim();
}

/**
 * 从 GroupContextPackage 构建 ATTENTION prompt 的变量
 */
export function buildAttentionVariables(
    pkg: GroupContextPackage,
    newMessageCount: number,
    options?: {
        persona?: string;
        lastAttendedAt?: string | null;
        timeSinceLastAttend?: string;
        stickinessLevel?: string;
        priorityMultiplier?: number;
        tonePreset?: string;
        callbacks?: SubagentCallback[];
        fastPathHistory?: string;
        messages?: string;
        dispatchedTopicIds?: string[];
    },
): Record<string, unknown> {
    const opts = options ?? {};

    return {
        chatId: pkg.chatId,
        chatType: deriveChatType(pkg.isDirectMessage),
        depth: pkg.depth,
        snapshotTimestamp: pkg.snapshotTimestamp,
        engagementScore: pkg.engagementScore,
        newMessageCount,
        topicCount: pkg.topicDigests.length,
        topicDigests: formatTopicDigests(pkg.topicDigests),

        // Persona
        persona: opts.persona ?? "",

        // Timing
        lastAttendedAt: opts.lastAttendedAt ?? "无记录",
        timeSinceLastAttend: opts.timeSinceLastAttend ?? "未知",

        // Stickiness
        stickinessLevel: opts.stickinessLevel ?? "STRANGER",
        priorityMultiplier: opts.priorityMultiplier ?? 0.2,
        tonePreset: opts.tonePreset ?? "礼貌得体",

        // Group model
        groupModel: !!pkg.groupModel,
        chatTitle: pkg.groupModel?.chatTitle ?? "",
        description: pkg.groupModel?.description ?? "",
        avgMessagesPerDay: pkg.groupModel?.avgMessagesPerDay ?? 0,
        engagementLevel: pkg.groupModel?.engagementLevel ?? "",
        recentFeedback: pkg.groupModel?.recentFeedback ?? "",

        // Callbacks
        hasCallbacks: !!opts.callbacks?.length,
        callbacks: opts.callbacks?.map(cb => `- [${cb.status}] ${cb.summary}`).join("\n") ?? "",

        // Messages
        messages: opts.messages ?? "",


        // FastPath history
        hasFastPathHistory: !!opts.fastPathHistory,
        fastPathHistory: opts.fastPathHistory ?? "",

        // Dispatched topics (防重复分派)
        hasDispatchedTopics: !!opts.dispatchedTopicIds?.length,
        dispatchedTopicIds: opts.dispatchedTopicIds?.join(", ") ?? "",

        // Active persons (Issue 3: PersonGroupProfile + aliases + mention 注入)
        activePersons: pkg.activePersons?.length
            ? pkg.activePersons.map((p: any) => {
                const tier = getDunbarTierLabel(p.dunbarTier);
                const rel = p.relationToAgent ? `, 关系: ${p.relationToAgent}` : "";
                const mentionStr = p.mention ? ` (提及方式: ${p.mention})` : "";
                const aka = p.aliases?.length ? ` (又名: ${p.aliases.join(", ")})` : "";
                return `${p.displayName}${mentionStr}${aka} (${tier}${rel})`;
            }).join("\n")
            : "",
    };
}

/**
 * 从 GlobalState + persona 构建 MAIN_SYSTEM prompt 的变量
 */
export function buildMainSystemVariables(
    persona: { name: string; description: string },
    globalState: GlobalState,
    decisionPrompt: string,
): Record<string, unknown> {
    // 备注 #9: recentDecisions 和 activeTasks 保留完整 composite chatId，让主 Agent 能区分平台来源
    const recentDecisions = globalState.getRecentDecisions().slice(-5)
        .map(d => `- [${d.chatId}] ${d.decision}`).join("\n") || "（无）";
    const activeTasks = globalState.getTaskList()
        .filter(t => t.status !== "DONE" && t.status !== "CANCELLED")
        .map(t => `- [${t.priority}][${t.status}] ${t.description}${t.chatId ? ` (群:${t.chatId})` : ""}`)
        .join("\n") || "（无待办任务）";

    return {
        personaName: persona.name,
        personaDescription: persona.description,
        attentionSummary: globalState.getAttentionSummary() || "（无）",
        recentDecisions,
        activeTasks,
        decisionPrompt,
    };
}

/**
 * 从 SubagentCallback 构建 CALLBACK prompt 的变量
 */
export function buildCallbackVariables(
    cb: SubagentCallback,
    chatTitle?: string,
    isDirectMessage?: boolean,
): Record<string, unknown> {
    const isCompleted = cb.status === "COMPLETED";
    const sentMessages = cb.sentMessages?.length
        ? cb.sentMessages.map(m => {
            const text = m.text.length > 80 ? m.text.slice(0, 80) + "..." : m.text;
            return `- "${text}"`;
        }).join("\n")
        : "（无）";

    return {
        chatId: getRawId(cb.chatId),
        chatType: deriveChatType(isDirectMessage),
        chatTitle: chatTitle || cb.chatId,
        taskId: cb.taskId,
        executionType: cb.executionType,
        status: cb.status,
        durationMs: cb.durationMs,
        isCompleted,
        sentMessages,
        summary: cb.summary,
        hasError: !!cb.error,
        error: cb.error ?? "",
    };
}

/**
 * 构建 FastPath system prompt 变量（静态，authorize 时设置一次）
 */
export function buildFastPathSystemVariables(
    persona: { name: string; description: string },
    chatTitle: string,
    isDirectMessage?: boolean,
): Record<string, unknown> {
    return {
        personaName: persona.name,
        personaDescription: persona.description,
        chatTitle,
        chatType: deriveChatType(isDirectMessage),
    };
}

/**
 * 构建 FastPath task prompt 变量（per-authorization，authorize 时设置一次）
 * 类似 executor 的 task context，包含群组信息、话题摘要、人物背景等
 */
export function buildFastPathTaskVariables(
    auth: FastPathConfig,
    chatId: string,
    chatTitle: string,
    isDirectMessage?: boolean,
    context?: {
        topicSummary?: string;
        personContext?: string;
        toneGuidance?: string;
    },
): Record<string, unknown> {
    return {
        chatId: getRawId(chatId),
        chatTitle,
        chatType: deriveChatType(isDirectMessage),
        preauthorizedActions: auth.preauthorizedActions.map(a => `- ${a}`).join("\n"),
        blockedActions: auth.blockedActions.length > 0
            ? auth.blockedActions.map(a => `- ❌ ${a}`).join("\n")
            : "(无)",
        maxReplyLength: auth.maxReplyLength ?? 150,
        tonePreset: context?.toneGuidance ?? auth.tonePreset,
        maxReplies: auth.maxRepliesBeforeReauth,
        hasTaskDescription: !!auth.taskDescription,
        taskDescription: auth.taskDescription ?? "",
        hasTopicSummary: !!context?.topicSummary,
        topicSummary: context?.topicSummary ?? "",
        hasPersonContext: !!context?.personContext,
        personContext: context?.personContext ?? "",
    };
}

/**
 * 构建 FastPath per-turn 用户消息（每次 handle 时动态生成）
 */
export function buildFastPathTurnContent(
    event: { userId: string; text: string },
    repliesSent: number,
    maxReplies: number,
    sentMessages?: ReadonlyArray<{ text: string; timestamp: string }>,
): string {
    const parts: string[] = [];

    // 已发送消息确认（如果有历史）
    if (sentMessages && sentMessages.length > 0) {
        parts.push(`[📤 已发送消息确认]`);
        for (const m of sentMessages) {
            parts.push(`- "${m.text.length > 100 ? m.text.slice(0, 100) + '...' : m.text}"`);
        }
        parts.push("");
    }

    // 剩余额度状态
    const remaining = maxReplies - repliesSent;
    parts.push(`[📊 额度状态: 已用 ${repliesSent}/${maxReplies}，剩余 ${remaining} 次回复机会]`);
    if (remaining <= 1) {
        parts.push(`[⚠ 这是最后的回复机会，请谨慎使用]`);
    }
    parts.push("");

    // 触发消息
    parts.push(`## 触发消息`);
    parts.push(`发送者: ${event.userId}`);
    parts.push(`内容: ${event.text}`);
    parts.push("");
    parts.push(`请直接输出回复内容（纯文本，不含其他格式）。如果不应回复，输出 "__SKIP__"。`);

    return parts.join("\n");
}

/** 话题渲染输入（统一接口，各调用方筛选/排序后传入） */
export interface FormattableTopic {
    id?: string;
    label: string;
    summary?: string;
    recentContext?: string;
    createdAt?: number | string;
    participants?: string[];
    messageCount?: number;
    /** Triage 判断理由（仅 ENGAGED 状态话题） */
    triageReason?: string;
}

/**
 * 将时间戳格式化为相对时间描述（如 "3小时前"、"2天前"）
 */
export function formatRelativeTime(timestamp: string | number | null | undefined): string {
    if (timestamp == null) return "";
    const ms = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
    if (isNaN(ms)) return "";
    const diffMs = Date.now() - ms;
    if (diffMs < 0) return "刚刚";
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
}

/**
 * 格式化话题列表为可读字符串（统一渲染逻辑）
 *
 * 输出格式：
 *   (3小时前) 话题标签 [参与者1, 参与者2] — 摘要文本 {topic_id}
 *
 * 如无摘要则 fallback 到 recentContext 最后 2 行。
 * 调用方负责筛选（时间范围、状态）和排序，此函数只负责渲染。
 */
export function formatTopicList(topics: FormattableTopic[], emptyText = "(无活跃话题)"): string {
    if (topics.length === 0) return emptyText;

    return topics.map(t => {
        const time = t.createdAt ? `(${formatRelativeTime(t.createdAt)})` : "";
        const id = t.id ? ` {${t.id}}` : "";
        const people = t.participants?.length ? ` [${t.participants.join(", ")}]` : "";
        const detail = t.summary
            ? ` — ${t.summary}`
            : (t.recentContext
                ? `: ${t.recentContext.split("\n").slice(-2).join("; ")}`
                : "");
        const reason = t.triageReason ? ` │ ✅ 建议介入，原因及方向: ${t.triageReason}` : "";
        return `${time} ${t.label}${people}${detail}${reason}${id}`.trim();
    }).join("\n");
}

/**
 * 格式化 TopicDigest 列表为可读字符串（内部调用 formatTopicList）
 */
function formatTopicDigests(digests: TopicDigest[]): string {
    return formatTopicList(digests.map(d => ({
        id: d.topicId,
        state: d.state,
        label: d.label,
        summary: d.summary,
        messageCount: d.messageCount,
        createdAt: d.lastActivityAt,
        triageReason: (d as any).triageReason,
    })));
}
