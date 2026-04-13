/**
 * fast-path-handler.ts — FastPath 快速回复处理器
 *
 * 严格受控的快速回复通道：
 * - 仅在主 Agent 显式授权后生效
 * - 受 maxReplies、过期时间约束
 * - 支持 __SKIP__ 标记跳过发送
 * - 过期/用尽后自动禁用
 * - 结果通过 callback (Q5) 回报主 Agent
 *
 * 参考设计：subagent.md §6, subtask.md S4
 */

import type {
    FastPathConfig,
    SubagentCallback,
} from "./types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./types.js";
import { callLLMWithFallback, type ChatMessage } from "../core/llm.js";
import { renderPrompt, buildFastPathTaskVariables, buildFastPathTurnContent } from "../main-agent/prompt-renderer.js";
import { resolveComponentTimeout, type LLMConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { getAgentSkillsBriefs } from "../sandbox/modules/docs.js";

const log = createLogger("fast-path");

/** FastPath 发送的消息 */
export interface FastPathMessage {
    text: string;
    timestamp: string;
}

/** FastPath 事件接口（从 NC 事件提取） */
export interface FastPathEvent {
    chatId: string;
    messageId: string;
    userId: string;
    text: string;
    timestamp: string;
}

/**
 * FastPathHandler — 快速回复处理器
 *
 * 每个群组一个实例，由 GroupSubagent 持有。
 */
export class FastPathHandler {
    readonly chatId: string;
    private authorization: FastPathConfig | null = null;
    private repliesSent = 0;
    private sentMessages: Array<{ text: string; timestamp: string }> = [];

    /** LLM 配置（用于生成回复） */
    private llmConfigs: LLMConfig[] = [];
    private personaName: string = "赛博群友";
    private personaDescription: string = "";
    private chatTitle: string = "";
    private isDirectMessage: boolean = false;

    /** 授权时注入的丰富上下文（类似 executor task context） */
    private taskContext: {
        topicSummary?: string;
        personContext?: string;
        toneGuidance?: string;
    } = {};

    /** 缓存的 task prompt（authorize 后渲染一次） */
    private cachedTaskPrompt: string = "";

    /** 发送回调（由外部注入，实际发送消息到 Telegram） */
    private sendFn: ((chatId: string, text: string) => Promise<string | undefined>) | null = null;

    /** 回调处理（到 Q5） */
    private callbackHandler: ((cb: SubagentCallback) => void) | null = null;

    constructor(chatId: string) {
        this.chatId = chatId;
    }

    /**
     * 注入发送函数
     */
    setSendFunction(fn: (chatId: string, text: string) => Promise<string | undefined>): void {
        this.sendFn = fn;
    }

    /**
     * 设置 callback handler
     */
    setCallbackHandler(handler: (cb: SubagentCallback) => void): void {
        this.callbackHandler = handler;
    }

    /**
     * 注入 LLM 配置和 persona
     */
    setLLMConfig(llmConfigs: LLMConfig[], persona: { name: string; description: string }, chatTitle?: string, isDirectMessage?: boolean): void {
        this.llmConfigs = llmConfigs;
        this.personaName = persona.name;
        this.personaDescription = persona.description;
        if (chatTitle) this.chatTitle = chatTitle;
        if (isDirectMessage !== undefined) this.isDirectMessage = isDirectMessage;
    }

    /**
     * 更新群组标题
     */
    setChatTitle(title: string): void {
        this.chatTitle = title;
    }

    /**
     * 注入任务上下文（话题摘要、人物背景等，授权前调用）
     */
    setTaskContext(ctx: {
        topicSummary?: string;
        personContext?: string;
        toneGuidance?: string;
    }): void {
        this.taskContext = ctx;
    }

    /**
     * 授权 FastPath
     */
    authorize(config: FastPathConfig): void {
        this.authorization = config;
        this.repliesSent = 0;
        this.sentMessages = [];

        // 渲染并缓存 task prompt（整个授权周期不变）
        this.cachedTaskPrompt = renderPrompt("FAST_PATH_TASK", buildFastPathTaskVariables(
            config,
            this.chatId,
            this.chatTitle || this.chatId,
            this.isDirectMessage,
            this.taskContext,
        ));

        log.info("authorize", {
            chatId: this.chatId,
            actions: config.preauthorizedActions,
            maxReplies: config.maxRepliesBeforeReauth,
            expiresAt: config.expiresAt,
        });
    }

    /**
     * 撤销 FastPath 授权
     */
    revoke(): void {
        if (this.authorization) {
            log.info("revoke", { chatId: this.chatId, repliesSent: this.repliesSent });
        }
        this.authorization = null;
        this.repliesSent = 0;
        this.sentMessages = [];
    }

    /**
     * 检查 FastPath 是否可用
     */
    isAuthorized(): boolean {
        if (!this.authorization) return false;

        // 检查过期
        if (new Date(this.authorization.expiresAt).getTime() < Date.now()) {
            log.info("isAuthorized: 已过期", { chatId: this.chatId });
            this.authorization = null;
            return false;
        }

        // 检查回复数
        if (this.repliesSent >= this.authorization.maxRepliesBeforeReauth) {
            log.info("isAuthorized: 回复数已用尽", { chatId: this.chatId, sent: this.repliesSent });
            this.authorization = null;
            return false;
        }

        return true;
    }

    /**
     * 处理一条消息，决定是否 FastPath 回复
     *
     * 处理逻辑：
     * 1. 检查授权状态
     * 2. 检查消息内容是否在授权范围内
     * 3. 生成回复（简单模板，完整 LLM 在 S5 集成）
     * 4. 检查 __SKIP__ 标记
     * 5. 发送并计数
     *
     * @returns 回复文本或 null（跳过）
     */
    async handle(event: FastPathEvent): Promise<string | null> {
        if (!this.isAuthorized()) {
            return null;
        }

        const auth = this.authorization!;

        // 检查是否在 blocked actions 中
        if (auth.blockedActions.some(a => event.text.toLowerCase().includes(a.toLowerCase()))) {
            log.debug("handle: 动作被阻止", { chatId: this.chatId, text: event.text.slice(0, 50) });
            return null;
        }

        // 生成回复（骨架，完整版由 LLM prompt 驱动）
        const reply = await this.generateReply(event, auth);

        // __SKIP__ 检查
        if (reply === "__SKIP__" || reply.includes("__SKIP__")) {
            log.debug("handle: __SKIP__", { chatId: this.chatId });
            return null;
        }

        // 实际发送
        let messageId: string | undefined;
        if (this.sendFn) {
            try {
                messageId = await this.sendFn(this.chatId, reply);
            } catch (err) {
                log.error("handle: 发送失败", { chatId: this.chatId, error: String(err) });

                // 报告错误 callback
                this.emitCallback(event, "ERROR", reply, String(err));
                return null;
            }
        }

        this.repliesSent++;
        this.sentMessages.push({ text: reply, timestamp: new Date().toISOString() });

        log.info("handle: 已发送", {
            chatId: this.chatId,
            repliesSent: this.repliesSent,
            max: auth.maxRepliesBeforeReauth,
        });

        // 报告 callback
        this.emitCallback(event, "COMPLETED", reply);

        // 检查是否用尽
        if (this.repliesSent >= auth.maxRepliesBeforeReauth) {
            log.info("handle: 回复数用尽，自动禁用", { chatId: this.chatId });
            this.authorization = null;
        }

        return reply;
    }

    /**
     * 获取当前状态
     */
    getStatus(): {
        authorized: boolean;
        repliesSent: number;
        maxReplies: number;
        expiresAt: string | null;
    } {
        return {
            authorized: this.isAuthorized(),
            repliesSent: this.repliesSent,
            maxReplies: this.authorization?.maxRepliesBeforeReauth ?? 0,
            expiresAt: this.authorization?.expiresAt ?? null,
        };
    }

    /**
     * 获取已发送消息列表
     */
    getSentMessages(): ReadonlyArray<{ text: string; timestamp: string }> {
        return this.sentMessages;
    }

    // ─── 内部方法 ───

    private async generateReply(event: FastPathEvent, auth: FastPathConfig): Promise<string> {
        // 尝试使用 LLM 生成回复 (subagent.md §12.2 ➆)
        // 3-layer prompt: system (静态 persona) → task (授权范围) → per-turn (触发消息 + 剩余额度)
        if (this.llmConfigs.length > 0) {
            try {
                // Layer 1: System prompt — 复用 sandbox 的 EXECUTION 模板
                const systemPrompt = renderPrompt("EXECUTION", {
                    personaName: this.personaName,
                    personaDescription: this.personaDescription,
                    apiTypeDefs: "",  // FastPath 不使用 sandbox API
                    agentSkillsBrief: getAgentSkillsBriefs(),
                });

                // Layer 2: Task prompt — 在 authorize() 时已缓存（含群组信息、话题摘要、人物背景）
                const taskPrompt = this.cachedTaskPrompt;

                // Layer 3: Per-turn (触发消息 + 剩余额度 + 已发送消息确认)
                const turnContent = buildFastPathTurnContent(
                    event,
                    this.repliesSent,
                    auth.maxRepliesBeforeReauth,
                    this.sentMessages.length > 0 ? this.sentMessages : undefined,
                );

                const messages: ChatMessage[] = [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: taskPrompt },
                    { role: "user", content: turnContent },
                ];

                const response = await callLLMWithFallback(
                    messages,
                    this.llmConfigs,
                    { caller: "fast-path", timeoutMs: resolveComponentTimeout("fast_path") },
                );

                return response.content.trim();
            } catch (err) {
                log.warn("generateReply: LLM 失败，fallback 到模板", { error: String(err) });
            }
        }

        // Fallback: 无 LLM 时使用简单模板
        for (const action of auth.preauthorizedActions) {
            if (event.text.toLowerCase().includes(action.toLowerCase())) {
                return `[FastPath:${auth.tonePreset}] ${action}`;
            }
        }
        return "__SKIP__";
    }

    private emitCallback(
        event: FastPathEvent,
        status: "COMPLETED" | "ERROR",
        reply: string,
        error?: string,
    ): void {
        if (!this.callbackHandler) return;

        const callback: SubagentCallback = {
            taskId: `fp-${event.messageId}`,
            chatId: this.chatId,
            chatTitle: this.chatTitle || undefined,
            executionType: "FAST_PATH",
            status,
            summary: `FastPath reply (${this.repliesSent}/${this.authorization?.maxRepliesBeforeReauth ?? 0})`,
            sentMessages: status === "COMPLETED" ? [{ text: reply, timestamp: new Date().toISOString() }] : undefined,
            error,
            durationMs: 0,
            createdAt: new Date().toISOString(),
        };

        this.callbackHandler(callback);
    }
}
