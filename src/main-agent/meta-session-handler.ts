import type { LLMConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import { createLogger } from "../core/logger.js";
import type { MetaSandbox } from "../meta-sandbox/meta-sandbox.js";
import { runMetaSession, type MetaSessionResult } from "../meta-sandbox/meta-session-runner.js";
import type { AttentionQueueEntry, SubagentCallback } from "../subagent/types.js";
import type { GlobalState } from "./global-state.js";

const log = createLogger("meta-session-handler");

export interface MetaSessionHandlerDeps {
    getPersona: () => { name?: string; description?: string } | undefined;
    globalState: Pick<GlobalState, "getSessionDigests" | "memoList">;
    sandbox: MetaSandbox;
    getLlmConfigs: () => LLMConfig[];
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
    const messages: ChatMessage[] = [
        {
            role: "system",
            content: buildSystemPrompt(persona.name ?? "赛博群友", persona.description ?? "跨群编排 agent"),
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

function buildSystemPrompt(personaName: string, personaDescription: string): string {
    return [
        `你是「${personaName}」，现在正在跨群编排多个聊天任务。`,
        personaDescription,
        "你运行在 MetaSandbox 中，可以直接调用以下 Meta API：conversations、memory、agents、dispatch、memo、schedule。",
        "如果需要采取动作，输出一个单独的 ```ts 代码块，在代码中直接 await 这些 API。",
        "如果本轮不需要动作，不要输出代码，直接结束。",
        "禁止使用 setTimeout/setInterval 之类的自调度方式；需要未来唤醒时使用 schedule.wakeOnCondition()。",
        "本轮结束时必须输出 <end_turn>，并在思考文本中包含 [SESSION_DIGEST]...[/SESSION_DIGEST]，摘要写清楚你做了什么、还在等什么。",
        "你的目标不是给出最终回复内容，而是完成跨群编排、检索、分发和状态管理。",
    ].filter(Boolean).join("\n\n");
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
    const parts: string[] = [];

    if (callbacks.length > 0) {
        parts.push([
            "## 新到达的 Subagent Callbacks",
            ...callbacks.map((cb) => `- ${cb.chatId}: status=${cb.status}, taskId=${cb.taskId}, summary=${cb.summary}`),
        ].join("\n"));
    }

    parts.push([
        "## 当前 Attention Set",
        ...entries.map(renderAttentionEntry),
    ].join("\n\n"));

    parts.push("请检查是否需要跨群检索、分派任务、写 memo 或注册 wake condition。若无需动作，请直接结束本轮。");

    return parts.join("\n\n");
}

function renderAttentionEntry(entry: AttentionQueueEntry): string {
    const topicLines = entry.topicDigests.length > 0
        ? entry.topicDigests.map((topic) => `  - ${topic.topicId}: ${topic.label} | ${topic.summary} | keywords=${topic.keywords.join(", ")}`).join("\n")
        : "  - (none)";
    const triggerLines = entry.schedulerTriggers?.length
        ? entry.schedulerTriggers.map((trigger) => `  - ${trigger.type}:${trigger.id} ${trigger.description}`).join("\n")
        : "  - (none)";

    return [
        `### ${entry.chatId}`,
        `- source: ${entry.source}`,
        `- priority: ${entry.priority}`,
        `- newMessageCount: ${entry.newMessageCount}`,
        `- engagementScore: ${entry.engagementScore ?? 0}`,
        `- stickinessLevel: ${entry.stickinessLevel}`,
        `- callbackPotential: ${entry.callbackPotential ?? 0}`,
        `- urgentSignals: ${entry.urgentSignals?.join(", ") ?? "(none)"}`,
        `- schedulerTriggers:\n${triggerLines}`,
        `- topicDigests:\n${topicLines}`,
    ].join("\n");
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}