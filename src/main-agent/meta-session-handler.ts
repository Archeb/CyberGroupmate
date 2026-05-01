import type { LLMConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import { createLogger } from "../core/logger.js";
import { loadPromptFile } from "../core/prompt-loader.js";
import { renderTemplate } from "../context-engine/template-engine.js";
import type { MetaSandbox } from "../meta-sandbox/meta-sandbox.js";
import { runMetaSession, type MetaLLMCaller, type MetaSessionResult } from "../meta-sandbox/meta-session-runner.js";
import type { AttentionQueueEntry, SubagentCallback } from "../subagent/types.js";
import type { GlobalState } from "./global-state.js";

const log = createLogger("meta-session-handler");

export interface MetaSessionHandlerDeps {
    getPersona: () => { name?: string; description?: string } | undefined;
    globalState: Pick<GlobalState, "getSessionDigests" | "memoList">;
    sandbox: MetaSandbox;
    getLlmConfigs: () => LLMConfig[];
    llmCaller?: MetaLLMCaller;
    maxTurns?: number;
    codeTimeout?: number;
    llmTimeoutMs?: number;
}

export function createMetaSessionHandler(deps: MetaSessionHandlerDeps) {
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

        const messages = buildMetaMessages(deps, entries, callbacks);
        log.info("运行 Meta session", {
            groups: entries.map((entry) => entry.chatId),
            callbacks: callbacks.length,
        });

        return runMetaSession(messages, deps.sandbox, llmConfigs, {
            maxTurns: deps.maxTurns,
            codeTimeout: deps.codeTimeout,
            llmCaller: deps.llmCaller,
            llmTimeoutMs: deps.llmTimeoutMs,
        });
    };
}

function buildMetaMessages(
    deps: MetaSessionHandlerDeps,
    entries: AttentionQueueEntry[],
    callbacks: SubagentCallback[],
): ChatMessage[] {
    const persona = deps.getPersona() ?? {};
    const systemPrompt = loadRequiredPrompt("meta-agent/meta-system.md");
    const messages: ChatMessage[] = [
        {
            role: "system",
            content: renderTemplate(systemPrompt, {
                personaName: persona.name ?? "赛博群友",
                personaDescription: persona.description ?? "跨群编排 agent",
                metaApiReference: buildMetaApiReference(),
            }),
        },
    ];

    const historicalContent = renderHistoricalContext(deps.globalState);
    if (historicalContent) {
        messages.push({ role: "user", content: historicalContent });
    }

    messages.push({
        role: "user",
        content: renderCurrentTurn(entries, callbacks),
    });

    return messages;
}

function renderHistoricalContext(globalState: Pick<GlobalState, "getSessionDigests" | "memoList">): string {
    const digests = globalState.getSessionDigests();
    const memos = globalState.memoList();
    const parts: string[] = [];

    if (digests.length > 0) {
        parts.push([
            "## 历史 Session Digests",
            ...digests.map((item) => `- [${item.createdAt}] ${item.content}`),
        ].join("\n"));
    }

    if (memos.length > 0) {
        parts.push([
            "## 当前全局备忘录",
            ...memos.map((item) => `- ${item.key}: ${safeJson(item.value)}${item.expiresAt ? ` (expiresAt=${item.expiresAt})` : ""}`),
        ].join("\n"));
    }

    return parts.join("\n\n");
}

function renderCurrentTurn(entries: AttentionQueueEntry[], callbacks: SubagentCallback[]): string {
    const template = loadRequiredPrompt("meta-agent/meta-attention.md");
    const callbacksSection = callbacks.length > 0
        ? [
            "## 新到达的 Subagent Callbacks",
            ...callbacks.map((cb) => `- ${cb.chatId}: status=${cb.status}, taskId=${cb.taskId}, summary=${cb.summary}`),
        ].join("\n")
        : "";
    const attentionSetSection = [
        "## 当前 Attention Set",
        ...entries.map(renderAttentionEntry),
    ].join("\n\n");

    return renderTemplate(template, {
        callbacksSection,
        attentionSetSection,
        currentTurnInstruction: "请检查是否需要跨群检索、分派任务、写 memo 或注册 wake condition。若无需动作，请直接结束本轮。",
    });
}

function renderAttentionEntry(entry: AttentionQueueEntry): string {
    const topicLines = entry.topicDigests.length > 0
        ? entry.topicDigests.map((topic) => `  - ${topic.topicId}: ${topic.label} | ${topic.summary} | keywords=${topic.keywords.join(", ")}`).join("\n")
        : "  - (none)";
    const triggerLines = entry.schedulerTriggers?.length
        ? entry.schedulerTriggers.map((trigger) => `  - ${trigger.type}:${trigger.id} ${trigger.description}`).join("\n")
        : "  - (none)";
    const recentMessageLines = entry.recentMessages?.length
        ? entry.recentMessages.map((message) => {
            const sender = message.displayName?.trim() || message.userId || "unknown";
            return `  - [${message.timestamp}] ${sender}: ${formatRecentMessageText(message.text)}`;
        }).join("\n")
        : "  - (none)";

    return [
        `### ${entry.chatId}`,
        `- source: ${entry.source}`,
        `- priority: ${entry.priority}`,
        `- newMessageCount: ${entry.newMessageCount}`,
        `- engagementScore: ${entry.engagementScore ?? 0}`,
        `- directAddressReason: ${entry.directAddressReason ?? "(none)"}`,
        `- stickinessLevel: ${entry.stickinessLevel}`,
        `- callbackPotential: ${entry.callbackPotential ?? 0}`,
        `- urgentSignals: ${entry.urgentSignals?.join(", ") ?? "(none)"}`,
        `- schedulerTriggers:\n${triggerLines}`,
        `- recentMessages:\n${recentMessageLines}`,
        `- topicDigests:\n${topicLines}`,
    ].join("\n");
}

function formatRecentMessageText(text: string): string {
    const flattened = text.replace(/\s+/g, " ").trim();
    if (flattened.length <= 160) {
        return flattened;
    }
    return `${flattened.slice(0, 157)}...`;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
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