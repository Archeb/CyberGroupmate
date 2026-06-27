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
    ActiveUserProfile,
    CodeActReplyTask,
    PostTaskReactionMessage,
    SubagentCallback,
} from "./types.js";
import type { FactSearchResult, InteractionSearchResult, MemoryStoreV2, RecentMessageEntry } from "../memory-v2/index.js";
import { SandboxPool } from "../sandbox/sandbox-pool.js";
import { NotificationCenter } from "../event/notification-center.js";
import { runCodeActSession, SentMessageCollector, type SessionResult, type SentMessageRecord } from "../sandbox/session-runner.js";
import { loadModuleRegistry, lookupFullDocs, generateBriefOverview, mergeModuleRegistries, type ModuleEntry } from "../sandbox/modules/module-registry.js";
import { getMcpModuleEntries } from "../sandbox/modules/mcp-bridge/index.js";
import { parseAllSkillDocs } from "../sandbox/skill-loader.js";
import { buildPrefixMap } from "../sandbox/api-intent-extractor.js";
import { renderPrompt } from "../context-engine/template-engine.js";
import { deriveChatType } from "../context-engine/prompt-renderer-utils.js";
import { ContextEngine } from "../context-engine/context-engine.js";
import { EXECUTOR_FOOTER_TEXT, getExecutorTaskProviders, type ExecutorResolveContext } from "../context-engine/providers/executor-providers.js";
import type { LLMConfig, VisionConfig } from "../core/config.js";
import { resolveComponentProfiles, loadConfig } from "../core/config.js";
import {
    enrichMessages,
    formatMessageLine,
    resolveReplyText,
    type EnrichedResult,
    type RawMessage,
    type StickerDescriptionLookup,
} from "../core/message-enricher.js";
import type { MediaDownloader } from "../core/media-downloader.js";
import type { ChatMessage, ImagePart } from "../core/llm.js";
import { createLogger } from "../core/logger.js";
import { formatTsForPrompt, normalizeProgrammaticTimestamps, sanitizePromptTimestamps } from "../core/timezone.js";
import { getRawId, ensureCompositeId, getPlatform, getGroupModelKey } from "../core/chat-id.js";
import type { GlobalState } from "../main-agent/global-state.js";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldCompact, compact as contextManagerCompact } from "../memory-v2/context-manager.js";
import { DEFAULT_BANNED_WORDS } from "../core/banned-words.js";
import { registerPendingMessageSignal, type PendingMessageSignal } from "../sandbox/send-interrupt.js";

const log = createLogger("code-act-executor");

type PromptFact = FactSearchResult & {
    displayName?: string;
    subjectLabel?: string;
    sourceChatLabel?: string;
};

type PromptInteraction = InteractionSearchResult & {
    displayName?: string;
    userLabel?: string;
    chatLabel?: string;
};

function formatUserLabel(memory: MemoryStoreV2 | undefined, userId: string, fallbackName?: string): string {
    const identity = memory?.getPersonIdentity(userId);
    const name = identity?.displayName?.trim() || fallbackName?.trim() || userId;
    return `${name}(${userId})`;
}

function formatChatLabel(memory: MemoryStoreV2 | undefined, chatId: string, fallbackTitle?: string | null): string {
    const model = memory?.getGroupModel(getGroupModelKey(chatId));
    const title = model?.chatTitle?.trim() || fallbackTitle?.trim() || chatId;
    return `${title}(${chatId})`;
}

function formatFactForPrompt(fact: PromptFact, memory: MemoryStoreV2 | undefined): string {
    const subject = fact.subjectLabel ?? formatUserLabel(memory, fact.subject, fact.displayName);
    const source = fact.sourceChatId
        ? formatChatLabel(memory, fact.sourceChatId, fact.sourceChatTitle)
        : fact.sourceChatLabel ?? fact.sourceChatTitle ?? undefined;
    const sourceParts = [
        source ? `来源: ${source}` : "",
        fact.sourceTopicLabel ? `话题: ${fact.sourceTopicLabel}` : "",
        fact.observedAt ? `观察时间: ${formatTsForPrompt(fact.observedAt)}` : "",
        fact.visibility ? `visibility=${fact.visibility}` : "",
        fact.sensitivity ? `sensitivity=${fact.sensitivity}` : "",
    ].filter(Boolean).join("；");
    return `- [${subject} · ${fact.category}] ${fact.content}${sourceParts ? ` (${sourceParts})` : ""}`;
}

function formatInteractionForPrompt(item: PromptInteraction, memory: MemoryStoreV2 | undefined): string {
    const user = item.userLabel ?? formatUserLabel(memory, item.userId, item.displayName);
    const source = item.chatLabel ?? formatChatLabel(memory, item.chatId);
    return `- [${formatTsForPrompt(item.timestamp)}] ${user} @ ${source}: ${item.summary} (${item.sentiment}, type=${item.type}, significance=${item.significance})`;
}

function hasProfileIdentity(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const profile = value as Record<string, unknown>;
    return [profile.userLabel, profile.displayName, profile.userId]
        .some(field => typeof field === "string" && field.trim().length > 0);
}

function sanitizeActiveUserProfiles(profiles: unknown): ActiveUserProfile[] {
    return Array.isArray(profiles)
        ? profiles.filter((profile): profile is ActiveUserProfile => hasProfileIdentity(profile))
        : [];
}

function looksLikePersonProfileContext(rawContext: string | undefined): boolean {
    const trimmed = rawContext?.trim();
    if (!trimmed) return false;

    try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed.some(hasProfileIdentity);
        }
        return hasProfileIdentity(parsed);
    } catch {
        return true;
    }
}

function formatPendingMessageLine(message: PostTaskReactionMessage, stickerDescriptionLookup?: StickerDescriptionLookup): string {
    return formatMessageLine({
        id: message.messageId,
        sender: message.sender,
        text: message.text,
        timestamp: message.timestamp,
        replyTo: message.replyToMessageId ? `msg#${message.replyToMessageId}` : undefined,
        replyToMsgId: message.replyToMessageId,
        mediaType: message.mediaType,
        mediaInfo: message.mediaInfo,
    }, {
        includeMediaTags: true,
        stickerDescriptionLookup,
    });
}

function findLatestDirectAttentionMessage(messages: PostTaskReactionMessage[]): PostTaskReactionMessage | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.isDirectAttention) {
            return messages[index];
        }
    }
    return undefined;
}

function formatPendingMessages(messages: PostTaskReactionMessage[], stickerDescriptionLookup?: StickerDescriptionLookup): string {
    const lines = messages.map((message) =>
        formatMessageLine({
            id: message.messageId,
            sender: message.sender,
            text: message.text,
            timestamp: message.timestamp,
            replyTo: message.replyToMessageId ? `msg#${message.replyToMessageId}` : undefined,
            replyToMsgId: message.replyToMessageId,
            mediaType: message.mediaType,
            mediaInfo: message.mediaInfo,
        }, { includeMediaTags: true, stickerDescriptionLookup })
    ).join("\n");
    return `[📩 新消息到达]\n${lines}`;
}

