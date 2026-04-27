/**
 * context-engine/providers/executor-providers.ts — Executor 专用 SectionProvider
 *
 * 替代旧的 renderPrompt("EXECUTION_TASK", vars) + stripVerboseSections() 逻辑。
 *
 * Task prompt 由多个结构化 section 组成，每个 section 有独立的 history 策略：
 * - persistent：保留在 session 历史中（header/decisions）
 * - ephemeral：仅在当前 turn 出现，下次 render 不进入历史（targetMessages/personContext）
 * - omit：在历史中替换为占位符（topicSummary/memoryContext）
 *
 * 这样在 session 历史积累时，不需要 stripVerboseSections 这种 regex hack，
 * 引擎会按声明式策略自动处理。
 */

import type { SectionProvider, ResolveContext } from "../types.js";
import { deriveChatType } from "../prompt-renderer-utils.js";
import { getRawId } from "../../core/chat-id.js";

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
    availableStickers?: Array<{ description: string; uniqueFileId: string }>;
    groundingContext?: string;
    imageParts?: unknown[];
}

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
            chatId: getRawId(ctx.chatId),
            chatType: deriveChatType(ctx.isDirectMessage),
            chatTitle: ctx.chatTitle ?? getRawId(ctx.chatId),
            taskId: ctx.taskId,
        };
    },
    render(data) {
        return [
            `═══ ${data.taskId} ═══`,
            `聊天对象: ${data.chatTitle} (chatId: ${data.chatId}) [${data.chatType}]`,
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
        label: "参考回复方式",
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
            "## 参考回复方式",
            "",
            data.decisions,
            `语气: ${data.toneGuidance}`,
        ].join("\n");
    },
};

// ═══ 3. Topic Summary ═══

/** 话题摘要 — omit (历史中用占位符) */
export const executorTopicSummaryProvider: SectionProvider<string> = {
    schema: {
        name: "executor.topicSummary",
        label: "话题摘要",
        source: "topic-registry",
        cache: "volatile",
        history: "omit",
    },
    resolve(ctx: ExecutorResolveContext) {
        return ctx.topicSummary || null;
    },
    render(data) {
        return `## 话题摘要\n${data}`;
    },
};

// ═══ 4. Person Context ═══

/** 人物背景 — ephemeral (下次 render 不进入历史) */
export const executorPersonContextProvider: SectionProvider<string> = {
    schema: {
        name: "executor.personContext",
        label: "相关人物背景",
        source: "memory.profiles",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx: ExecutorResolveContext) {
        return ctx.personContext || null;
    },
    render(data) {
        return `## 相关人物背景\n${data}`;
    },
};

// ═══ 5. Memory Context ═══

/** 相关记忆 — omit (内容大，历史中用占位符) */
export const executorMemoryContextProvider: SectionProvider<string> = {
    schema: {
        name: "executor.memoryContext",
        label: "相关记忆",
        source: "memory.search",
        cache: "volatile",
        history: "omit",
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
            "- 历史话题带有 topicId，如果某个话题高度相关且需要更详细的上下文，可以用 `memory.searchTopics()` 或 `memory.browseHistory()` 按 topicId 获取完整对话记录。",
            "- 如果提供的记忆不够用，可以调用 memory.* 工具主动检索更多信息。",
        ].join("\n");
    },
};

// ═══ 6. Target Messages ═══

/** 目标消息 — ephemeral (大段原文，每次从 recentMessages 重新获取) */
export const executorTargetMessagesProvider: SectionProvider<string> = {
    schema: {
        name: "executor.targetMessages",
        label: "目标消息",
        source: "message-enricher",
        cache: "volatile",
        history: "ephemeral",
    },
    resolve(ctx: ExecutorResolveContext) {
        return ctx.targetMessages || null;
    },
    render(data) {
        return `## 目标消息\n${data}`;
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
            .map(s => `- ${s.description} (uniqueFileId: ${s.uniqueFileId})`)
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
        executorHeaderProvider,
        executorDecisionsProvider,
        executorTopicSummaryProvider,
        executorPersonContextProvider,
        executorMemoryContextProvider,
        executorTargetMessagesProvider,
        executorStickersProvider,
        executorGroundingProvider,
        executorFooterProvider,
    ];
}
