/**
 * code-act-executor.ts — per-group CodeAct 执行器
 *
 * 每个群组的 CodeAct 执行器：
 * - 持有独立 LLM session（ChatMessage[] 对话历史）
 * - 通过 SandboxPool 获取 sandbox 实例
 * - 执行主 Agent 分派的 CodeActReplyTask
 * - 串行执行（通过 Q4 执行队列）
 * - 产出 SubagentCallback 到 Q5
 *
 * 参考设计：subagent.md §3.2, subtask.md S3.2
 */

import type {
    CodeActReplyTask,
    SubagentCallback,
    GroupContextPackage,
} from "./types.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import { SandboxPool } from "../sandbox/sandbox-pool.js";
import { NotificationCenter } from "../event/notification-center.js";
import { runCodeActSession, SentMessageCollector, type SessionResult, type SentMessageRecord } from "../sandbox/session-runner.js";
import { renderPrompt } from "../main-agent/prompt-renderer.js";
import type { LLMConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import { createLogger } from "../core/logger.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldCompact, compact as contextManagerCompact } from "../memory-v2/context-manager.js";
import { formatTsForDisplay } from "../core/timezone.js";

const log = createLogger("code-act-executor");

// ─── API 类型定义缓存 ───
let _apiTypeDefsCache: string | null = null;

/**
 * 加载 API 类型定义文件，拼接为单个字符串注入到执行 prompt
 */
function loadApiTypeDefs(): string {
    if (_apiTypeDefsCache) return _apiTypeDefsCache;

    try {
        const thisFile = fileURLToPath(import.meta.url);
        const scenesDir = join(dirname(thisFile), "..", "scenes");

        const files = [
            join(scenesDir, "telegram.d.ts"),
            join(scenesDir, "memory.d.ts"),
            join(scenesDir, "shared", "runtime.d.ts"),
            join(scenesDir, "shared", "actions.d.ts"),
            join(scenesDir, "shared", "skills.d.ts"),
        ];

        const parts: string[] = [];
        for (const f of files) {
            if (existsSync(f)) {
                parts.push(`// --- ${f.split("/").pop()} ---\n${readFileSync(f, "utf-8")}`);
            }
        }
        _apiTypeDefsCache = parts.join("\n\n");
    } catch {
        _apiTypeDefsCache = "// API type definitions not available";
    }
    return _apiTypeDefsCache;
}

/** CodeActExecutor 配置 */

/**
 * 剥离 task prompt 中的冗余大段原文，用于保存到 session 历史时精简体积。
 * 被剥离的内容在下次执行时会从 memory.getRecentMessages() 重新获取。
 */
function stripVerboseSections(content: string): string {
    let result = content;
    // 剥离 "## 目标消息" 区段（从标题到下一个 ## 或文档末尾）
    result = result.replace(
        /## 目标消息\n[\s\S]*?(?=\n## |$)/,
        "## 目标消息\n[见当前任务的消息原文]"
    );
    // 剥离 "## 相关人物背景" 区段
    result = result.replace(
        /## 相关人物背景\n[\s\S]*?(?=\n## |$)/,
        "## 相关人物背景\n[见当前任务]"
    );
    return result;
}
export interface CodeActExecutorConfig {
    /** 单次执行最大超时 (ms)。默认 60000 */
    maxExecutionTimeMs: number;
    /** session 最大消息数（超过后 compact）。默认 100 */
    maxSessionMessages: number;
}

const DEFAULT_EXECUTOR_CONFIG: CodeActExecutorConfig = {
    maxExecutionTimeMs: 60_000,
    maxSessionMessages: 100,
};

/** 简化的 ChatMessage 用于 session 持久化 */
export interface SessionMessage {
    role: "system" | "user" | "assistant";
    content: string;
    timestamp: string;
}

/** 每次 session 执行中发出的消息记录（用于 compact 时保留） */
export interface SessionExecutionRecord {
    taskId: string;
    timestamp: string;
    endReason: string;
    turns: number;
    sentMessages: SentMessageRecord[];
    /** assistant 的思考摘要（去掉代码块后的文本） */
    thinkingSummary: string;
}

/**
 * CodeActExecutor — per-group CodeAct 执行器
 *
 * 注意：Sandbox 实例由 SandboxPool 管理，此处只持有引用。
 * 实际的 runCodeActSession 调用在 S5 主循环中由 main-agent 编排。
 */
export class CodeActExecutor {
    readonly chatId: string;
    private config: CodeActExecutorConfig;

    /** 独立对话历史（跨 session 保留） */
    session: SessionMessage[] = [];

    /** 每次 session 的执行记录（用于 compact 时提取摘要） */
    private executionRecords: SessionExecutionRecord[] = [];

    /** 任务执行队列 (Q4) */
    private taskQueue: CodeActReplyTask[] = [];
    /** 是否正在处理任务 */
    private processing = false;

    /** 上次 compact 时间 */
    lastCompactedAt: string | null = null;

    /** Agent 最后回复时间戳（由 GroupSubagent 同步写入，持久化到 session JSON） */
    lastAgentReplyAt: number = 0;

    /** 执行计数 */
    private executionCount = 0;

    /** Callback handler（由 GroupSubagent 或 S8 集成时注入） */
    private callbackHandler: ((cb: SubagentCallback) => void) | null = null;

    /** 层 2: 消息前送缓冲区 — NC hook 在 session 执行期间推入新消息 */
    private pendingMessages: Array<{ id: string; sender: string; text: string; timestamp: string }> = [];

    /** Memory 引用（层 1 用于刷新目标消息） */
    private memory: MemoryStoreV2 | null = null;

    constructor(chatId: string, config?: Partial<CodeActExecutorConfig>) {
        this.chatId = chatId;
        this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
    }

    /**
     * 设置 callback handler（回调到 Q5）
     */
    setCallbackHandler(handler: (cb: SubagentCallback) => void): void {
        this.callbackHandler = handler;
    }

    /**
     * 注入运行时依赖（Sandbox + NC + LLM）
     *
     * Fix 9: 完整的 Sandbox 集成。调用后 execute() 将使用
     * SandboxPool.acquire(chatId) 获取独立 sandbox 实例，
     * 然后通过 runCodeActSession() 执行 CodeAct 多轮交互。
     * 未注入时 execute() 使用骨架逻辑（用于测试）。
     *
     * 参考设计：subagent.md §3.2
     */
    private sandboxPool: SandboxPool | null = null;
    private nc: NotificationCenter | null = null;
    private llmConfig: LLMConfig | null = null;
    private sessionsDir: string = "workspace/sessions";
    /** 持久化文件路径（由外部注入） */
    private sessionFilePath: string | null = null;
    private personaName: string = "赛博群友";
    private personaDescription: string = "";

    setDependencies(
        sandboxPool: SandboxPool,
        nc: NotificationCenter,
        llmConfig: LLMConfig,
        sessionsDir?: string,
        persona?: { name: string; description: string },
        memory?: MemoryStoreV2,
    ): void {
        this.sandboxPool = sandboxPool;
        this.nc = nc;
        this.llmConfig = llmConfig;
        if (sessionsDir) this.sessionsDir = sessionsDir;
        if (persona) {
            this.personaName = persona.name;
            this.personaDescription = persona.description;
        }
        if (memory) this.memory = memory;
        log.info("setDependencies", { chatId: this.chatId, hasSandboxPool: true });
    }

    /**
     * 设置持久化文件路径
     */
    setSessionFilePath(filePath: string): void {
        this.sessionFilePath = filePath;
    }

    /**
     * 获取持久化文件路径
     */
    getSessionFilePath(): string | null {
        return this.sessionFilePath;
    }

    /** 检查是否已注入依赖 */
    hasDependencies(): boolean {
        return this.sandboxPool !== null && this.nc !== null && this.llmConfig !== null;
    }

    /**
     * 向 Q4 入队一个任务
     */
    enqueue(task: CodeActReplyTask): void {
        this.taskQueue.push(task);
        log.debug("enqueue", { chatId: this.chatId, taskId: task.taskId, queueSize: this.taskQueue.length });

        // 尝试开始处理
        this.processNext();
    }

    /**
     * 执行一个 CodeAct 任务（核心方法）
     *
     * 当前实现：
     * 1. 记录任务上下文到 session
     * 2. 产出 callback
     *
     * 完整实现在 S5 主循环中：会调用 SandboxPool.acquire(),
     * runCodeActSession() 等。此处提供结构骨架。
     */
    async execute(task: CodeActReplyTask): Promise<SubagentCallback> {
        const startTime = Date.now();
        this.executionCount++;

        log.info("execute: 开始", {
            chatId: this.chatId,
            taskId: task.taskId,
            replyMode: task.replyMode,
            decisionsCount: task.decisions.length,
            hasSandbox: this.hasDependencies(),
        });

        // 记录 task 上下文到 session
        this.session.push({
            role: "user",
            content: `[TASK ${task.taskId}] ${JSON.stringify({
                replyMode: task.replyMode,
                decisions: task.decisions,
                topicDigests: task.contextSnapshot.topicDigests,
            })}`,
            timestamp: task.createdAt,
        });

        // 检查 session 长度
        if (this.session.length > this.config.maxSessionMessages) {
            await this.compactSession();
        }

        try {
            // ═══ Fix 9: 实际的 Sandbox 执行逻辑 ═══
            if (this.hasDependencies()) {
                return await this.executeWithSandbox(task, startTime);
            }

            // Fallback: 无依赖时使用骨架逻辑（测试用）
            return this.executeSkeletonFallback(task, startTime);

        } catch (err) {
            const durationMs = Date.now() - startTime;
            const callback: SubagentCallback = {
                taskId: task.taskId,
                chatId: this.chatId,
                executionType: "CODEACT",
                status: "ERROR",
                summary: `Execution failed: ${String(err)}`,
                error: String(err),
                durationMs,
                createdAt: new Date().toISOString(),
            };

            log.error("execute: 失败", { chatId: this.chatId, taskId: task.taskId, error: String(err) });
            return callback;
        }
    }

    /**
     * 实际的 Sandbox 执行路径（Fix 9 + Fix 1/2/3）
     *
     * 1. 渲染 Prompt ➞ 模板
     * 2. 注入历史 session 上下文（Fix 2）
     * 3. 注册 SentMessageCollector（Fix 1）
     * 4. 调用 runCodeActSession()
     * 5. 保存 session 结果到 this.session（Fix 2）
     * 6. 解析 SessionResult
     */
    private async executeWithSandbox(
        task: CodeActReplyTask,
        startTime: number,
    ): Promise<SubagentCallback> {
        // 1. 提取 contextSnapshot 中的执行上下文字段（dispatch-handler 类型安全注入）
        const ctx = task.contextSnapshot;
        const topicSummary = ctx.topicSummary ?? "";
        const personContext = ctx.personContext ?? "";
        const toneGuidance = ctx.toneGuidance ?? "";
        const contentDirection = ctx.contentDirection ?? task.decisions.map(d => d.contentDirection ?? "").filter(Boolean).join("; ");

        // 2. 格式化目标消息（含 reply-to 关系 + 媒体描述）
        const imageParts: Array<{ url: string }> = [];
        const targetMessages = (ctx.recentMessages ?? []).map(
            (m) => {
                const replyTag = m.replyTo ? ` (↩ reply to ${m.replyTo})` : "";
                let textPart = m.text ?? "";

                // 注入媒体描述（路径 B/C）
                if (m.processedMedia && m.processedMedia.length > 0) {
                    for (const pm of m.processedMedia) {
                        if (pm.description) {
                            // 如果文本中有占位符则替换，否则追加
                            textPart = textPart + ` ${pm.description}`;
                        }
                        if (pm.base64Data && pm.mimeType) {
                            // 路径 A: 收集 base64 图片，稍后注入 LLM messages
                            imageParts.push({
                                url: `data:${pm.mimeType};base64,${pm.base64Data}`,
                            });
                            textPart = textPart.replace("[📷 图片]", `[📷 图片${imageParts.length}]`);
                        }
                    }
                }

                return `[${formatTsForDisplay(m.timestamp) ?? ""}] [msgId:${m.id ?? "?"}] ${m.sender ?? "?"}${replyTag}: ${textPart}`;
            }
        ).join("\n") || "(无目标消息原文)";

        // 3. 格式化决策
        const formattedDecisions = task.decisions.map(d =>
            `- [${d.action}] ${d.contentDirection ?? d.reason ?? ""} (topicId: ${d.topicId ?? "N/A"}, confidence: ${d.confidence})`
        ).join("\n");

        // 4. 渲染系统 prompt (subagent.md §12.2 ➎ — 稳定部分，可缓存)
        const systemVars = {
            personaName: this.personaName,
            personaDescription: this.personaDescription,
            apiTypeDefs: loadApiTypeDefs(),
        };
        const systemPrompt = renderPrompt("EXECUTION", systemVars);

        // 5. 渲染任务 prompt (每次任务不同)
        const taskVars = {
            chatId: this.chatId,
            chatTitle: ctx.chatTitle ?? ctx.groupModel?.chatTitle ?? this.chatId,
            taskId: task.taskId,
            replyMode: task.replyMode,
            targetMessages,
            topicSummary,
            personContext,
            contentDirection,
            toneGuidance,
            decisions: formattedDecisions,
        };
        const taskPrompt = renderPrompt("EXECUTION_TASK", taskVars);

        // ═══ Fix 2: 构建 messages 时注入历史 session 上下文 ═══
        const messages: ChatMessage[] = [
            { role: "system", content: systemPrompt },
        ];

        // 注入历史 session（如果有）
        if (this.session.length > 0) {
            // 先检查是否需要 compact
            if (this.session.length > this.config.maxSessionMessages) {
                await this.compactSession();
            }
            // 将历史 session 消息作为 LLM 上下文注入
            for (const msg of this.session) {
                messages.push({ role: msg.role, content: msg.content });
            }
        }

        // 当前任务 prompt 放在最后（路径 A 时附加图片）
        messages.push({
            role: "user",
            content: taskPrompt,
            ...(imageParts.length > 0 ? { imageParts } : {}),
        });

        // ═══ Fix 1: 注册 SentMessageCollector ═══
        // 清空 pending buffer（层 1 已经刷新了 recentMessages，此处 drain 掉残留）
        this.pendingMessages = [];

        const sentCollector = new SentMessageCollector();
        const sandbox = await this.sandboxPool!.acquire(this.chatId);

        // 注册 notify 监听器收集已发消息
        const notifyListener = (event: Record<string, unknown>) => {
            // 按 chatId 过滤，只收集本群组的消息
            const eventChatId = String(event.chatId ?? "");
            if (eventChatId === this.chatId || eventChatId === "") {
                sentCollector.collect(event);
            }
        };
        sandbox.on("notify", notifyListener);

        log.info("executeWithSandbox: 开始 CodeAct session", {
            chatId: this.chatId,
            taskId: task.taskId,
            historyMessages: this.session.length,
        });

        let sessionResult: SessionResult;
        try {
            sessionResult = await runCodeActSession(
                messages,
                sandbox,
                this.nc!,
                this.llmConfig!,
                this.sessionsDir,
                this.config.maxExecutionTimeMs,
                sentCollector, // Fix 1: 传入 collector
                () => this.drainPendingMessages(), // 层 2: turn 间消息注入
            );
        } finally {
            // 清理监听器，释放 sandbox
            sandbox.removeListener("notify", notifyListener);
            this.sandboxPool!.release(this.chatId);
        }

        const durationMs = Date.now() - startTime;

        // ═══ Fix 2: 保存本次 session 的完整对话到 this.session ═══
        // 跳过 system prompt（this.session 不需要重复存系统 prompt）
        // 跳过已有的历史消息（只保存新产生的对话）
        const historyOffset = 1 + this.session.length; // 1 for system prompt + existing history
        const newMessages = sessionResult.messages.slice(historyOffset);
        for (const msg of newMessages) {
            let content = msg.content;
            // 对 user 消息剥离冗余原文段落，避免历史 session 中消息/人物/发送确认重复
            if (msg.role === "user") {
                content = stripVerboseSections(content);
            }
            this.session.push({
                role: msg.role as "system" | "user" | "assistant",
                content,
                timestamp: new Date().toISOString(),
            });
        }

        // 记录 execution record（用于 compact）
        const thinkingSummary = sessionResult.turns
            .map(t => t.thinking)
            .filter(Boolean)
            .join(" | ")
            .slice(0, 500);

        this.executionRecords.push({
            taskId: task.taskId,
            timestamp: new Date().toISOString(),
            endReason: sessionResult.endReason,
            turns: sessionResult.turns.length,
            sentMessages: [...sentCollector.allSent],
            thinkingSummary,
        });

        // 5. 构建 callback
        const isError = sessionResult.endReason === "error";
        const callback: SubagentCallback = {
            taskId: task.taskId,
            chatId: this.chatId,
            executionType: "CODEACT",
            status: isError ? "ERROR" : "COMPLETED",
            summary: `CodeAct session ${sessionResult.sessionId}: ${sessionResult.endReason}, ` +
                `${sessionResult.turns.length} turns, ${sentCollector.allSent.length} messages sent`,
            replyContent: sessionResult.turns
                .filter((t: any) => t.role === "assistant" && t.content)
                .map((t: any) => t.content)
                .join("\n") || undefined,
            sentMessages: sentCollector.allSent.length > 0
                ? sentCollector.allSent.map(m => ({ text: m.text, timestamp: m.timestamp }))
                : undefined,
            tokensUsed: (sessionResult as any).tokensUsed ?? undefined,
            error: sessionResult.error,
            durationMs,
            createdAt: new Date().toISOString(),
        };

        log.info("executeWithSandbox: 完成", {
            chatId: this.chatId,
            taskId: task.taskId,
            sessionId: sessionResult.sessionId,
            endReason: sessionResult.endReason,
            turns: sessionResult.turns.length,
            sentMessages: sentCollector.allSent.length,
            sentMessagePreviews: sentCollector.allSent.map(m =>
                m.text.length > 60 ? m.text.slice(0, 60) + "..." : m.text
            ),
            sessionSize: this.session.length,
            durationMs,
        });

        return callback;
    }

    /**
     * 骨架 fallback（无依赖注入时，用于测试）
     */
    private executeSkeletonFallback(
        task: CodeActReplyTask,
        startTime: number,
    ): SubagentCallback {
        const durationMs = Date.now() - startTime;

        this.session.push({
            role: "assistant",
            content: `[COMPLETED] Task ${task.taskId} executed in ${durationMs}ms (skeleton fallback)`,
            timestamp: new Date().toISOString(),
        });

        const callback: SubagentCallback = {
            taskId: task.taskId,
            chatId: this.chatId,
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: `Executed ${task.replyMode} task with ${task.decisions.length} decisions (skeleton)`,
            replyContent: task.decisions.map(d => d.contentDirection ?? "").filter(Boolean).join("\n") || undefined,
            tokensUsed: 0,
            durationMs,
            createdAt: new Date().toISOString(),
        };

        log.info("execute: 完成 (skeleton)", { chatId: this.chatId, taskId: task.taskId, durationMs });
        return callback;
    }

    /**
     * 获取 Q4 队列大小
     */
    getQueueSize(): number {
        return this.taskQueue.length;
    }

    /**
     * 获取 session 大小
     */
    getSessionSize(): number {
        return this.session.length;
    }

    /**
     * 获取执行计数
     */
    getExecutionCount(): number {
        return this.executionCount;
    }

    /**
     * 是否正在处理
     */
    isProcessing(): boolean {
        return this.processing;
    }

    // ─── 消息前送方法 ───

    /**
     * 层 2: 推入一条新消息到 pending buffer
     * 由 NC hook 在 session 执行期间调用
     */
    pushPendingMessage(msg: { id: string; sender: string; text: string; timestamp: string }): void {
        this.pendingMessages.push(msg);
        log.debug("pushPendingMessage", {
            chatId: this.chatId,
            msgId: msg.id,
            sender: msg.sender,
            textPreview: msg.text.length > 50 ? msg.text.slice(0, 50) + "..." : msg.text,
            bufferSize: this.pendingMessages.length,
        });
    }

    /**
     * 层 2: 取出并格式化 pending messages，清空 buffer
     * 由 session-runner 在每个 turn 的 LLM 调用前调用
     * @returns 格式化的消息文本，无新消息时返回 null
     */
    drainPendingMessages(): string | null {
        if (this.pendingMessages.length === 0) return null;
        const drained = this.pendingMessages.splice(0);
        const lines = drained.map(m =>
            `[${formatTsForDisplay(m.timestamp)}] ${m.sender}: ${m.text}`
        ).join("\n");
        log.info("drainPendingMessages", {
            chatId: this.chatId,
            count: drained.length,
        });
        return `[📩 新消息到达]\n${lines}`;
    }

    /**
     * 层 1: 刷新 task 的目标消息列表
     * 在 processNext() 取出 task 后、execute() 前调用
     */
    private refreshTaskMessages(task: CodeActReplyTask): void {
        if (!this.memory) return;
        try {
            const freshMessages = this.memory.getRecentMessages(this.chatId, 20);
            if (freshMessages.length === 0) return;

            const msgIdToName = new Map<string, string>();
            for (const m of freshMessages) {
                msgIdToName.set(m.messageId, m.displayName || `(uid:${m.userId})`);
            }

            task.contextSnapshot.recentMessages = freshMessages.map((m: any) => ({
                id: String(m.messageId ?? m.id ?? ""),
                sender: String(m.displayName ?? m.sender ?? m.userId ?? "?"),
                text: String(m.text ?? ""),
                timestamp: String(m.timestamp ?? ""),
                replyTo: m.replyToMessageId
                    ? (msgIdToName.get(m.replyToMessageId) ?? `msg#${m.replyToMessageId}`)
                    : undefined,
                mediaType: m.mediaType ?? undefined,
                mediaInfo: m.mediaInfo ?? undefined,
            }));

            log.info("refreshTaskMessages: 已刷新目标消息", {
                chatId: this.chatId,
                taskId: task.taskId,
                messageCount: task.contextSnapshot.recentMessages.length,
            });
        } catch (err) {
            log.warn("refreshTaskMessages: 刷新失败", {
                chatId: this.chatId,
                taskId: task.taskId,
                error: String(err),
            });
        }
    }

    /**
     * 清空 session（用于测试）
     */
    clearSession(): void {
        this.session = [];
        this.lastCompactedAt = null;
    }

    // ─── 内部方法 ───

    private async processNext(): Promise<void> {
        if (this.processing) return;
        if (this.taskQueue.length === 0) return;

        this.processing = true;

        try {
            while (this.taskQueue.length > 0) {
                const task = this.taskQueue.shift()!;

                // 层 1: 执行前刷新目标消息
                this.refreshTaskMessages(task);

                const callback = await this.execute(task);

                // 通知 callback handler (Q5)
                if (this.callbackHandler) {
                    this.callbackHandler(callback);
                }

                // 每次任务完成后自动持久化 session
                this.saveSession();
            }
        } finally {
            this.processing = false;
        }
    }

    // ─── 持久化方法 ───

    /**
     * 将 session 状态持久化到磁盘
     *
     * 保存内容：session 历史、executionRecords、executionCount、lastCompactedAt
     * 文件格式：JSON，路径由 sessionFilePath 决定
     */
    saveSession(): void {
        if (!this.sessionFilePath) return;

        try {
            const dir = dirname(this.sessionFilePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            const state = {
                chatId: this.chatId,
                session: this.session,
                executionRecords: this.executionRecords,
                executionCount: this.executionCount,
                lastCompactedAt: this.lastCompactedAt,
                lastAgentReplyAt: this.lastAgentReplyAt,
                savedAt: new Date().toISOString(),
            };

            writeFileSync(this.sessionFilePath, JSON.stringify(state, null, 2), "utf-8");
            log.debug("saveSession: 已保存", {
                chatId: this.chatId,
                sessionSize: this.session.length,
                executionCount: this.executionCount,
                path: this.sessionFilePath,
            });
        } catch (err) {
            log.warn("saveSession: 保存失败", {
                chatId: this.chatId,
                error: String(err),
            });
        }
    }

    /**
     * 从磁盘恢复 session 状态
     *
     * @param filePath - 可选，覆盖当前 sessionFilePath
     * @returns 是否成功恢复
     */
    loadSession(filePath?: string): boolean {
        const path = filePath ?? this.sessionFilePath;
        if (!path) return false;

        // 同时设置 sessionFilePath
        this.sessionFilePath = path;

        if (!existsSync(path)) return false;

        try {
            const raw = readFileSync(path, "utf-8");
            const state = JSON.parse(raw);

            if (state.chatId && state.chatId !== this.chatId) {
                log.warn("loadSession: chatId 不匹配", {
                    expected: this.chatId,
                    got: state.chatId,
                });
                return false;
            }

            this.session = Array.isArray(state.session) ? state.session : [];
            this.executionRecords = Array.isArray(state.executionRecords) ? state.executionRecords : [];
            this.executionCount = typeof state.executionCount === "number" ? state.executionCount : 0;
            this.lastCompactedAt = state.lastCompactedAt ?? null;
            this.lastAgentReplyAt = typeof state.lastAgentReplyAt === "number" ? state.lastAgentReplyAt : 0;

            log.info("loadSession: 已恢复", {
                chatId: this.chatId,
                sessionSize: this.session.length,
                executionCount: this.executionCount,
                savedAt: state.savedAt,
            });
            return true;
        } catch (err) {
            log.warn("loadSession: 恢复失败", {
                chatId: this.chatId,
                path,
                error: String(err),
            });
            return false;
        }
    }

    /**
     * Fix 3: 两层智能 Compact
     *
     * Layer 1 (快速/确定性): 扫描 session 历史和 executionRecords，
     * 生成结构化摘要，保留操作+已发消息+思考要点，丢弃代码块。
     *
     * Layer 2 (LLM/token-budget): 如果 compact 后 token 总量仍超预算，
     * 调用 context-manager.compact() 生成 LLM Context Briefing，
     * 支持话题保护和 reply chain 保护。
     */
    private async compactSession(): Promise<void> {
        const keep = Math.max(4, Math.floor(this.config.maxSessionMessages * 0.4));
        if (this.session.length <= keep) return;

        // ═══ Layer 1: 结构化快速 compact ═══
        // 从 executionRecords 构建摘要
        const recordSummaries: string[] = [];
        for (const rec of this.executionRecords) {
            const sentPart = rec.sentMessages.length > 0
                ? `\n  已发消息: ${rec.sentMessages.map(m => `"${m.text.length > 80 ? m.text.slice(0, 80) + '...' : m.text}"`).join(" / ")}`
                : "";
            const thinkingPart = rec.thinkingSummary
                ? `\n  思路: ${rec.thinkingSummary.slice(0, 200)}`
                : "";
            recordSummaries.push(
                `- Task ${rec.taskId} (${rec.timestamp}): ${rec.endReason}, ${rec.turns} turns${sentPart}${thinkingPart}`
            );
        }

        // 从 session 中提取所有 [📤 已发送消息确认] 段落（fallback，兜底 executionRecords 之外的）
        const sentConfirmations: string[] = [];
        for (const msg of this.session) {
            if (msg.role === "user" && msg.content.includes("[📤 已发送消息确认]")) {
                const lines = msg.content.split("\n").filter(l => l.startsWith("- 发送到"));
                sentConfirmations.push(...lines);
            }
        }

        // 构建 compact 摘要
        let compactContent = `[SESSION_HISTORY_COMPACT]\n== 之前执行了 ${this.executionCount} 次任务 ==`;
        if (recordSummaries.length > 0) {
            compactContent += `\n${recordSummaries.join("\n")}`;
        }
        if (sentConfirmations.length > 0 && recordSummaries.length === 0) {
            // 如果没有 executionRecords（旧数据），用 session 中提取的兜底
            compactContent += `\n\n== 历史已发消息 ==\n${sentConfirmations.join("\n")}`;
        }

        const compactMsg: SessionMessage = {
            role: "user",
            content: compactContent,
            timestamp: new Date().toISOString(),
        };

        // 保留最近 keep 条消息 + compact 摘要
        this.session = [compactMsg, ...this.session.slice(-keep)];
        // 清理已被 compact 的 executionRecords（保留最近 3 条）
        if (this.executionRecords.length > 3) {
            this.executionRecords = this.executionRecords.slice(-3);
        }
        this.lastCompactedAt = new Date().toISOString();
        log.debug("compactSession Layer 1", {
            chatId: this.chatId,
            remaining: this.session.length,
            executionRecords: this.executionRecords.length,
        });

        // ═══ Layer 2: token-budget LLM compact (context-manager) ═══
        if (this.llmConfig) {
            const chatMessages: ChatMessage[] = this.session.map(m => ({
                role: m.role,
                content: m.content,
            }));
            if (shouldCompact(chatMessages)) {
                log.info("compactSession Layer 2: token 仍超预算，调用 context-manager compact", {
                    chatId: this.chatId,
                    messageCount: chatMessages.length,
                });
                try {
                    const compacted = await contextManagerCompact(chatMessages, this.llmConfig);
                    this.session = compacted.map(m => ({
                        role: m.role as SessionMessage["role"],
                        content: m.content,
                        timestamp: new Date().toISOString(),
                    }));
                    log.info("compactSession Layer 2 完成", {
                        chatId: this.chatId,
                        afterMessages: this.session.length,
                    });
                } catch (err) {
                    log.warn("compactSession Layer 2 失败，保留 Layer 1 结果", {
                        chatId: this.chatId,
                        error: String(err),
                    });
                }
            }
        }
    }
}
