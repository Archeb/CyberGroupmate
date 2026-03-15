/**
 * reply-pipeline.ts — Agent-Memory Bridge
 *
 * 把 Memory / Pipeline 侧的结构化结果桥接成 Agent 侧可消费的 CodeAct 输入。
 *
 * 设计目标：
 * - 不引入 tool use
 * - 输出仍然是 prompt + typed code surface
 * - 为 FAST_PATH / 话题介入 / ENGAGED 对话三种来源统一组装任务
 */

import { createLogger } from "../core/logger.js";
import type { LLMConfig } from "../core/config.js";
import type { MemoryStoreV2, RecallResult } from "../memory-v2/index.js";
import type { Message, Topic, TriageDecision, ModelRouteResult } from "./types.js";
import type { ModelRouter } from "./model-router.js";
import type { TopicRegistry } from "./topic-registry.js";
import { ContextAssembler } from "./context-assembler.js";

const log = createLogger("reply-pipeline");

export type ReplyTaskSource = "FAST_PATH" | "TOPIC_TRIAGE" | "ENGAGED";

export interface ReplyTask {
    id: string;
    source: ReplyTaskSource;
    scene: string;
    chatId: string;
    topicId?: string;
    modelRoute: ModelRouteResult;
    title: string;
    prompt: string;
    messages: Message[];
    recall?: RecallResult;
    replyHint?: string;
    sceneFocus?: string;
    latentMemory?: string;
}

let taskCounter = 0;

function nextTaskId(): string {
    taskCounter += 1;
    return `reply_${Date.now().toString(36)}_${taskCounter.toString(36).padStart(4, "0")}`;
}

function unique<T>(items: T[]): T[] {
    return Array.from(new Set(items));
}

