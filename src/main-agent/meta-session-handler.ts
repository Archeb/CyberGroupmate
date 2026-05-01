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

function loadRequiredPrompt(relativePath: string): string {
    const content = loadPromptFile(relativePath);
    if (!content) {
        throw new Error(`Missing prompt file: ${relativePath}`);
    }
    return content;
}

function buildMetaApiReference(): string {
    return [
        "- conversations.query(filters): 跨群检索消息、话题与回调线索。",
        "- memory.searchEntities(query, options?): 检索人物、别名、core facts、近期会话和 topic 关键字。",
        "- agents.listStatus(): 查看各群 Subagent 的运行状态与积压。",
        "- dispatch.taskToGroup(chatId, taskSpec): 向指定群派发 CodeAct 回复任务。",
        "- memo.set/get/delete/list: 读写跨会话备忘录。",
        "- schedule.wakeOnCondition(condition): 注册 delay / callback_received 唤醒条件。",
    ].join("\n");
}