function formatMidTurnDirectAttentionPrompt(
    messages: PostTaskReactionMessage[],
    directReason: string,
    stickerDescriptionLookup?: StickerDescriptionLookup,
): string {
    const lines = messages.map((message) => formatPendingMessageLine(message, stickerDescriptionLookup));
    return [
        "[📩 新消息到达]",
        ...lines,
        "",
        `[mid-turn direct attention: ${directReason}] 这些消息发生在你处理当前任务期间，其中有人直接叫住你、回复你或提及你。请结合当前会话、刚才的执行结果和上面所有尚未处理的新消息判断是否需要调整下一步行动或直接回复；需要时在下一轮自然处理，不需要则继续当前任务。`,
    ].join("\n");
}

function formatContinuationPromptFromEnrichedMessages(
    formattedMessages: string,
    directReason: string,
    classifierReason?: string,
): string {
    return [
        "[📩 新消息到达]",
        formattedMessages,
        "",
        `[post-task direct attention: ${directReason}]${classifierReason ? ` 判定原因: ${classifierReason}` : ""} 请基于上下文决定如何行动。`,
    ].join("\n");
}

type PendingMessageDrainSource = "observation" | "turn";

// ─── API 概览缓存 ───
const _apiBriefCache = new Map<string, string>();

/** 模块注册表缓存（运行时错误后文档注入用） */
let _moduleRegistryCache: ModuleEntry[] | null = null;

/**
 * 刷新模块注册表缓存（合并内置模块 + TS Skills + MCP 动态模块）。
 * 当 MCP 连接变更或 Skills 热重载后调用。
 */
export function refreshModuleRegistryCache(): void {
    const builtin = loadModuleRegistry() || [];
    const mcp = getMcpModuleEntries() || [];
    const skills = parseAllSkillDocs() || [];
    _moduleRegistryCache = mergeModuleRegistries(builtin, mcp, skills);
    _apiBriefCache.clear(); // 清除 brief 缓存，强制重新生成
}

/**
 * 获取当前模块注册表缓存（懒加载）。
 * 供外部（如 session-runner 的运行时错误文档注入）使用。
 */
export function getModuleRegistryCache(): ModuleEntry[] {
    if (!_moduleRegistryCache) {
        refreshModuleRegistryCache();
    }
    return _moduleRegistryCache!;
}

/** 平台专属模块名映射（用于过滤非当前平台的 adapter 模块） */
const PLATFORM_MODULES: Record<string, string> = {
    telegram: "telegram",
    discord: "discord",
    onebot: "onebot",
};

/**
 * 加载 API 轻量概览，按平台过滤，注入到执行 prompt 的 {{apiTypeDefs}} 占位符。
 *
 * 重要变更：不再读取原始 .d.ts 全文！
 * 改为从 modules-docs.json 提取 Host-coupled APIs，并在运行时动态解析
 * workspace/skills/ 里的 TS Skills 的 .d.ts，提取每个方法的一句话 brief 签名。
 * 完整文档由 session-runner 在运行时错误后按需注入。
 */
export function loadApiTypeDefs(platform: string = "telegram", allowedModules?: Set<string>): string {
    try {
        // 确保 registry 已加载（合并内置模块与动态 TS Skills）
        const registry = getModuleRegistryCache();

        // 当有 allowedModules 过滤时，不使用缓存（每次 task 可能不同）
        const cacheKey = allowedModules ? null : platform;
        let moduleBrief = cacheKey ? _apiBriefCache.get(cacheKey) : undefined;
        if (!moduleBrief) {
            if (registry.length === 0) {
                // 降级：如果 modules-docs.json 不存在且无 Skills，返回空提示
                moduleBrief = "// API type definitions not available. Run `npm run gen:module-docs` to generate host APIs.";
            } else {
                // 确定需要排除的其他平台模块
                const excludedModules = new Set<string>();
                for (const [plat, modName] of Object.entries(PLATFORM_MODULES)) {
                    if (plat !== platform) {
                        excludedModules.add(modName);
                    }
                }

                // 按平台过滤模块
                const filteredRegistry = registry.filter(mod => !excludedModules.has(mod.name));

                // 生成轻量概览（包含内置模块 + TS Skills + AgentSkills）
                moduleBrief = generateBriefOverview(filteredRegistry, allowedModules);
            }
            if (cacheKey) _apiBriefCache.set(cacheKey, moduleBrief);
        }

        return moduleBrief;
    } catch (err) {
        const errorMsg = err instanceof Error ? err.stack ?? err.message : String(err);
        log.error("loadApiTypeDefs failed", { error: errorMsg });
        return "// API type definitions not available";
    }
}

/** CodeActExecutor 配置 */

// stripVerboseSections 已由 ContextEngine 的 history 策略替代：
// - executor.targetMessages: history="delta-only" → 只把新增目标消息写入 session 历史
// - executor.personContext: history="delta-only" → 只把新增/变化人物背景写入 session 历史
// - executor.topicSummary: history="ephemeral" → 仅当前任务可见
// - executor.memoryContext: history="ephemeral" → 仅当前任务可见

function normalizeThinkingText(thinking: string | undefined): string {
    if (!thinking) return "";
    return thinking
        .replace(/<end_task>/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function formatThinkingTranscript(result: SessionResult): string {
    const parts = result.turns
        .map((turn, index) => {
            const thinking = normalizeThinkingText(turn.thinking);
            if (!thinking) return null;
            return `[Turn ${index + 1}]\n${thinking}`;
        })
        .filter((part): part is string => !!part);

    const transcript = parts.join("\n\n");
    return `本次思考过程：\n\`\`\`text\n${transcript || ""}\n\`\`\``;
}

function formatThinkingPlaceholder(reason: string): string {
    return `本次思考过程：\n\`\`\`text\n${reason}\n\`\`\``;
}

function isExecutorTaskPrompt(content: string): boolean {
    return content.startsWith("═══ ") && content.includes(EXECUTOR_FOOTER_TEXT);
}

function collapseExecutorTaskPrompt(content: string): string {
    const footerIndex = content.lastIndexOf(EXECUTOR_FOOTER_TEXT);
    return footerIndex === -1
        ? content
        : content.slice(0, footerIndex + EXECUTOR_FOOTER_TEXT.length);
}

function findLatestExecutorTaskPromptIndex(messages: SessionMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index]?.role === "user" && isExecutorTaskPrompt(messages[index].content)) {
            return index;
        }
    }
    return -1;
}

export interface CodeActExecutorConfig {
    /** 单次执行最大超时 (ms)。默认 60000 */
    maxExecutionTimeMs: number;
    /** session 最大消息数（超过后 compact）。默认 100 */
    maxSessionMessages: number;
    /** 最大交互轮次。默认 30 */
    maxTurns: number;
}

const DEFAULT_EXECUTOR_CONFIG: CodeActExecutorConfig = {
    maxExecutionTimeMs: 60_000,
    maxSessionMessages: 100,
    maxTurns: 30,
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

const SESSION_MESSAGE_ID_RE = /\[msgId:([^\]\r\n]+)\]/g;

function extractSeenMessageIds(messages: SessionMessage[]): string[] {
    const ids: string[] = [];
    for (const msg of messages) {
        for (const match of msg.content.matchAll(SESSION_MESSAGE_ID_RE)) {
            const id = match[1]?.trim();
            if (id && id !== "?") ids.push(id);
        }
    }
    return ids;
}