function formatNaturalTime(timestampMs: number): string {
    const diffMs = Date.now() - timestampMs;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin}分钟前`;

    const diffHours = Math.floor(diffMin / 60);
    const remMin = diffMin % 60;
    if (diffHours < 24) {
        return remMin > 0 ? `${diffHours}小时${remMin}分钟前` : `${diffHours}小时前`;
    }

    const diffDays = Math.floor(diffHours / 24);
    const remHours = diffHours % 24;
    if (diffDays < 7) {
        if (remHours > 0 && remMin > 0) return `${diffDays}天${remHours}小时${remMin}分钟前`;
        if (remHours > 0) return `${diffDays}天${remHours}小时前`;
        return `${diffDays}天前`;
    }

    const date = new Date(timestampMs);
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const now = new Date();
    if (date.getFullYear() === now.getFullYear()) {
        return `${month}月${day}日 ${hour}:${minute}`;
    }
    return `${date.getFullYear()}年${month}月${day}日 ${hour}:${minute}`;
}

function formatDirectMessageLine(message: Message): string {
    const platform = message.platform ?? message.scene ?? "unknown";
    const chatType = message.chatType ?? (message.isDirectMessage ? "private" : "chat");
    const ids = [
        `u:${message.senderId}`,
        `c:${message.chatId}`,
        `m:${message.id}`,
        message.replyToMessageId ? `r:${message.replyToMessageId}` : null,
    ].filter(Boolean).join(" ");

    return `- [${platform}/${chatType}] ${message.senderName} (${ids}) ${formatNaturalTime(message.timestamp)}: ${message.text}`;
}

export class ReplyPipeline {
    private contextAssembler: ContextAssembler;

    constructor(
        private memory: MemoryStoreV2,
        private topicRegistry: TopicRegistry,
        private modelRouter: ModelRouter,
        private baseLLMConfig: LLMConfig,
    ) {
        this.contextAssembler = new ContextAssembler(memory);
    }

    buildDirectTasks(messages: Message[]): ReplyTask[] {
        const byChat = new Map<string, Message[]>();
        for (const msg of messages) {
            const group = byChat.get(msg.chatId) ?? [];
            group.push(msg);
            byChat.set(msg.chatId, group);
        }

        const tasks: ReplyTask[] = [];
        for (const [chatId, group] of byChat) {
            const route = this.modelRouter.route(true, undefined, group);
            const assembled = this.contextAssembler.assemble({
                scene: "telegram",
                chatId: String(chatId),
                messages: group,
            });
            tasks.push({
                id: nextTaskId(),
                source: "FAST_PATH",
                scene: "telegram",
                chatId: String(chatId),
                modelRoute: route,
                title: `FAST_PATH chat=${chatId}`,
                prompt: this.buildDirectPrompt(group, route, assembled.sceneFocusBlock, assembled.latentMemoryBlock),
                messages: group,
                sceneFocus: assembled.sceneFocusBlock,
                latentMemory: assembled.latentMemoryBlock,
            });
        }
        return tasks;
    }

    async buildTopicTask(topicId: string): Promise<ReplyTask | null> {
        const topic = this.topicRegistry.get(topicId);
        if (!topic || !topic.decision?.should_intervene) return null;

        const recall = await this.recallForTopic(topic);
        const route = this.modelRouter.route(false, topic.decision, []);
        const assembled = this.contextAssembler.assemble({
            scene: "telegram",
            chatId: String(topic.chatId),
            messages: topic.pendingMessages.slice(-3),
            recentContext: topic.recentContext,
        });

        return {
            id: nextTaskId(),
            source: "TOPIC_TRIAGE",
            scene: "telegram",
            chatId: String(topic.chatId),
            topicId: topic.id,
            modelRoute: route,
            title: `TOPIC_TRIAGE ${topic.label}`,
            prompt: this.buildTopicPrompt(topic, topic.decision, recall, route, assembled.sceneFocusBlock, assembled.latentMemoryBlock),
            messages: [],
            recall,
            sceneFocus: assembled.sceneFocusBlock,
            latentMemory: assembled.latentMemoryBlock,
        };
    }

    async buildEngagedTask(topicId: string, messages: Message[], replyHint: string): Promise<ReplyTask | null> {
        const topic = this.topicRegistry.get(topicId);
        if (!topic) return null;

        const decision = topic.decision ?? {
            should_intervene: true,
            reason: "engaged conversation",
            intervention_type: "CASUAL_CHAT",
            confidence: 0.8,
        };
        const recall = await this.recallForTopic(topic);
        const route = this.modelRouter.route(true, decision, messages);
        const assembled = this.contextAssembler.assemble({
            scene: "telegram",
            chatId: String(topic.chatId),
            messages,
            recentContext: topic.recentContext,
        });

        return {
            id: nextTaskId(),
            source: "ENGAGED",
            scene: "telegram",
            chatId: String(topic.chatId),
            topicId: topic.id,
            modelRoute: route,
            title: `ENGAGED ${topic.label}`,
            prompt: this.buildEngagedPrompt(topic, messages, replyHint, recall, route, assembled.sceneFocusBlock, assembled.latentMemoryBlock),
            messages,
            recall,
            replyHint,
            sceneFocus: assembled.sceneFocusBlock,
            latentMemory: assembled.latentMemoryBlock,
        };
    }

    getTaskLLMConfig(task: ReplyTask): LLMConfig {
        return {
            ...this.baseLLMConfig,
            ...task.modelRoute.overrides,
        };
    }

    private async recallForTopic(topic: Topic): Promise<RecallResult | undefined> {
        const queryParts = unique([topic.label, ...topic.keywords]).filter(Boolean);
        if (queryParts.length === 0) return undefined;

        try {
            return await this.memory.recall(queryParts.join(" "), {
                chatId: String(topic.chatId),
                maxResults: 5,
            });
        } catch (err) {
            log.warn("topic recall failed", { topicId: topic.id, error: String(err) });
            return undefined;
        }
    }

    private buildDirectPrompt(messages: Message[], route: ModelRouteResult, sceneFocus: string, latentMemory: string): string {
        const lines = messages.map(formatDirectMessageLine).join("\n");

        return [
            `[Reply Pipeline] 来源: FAST_PATH`,
            `建议模型: ${route.model}`,
            "",
            sceneFocus,
            "",
            latentMemory,
            "",
            "以下消息需要立即处理。你仍然通过写 TypeScript 代码来行动，不使用 tool calling。",
            "优先直接使用当前已注入的类型定义、来源信息和潜意识上下文；只有当你需要高级能力或不确定 API 细节时，再去读 docs。",
            "如需发消息，直接使用 ctx.tg.sendText() 发送，不需要切换场景。",
            "不要写未 await 的 async IIFE；优先直接顶层 await，或写成 await (async () => { ... })()。",
            "如需读取历史或记忆，请主动调用 memory.recall() / memory.browseHistory()；不要为了确认基础 API 而默认先读 docs。",
            "",
            "[Incoming Messages]",
            lines,
        ].join("\n");
    }

    private buildTopicPrompt(
        topic: Topic,
        decision: TriageDecision,
        recall: RecallResult | undefined,
        route: ModelRouteResult,
        sceneFocus: string,
        latentMemory: string,
    ): string {
        return [
            `[Reply Pipeline] 来源: TOPIC_TRIAGE`,
            `建议模型: ${route.model}`,
            `话题: ${topic.label}`,
            `chatId: ${topic.chatId}`,
            `决策: ${decision.intervention_type} (confidence=${decision.confidence.toFixed(2)})`,
            `理由: ${decision.reason}`,
            "",
            sceneFocus,
            "",
            latentMemory,
            "",
            "以下是框架预处理后的结构化上下文。你仍然需要通过 CodeAct 写代码来完成任务。",
            "优先直接使用已注入的类型定义和上下文；只有在需要高级能力或不确定 API 细节时才读 docs。",
            "",
            `最近上下文:\n${topic.recentContext || "（无）"}`,
            "",
            this.formatRecall(recall),
            "",
            "请判断是否需要读取 memory 或查看话题上下文，并自行写代码完成检索、补充上下文、生成回复、发送消息。",
        ].join("\n");
    }

    private buildEngagedPrompt(
        topic: Topic,
        messages: Message[],
        replyHint: string,
        recall: RecallResult | undefined,
        route: ModelRouteResult,
        sceneFocus: string,
        latentMemory: string,
    ): string {
        const lines = messages.map(m => `- ${m.senderName}: ${m.text}`).join("\n");

        return [
            `[Reply Pipeline] 来源: ENGAGED`,
            `建议模型: ${route.model}`,
            `话题: ${topic.label}`,
            `chatId: ${topic.chatId}`,
            `对话轮次: ${topic.turnCount}/${topic.maxTurns}`,
            `回复方向提示: ${replyHint || "（无）"}`,
            "",
            sceneFocus,
            "",
            latentMemory,
            "",
            "优先直接使用已注入的类型定义和上下文；只有在需要高级能力或不确定 API 细节时才读 docs。",
            "如需发消息，直接使用 ctx.tg.sendText() 发送，不需要切换场景。",
            "",
            `新消息:\n${lines}`,
            "",
            `最近话题上下文:\n${topic.recentContext || "（无）"}`,
            "",
            this.formatRecall(recall),
            "",
            "你正处于一段已经介入的话题中。请保持自然节奏，必要时先检索记忆，再通过代码发送回复。",
        ].join("\n");
    }

    private formatRecall(recall: RecallResult | undefined): string {
        if (!recall) return "Memory Context: （未命中）";

        const parts: string[] = [];
        if (recall.topics.length > 0) {
            parts.push(`相关话题: ${recall.topics.slice(0, 3).map(t => t.label).join("、")}`);
        }
        if (recall.facts.length > 0) {
            parts.push(`相关事实: ${recall.facts.slice(0, 5).map(f => f.content).join("；")}`);
        }
        if (recall.persons.length > 0) {
            parts.push(`相关人物: ${recall.persons.slice(0, 3).map(p => p.userId).join("、")}`);
        }
        if (recall.deepSummary) {
            parts.push(`Deep Summary: ${recall.deepSummary}`);
        }

        return parts.length > 0 ? `Memory Context:\n${parts.join("\n")}` : "Memory Context: （未命中）";
    }
}