function formatExecutionRecordForCompact(rec: SessionExecutionRecord): string | null {
    const sentPart = rec.sentMessages.length > 0
        ? `\n  已发消息: ${rec.sentMessages.map(m => `"${m.text.length > 80 ? m.text.slice(0, 80) + '...' : m.text}"`).join(" / ")}`
        : "";
    const thinkingPart = rec.thinkingSummary
        ? `\n  思路: ${rec.thinkingSummary.slice(0, 200)}`
        : "";

    if (!sentPart && !thinkingPart && rec.endReason === "end_turn") {
        return null;
    }

    const resultPart = rec.endReason === "end_turn" ? "" : `，结果: ${rec.endReason}`;
    return `- ${formatTsForPrompt(rec.timestamp)}${resultPart}${sentPart}${thinkingPart}`;
}

/**
 * session endReason → 派发任务终态映射：
 *   - error       → ERROR
 *   - interrupted → SKIPPED（被新消息/用户打断，是主动让路，非失败，不应误记 COMPLETED）
 *   - 其余（end_turn / max_turns）→ COMPLETED
 * 注意：TIMEOUT 不在此产生——它只由 GlobalState 启动对账（进程中途退出残留 RUNNING）补写。
 */
export function endReasonToTaskStatus(endReason: string | undefined): SubagentCallback["status"] {
    return endReason === "error" ? "ERROR"
        : endReason === "interrupted" ? "SKIPPED"
            : "COMPLETED";
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

    /** 声明式 prompt 组装引擎（per-executor 实例） */
    private contextEngine: ContextEngine;

    /** 每次 session 的执行记录（用于 compact 时提取摘要） */
    private executionRecords: SessionExecutionRecord[] = [];

    /** 任务执行队列 (Q4) */
    private taskQueue: CodeActReplyTask[] = [];
    /** 是否正在处理任务 */
    private processing = false;
    /** 用户是否请求取消当前执行 */
    private cancelRequested = false;

    /** 上次 compact 时间 */
    lastCompactedAt: string | null = null;

    /** Agent 最后回复时间戳（由 GroupSubagent 同步写入，持久化到 session JSON） */
    lastAgentReplyAt: number = 0;

    /** 执行计数 */
    private executionCount = 0;

    /** Callback handler（由 GroupSubagent 或 S8 集成时注入） */
    private callbackHandler: ((cb: SubagentCallback) => void) | null = null;
    /** pending 消息实际注入 prompt 后的通知，用于和 post-task window 跨路径去重 */
    private pendingMessageDrainHandler: ((messages: PostTaskReactionMessage[], source: PendingMessageDrainSource) => void) | null = null;

    /** 层 2: 消息前送缓冲区 — NC hook 在 session 执行期间推入新消息 */
    private pendingMessages: PostTaskReactionMessage[] = [];
    private pendingMessageVersion = 0;
    private readonly pendingMessageEmitter = new EventEmitter();

    /** Memory 引用（层 1 用于刷新目标消息） */
    private memory: MemoryStoreV2 | null = null;
    /** GlobalState 引用（用于同步 Meta Session Digest 与任务历史） */
    private globalState: Pick<GlobalState, "getSessionDigests" | "updateDispatchedSubagentTask"> | null = null;

    constructor(chatId: string, config?: Partial<CodeActExecutorConfig>) {
        this.chatId = chatId;
        this.config = { ...DEFAULT_EXECUTOR_CONFIG, ...config };
        // 初始化 ContextEngine，注册 executor task providers
        this.contextEngine = new ContextEngine(`executor:${chatId}`);
        this.contextEngine.registerAll(getExecutorTaskProviders());
    }

    /**
     * 设置 callback handler（回调到 Q5）
     */
    setCallbackHandler(handler: (cb: SubagentCallback) => void): void {
        this.callbackHandler = handler;
    }

    setPendingMessageDrainHandler(
        handler: (messages: PostTaskReactionMessage[], source: PendingMessageDrainSource) => void,
    ): void {
        this.pendingMessageDrainHandler = handler;
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

    /** 持久化文件路径（由外部注入） */
    private sessionFilePath: string | null = null;
    private personaName: string = "赛博群友";
    private personaDescription: string = "";
    /** Vision 配置 */
    private visionConfig: VisionConfig | undefined;
    /** Vision tier LLM 配置（独立 vision 模型，Path B 描述用） */
    private visionLlmConfig: LLMConfig | undefined;
    /** 媒体下载函数（委托给 adapter） */
    private downloadFn: ((fileId: string) => Promise<Buffer>) | undefined;
    /** 平台无关的 typing 状态发送函数（由宿主注入，如 Telegram sendTyping） */
    private sendTypingFn: ((chatId: string) => Promise<void>) | undefined;
    /** 媒体下载管理器（保存文件到磁盘） */
    private mediaDownloader: MediaDownloader | undefined;
    /** 平台特定的 @ 提及格式化函数（由 adapter 提供） */
    private formatMentionFn: ((rawUserId: string, username?: string) => string | undefined) | undefined;

    setDependencies(
        sandboxPool: SandboxPool,
        nc: NotificationCenter,

        persona?: { name: string; description: string },
        memory?: MemoryStoreV2,
        visionConfig?: VisionConfig,
        downloadFn?: (fileId: string) => Promise<Buffer>,
        sendTyping?: (chatId: string) => Promise<void>,
        visionLlmConfig?: LLMConfig,
        mediaDownloader?: MediaDownloader,
        formatMention?: (rawUserId: string, username?: string) => string | undefined,
        globalState?: Pick<GlobalState, "getSessionDigests" | "updateDispatchedSubagentTask">,
    ): void {
        this.sandboxPool = sandboxPool;
        this.nc = nc;

        if (persona) {
            this.personaName = persona.name;
            this.personaDescription = persona.description;
        }
        if (memory) this.memory = memory;
        this.visionConfig = visionConfig;
        this.visionLlmConfig = visionLlmConfig;
        this.downloadFn = downloadFn;
        this.sendTypingFn = sendTyping;
        this.mediaDownloader = mediaDownloader;
        this.formatMentionFn = formatMention;
        this.globalState = globalState ?? this.globalState;
        log.info("setDependencies", { chatId: this.chatId, hasSandboxPool: true, hasVision: !!visionConfig, hasVisionLlm: !!visionLlmConfig, hasDownload: !!downloadFn, hasTyping: !!sendTyping, hasMediaDownloader: !!mediaDownloader, hasMention: !!formatMention, hasGlobalState: !!this.globalState });
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
        return this.sandboxPool !== null && this.nc !== null && resolveComponentProfiles("session").length > 0;
    }

    private buildSessionHistoryMessages(isContinuation: boolean): ChatMessage[] {
        const latestTaskPromptIndex = isContinuation ? findLatestExecutorTaskPromptIndex(this.session) : -1;
        return this.session.map((msg, index) => ({
            role: msg.role,
            content: sanitizePromptTimestamps(
                msg.role === "user" && isExecutorTaskPrompt(msg.content) && index !== latestTaskPromptIndex
                    ? collapseExecutorTaskPrompt(msg.content)
                    : msg.content,
            ),
            ...(index === this.session.length - 1 ? { cacheBreakpoint: true } : {}),
        }));
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

        let callback: SubagentCallback;

        try {
            // ═══ Fix 9: 实际的 Sandbox 执行逻辑 ═══
            if (this.hasDependencies()) {
                callback = await this.executeWithSandbox(task, startTime);
            } else {
                // Fallback: 无依赖时使用骨架逻辑（测试用）
                callback = this.executeSkeletonFallback(task, startTime);
            }

        } catch (err) {
            const durationMs = Date.now() - startTime;
            const cancelledByUser = this.cancelRequested;
            const thinkingSummary = cancelledByUser
                ? formatThinkingPlaceholder("执行已被用户取消，未保留可用的思考记录")
                : formatThinkingPlaceholder("执行在 session 外层异常中断，未保留可用的思考记录");
            callback = {
                taskId: task.taskId,
                chatId: this.chatId,
                chatTitle: task.contextSnapshot.chatTitle ?? task.contextSnapshot.groupModel?.chatTitle,
                isDirectMessage: task.contextSnapshot.isDirectMessage,
                executionType: "CODEACT",
                status: cancelledByUser ? "SKIPPED" : "ERROR",
                summary: cancelledByUser
                    ? `Execution cancelled by user\n\n${thinkingSummary}`
                    : `Execution failed: ${String(err)}\n\n${thinkingSummary}`,
                error: cancelledByUser ? undefined : String(err),
                durationMs,
                createdAt: new Date().toISOString(),
                contentDirection: (task.contextSnapshot.contentDirection ?? task.decisions.map(d => d.contentDirection ?? "").filter(Boolean).join("; ")) || undefined,
            };

            this.globalState?.updateDispatchedSubagentTask(task.taskId, {
                status: callback.status,
                summary: callback.summary,
                error: callback.error,
                durationMs,
                completedAt: callback.createdAt,
            });

            if (cancelledByUser) {
                log.info("execute: 已取消", { chatId: this.chatId, taskId: task.taskId, error: String(err) });
            } else {
                log.error("execute: 失败", { chatId: this.chatId, taskId: task.taskId, error: String(err) });
            }
        }

        await this.finalizeExecutionArtifacts();
        return callback;
    }

    private async finalizeExecutionArtifacts(): Promise<void> {
        if (this.session.length > this.config.maxSessionMessages) {
            await this.compactSession();
        }
        this.saveSession();
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
        const contentDirection = ctx.contentDirection ?? task.decisions.map(d => d.contentDirection ?? "").filter(Boolean).join("; ");
        const isContinuation = !!task.continuationPrompt;

        // 2. 渲染系统 prompt (subagent.md §12.2 ➎ — 稳定部分，保持 Mustache 模板)
        const currentConfig = loadConfig();
        const baseSkills = currentConfig.subagent?.baseSkills ?? [
            "runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "dispatch", "vision", "shell",
        ];
        const platform = getPlatform(this.chatId);
        const allowedSkills = new Set<string>([
            ...baseSkills,
            "dispatch",
            platform,
            ...(task.useSkills ?? []),
        ]);
        const todoItems = this.memory ? this.memory.todoList(this.chatId) : [];
        const systemVars = {
            personaName: this.personaName,
            personaDescription: this.personaDescription,
            apiTypeDefs: loadApiTypeDefs(platform, allowedSkills),
            platformModule: platform,
            hasTodos: todoItems.length > 0,
            todosText: todoItems.map((item) =>
                item.dueAt
                    ? `- ${item.key}: ${item.content} (到期: ${formatTsForPrompt(item.dueAt)})`
                    : `- ${item.key}: ${item.content}`
            ).join("\n"),
        };
        const systemPrompt = renderPrompt("EXECUTION", systemVars);

        let taskPrompt = task.continuationPrompt ?? "";
        let imageParts: ChatMessage["imageParts"] = [];
        let renderResult: ReturnType<ContextEngine["render"]> | null = null;

        if (isContinuation && task.continuationMessages?.length) {
            const enriched = await this.enrichReactionMessages(task.continuationMessages);
            taskPrompt = formatContinuationPromptFromEnrichedMessages(
                enriched.formattedText,
                task.continuationReason ?? "post-task",
                task.continuationClassifierReason,
            );
            imageParts = enriched.imageParts;
        } else if (!isContinuation) {
            const topicSummary = ctx.topicSummary ?? "";
            const toneGuidance = ctx.toneGuidance ?? "";
            const memoryContext = task.memoryContext;
            const explicitMemoryContextText = memoryContext
                ? [
                    memoryContext.facts.length
                        ? `## 相关事实\n${memoryContext.facts.map((fact) => formatFactForPrompt(fact, this.memory ?? undefined)).join("\n")}`
                        : "",
                    memoryContext.topics.length
                        ? `## 相关历史话题\n${memoryContext.topics.map((topic) => `- [${formatTsForPrompt(topic.startedAt)}] ${topic.label} — ${topic.summary} (topicId: ${topic.topicId}; 来源: ${formatChatLabel(this.memory ?? undefined, topic.chatId)})`).join("\n")}`
                        : "",
                    memoryContext.interactions.length
                        ? `## 近期互动\n${memoryContext.interactions.map((item) => formatInteractionForPrompt(item, this.memory ?? undefined)).join("\n")}`
                        : "",
                ].filter(Boolean).join("\n\n")
                : "";
            const activeUserProfiles = sanitizeActiveUserProfiles(ctx.activeUserProfiles);
            const activeProfilesContext = activeUserProfiles.length
                ? JSON.stringify(normalizeProgrammaticTimestamps(activeUserProfiles))
                : "";
            const legacyPersonContext = typeof ctx.personContext === "string" ? ctx.personContext : undefined;
            const legacyIsPersonContext = looksLikePersonProfileContext(legacyPersonContext);
            const memoryContextText = explicitMemoryContextText;

            // personContext: Meta 侧构造 activeUserProfiles；这里交给 provider 做 delta 与 Markdown 渲染
            const personContext = activeProfilesContext || (legacyIsPersonContext ? legacyPersonContext : "");

            // 3. 消息富化：媒体处理 + 格式化（委托 message-enricher）
            const recentMessages = ctx.recentMessages ?? [];
            const enriched = await enrichMessages(
                [...recentMessages].reverse().map(m => ({
                    ...m,
                    chatId: this.chatId,
                })),
                {
                    visionConfig: this.visionConfig,
                    llmConfig: resolveComponentProfiles("session")[0],
                    visionLlmConfig: this.visionLlmConfig,
                    downloadFn: this.downloadFn,
                    stickerCache: this.memory ?? undefined,
                    chatId: this.chatId,
                    mediaDownloader: this.mediaDownloader,
                },
            );
            const targetMessages = enriched.formattedText;
            imageParts = enriched.imageParts;

            const availableStickers = ctx.availableStickers?.length
                ? ctx.availableStickers
                : this.buildAvailableStickers(task);

            // 4. 渲染任务 prompt — 通过 ContextEngine 声明式组装
            const resolveCtx: ExecutorResolveContext = {
                chatId: this.chatId,
                isDirectMessage: ctx.isDirectMessage,
                chatTitle: ctx.chatTitle ?? ctx.groupModel?.chatTitle ?? getRawId(this.chatId),
                taskId: task.taskId,
                decisions: task.decisions,
                toneGuidance: ctx.toneGuidance ?? task.decisions.map(d => d.contentDirection ?? "").filter(Boolean).join("; ") ? undefined : undefined,
                topicSummary,
                personContext,
                memoryContext: memoryContextText || undefined,
                quotedContext: ctx.quotedContext,
                targetMessages,
                availableStickers,
                groundingContext: ctx.groundingContext,
                sessionDigests: this.globalState?.getSessionDigests(),
                useSkills: task.useSkills,
            };
            // 重新计算 toneGuidance（避免上面的 ternary 混乱）
            resolveCtx.toneGuidance = toneGuidance || undefined;

            renderResult = this.contextEngine.render(resolveCtx);

            // 组装最终 task prompt：persistent/delta-only sections 在 historicalContent，
            // ephemeral sections 在 ephemeralContent（topicSummary/memoryContext/stickers/grounding）
            const taskPromptParts: string[] = [];
            if (renderResult.historicalContent) taskPromptParts.push(renderResult.historicalContent);
            if (renderResult.ephemeralContent) taskPromptParts.push(renderResult.ephemeralContent);
            taskPrompt = taskPromptParts.join("\n\n");
        }

        // 仅回复生成时注入：当前 session 主模型的 per-model 补充提示词（贴 task prompt 末尾，recency 最高，紧贴生成）。
        // 不改 system prompt / persona；只影响 reply 路径。
        const replyBoost = resolveComponentProfiles("session")[0]?.replyPrompt;
        if (replyBoost) taskPrompt = (taskPrompt ? taskPrompt + "\n\n" : "") + replyBoost;

        // ═══ Fix 2: 构建 messages 时注入历史 session 上下文 ═══
        const messages: ChatMessage[] = [
            { role: "system", content: systemPrompt, cacheBreakpoint: true },
        ];

        // 注入历史 session（如果有）
        if (this.session.length > 0) {
            messages.push(...this.buildSessionHistoryMessages(isContinuation));
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

        const sentCollector = new SentMessageCollector(this.memory ?? undefined);
        const sandbox = await this.sandboxPool!.acquire(this.chatId);
        const deduplicateSentMessages = currentConfig.subagent?.deduplicateSentMessages !== false;
        const bannedWords = currentConfig.subagent?.bannedWords ?? DEFAULT_BANNED_WORDS;

        // 设置平台标识，供 capability-registry 和 scene.current 使用
        await sandbox.execute(`__setPlatform(${JSON.stringify(platform)})`, 5000);
        await sandbox.execute(`__setDuplicateMessageBlocking(${JSON.stringify(deduplicateSentMessages)})`, 5000);
        await sandbox.execute(`__setBannedWords(${JSON.stringify(bannedWords)})`, 5000);
        // 注册 notify 监听器收集已发消息
        const rawChatId = getRawId(this.chatId);
        const notifyListener = (event: Record<string, unknown>) => {
            // 按 chatId 过滤，只收集本群组的消息
            // sandbox 发出的事件中 chatId 是 raw ID（因为 LLM 代码使用 getRawId 注入的 chatId），
            // 需要同时匹配 raw 和 composite 格式
            const eventChatId = String(event.chatId ?? "");
            if (eventChatId === this.chatId || eventChatId === rawChatId || eventChatId === "") {
                sentCollector.collect(event);
            }
        };
        sandbox.on("notify", notifyListener);

        // ═══ Typing 状态指示 ═══
        // Telegram typing 状态约 5 秒后过期，用 4 秒间隔保持活跃
        let typingTimer: ReturnType<typeof setInterval> | null = null;
        if (this.sendTypingFn) {
            const doTyping = () => {
                this.sendTypingFn!(this.chatId).catch(err => {
                    log.debug("sendTyping failed", { chatId: this.chatId, error: String(err) });
                });
            };
            doTyping(); // 立即发送一次
            typingTimer = setInterval(doTyping, 4000);
        }

        log.info("executeWithSandbox: 开始 CodeAct session", {
            chatId: this.chatId,
            taskId: task.taskId,
            historyMessages: this.session.length,
        });

        this.globalState?.updateDispatchedSubagentTask(task.taskId, {
            status: "RUNNING",
        });

        let sessionResult: SessionResult;
        const unregisterPendingSignal = registerPendingMessageSignal(this.chatId, this.createPendingMessageSignal());
        try {
            sessionResult = await runCodeActSession(
                messages,
                sandbox,
                this.nc!,
                resolveComponentProfiles("session"),
                this.config.maxExecutionTimeMs,
                sentCollector, // Fix 1: 传入 collector
                async () => this.drainPendingMessages(), // 层 2: turn 间消息注入
                async () => this.drainPendingMessagesForObservation(), // 层 2: direct attention 立即并入 observation
                `让${this.personaName}想想，`,  // prefill: 引导 LLM 以角色开始思考
                ["[Execution Output]"],  // stop sequences
                this.chatId,  // 关联 chatId，用于 codeActEvents 进度广播
                this.config.maxTurns,  // 最大交互轮次
                // 运行时错误后按需加载完整 API 文档（每个 turn 动态获取最新 registry）
                (() => {
                    const registry = getModuleRegistryCache();
                    if (registry.length === 0) return undefined;
                    return {
                        getPrefixMap: () => buildPrefixMap(getModuleRegistryCache()),
                        lookupDocs: (calledMethods: string[]) =>
                            lookupFullDocs(getModuleRegistryCache(), calledMethods),
                    };
                })(),
                renderResult?.manifest,
            );
        } finally {
            unregisterPendingSignal();
            // 停止 typing 指示
            if (typingTimer) clearInterval(typingTimer);
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
            this.session.push({
                role: msg.role as "system" | "user" | "assistant",
                content: sanitizePromptTimestamps(msg.content),
                timestamp: new Date().toISOString(),
            });
        }

        // 提交 ContextEngine 状态（标记当前数据已被 LLM 看过）
        if (renderResult) {
            this.contextEngine.commit(renderResult.tree);
        }

        // 记录 execution record（用于 compact）
        const thinkingSummary = sessionResult.turns
            .map(t => normalizeThinkingText(t.thinking))
            .filter(Boolean)
            .join(" | ")
            .slice(0, 500);

        const thinkingTranscript = formatThinkingTranscript(sessionResult);

        this.executionRecords.push({
            taskId: task.taskId,
            timestamp: new Date().toISOString(),
            endReason: sessionResult.endReason,
            turns: sessionResult.turns.length,
            sentMessages: [...sentCollector.allSent],
            thinkingSummary,
        });

        // 5. 构建 callback
        // endReason → 终态映射（见 endReasonToTaskStatus）。
        const status: SubagentCallback["status"] = endReasonToTaskStatus(sessionResult.endReason);
        const callback: SubagentCallback = {
            taskId: task.taskId,
            chatId: this.chatId,
            chatTitle: ctx.chatTitle ?? ctx.groupModel?.chatTitle,
            isDirectMessage: ctx.isDirectMessage,
            executionType: "CODEACT",
            status,
            summary: thinkingTranscript,
            replyContent: sessionResult.turns
                .filter((t: any) => t.role === "assistant" && t.content)
                .map((t: any) => t.content)
                .join("\n") || undefined,
            sentMessages: sentCollector.allSent.length > 0
                ? sentCollector.allSent.map(m => ({ messageId: m.messageId, text: m.text, timestamp: m.timestamp }))
                : undefined,
            tokensUsed: (sessionResult as any).tokensUsed ?? undefined,
            error: sessionResult.error,
            durationMs,
            createdAt: new Date().toISOString(),
            contentDirection,
        };

        this.globalState?.updateDispatchedSubagentTask(task.taskId, {
            status: callback.status,
            sessionId: sessionResult.sessionId,
            summary: callback.summary,
            sentMessages: callback.sentMessages,
            error: callback.error,
            durationMs,
            completedAt: callback.createdAt,
        });

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

    private buildAvailableStickers(task: CodeActReplyTask): Array<{ emoji?: string; emojis?: string[]; description: string; uniqueFileId: string }> | undefined {
        if (!this.memory) return undefined;

        const suggestedEmojis = task.decisions.flatMap(decision => decision.suggestedEmojis ?? []);
        if (suggestedEmojis.length === 0) return undefined;

        const rawMatchLimit = Math.max(this.memory.getAllStickerDescriptions().length, 12);
        const matches = this.memory.searchStickersByEmoji(suggestedEmojis, rawMatchLimit);
        const seen = new Set<string>();
        const sendableStickers: Array<{ emoji?: string; emojis?: string[]; description: string; uniqueFileId: string }> = [];

        for (const match of matches) {
            if (!match.enabled || seen.has(match.uniqueFileId)) continue;
            const filePath = this.mediaDownloader?.getExistingPath(match.uniqueFileId);
            if (!filePath || filePath.toLowerCase().endsWith(".webm")) continue;

            const cached = this.memory.getStickerDescription(match.uniqueFileId);
            sendableStickers.push({
                uniqueFileId: match.uniqueFileId,
                description: match.description,
                emoji: match.emoji,
                emojis: cached?.emojis?.length ? cached.emojis : [match.emoji],
            });
            seen.add(match.uniqueFileId);
        }

        if (sendableStickers.length === 0) return undefined;
        if (sendableStickers.length <= 12) return sendableStickers;

        const shuffled = [...sendableStickers];
        for (let index = shuffled.length - 1; index > 0; index--) {
            const swapIndex = Math.floor(Math.random() * (index + 1));
            [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
        }

        return shuffled.slice(0, 12);
    }

    /**
     * 骨架 fallback（无依赖注入时，用于测试）
     */
    private executeSkeletonFallback(
        task: CodeActReplyTask,
        startTime: number,
    ): SubagentCallback {
        const durationMs = Date.now() - startTime;

        const taskPrompt = (
            task.continuationPrompt
            ?? task.contextSnapshot.contentDirection
            ?? task.decisions.map((decision) => decision.contentDirection ?? decision.reason ?? "").filter(Boolean).join("\n")
        ) || `[TASK] ${task.replyMode} (${task.decisions.length} decisions)`;
        this.session.push({
            role: "user",
            content: taskPrompt,
            timestamp: new Date().toISOString(),
        });

        this.session.push({
            role: "assistant",
            content: `[COMPLETED] Task ${task.taskId} executed in ${durationMs}ms (skeleton fallback)`,
            timestamp: new Date().toISOString(),
        });

        const callback: SubagentCallback = {
            taskId: task.taskId,
            chatId: this.chatId,
            chatTitle: task.contextSnapshot.chatTitle ?? task.contextSnapshot.groupModel?.chatTitle,
            isDirectMessage: task.contextSnapshot.isDirectMessage,
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: `Executed ${task.replyMode} task with ${task.decisions.length} decisions (skeleton)\n\n${formatThinkingPlaceholder("当前为 skeleton fallback，未产生可用的思考记录")}`,
            replyContent: task.decisions.map(d => d.contentDirection ?? "").filter(Boolean).join("\n") || undefined,
            tokensUsed: 0,
            durationMs,
            createdAt: new Date().toISOString(),
            contentDirection: (task.contextSnapshot.contentDirection ?? task.decisions.map(d => d.contentDirection ?? "").filter(Boolean).join("; ")) || undefined,
        };

        this.globalState?.updateDispatchedSubagentTask(task.taskId, {
            status: callback.status,
            summary: callback.summary,
            durationMs,
            completedAt: callback.createdAt,
        });

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
    pushPendingMessage(msg: PostTaskReactionMessage): void {
        this.pendingMessages.push(msg);
        this.pendingMessageVersion++;
        this.pendingMessageEmitter.emit("pending-message", this.pendingMessageVersion);
        log.debug("pushPendingMessage", {
            chatId: this.chatId,
            msgId: msg.messageId,
            sender: msg.sender,
            textPreview: msg.text.length > 50 ? msg.text.slice(0, 50) + "..." : msg.text,
            directReason: msg.directReason,
            hasMedia: !!msg.mediaInfo,
            bufferSize: this.pendingMessages.length,
        });
    }

    private createPendingMessageSignal(): PendingMessageSignal {
        return {
            getVersion: () => this.pendingMessageVersion,
            getPendingCount: () => this.pendingMessages.length,
            onChange: (listener) => {
                this.pendingMessageEmitter.on("pending-message", listener);
                return () => this.pendingMessageEmitter.off("pending-message", listener);
            },
            waitForChange: (sinceVersion, timeoutMs) => this.waitForPendingMessageChange(sinceVersion, timeoutMs),
        };
    }

    private waitForPendingMessageChange(sinceVersion: number, timeoutMs: number): Promise<boolean> {
        if (this.pendingMessageVersion !== sinceVersion) return Promise.resolve(true);
        if (timeoutMs <= 0) return Promise.resolve(false);

        return new Promise((resolve) => {
            let settled = false;
            const cleanup = () => {
                this.pendingMessageEmitter.off("pending-message", onPendingMessage);
                clearTimeout(timer);
            };
            const finish = (changed: boolean) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(changed);
            };
            const onPendingMessage = () => finish(true);
            const timer = setTimeout(() => finish(false), timeoutMs);
            if (timer.unref) timer.unref();
            this.pendingMessageEmitter.on("pending-message", onPendingMessage);
        });
    }

    private async enrichReactionMessages(messages: PostTaskReactionMessage[]): Promise<EnrichedResult> {
        const messagesById = new Map(messages.map((message) => [message.messageId, message]));
        const rawMessages: RawMessage[] = await Promise.all(messages.map(async (message) => {
            const replyToMsgId = message.replyToMessageId;
            const inBatchReply = replyToMsgId ? messagesById.get(replyToMsgId) : undefined;
            let replyTo = inBatchReply?.sender;
            let replyToText: string | undefined;

            if (replyToMsgId && !inBatchReply && this.memory) {
                try {
                    const original = this.memory.getMessageById(this.chatId, replyToMsgId);
                    if (original) {
                        replyTo = original.displayName || original.userId || `msg#${replyToMsgId}`;
                        replyToText = await resolveReplyText(original, {
                            stickerCache: this.memory,
                            visionConfig: this.visionConfig,
                            llmConfig: resolveComponentProfiles("session")[0] ?? undefined,
                            visionLlmConfig: this.visionLlmConfig,
                            downloadFn: this.downloadFn,
                            chatId: this.chatId,
                        });
                    }
                } catch (error) {
                    log.debug("enrichReactionMessages: reply target lookup failed", {
                        chatId: this.chatId,
                        replyToMsgId,
                        error: String(error),
                    });
                }
            }

            return {
                id: message.messageId,
                sender: message.sender,
                text: message.text,
                timestamp: message.timestamp,
                replyTo: replyTo ?? (replyToMsgId ? `msg#${replyToMsgId}` : undefined),
                replyToMsgId,
                replyToText,
                mediaType: message.mediaType,
                mediaInfo: message.mediaInfo,
                chatId: this.chatId,
            };
        }));

        return enrichMessages(rawMessages, {
            visionConfig: this.visionConfig,
            llmConfig: resolveComponentProfiles("session")[0],
            visionLlmConfig: this.visionLlmConfig,
            downloadFn: this.downloadFn,
            stickerCache: this.memory ?? undefined,
            chatId: this.chatId,
            mediaDownloader: this.mediaDownloader,
        });
    }

    /**
     * 层 2: 在当前 turn 的 observation 前优先抽取 direct attention 消息
     * 仅当有人直接叫住 agent 时才清空 buffer 并立即反馈给模型。
     */
    async drainPendingMessagesForObservation(): Promise<{ content: string; imageParts?: ImagePart[] } | null> {
        const trigger = findLatestDirectAttentionMessage(this.pendingMessages);
        if (!trigger) return null;

        const drained = this.pendingMessages.splice(0);
        const directReason = trigger.directReason ?? "direct-address";
        log.info("drainPendingMessagesForObservation", {
            chatId: this.chatId,
            count: drained.length,
            directReason,
        });
        this.notifyPendingMessagesDrained(drained, "observation");
        const enriched = await this.enrichReactionMessages(drained);
        const content = [
            "[📩 新消息到达]",
            enriched.formattedText,
            "",
            `[mid-turn direct attention: ${directReason}] 这些消息发生在你处理当前任务期间，其中有人直接叫住你、回复你或提及你。请结合当前会话、刚才的执行结果和上面所有尚未处理的新消息判断是否需要调整下一步行动或直接回复；需要时在下一轮自然处理，不需要则继续当前任务。`,
        ].join("\n");
        return { content, imageParts: enriched.imageParts.length ? enriched.imageParts : undefined };
    }

    /**
     * 层 2: 取出并格式化 pending messages，清空 buffer
     * 由 session-runner 在每个 turn 的 LLM 调用前调用
     * @returns 格式化的消息文本和图片，无新消息时返回 null
     */
    async drainPendingMessages(): Promise<{ content: string; imageParts?: ImagePart[] } | null> {
        if (this.pendingMessages.length === 0) return null;
        const drained = this.pendingMessages.splice(0);
        const trigger = findLatestDirectAttentionMessage(drained);
        log.info("drainPendingMessages", {
            chatId: this.chatId,
            count: drained.length,
            hasDirectAttention: !!trigger,
        });
        this.notifyPendingMessagesDrained(drained, "turn");
        const enriched = await this.enrichReactionMessages(drained);
        if (trigger) {
            const directReason = trigger.directReason ?? "direct-address";
            const content = [
                "[📩 新消息到达]",
                enriched.formattedText,
                "",
                `[mid-turn direct attention: ${directReason}] 这些消息发生在你处理当前任务期间，其中有人直接叫住你、回复你或提及你。请结合当前会话、刚才的执行结果和上面所有尚未处理的新消息判断是否需要调整下一步行动或直接回复；需要时在下一轮自然处理，不需要则继续当前任务。`,
            ].join("\n");
            return { content, imageParts: enriched.imageParts.length ? enriched.imageParts : undefined };
        }
        const content = `[📩 新消息到达]\n${enriched.formattedText}`;
        return { content, imageParts: enriched.imageParts.length ? enriched.imageParts : undefined };
    }

    private notifyPendingMessagesDrained(
        messages: PostTaskReactionMessage[],
        source: PendingMessageDrainSource,
    ): void {
        if (!this.pendingMessageDrainHandler || messages.length === 0) return;
        try {
            this.pendingMessageDrainHandler(messages, source);
        } catch (err) {
            log.debug("pending message drain handler failed", {
                chatId: this.chatId,
                source,
                error: String(err),
            });
        }
    }

    /**
     * 层 1: 刷新 task 的目标消息列表
     * 在 processNext() 取出 task 后、execute() 前调用
     */
    private async refreshTaskMessages(task: CodeActReplyTask): Promise<void> {
        if (!this.memory) return;
        try {
            const freshMessages = this.memory.getRecentMessages(this.chatId, 20);
            if (freshMessages.length === 0) return;

            const msgIdToName = new Map<string, string>();
            for (const m of freshMessages) {
                msgIdToName.set(m.messageId, m.displayName || `(uid:${m.userId})`);
            }

            task.contextSnapshot.recentMessages = await Promise.all(freshMessages.map(async (m: any) => {
                const isInContext = m.replyToMessageId ? msgIdToName.has(m.replyToMessageId) : false;
                // 不在上下文中时，从 DB 查询原消息并解析文本/媒体描述（含 vision 处理）
                let replyToText: string | undefined;
                if (m.replyToMessageId && !isInContext && this.memory) {
                    try {
                        const origMsg = this.memory.getMessageById(this.chatId, m.replyToMessageId);
                        if (origMsg) {
                            replyToText = await resolveReplyText(origMsg, {
                                stickerCache: this.memory ?? undefined,
                                visionConfig: this.visionConfig,
                                llmConfig: resolveComponentProfiles("session")[0] ?? undefined,
                                visionLlmConfig: this.visionLlmConfig,
                                downloadFn: this.downloadFn,
                                chatId: this.chatId,
                            });
                        }
                    } catch { /* 非关键路径 */ }
                }
                return {
                    id: String(m.messageId ?? m.id ?? ""),
                    sender: String(m.displayName ?? m.sender ?? m.userId ?? "?"),
                    text: String(m.text ?? ""),
                    timestamp: String(m.timestamp ?? ""),
                    replyTo: m.replyToMessageId
                        ? (msgIdToName.get(m.replyToMessageId) ?? `msg#${m.replyToMessageId}`)
                        : undefined,
                    replyToMsgId: m.replyToMessageId ?? undefined,
                    replyToText,
                    mediaType: m.mediaType ?? undefined,
                    mediaInfo: m.mediaInfo ?? undefined,
                };
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
        this.executionRecords = [];
        this.pendingMessages = [];
        this.lastCompactedAt = null;
        this.contextEngine.ledger.reset();
        this.saveSession();
    }

    async cancelCurrentRun(): Promise<void> {
        this.cancelRequested = true;
        this.taskQueue = [];
        this.pendingMessages = [];

        if (this.sandboxPool) {
            await this.sandboxPool.destroy(this.chatId);
        }

        log.info("cancelCurrentRun: 已请求取消", { chatId: this.chatId });
    }

    // ─── 内部方法 ───

    private async processNext(): Promise<void> {
        if (this.processing) return;
        if (this.taskQueue.length === 0) return;

        this.processing = true;

        try {
            while (this.taskQueue.length > 0) {
                if (this.cancelRequested) {
                    this.taskQueue = [];
                    break;
                }

                const task = this.taskQueue.shift()!;
                const updatedTask = this.globalState?.updateDispatchedSubagentTask(task.taskId, {
                    status: "RUNNING",
                });
                log.info("processNext: task dequeued", {
                    chatId: this.chatId,
                    taskId: task.taskId,
                    remainingQueueSize: this.taskQueue.length,
                    statusMarkedRunning: !!updatedTask,
                    skipRefreshTaskMessages: !!task.skipRefreshTaskMessages,
                    isContinuation: !!task.continuationPrompt,
                });

                // 层 1: 执行前刷新目标消息。轻量续接任务只追加一条 continuation prompt。
                if (!task.skipRefreshTaskMessages && !task.continuationPrompt) {
                    await this.refreshTaskMessages(task);
                }

                const callback = await this.execute(task);

                // 通知 callback handler (Q5)
                if (this.callbackHandler) {
                    this.callbackHandler(callback);
                }

                if (this.cancelRequested) {
                    this.taskQueue = [];
                    break;
                }
            }
        } finally {
            this.processing = false;
            this.cancelRequested = false;
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
                contextLedger: this.contextEngine.ledger.toSnapshot(),
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
            this.contextEngine.ledger.loadSnapshot(state.contextLedger);

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

    private rebuildCompactedInteractionHistory(compactedMessages: SessionMessage[]): string | null {
        if (!this.memory || compactedMessages.length === 0) return null;

        const seenMessageIds = extractSeenMessageIds(compactedMessages);
        if (seenMessageIds.length === 0) return null;

        const firstMessageId = seenMessageIds[0];
        const lastMessageId = seenMessageIds[seenMessageIds.length - 1];
        let messages = this.memory.getMessagesBetweenIds(this.chatId, firstMessageId, lastMessageId);
        let source = `memory range ${firstMessageId}..${lastMessageId}`;

        if (messages.length === 0) {
            // 边界消息缺失时退化为按已见 id 批量读取；这不能补回 agent 插话，
            // 但至少比完全丢失被 compact 的原文更好。
            const uniqueIds = [...new Set(seenMessageIds)];
            messages = this.memory.getMessagesByIds(this.chatId, uniqueIds);
            source = `memory ids ${uniqueIds.length}`;
        }

        if (messages.length === 0) return null;

        const formatted = this.formatMemoryMessagesForHistory(messages);
        if (!formatted) return null;

        log.info("compactSession: 已从 memory 重建交互历史", {
            chatId: this.chatId,
            firstMessageId,
            lastMessageId,
            messages: messages.length,
            source,
        });

        return [
            "== 被压缩的交互历史（从 memory 重建） ==",
            `范围: msgId:${firstMessageId} → msgId:${lastMessageId}；共 ${messages.length} 条`,
            formatted,
        ].join("\n");
    }

    private formatMemoryMessagesForHistory(messages: RecentMessageEntry[]): string {
        const msgIdToName = new Map<string, string>();
        for (const msg of messages) {
            msgIdToName.set(msg.messageId, msg.displayName || `(uid:${msg.userId})`);
        }

        return messages.map(msg => {
            let replyTo: string | undefined;
            let replyToText: string | undefined;
            if (msg.replyToMessageId) {
                replyTo = msgIdToName.get(msg.replyToMessageId);
                if (!replyTo && this.memory) {
                    const replied = this.memory.getMessageById(this.chatId, msg.replyToMessageId);
                    if (replied) {
                        replyTo = replied.displayName || `(uid:${replied.userId})`;
                        replyToText = replied.text || undefined;
                    }
                }
                replyTo ??= `msg#${msg.replyToMessageId}`;
            }

            return formatMessageLine({
                id: msg.messageId,
                sender: msg.displayName || `(uid:${msg.userId})`,
                text: msg.text,
                timestamp: msg.timestamp,
                replyTo,
                replyToMsgId: msg.replyToMessageId,
                replyToText,
                mediaType: msg.mediaType,
                mediaInfo: msg.mediaInfo,
            }, {
                includeMediaTags: true,
                stickerDescriptionLookup: this.memory ?? undefined,
            });
        }).join("\n");
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
        const compactedMessages = this.session.slice(0, -keep);
        const recentMessages = this.session.slice(-keep);

        // ═══ Layer 1: 结构化快速 compact ═══
        // 从 executionRecords 构建摘要
        const recordSummaries: string[] = [];
        for (const rec of this.executionRecords) {
            const summary = formatExecutionRecordForCompact(rec);
            if (summary) recordSummaries.push(summary);
        }

        // 从 session 中提取所有 [📤 已发送消息确认] 段落（fallback，兜底 executionRecords 之外的）
        const sentConfirmations: string[] = [];
        for (const msg of compactedMessages) {
            if (msg.role === "user" && msg.content.includes("[📤 已发送消息确认]")) {
                const lines = msg.content.split("\n").filter(l => l.startsWith("- 发送到"));
                sentConfirmations.push(...lines);
            }
        }

        const rebuiltInteractionHistory = this.rebuildCompactedInteractionHistory(compactedMessages);

        // 构建 compact 摘要
        let compactContent = `[SESSION_HISTORY_COMPACT]\n== 之前执行了 ${this.executionCount} 次任务 ==`;
        if (recordSummaries.length > 0) {
            compactContent += `\n${recordSummaries.join("\n")}`;
        }
        if (sentConfirmations.length > 0 && recordSummaries.length === 0) {
            // 如果没有 executionRecords（旧数据），用 session 中提取的兜底
            compactContent += `\n\n== 历史已发消息 ==\n${sentConfirmations.join("\n")}`;
        }
        if (rebuiltInteractionHistory) {
            compactContent += `\n\n${rebuiltInteractionHistory}`;
        }

        const compactMsg: SessionMessage = {
            role: "user",
            content: compactContent,
            timestamp: new Date().toISOString(),
        };

        // 保留最近 keep 条消息 + compact 摘要
        this.session = [compactMsg, ...recentMessages];
        // 清理已被 compact 的 executionRecords（保留最近 3 条）
        if (this.executionRecords.length > 3) {
            this.executionRecords = this.executionRecords.slice(-3);
        }
        this.lastCompactedAt = new Date().toISOString();
        // compaction 后 ledger 必须 reset（旧数据已被压缩，delta 追踪失效）
        this.contextEngine.ledger.reset();
        log.debug("compactSession Layer 1", {
            chatId: this.chatId,
            remaining: this.session.length,
            executionRecords: this.executionRecords.length,
        });

        // ═══ Layer 2: token-budget LLM compact (context-manager) ═══
        const sessionConfigs = resolveComponentProfiles("session");
        const compactConfigs = resolveComponentProfiles("compact");
        const targetSessionConfig = sessionConfigs[0];
        if (targetSessionConfig && compactConfigs.length > 0) {
            const chatMessages: ChatMessage[] = this.session.map(m => ({
                role: m.role,
                content: m.content,
            }));
            if (shouldCompact(chatMessages, undefined, targetSessionConfig)) {
                log.info("compactSession Layer 2: token 仍超预算，调用 context-manager compact", {
                    chatId: this.chatId,
                    messageCount: chatMessages.length,
                });
                try {
                    const compacted = await contextManagerCompact(chatMessages, compactConfigs, undefined, {
                        targetLlmConfig: targetSessionConfig,
                    });
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
