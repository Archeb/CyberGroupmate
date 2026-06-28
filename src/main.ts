/**
 * main.ts — Orchestrator / Main Agent ↔ Subagent Architecture
 *
 * 系统入口点。管理 agent 的完整生命周期：
 * PlatformAdapter → NC → MessageLogWriter + GroupDispatcher → Observer → Accumulator
 * → MainAgentLoop → DecisionMaker → CodeActExecutor → Q5 → GlobalState
 *
 * 架构切换自 subagent.md v0.5.0:
 * - 主 Agent: 快层·决策者，拥有全局上下文，串行轮询 Accumulator 做出决策
 * - Subagent: 慢层·执行者，per-group Observer + CodeActExecutor
 */

import { NotificationCenter, type NotificationEvent } from "./event/notification-center.js";
import { ensureCompositeId, getRawId, getPlatform, getGroupModelKey } from "./core/chat-id.js";
import { SandboxPool } from "./sandbox/sandbox-pool.js";
import type { ShellWakeEvent } from "./sandbox/sandbox.js";
import { installSkillsDependencies } from "./sandbox/skill-loader.js";
import { createSandboxHostCallHandler } from "./sandbox/host-call-handler.js";
import { MemoryStoreV2 } from "./memory-v2/index.js";
import { createMemoryStore } from "./core/memory-factory.js";
import {
    loadConfig,
    resolveComponentProfiles,
    resolveEmbeddingConfig,
    type AppConfig,
    type EnvironmentVariable,
} from "./core/config.js";
import { describeImage, ensureSupportedFormat } from "./core/vision-processor.js";
import { normalizeMessageMediaFields } from "./core/message-enricher.js";
import { TopicRegistry } from "./pipeline/index.js";
import {
    existsSync,
    mkdirSync,
    readFileSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { createLogger } from "./core/logger.js";
import { setGlobalTimezone, getGlobalTimezone } from "./core/timezone.js";
import { TelegramAdapter } from "./adapter/telegram-adapter.js";
import { DiscordAdapter } from "./adapter/discord-adapter.js";
import { OneBotAdapter } from "./adapter/onebot-adapter.js";
import type { PlatformAdapter } from "./adapter/platform-adapter.js";
import { markChatAsRead } from "./adapter/read-receipts.js";

import { SubagentManager } from "./subagent/subagent-manager.js";
import { CallbackQueue } from "./subagent/callback-queue.js";
import { AttentionAccumulator } from "./accumulator/attention-accumulator.js";
import {
    createDirectAddressItem,
    createSchedulerItem,
} from "./accumulator/queue-entry-adapter.js";
import { MainAgentLoop } from "./main-agent/main-agent-loop.js";
import { GlobalState } from "./main-agent/global-state.js";
import { createMetaSessionHandler } from "./main-agent/meta-session-handler.js";
import { buildWakeConditionPayload, matchDelayWakeReminder } from "./main-agent/wake-conditions.js";
import { evaluateStickiness, createStickiness, updateStickiness } from "./subagent/stickiness.js";
import { matchesCron } from "./core/cron-matcher.js";
import { autoReconnect as autoReconnectMcp, initMcpBridge, mcpBridge } from "./sandbox/modules/mcp-bridge/index.js";
import { CodeActExecutor, refreshModuleRegistryCache } from "./subagent/code-act-executor.js";
import { PostTaskWindowManager, buildDispatchedRecordForPostTaskDirect } from "./subagent/post-task-window.js";
import {
    buildDispatchedRecordForShellWakeDirect,
    buildShellWakeDirectTask,
} from "./subagent/shell-wake-task.js";
import type { ActiveUserProfile } from "./subagent/types.js";
import { MetaSandbox } from "./meta-sandbox/meta-sandbox.js";
import { buildMetaApiContext } from "./meta-sandbox/meta-api/index.js";

const log = createLogger("main");

let _metricsStopFn: (() => void) | null = null;

interface StickinessInteractionStats {
    chatId: string;
    interactionCount: number;
    lastInteractionAt: string | null;
}

function getStickinessInteractionStats(memory: MemoryStoreV2, days: number): StickinessInteractionStats[] {
    const grouped = new Map<string, StickinessInteractionStats>();
    for (const [chatId, stats] of memory.countInteractionsPerChat(days)) {
        const groupKey = getGroupModelKey(chatId);
        const current = grouped.get(groupKey);
        if (!current) {
            grouped.set(groupKey, {
                chatId: groupKey,
                interactionCount: stats.interactionCount,
                lastInteractionAt: stats.lastInteractionAt,
            });
            continue;
        }
        current.interactionCount += stats.interactionCount;
        if (stats.lastInteractionAt && (!current.lastInteractionAt || stats.lastInteractionAt > current.lastInteractionAt)) {
            current.lastInteractionAt = stats.lastInteractionAt;
        }
    }
    return [...grouped.values()];
}

function daysSinceInteraction(chatId: string, stats: StickinessInteractionStats[]): number {
    const lastInteractionAt = stats.find(item => item.chatId === chatId)?.lastInteractionAt;
    if (!lastInteractionAt) return Number.POSITIVE_INFINITY;
    return (Date.now() - new Date(lastInteractionAt).getTime()) / 86400_000;
}
let _gracefulShutdown: ((signal: string) => Promise<void>) | null = null;
let _shutdownStarted = false;

async function requestGracefulShutdown(signal: string): Promise<void> {
    if (_shutdownStarted) {
        log.warn("Shutdown already in progress", { signal });
        return;
    }
    _shutdownStarted = true;

    console.log("\n🛑 Shutting down...");
    log.info("收到停止信号", { signal });

    const hardTimeoutMs = 30_000;
    const hardTimeout = setTimeout(() => {
        log.error("Graceful shutdown 超时，强制退出", { timeoutMs: hardTimeoutMs });
        process.exit(1);
    }, hardTimeoutMs);
    if (hardTimeout.unref) hardTimeout.unref();

    let exitCode = 0;
    try {
        if (_gracefulShutdown) {
            await _gracefulShutdown(signal);
        } else {
            // 初始化中断时至少先停掉 metrics exporter
            _metricsStopFn?.();
        }
    } catch (err) {
        exitCode = 1;
        log.error("Graceful shutdown 失败", { signal, error: String(err) });
    } finally {
        clearTimeout(hardTimeout);
        process.exit(exitCode);
    }
}

// ─── 常量 ───

/** 数据目录 */
const DATA_DIR = "workspace";

/** 事件日志路径 */
const EVENTS_PATH = join(DATA_DIR, "events.jsonl");

/** Session transcript 目录 */
const SESSIONS_DIR = join(DATA_DIR, "sessions");

/** 全局 MCP 连接持久化路径 */
const MCP_CONNECTIONS_PATH = join(DATA_DIR, "mcp-connections.json");

// ─── 辅助函数 ───

/**
 * 确保数据目录结构存在
 */
function ensureDataDirs(): void {
    const dirs = [
        DATA_DIR,
        join(DATA_DIR, "tg-session"),
        join(DATA_DIR, "dream-journal"),
    ];
    for (const dir of dirs) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
}

interface EnvPlan {
    hostVisible: Record<string, string>;
    sandboxVisible: Record<string, string>;
    managedKeys: string[];
}

function buildEnvPlan(envVars?: EnvironmentVariable[]): EnvPlan {
    const hostVisible: Record<string, string> = {};
    const sandboxVisible: Record<string, string> = {};
    const managedKeySet = new Set<string>();

    if (envVars) {
        for (const ev of envVars) {
            managedKeySet.add(ev.key);
            if (ev.scope === "host" || ev.scope === "both") {
                hostVisible[ev.key] = ev.value;
            }
            if (ev.scope === "sandbox" || ev.scope === "both") {
                sandboxVisible[ev.key] = ev.value;
            }
        }
    }

    return {
        hostVisible,
        sandboxVisible,
        managedKeys: [...managedKeySet],
    };
}

function applyHostManagedEnv(plan: EnvPlan): void {
    for (const key of plan.managedKeys) {
        if (key in plan.hostVisible) {
            process.env[key] = plan.hostVisible[key];
        } else {
            delete process.env[key];
        }
    }
}

function normalizeEnvVars(envVars?: EnvironmentVariable[]): EnvironmentVariable[] {
    if (!envVars || envVars.length === 0) return [];
    const out: EnvironmentVariable[] = [];
    const seen = new Set<string>();
    for (let i = envVars.length - 1; i >= 0; i--) {
        const ev = envVars[i];
        const key = String(ev.key ?? "").trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, value: String(ev.value ?? ""), scope: ev.scope });
    }
    return out.reverse();
}

function isValidEnvKey(key: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}



function serializeTopic(topic: ReturnType<TopicRegistry["get"]>): Record<string, unknown> | null {
    if (!topic) return null;
    return {
        ...topic,
        participantIds: [...topic.participantIds].map(String),
        messageIds: topic.messageIds.map(String),
        pendingMessages: topic.pendingMessages.map(msg => ({
            ...msg,
            id: String(msg.id),
            chatId: String(msg.chatId),
            senderId: String(msg.senderId),
            replyToMessageId: msg.replyToMessageId ? String(msg.replyToMessageId) : undefined,
        })),
    };
}

// ─── 入口 ───

/**
 * 主入口函数 — Main Agent ↔ Subagent 架构
 */
async function main(): Promise<void> {
    log.info("🤖 CyberGroupmate starting... (Subagent Architecture)");

    // ─── 初始化基础设施 ───
    ensureDataDirs();

    const appConfig = loadConfig();

    // ─── Rate Limiter 初始化 ───
    const { rateLimiter } = await import("./core/llm-rate-limiter.js");
    if (appConfig.rateLimiting) {
        rateLimiter.updateConfig(appConfig.rateLimiting);
    }

    // ─── 全局时区初始化 ───
    setGlobalTimezone(appConfig.timezone);

    // ─── 环境变量注入（按 scope 分流） ───
    let currentEnvPlan = buildEnvPlan(appConfig.envVars);
    applyHostManagedEnv(currentEnvPlan);
    if (currentEnvPlan.managedKeys.length > 0) {
        const hostOnlyKeys = currentEnvPlan.managedKeys.filter((k) => !(k in currentEnvPlan.sandboxVisible));
        log.info("环境变量注入", {
            hostOnly: hostOnlyKeys.length,
            sandboxOnly: Object.keys(currentEnvPlan.sandboxVisible)
                .filter((k) => !(k in currentEnvPlan.hostVisible)).length,
            both: Object.keys(currentEnvPlan.sandboxVisible)
                .filter((k) => k in currentEnvPlan.hostVisible).length,
        });
    }

    log.info("LLM Profiles 加载完成", {
        profiles: Object.keys(appConfig.llmProfiles).join(", "),
        routing: Object.entries(appConfig.llmRouting)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}→${Array.isArray(v) ? `[${v.join(",")}]` : v}`)
            .join(", "),
    });
    if (appConfig.telegram) {
        log.info("Telegram 配置", {
            mode: appConfig.telegram.mode,
            apiId: appConfig.telegram.apiId ? "✓" : "✗",
            apiHash: appConfig.telegram.apiHash ? "✓" : "✗",
            botToken: appConfig.telegram.botToken ? "✓" : "✗",
            whitelist: appConfig.telegram.whitelist?.enabled ? "on" : "off",
        });
    }
    if (appConfig.discord) {
        log.info("Discord 配置", {
            botToken: appConfig.discord.botToken ? "✓" : "✗",
            applicationId: appConfig.discord.applicationId ? "✓" : "✗",
        });
    }
    if (appConfig.onebot) {
        log.info("OneBot 配置", {
            wsUrl: appConfig.onebot.wsUrl ? "✓" : "✗",
            selfId: appConfig.onebot.selfId ? "✓" : "✗",
            whitelist: appConfig.onebot.whitelist?.enabled ? "on" : "off",
        });
    }

    initMcpBridge({
        persistPath: MCP_CONNECTIONS_PATH,
        onRegistryChange: () => {
            refreshModuleRegistryCache();
        },
    });
    await autoReconnectMcp();
    for (const server of appConfig.mcpServers ?? []) {
        if (server.autoConnect === false) continue;
        try {
            await mcpBridge.connect({
                name: server.name,
                transport: server.transport,
                command: server.command,
                args: server.args,
                env: server.env,
                url: server.url,
                headers: server.headers,
            });
        } catch (err) {
            log.warn("MCP 预配置连接失败", { name: server.name, error: String(err) });
        }
    }

    // 共享 MediaDownloader 实例（用于 sendSticker、Dashboard 等）
    const { MediaDownloader } = await import("./core/media-downloader.js");
    const sharedMediaDownloader = new MediaDownloader({
        retentionDays: appConfig.vision?.mediaRetentionDays ?? 3,
        maxFileSize: (appConfig.vision?.maxMediaDownloadSize ?? 20) * 1024 * 1024,
    });

    // 图片目录数据库（独立于 memory.db，用于表情包频率追踪）
    const { ImageCatalog } = await import("./core/image-catalog.js");
    const imageCatalog = new ImageCatalog(join(DATA_DIR, "image-catalog.db"));

    const nc = new NotificationCenter(EVENTS_PATH);
    let shuttingDown = false;
    let sandboxDispatchApi: {
        taskToGroup: (chatId: string, taskSpec: any, options?: any) => Promise<unknown>;
        getTask: (taskId: string) => Promise<unknown>;
        listTasks: (options?: any) => Promise<unknown>;
    } | null = null;

    // ─── 自动检查并安装 Skills 依赖 ───
    await installSkillsDependencies(join(process.cwd(), "workspace", "skills"));

    const sandboxPool = new SandboxPool({
        maxInstances: appConfig.subagent?.maxSandboxInstances ?? 5,
        idleTimeout: appConfig.subagent?.sandboxIdleTimeout ?? 600_000,
        sandboxEnv: currentEnvPlan.sandboxVisible,
        hostOnlyKeys: currentEnvPlan.managedKeys.filter((k) => !(k in currentEnvPlan.sandboxVisible)),
        onAcquire: (sandbox, chatId) => {
            // 每个新建的 sandbox 实例注册 host call handler
            sandbox.on("notify", (event: Record<string, unknown>) => {
                nc.push(event as { type: string;[key: string]: unknown });
            });
            // shell.runBackground() 完成 / 空闲 / 硬超时 → 直达原 Subagent 续接任务
            sandbox.on("shell_wake", (event: ShellWakeEvent) => {
                enqueueShellWakeDirectTask(chatId, event);
            });
            sandbox.setHostCallHandler(createSandboxHostCallHandler(chatId, {
                appConfig,
                globalState,
                memory,
                adapters,
                sandbox,
                sandboxPool,
                mcpBridge,
                accumulator,
                dispatchApi: {
                    taskToGroup: async (targetChatId, taskSpec, options) => {
                        if (!sandboxDispatchApi) {
                            throw new Error("dispatch API not initialized");
                        }
                        return sandboxDispatchApi.taskToGroup(targetChatId, taskSpec, options);
                    },
                    getTask: async (taskId) => {
                        if (!sandboxDispatchApi) {
                            throw new Error("dispatch API not initialized");
                        }
                        return sandboxDispatchApi.getTask(taskId);
                    },
                    listTasks: async (options) => {
                        if (!sandboxDispatchApi) {
                            throw new Error("dispatch API not initialized");
                        }
                        return sandboxDispatchApi.listTasks(options);
                    },
                },
                buildEnvPlan,
                getCurrentEnvPlan: () => currentEnvPlan,
                setCurrentEnvPlan: (plan) => {
                    currentEnvPlan = plan;
                },
                applyHostManagedEnv,
            }));
            sandbox.on("stderr", (data: string) => {
                if (data.trim()) {
                    log.warn("Sandbox stderr", { chatId, output: data.trim() });
                }
            });
            sandbox.on("print", (message: string) => {
                console.log(`🤖 ${message}`);
            });
            sandbox.on("input_request", ({ id, prompt }: { id: string; prompt: string }) => {
                log.info("Agent 请求输入", { chatId, prompt });
                hostRL.question(`🤖 ${prompt}`, (answer: string) => {
                    sandbox.sendInputResponse(id, answer.trim());
                });
            });
            log.debug("SandboxPool onAcquire: 已初始化", { chatId });
        },
    });
    // 经由工厂构建：本地 SQLite 存储 + 检索，并注入全局隐私分级。
    // embedding 检索由 embedding.enabled 开关控制（默认关 → 走 FTS5/LIKE 关键词召回；
    // 开启后写入异步生成向量、recall 走向量，存量需跑一次 cli memory backfill-embeddings）。
    const embeddingConfig = resolveEmbeddingConfig(appConfig);
    const memory = createMemoryStore(join(DATA_DIR, "memory.db"), { config: appConfig, embeddingConfig });
    const { createInterface: createRL } = await import("node:readline");
    const hostRL = createRL({ input: process.stdin, output: process.stdout });

    const promptUser = async (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            hostRL.question(`🤖 ${prompt}`, (answer: string) => {
                resolve(answer.trim());
            });
        });

    // ─── Adapter 初始化（条件性创建） ───
    const adapters: PlatformAdapter[] = [];

    if (appConfig.telegram) {
        const telegramAdapter = new TelegramAdapter(
            appConfig.telegram,
            nc,
            promptUser,
            (message) => console.log(`🤖 ${message}`),
            undefined, // use default client factory
            sharedMediaDownloader,
        );
        adapters.push(telegramAdapter);
    }

    if (appConfig.discord) {
        const discordAdapter = new DiscordAdapter(appConfig.discord, nc, memory);
        adapters.push(discordAdapter);
    }

    if (appConfig.onebot) {
        const onebotAdapter = new OneBotAdapter(appConfig.onebot, nc, sharedMediaDownloader);
        adapters.push(onebotAdapter);
    }

    if (adapters.length === 0) {
        throw new Error("至少需要配置一个平台 adapter（telegram / discord / onebot）");
    }

    // 通用路由函数
    function getAdapterForChat(chatId: string): PlatformAdapter | undefined {
        try {
            const platform = getPlatform(chatId);
            return adapters.find(a => a.platform === platform);
        } catch {
            return undefined;
        }
    }

    function markDirectSubagentDeliveryAsRead(chatId: string, reason: string): void {
        markChatAsRead(adapters, chatId, reason);
    }

    // ─── Subagent 架构组件初始化 ───
    // 注意: message_log 落盘由 RecordingPipeline Step 4 负责，不再需要独立的 MessageLogWriter hook
    let accumulator: AttentionAccumulator;
    let postTaskWindows: PostTaskWindowManager | null = null;
    const subagentManager = new SubagentManager({
        observerConfig: {
            engagementWindowMs: 5 * 60 * 1000,
            alertEngagementThreshold: appConfig.subagent?.alertEngagementThreshold ?? 60,
            mentionKeywords: appConfig.notification?.mentionKeywords ?? [],
        },
        recordingDeps: {
            personaName: appConfig.persona?.name ?? "赛博群友",
            personaDescription: appConfig.persona?.description ?? "赛博群友",
            memory,
            // 开启 embedding 时，RecordingPipeline 才会为新话题增量生成向量（否则话题向量永远为空，
            // 只能靠 cli backfill 补，召回退化为关键词）。
            embeddingConfig,
            pipelineConfig: appConfig.recordingPipeline,
            publishTopicSignals: (signals) => {
                const deliverableSignals = signals.filter((signal) => !postTaskWindows?.hasActiveWindow(signal.chatId));
                const suppressedCount = signals.length - deliverableSignals.length;
                for (const signal of deliverableSignals) {
                    accumulator.ingest(2, {
                        chatId: signal.chatId,
                        source: "TOPIC_SIGNAL",
                        payload: signal.payload,
                        enqueuedAt: signal.enqueuedAt,
                        pressure: signal.pressure,
                    });
                }

                if (suppressedCount > 0) {
                    log.info("topic-signals suppressed by post-task window", {
                        count: suppressedCount,
                        chatIds: [...new Set(signals
                            .filter((signal) => postTaskWindows?.hasActiveWindow(signal.chatId))
                            .map((signal) => signal.chatId))],
                    });
                }

                if (deliverableSignals.length > 0) {
                    log.info("topic-signals → Accumulator", {
                        chatId: deliverableSignals[0]?.chatId,
                        count: deliverableSignals.length,
                        topics: deliverableSignals.map((signal) => ({
                            topicId: signal.topicId,
                            pressure: signal.pressure,
                            callbackPotential: signal.callbackPotential,
                        })),
                    });
                }
            },
        },
        memory,  // 用于启动时恢复 TopicRegistry
        sessionsDir: SESSIONS_DIR,

        // Stickiness 恢复：按近 7 天 agent 互动量在活跃群中的排名推断级别
        stickinessProvider: (chatId: string) => {
            const groupKey = getGroupModelKey(chatId);
            const gm = memory.getGroupModel(groupKey);
            if (!gm) return undefined;
            const recentInteractionStats = getStickinessInteractionStats(memory, 7);
            const lastInteractionStats = getStickinessInteractionStats(memory, 3650);
            const level = evaluateStickiness(
                gm,
                daysSinceInteraction(groupKey, lastInteractionStats),
                "STRANGER",
                recentInteractionStats,
            );
            if (level !== "STRANGER") {
                log.info("stickinessProvider: 从互动排名恢复", { chatId, level });
                return createStickiness(level);
            }
            return undefined;
        },
    });
    // 启动时恢复已保存的 subagent sessions
    const restoredChatIds = subagentManager.restoreAll();
    if (restoredChatIds.length > 0) {
        log.info("已恢复 subagent sessions", { count: restoredChatIds.length, chatIds: restoredChatIds });
    }
    const q5 = new CallbackQueue();
    const globalState = new GlobalState({
        filePath: join(DATA_DIR, "global-state.json"),
        autoSaveInterval: 30000,
    });
    accumulator = new AttentionAccumulator(globalState, {
        windowMs: appConfig.subagent?.pollInterval ?? 5000,
    });
    accumulator.restoreSignalPool();
    postTaskWindows = new PostTaskWindowManager({
        windowMs: appConfig.subagent?.postTaskWindowMs,
        callbackQueue: q5,
        accumulator,
        subagentManager,
        onDirectTaskEnqueued: (task) => {
            try {
                globalState.recordDispatchedSubagentTask(buildDispatchedRecordForPostTaskDirect(task));
            } finally {
                markDirectSubagentDeliveryAsRead(task.chatId, "post-task-direct");
            }
        },
        recentMessagesProvider: (chatId, limit) => memory.getRecentMessages(chatId, limit).reverse().map((message) => ({
            messageId: String(message.messageId),
            sender: String(message.displayName || message.userId || "?"),
            text: String(message.text ?? ""),
            timestamp: String(message.timestamp ?? ""),
            replyToMessageId: message.replyToMessageId ? String(message.replyToMessageId) : undefined,
            mediaType: message.mediaType ?? undefined,
            mediaInfo: message.mediaInfo ?? undefined,
        })),
        stickerDescriptionLookup: memory,
        downloadFnProvider: (chatId) => buildDownloadFn(chatId),
        mediaDownloader: sharedMediaDownloader,
    });

    log.info("Subagent 组件初始化完成", {
        restoredSignalPoolSize: accumulator.getSignalPoolSize(),
    });

    // ─── NC.onPush: 消息实时处理管线 ───
    // mentionKeywords 现在在每次消息到达时动态从 loadConfig() 读取（支持热重载）

    // Hook 2: 消息分发到 per-group GroupSubagent (Observer + RecordingPipeline)
    nc.onPush(event => {
        if (shuttingDown) return;
        const chatId = String(event.chatId ?? "");
        if (!chatId) return;

        // ─── Agent 发出消息的即时落盘（Fix: 修复 agent 消息不可见导致重复回复） ───
        // system.agent_message_sent 事件不属于普通 adapter 入站消息；
        // 这里即时写入 message_log，确保 getRecentMessages() 能看到 agent 消息。
        const eventType = String(event.type ?? "");
        if (eventType === "system.agent_message_sent") {
            // Fix: sandbox 发出的 agent_message_sent 事件中 chatId 是 raw ID（因为
            // code-act-executor 用 getRawId 注入 prompt），但 message_log 需要
            // composite key 才能被 getRecentMessages(compositeId) 查询到。
            // 从 event.scene 动态获取平台名（sandbox 模块设置：telegram.ts → "telegram"，
            // 未来 discord.ts → "discord"），用 ensureCompositeId 补全前缀。
            const platform = String(event.scene ?? "") as import("./core/chat-id.js").PlatformName;
            const compositeChatId = ensureCompositeId(platform, chatId);
            const messageId = String(event.messageId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
            const timestamp = typeof event.timestamp === "string"
                ? event.timestamp
                : new Date(typeof event.timestamp === "number" ? event.timestamp : Date.now()).toISOString();
            const agentName = appConfig.persona?.name ?? "agent";
            const text = String(event.text ?? "");
            const mediaFields = normalizeMessageMediaFields((event as any).mediaInfo, text);
            try {
                memory.storeMessageBatch([{
                    messageId,
                    chatId: compositeChatId,
                    userId: agentName,
                    displayName: appConfig.persona?.name ?? "赛博群友",
                    text,
                    replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
                    timestamp,
                    mediaType: mediaFields.mediaType,
                    mediaInfo: mediaFields.mediaInfo,
                }]);
                memory.storeInteraction({
                    chatId: compositeChatId,
                    userId: agentName,
                    topicId: null,
                    type: "agent_replied",
                    summary: text.slice(0, 200),
                    sentiment: "neutral",
                    significance: 0.7,
                    date: timestamp,
                });
            } catch (err) {
                log.warn("Agent 消息落盘失败", { chatId: compositeChatId, error: String(err) });
            }

            // 同步喂给 RecordingPipeline buffer，使 flush 时 LLM prompt 能看到 agent 消息
            // （与普通消息双路写入一致：即时落盘 DB + 喂给 buffer）
            const agentSub = subagentManager.get(compositeChatId);
            if (agentSub?.recordingPipeline) {
                const agentMsg: import("./pipeline/types.js").Message = {
                    id: messageId,
                    chatId: compositeChatId,
                    senderId: agentName,
                    senderName: appConfig.persona?.name ?? "赛博群友",
                    text,
                    timestamp: Date.now(),
                    replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
                    mediaType: mediaFields.mediaType,
                    mediaInfo: mediaFields.mediaInfo,
                };
                agentSub.recordingPipeline.onMessage(agentMsg);
            }
            postTaskWindows.handleSentMessage(compositeChatId, event);

            return; // agent 消息不走后续 Observer/Accumulator 逻辑
        }

        // 接收所有消息类型事件（TelegramAdapter 使用 "nc.message"）
        if (eventType !== "nc.message") return;

        // ─── 即时落盘：确保 message_log 实时可查 ───
        // RecordingPipeline 的 flush 是延迟触发的（50 条消息 OR 2 分钟静默），
        // 但 attend-handler 在每个 tick（~5s）就会通过 memory.getRecentMessages()
        // 从 message_log 表读取最近消息构建 LLM 上下文。
        // 如果不在此处即时写入，最新消息在 flush 之前对 attend-handler 不可见。
        // storeMessageBatch 内部使用 INSERT OR IGNORE，所以 RecordingPipeline
        // 后续 flush 时的重复写入不会冲突。
        try {
            memory.storeMessageBatch([{
                messageId: String(event.messageId ?? event.id ?? `msg_${Date.now()}`),
                chatId,
                userId: ensureCompositeId(getPlatform(chatId), String(event.userId ?? event.user_id ?? event.senderId ?? "")),
                displayName: String(event.displayName ?? event.senderName ?? event.userName ?? ""),
                text: String(event.text ?? event.message ?? ""),
                replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
                timestamp: new Date().toISOString(),
                mediaType: (event as any).mediaInfo?.type ?? undefined,
                mediaInfo: (event as any).mediaInfo ? JSON.stringify((event as any).mediaInfo) : undefined,
            }]);
        } catch (err) {
            log.warn("即时消息落盘失败", { chatId, error: String(err) });
        }

        // ─── username 持久化到 PersonIdentity（供 attend-handler activePersons 使用） ───
        const eventUsername = event.username as string | undefined;
        if (eventUsername) {
            const eventUserId = String(event.userId ?? event.user_id ?? event.senderId ?? "");
            if (eventUserId) {
                try {
                    const compositeUid2 = ensureCompositeId(getPlatform(chatId), eventUserId);
                    memory.upsertPersonIdentity(compositeUid2, { username: eventUsername });
                } catch { /* 非关键路径 */ }
            }
        }

        // ─── chatTitle 持久化：确保 group_models 表有群名/私聊对象名 ───
        // 群聊: event.chatTitle 来自 chat.title
        // 私聊: chatTitle 为对方 displayName（normalizeChat fallback），也可以用 event.displayName
        const isDMChat = !!event.isDirectMessage;
        const incomingTitle = isDMChat
            ? String(event.displayName ?? event.chatTitle ?? "")
            : String(event.chatTitle ?? "");
        if (incomingTitle) {
            try {
                const existing = memory.getGroupModel(getGroupModelKey(chatId));
                if (!existing || existing.chatTitle !== incomingTitle) {
                    memory.upsertGroupModel(getGroupModelKey(chatId), { chatTitle: incomingTitle, isDirectMessage: isDMChat });
                    log.debug("chatTitle 已更新", { chatId, chatTitle: incomingTitle, isDM: isDMChat });
                }
            } catch (err) {
                log.warn("chatTitle 持久化失败", { chatId, error: String(err) });
            }
        }

        const sub = subagentManager.getOrCreate(chatId);
        // Per-group: Observer + RecordingPipeline 同时处理消息 (subagent.md §3.1)
        sub.onMessage(event);

        // 紧急路径：DM / @mention / 文本提及 agent 名字 → 立即注入 Layer 0。
        const isDM = !!event.isDirectMessage;
        const isMention = !!event.mentionsAgent;
        // 文本提及检测：检查消息内容是否包含配置的 mention_keywords（agent 名字等）
        // 动态读取（支持热重载）
        const mentionKeywords = (loadConfig().notification?.mentionKeywords ?? []).map(k => k.toLowerCase()).filter(k => k.length > 0);
        const messageText = String(event.text ?? event.message ?? "").toLowerCase();
        const hasNameMention = mentionKeywords.length > 0 && mentionKeywords.some(kw => messageText.includes(kw));
        const isReplyToAgentInPostTaskWindow = postTaskWindows.isReplyToWindowSentMessage(chatId, event);
        const directReason = isDM
            ? "DM"
            : isMention
                ? "@mention"
                : hasNameMention
                    ? "name-mention"
                    : isReplyToAgentInPostTaskWindow
                        ? "reply-to-agent"
                        : "";
        const isDirectAttention = directReason.length > 0;
        const executor = sub.codeActExecutor as import("./subagent/code-act-executor.js").CodeActExecutor | null;
        const executorProcessing = !!executor?.isProcessing();

        postTaskWindows.recordMessage(chatId, event, { isDirectAttention, directReason: directReason || undefined });

        if (isDirectAttention) {
            const handledByPostTaskWindow = executorProcessing
                ? postTaskWindows.hasActiveWindow(chatId)
                : postTaskWindows.tryForwardDirectMessage(chatId, event, directReason);
            if (!handledByPostTaskWindow) {
                const entry = sub.buildQueueEntry("DIRECT_ADDRESS");
                accumulator.ingest(0, createDirectAddressItem(chatId, {
                    reason: directReason,
                    queueEntry: entry,
                    event: {
                        messageId: event.messageId ?? event.id,
                        userId: event.userId ?? event.senderId,
                    },
                }));
            }
            log.info("即时 → Layer0", {
                chatId,
                reason: directReason,
                handledByPostTaskWindow,
                engagement: sub.observer.getEngagementScore(),
            });

            // 记录入方向交互（用户 → agent，此刻已发生）
            try {
                const rawUserId = String(event.userId ?? event.senderId ?? "");
                const userId = rawUserId ? ensureCompositeId(getPlatform(chatId), rawUserId) : "";
                const displayName = String(event.displayName ?? event.senderName ?? event.userName ?? "");
                const messageText = String(event.text ?? event.message ?? "").slice(0, 200);
                // Issue 4: 包含发言人信息的交互摘要
                const summary = displayName ? `[${displayName}] ${messageText}` : messageText;
                memory.storeInteraction({
                    chatId,
                    userId,
                    topicId: null,
                    type: isDM ? "direct_message" : "agent_mentioned",
                    summary,
                    sentiment: "neutral",
                    significance: isDM ? 0.8 : 0.6,
                    date: new Date().toISOString(),
                });
                // Issue 3: 同步 displayName 到 PersonIdentity
                if (userId && displayName) {
                    const compositeUid = ensureCompositeId(getPlatform(chatId), userId);
                    memory.upsertPersonIdentity(compositeUid, { displayName });
                }
            } catch { /* 非关键路径 */ }
        }

        // 层 2 消息前送：执行中只前送 direct attention。
        // 群聊普通消息留给 Observer / post-task follow-up，避免每句话都打断当前 task。
        if (executorProcessing && executor && isDirectAttention) {
            executor.pushPendingMessage({
                messageId: String(event.messageId ?? event.id ?? `msg_${Date.now()}`),
                sender: String(event.displayName ?? event.senderName ?? event.userName ?? "?"),
                text: String(event.text ?? event.message ?? ""),
                timestamp: String(event.timestamp ?? new Date().toISOString()),
                isDirectAttention,
                directReason: directReason || undefined,
                replyToMessageId: event.replyToMessageId != null ? String(event.replyToMessageId) : undefined,
                mediaType: (event as any).mediaInfo?.type ?? undefined,
                mediaInfo: (event as any).mediaInfo ? JSON.stringify((event as any).mediaInfo) : undefined,
            });
            markDirectSubagentDeliveryAsRead(chatId, "pending-message-forward");
        }

    });

    // Per-group TopicRegistry 定时清理（遍历所有 subagent 的 topicRegistry）
    const topicCleanupInterval = setInterval(() => {
        for (const sub of subagentManager.getAllSubagents()) {
            sub.topicRegistry.cleanup();
        }
    }, 60_000);
    if (topicCleanupInterval.unref) topicCleanupInterval.unref();

    // Subagent 实例是 chat-bound 的，不做空闲回收。
    // Sandbox 空闲回收由 SandboxPool 独立管理。

    // ─── Reflection 定时器 ───
    // 参数现在在定时器内动态读取，支持热重载
    const checkInterval = ((appConfig.reflection?.checkInterval ?? 300)) * 1000;
    const lastActivityPerChat = new Map<string, number>();
    const lastReflectedAtMap = new Map<string, number>();
    const reflectionInProgress = new Set<string>();

    function isOutsideAwakeHours(): boolean {
        const awakeHours = loadConfig().reflection?.awakeHours;
        if (!awakeHours) return false;
        const [start, end] = awakeHours;
        let currentHour: number;
        const tz = getGlobalTimezone();
        if (tz) {
            try {
                const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz });
                currentHour = parseInt(formatter.format(new Date()), 10);
            } catch {
                currentHour = new Date().getHours();
            }
        } else {
            currentHour = new Date().getHours();
        }
        if (start <= end) {
            return currentHour < start || currentHour >= end;
        }
        return currentHour >= end && currentHour < start;
    }

    // Track chat activity for reflection
    nc.onPush(event => {
        if (shuttingDown) return;
        const chatId = String(event.chatId ?? "");
        if (chatId) lastActivityPerChat.set(chatId, Date.now());
    });

    const reflectionInterval = setInterval(async () => {
        if (shuttingDown) return;
        const now = Date.now();
        for (const [chatId, lastActive] of lastActivityPerChat) {
            if (reflectionInProgress.has(chatId)) continue;

            const silentSec = (now - lastActive) / 1000;
            const lastReflected = lastReflectedAtMap.get(chatId) ?? 0;
            const sinceReflectionSec = lastReflected > 0 ? (now - lastReflected) / 1000 : Infinity;

            // 动态读取 reflection 参数（支持热重载）
            const reflCfg = loadConfig().reflection ?? {};
            const silenceThreshold = reflCfg.silenceThreshold ?? 7200;
            const maxInterval = reflCfg.maxInterval ?? 86400;

            const silenceTriggered = silentSec >= silenceThreshold;
            const maxIntervalTriggered = sinceReflectionSec >= maxInterval;
            const scheduleTriggered = isOutsideAwakeHours() && sinceReflectionSec > 3600;

            if (silenceTriggered || maxIntervalTriggered || scheduleTriggered) {
                reflectionInProgress.add(chatId);
                const reason = silenceTriggered ? "冷场触发" : maxIntervalTriggered ? "最大间隔触发" : "作息触发";
                log.info(`${reason} Reflection`, { chatId });
                try {
                    const result = await memory.reflect(chatId, undefined, reflCfg);
                    lastReflectedAtMap.set(chatId, Date.now());

                    // Stickiness 重评估（architecture_v2.md §2.2）
                    const sub = subagentManager.get(chatId);
                    if (sub) {
                        const groupKey = getGroupModelKey(chatId);
                        const gm = memory.getGroupModel(groupKey);
                        if (gm) {
                            const recentInteractionStats = getStickinessInteractionStats(memory, 7);
                            const lastInteractionStats = getStickinessInteractionStats(memory, 3650);
                            const newLevel = evaluateStickiness(
                                gm,
                                daysSinceInteraction(groupKey, lastInteractionStats),
                                sub.stickiness.level,
                                recentInteractionStats,
                            );
                            if (newLevel !== sub.stickiness.level) {
                                const oldLevel = sub.stickiness.level;
                                sub.stickiness = updateStickiness(sub.stickiness, newLevel);
                                log.info("Stickiness 变更", { chatId, from: oldLevel, to: newLevel });
                            }
                        }
                    }

                    log.info("Reflection 完成", {
                        chatId,
                        period: `${result.reflectedPeriod.from} → ${result.reflectedPeriod.to}`,
                        personUpdates: result.personUpdates.length,
                        newFacts: result.newCoreFacts.length,
                        merged: result.mergedEpisodes,
                    });
                } catch (err) {
                    log.error("Reflection 失败", { chatId, error: String(err) });
                } finally {
                    reflectionInProgress.delete(chatId);
                    if (silenceTriggered) {
                        lastActivityPerChat.delete(chatId);
                    }
                }
            }
        }
    }, checkInterval);
    if (reflectionInterval.unref) reflectionInterval.unref();

    // ─── MainAgentLoop 配置 ───
    const mainLoop = new MainAgentLoop(accumulator, q5, subagentManager, {
        pollInterval: appConfig.subagent?.pollInterval ?? 5000,
    }, globalState, adapters);



    const sendTyping = async (chatId: string) => {
        const adapter = getAdapterForChat(chatId);
        if (!adapter) {
            return;
        }
        const typingMethod = `${adapter.platform}.sendTyping`;
        await adapter.handleCall(typingMethod, [chatId]);
    };

    const buildDownloadFn = (chatId: string) => {
        const adapter = adapters.find((item) => chatId.startsWith(item.platform + ":"));
        if (!adapter) {
            return undefined;
        }
        return async (fileId: string, mediaChatId?: string, messageId?: string, uniqueFileId?: string): Promise<Buffer> => {
            const result = await adapter.handleCall(`${adapter.platform}.downloadMedia`, [fileId, mediaChatId ?? chatId, messageId, uniqueFileId]);
            if (Buffer.isBuffer(result)) {
                return result;
            }
            if (result && typeof result === "object" && "buffer" in result) {
                return Buffer.from((result as { buffer: string }).buffer, "base64");
            }
            throw new Error(`downloadMedia: unexpected result type: ${typeof result}`);
        };
    };

    function initializeCodeActExecutor(executor: CodeActExecutor, chatId: string): void {
        const currentConfig = loadConfig();
        const persona = currentConfig.persona;
        const visionConfig = currentConfig.vision;
        const visionLlmConfig = currentConfig.llmRouting.vision
            ? resolveComponentProfiles("vision", currentConfig)[0]
            : undefined;
        const chatAdapter = adapters.find((item) => chatId.startsWith(item.platform + ":"));
        const formatMention = chatAdapter
            ? (rawId: string, username?: string) => chatAdapter.formatMention(rawId, username)
            : undefined;

        executor.setCallbackHandler((cb) => {
            postTaskWindows?.handleCallback(cb);

            setTimeout(() => {
                try {
                    const sub = subagentManager.get(cb.chatId);
                    if (sub?.recordingPipeline) {
                        sub.recordingPipeline.flush();
                    }
                } catch (error) {
                    log.debug("post-session flush failed", { chatId: cb.chatId, error: String(error) });
                }
            }, 60_000);
        });
        executor.setPendingMessageDrainHandler((messages, source) => {
            postTaskWindows?.markMessagesInjected(
                chatId,
                messages.map((message) => message.messageId),
                `mid-turn-${source}`,
            );
        });
        executor.setDependencies(
            sandboxPool,
            nc,
            persona,
            memory,
            visionConfig,
            buildDownloadFn(chatId),
            sendTyping,
            visionLlmConfig,
            sharedMediaDownloader,
            formatMention,
            globalState,
        );
    }

    function ensureCodeActExecutor(chatId: string): CodeActExecutor {
        const subagent = subagentManager.getOrCreate(chatId);
        let executor = subagent.codeActExecutor as CodeActExecutor | null | undefined;
        if (!executor) {
            executor = new CodeActExecutor(chatId);
            subagent.codeActExecutor = executor;
        }

        if (!executor.getSessionFilePath()) {
            executor.setSessionFilePath(subagentManager.getSessionFilePath(chatId));
            executor.loadSession();
        }

        initializeCodeActExecutor(executor, chatId);
        return executor;
    }

    function enqueueShellWakeDirectTask(chatId: string, event: ShellWakeEvent): void {
        try {
            const subagent = subagentManager.getOrCreate(chatId);
            const executor = ensureCodeActExecutor(chatId);
            const task = buildShellWakeDirectTask({
                chatId,
                event,
                queueEntry: subagent.buildQueueEntry("SCHEDULER_TRIGGER"),
            });

            globalState.recordDispatchedSubagentTask(buildDispatchedRecordForShellWakeDirect(task, event));
            executor.enqueue(task);
            markDirectSubagentDeliveryAsRead(chatId, "shell-wake");
            log.info("shell_wake → subagent", {
                chatId,
                taskId: task.taskId,
                tabId: event.tabId,
                reason: event.reason,
            });
        } catch (error) {
            log.error("shell_wake direct enqueue failed", {
                chatId,
                tabId: event.tabId,
                reason: event.reason,
                error: error instanceof Error ? error.stack ?? error.message : String(error),
            });
        }
    }

    let activeUserProfilesForDispatch = new Map<string, ActiveUserProfile[]>();
    let metaSandbox: MetaSandbox | null = null;
    let harnessManager: import("./harness/manager.js").HarnessManager | null = null;
    const metaApiContext = buildMetaApiContext({
        memory,
        subagentManager,
        globalState,
        accumulator,
        groundingConfig: appConfig.grounding,
        getActiveUserProfilesForChat: (chatId) => activeUserProfilesForDispatch.get(chatId),
        getQuoteOutput: (index) => metaSandbox?.getOutput(index),
        getHarnessManager: () => harnessManager,
        workspaceRoot: process.cwd(),
        onTaskDispatched: (task) => {
            metricsInstance?.groupCollector.onAttend(task.chatId, "REPLY");
        },
        initializeExecutor: (executor, chatId) => {
            initializeCodeActExecutor(executor as CodeActExecutor, chatId);
        },
    });
    sandboxDispatchApi = metaApiContext.dispatch;
    metaSandbox = new MetaSandbox(metaApiContext);

    mainLoop.setMetaSessionHandler(createMetaSessionHandler({
        getPersona: () => loadConfig().persona,
        globalState,
        memory,
        sandbox: metaSandbox,
        setActiveUserProfilesForDispatch: (profilesByChatId) => {
            activeUserProfilesForDispatch = new Map(profilesByChatId);
        },
        getLlmConfigs: () => resolveComponentProfiles("meta", loadConfig()),
        maxTurns: 10,
        codeTimeout: 30_000,
        llmTimeoutMs: 60_000,
    }));

    log.info("MainAgentLoop 配置完成");

    // ─── 贴纸检测定时器（定期扫描待判定的图片） ───
    const stickerStealingEnabled = appConfig.vision?.stickerStealingEnabled !== false;
    const visionLlmConfigsForDetector = appConfig.llmRouting.vision
        ? resolveComponentProfiles("vision", appConfig)
        : resolveComponentProfiles("session", appConfig);
    if (stickerStealingEnabled && visionLlmConfigsForDetector.length > 0) {
        const { StickerDetector } = await import("./core/sticker-detector.js");
        const minFreq = appConfig.vision?.stickerStealingMinFrequency ?? 3;
        const intervalMin = appConfig.vision?.stickerStealingIntervalMin ?? 10;
        const stickerDetector = new StickerDetector({
            imageCatalog,
            mediaDownloader: sharedMediaDownloader,
            memory,
            visionConfigs: visionLlmConfigsForDetector,
            minFrequency: minFreq,
            newStickerEnabledByDefault: appConfig.vision?.newStickerDefault !== "disabled",
        });
        const STICKER_DETECT_INTERVAL = intervalMin * 60 * 1000;
        const stickerDetectTimer = setInterval(() => {
            stickerDetector.processCandidates().catch(err => {
                log.warn("贴纸检测定时任务失败", { error: String(err) });
            });
        }, STICKER_DETECT_INTERVAL);
        if (stickerDetectTimer.unref) stickerDetectTimer.unref();
        // 启动后延迟 1 分钟首次运行
        setTimeout(() => {
            stickerDetector.processCandidates().catch(err => {
                log.warn("贴纸检测首次运行失败", { error: String(err) });
            });
        }, 60_000);
        log.info("贴纸检测定时器已启动", { intervalMin, minFreq });
    } else if (!stickerStealingEnabled) {
        log.info("偷表情包功能已禁用");
    }

    // ─── Dashboard 监控仪表盘 ───
    const dashboardEnabled = appConfig.dashboard?.enabled !== false;
    let dashboardServer: { stop: () => void } | null = null;
    let dashboardDeps: import("./dashboard/types.js").DashboardDeps | null = null;
    if (dashboardEnabled) {
        const { DashboardServer } = await import("./dashboard/dashboard-server.js");
        const { TokenStatsCollector } = await import("./dashboard/token-stats.js");
        const dashboardHost = appConfig.dashboard?.host ?? "127.0.0.1";
        const dashboardToken = appConfig.dashboard?.token ?? "cybergroupmate";
        const dashboardPort = appConfig.dashboard?.port ?? 6767;
        if ((dashboardHost === "0.0.0.0" || dashboardHost === "::") && !String(dashboardToken).trim()) {
            throw new Error("Dashboard 绑定 0.0.0.0 或 :: 时 token 不能为空（请设置 dashboard.token）");
        }

        const tokenStats = new TokenStatsCollector(
            join(DATA_DIR, "token-stats.json"),
            appConfig.llmProfiles,
        );

        // 进程退出时保存统计
        process.on("exit", () => tokenStats.shutdown());

        dashboardDeps = {
                nc,
                subagentManager,
                accumulator,
                q5,
                mainLoop,
                globalState,
                sandboxPool,
                memory,
                tokenStats,
                mediaDownloader: sharedMediaDownloader,
                imageCatalog,
                adapters,
                metaSandbox,
                onConfigSaved: async (config) => {
                    tokenStats.setProfiles(config.llmProfiles ?? {});
                    if (config.rateLimiting) {
                        rateLimiter.updateConfig(config.rateLimiting);
                    }
                    const normalized = normalizeEnvVars(config.envVars);
                    currentEnvPlan = buildEnvPlan(normalized);
                    applyHostManagedEnv(currentEnvPlan);
                    await sandboxPool.updateManagedEnv(
                        currentEnvPlan.sandboxVisible,
                        currentEnvPlan.managedKeys,
                    );
                    log.info("Dashboard 配置变更：env 已热同步", {
                        managed: currentEnvPlan.managedKeys.length,
                    });
                },
            };
        const dashboard = new DashboardServer(
            dashboardDeps,
            { host: dashboardHost, port: dashboardPort, token: dashboardToken, enabled: true },
        );
        dashboardServer = dashboard;
        await dashboard.start();
        const displayHost = dashboardHost === "0.0.0.0" || dashboardHost === "::" ? "localhost" : dashboardHost;
        log.info("Dashboard 已启动", { listen: `${dashboardHost}:${dashboardPort}`, url: `http://${displayHost}:${dashboardPort}?token=${dashboardToken}` });
    }

    // ─── Background Agent MCP Server ───
    const mcpServerEnabled = appConfig.backgroundAgent?.enabled !== false;
    let mcpServerInstance: { httpServer: import("node:http").Server; config: { port: number; authToken: string } } | null = null;
    {
        const { writeFileSync, unlinkSync } = await import("node:fs");
        const { join } = await import("node:path");
        const mcpInfoPath = join(process.cwd(), "workspace", "mcp-server-info.json");
        try { unlinkSync(mcpInfoPath); } catch {}
        if (mcpServerEnabled) {
            const { startMcpServer, generateAuthToken } = await import("./mcp-server/index.js");
            const mcpPort = appConfig.backgroundAgent?.mcpPort ?? 3100;
            const mcpToken = appConfig.backgroundAgent?.mcpToken ?? generateAuthToken();
            try {
                mcpServerInstance = await startMcpServer(
                    { metaApi: metaApiContext, globalState, accumulator, sandboxPool, workspaceRoot: process.cwd() },
                    { port: mcpPort, authToken: mcpToken },
                );
                if (mcpServerInstance) {
                    const connInfo = { url: `http://127.0.0.1:${mcpPort}/mcp`, token: mcpToken };
                    writeFileSync(mcpInfoPath, JSON.stringify(connInfo, null, 2));
                }
            } catch (err) {
                log.error("MCP Server 启动失败", { error: String(err) });
            }
        }
    }

    // ─── Background Agent HarnessManager ───
    const bgHarness = appConfig.backgroundAgent?.harness;
    if (mcpServerInstance && (bgHarness === "claude-code" || bgHarness === "copilot")) {
        const { HarnessManager, ClaudeCodeLauncher, CopilotCliLauncher } = await import("./harness/index.js");
        const { buildDreamingDigest } = await import("./harness/dreaming-context.js");
        const launcher = bgHarness === "copilot"
            ? new CopilotCliLauncher(appConfig.backgroundAgent!.copilotPath)
            : new ClaudeCodeLauncher(appConfig.backgroundAgent!.claudeCodePath);
        const model = appConfig.backgroundAgent!.harnessModel ?? appConfig.backgroundAgent!.claudeModel;
        harnessManager = new HarnessManager({
            launcher,
            workDir: process.cwd(),
            mcpUrl: `http://127.0.0.1:${mcpServerInstance.config.port}/mcp`,
            mcpToken: mcpServerInstance.config.authToken,
            persona: appConfig.persona,
            model,
            maxBudgetUsd: appConfig.backgroundAgent!.maxBudgetUsd,
            extraArgs: appConfig.backgroundAgent!.extraArgs,
            minDreamIntervalMs: appConfig.backgroundAgent!.minIntervalHours != null
                ? appConfig.backgroundAgent!.minIntervalHours * 60 * 60_000
                : undefined,
            buildDreamingDigest: (sinceTs) => buildDreamingDigest({
                listTasks: () => globalState.listDispatchedSubagentTasks({ limit: 200 }).tasks,
                memory,
                sinceTs,
            }),
        });
        harnessManager.onSpawnFailure = (error, pendingCount) => {
            globalState.addSessionDigest(`[Background Agent spawn failed] ${error} (${pendingCount} pending tasks)`);
        };
        if (dashboardDeps) dashboardDeps.harnessManager = harnessManager;
        log.info("HarnessManager 已创建", { harness: bgHarness });
    }

    // ─── Prometheus Metrics Exporter ───
    let metricsInstance: import("./metrics/index.js").MetricsInstance | null = null;
    const metricsEnabled = appConfig.metrics?.enabled !== false;
    if (metricsEnabled) {
        const { startMetrics } = await import("./metrics/index.js");
        metricsInstance = await startMetrics(
            { subagentManager, sandboxPool, accumulator, q5, mainLoop },
            appConfig.metrics,
        );

        // Hook 1: 消息到达时更新 group_messages_total
        nc.onPush(event => {
            if (shuttingDown) return;
            const eventType = String(event.type ?? "");
            if (eventType !== "nc.message") return;
            const chatId = String(event.chatId ?? "");
            if (chatId) metricsInstance!.groupCollector.onMessage(chatId);
        });

        log.info("指标 exporter 已启动", {
            host: appConfig.metrics?.host ?? "127.0.0.1",
            port: appConfig.metrics?.port ?? 9091,
            path: appConfig.metrics?.path ?? "/metrics",
        });
        // 将 exporter 存入模块层变量，以便 Graceful shutdown 调用 stop()
        _metricsStopFn = () => metricsInstance!.exporter.stop();
    }

    // NOTE: Sandbox 事件处理和 host call handler 已通过 SandboxPool.onAcquire 回调注册
    // sandbox 实例在 CodeActExecutor.executeWithSandbox() 中按需创建，不再全局启动
    log.info("SandboxPool 已配置", {
        maxInstances: appConfig.subagent?.maxSandboxInstances ?? 5,
        idleTimeout: appConfig.subagent?.sandboxIdleTimeout ?? 600_000,
    });

    // ─── 统一调度器 Watchdog ───
    // 每 30 秒检查到期 reminder 和匹配的 cron 事件
    // 触发时通过 AttentionAccumulator 唤醒主 Agent，而非直接执行代码
    const schedulerWatchdogInterval = setInterval(() => {
        const now = new Date();

        // ── Reminder 检查 ──
        const dueReminders = globalState.getDueReminders();
        for (const reminder of dueReminders) {
            globalState.markReminderTriggered(reminder.id);

            const wakeMatch = matchDelayWakeReminder(reminder, globalState.getWakeConditions());
            if (wakeMatch) {
                globalState.removeWakeCondition(wakeMatch.conditionId);
                accumulator.ingest(1, {
                    chatId: "__meta__",
                    source: "WAKE_CONDITION",
                    enqueuedAt: Date.now(),
                    payload: buildWakeConditionPayload(wakeMatch, { reminderId: reminder.id }),
                });
                log.info("Meta wake delay 到期 → Layer1", {
                    reminderId: reminder.id,
                    conditionId: wakeMatch.conditionId,
                });
                continue;
            }

            const reminderCallback = reminder.callback ?? reminder.description;
            const reminderBindingId = reminder.bindingId ?? (reminder.chatId === "__meta__" ? "meta" : reminder.chatId);
            if (reminder.chatId === "__meta__" || reminder.callback || reminder.bindingId) {
                accumulator.ingest(1, {
                    chatId: "__meta__",
                    source: "SCHEDULER",
                    enqueuedAt: Date.now(),
                    payload: {
                        id: reminder.id,
                        type: "reminder",
                        description: reminderCallback,
                        callback: reminderCallback,
                        bindingId: reminderBindingId,
                        data: reminder.data,
                    },
                });
                log.info("Reminder 到期 → Meta Layer1", {
                    id: reminder.id,
                    bindingId: reminderBindingId,
                    desc: reminderCallback.slice(0, 80),
                });
                continue;
            }

            const sub = subagentManager.getOrCreate(reminder.chatId);
            const entry = sub.buildQueueEntry("SCHEDULER_TRIGGER");
            entry.schedulerTriggers = [{
                id: reminder.id,
                type: "reminder",
                description: reminder.description,
            }];
            accumulator.ingest(1, createSchedulerItem(reminder.chatId, {
                type: "reminder",
                id: reminder.id,
                description: reminder.description,
                queueEntry: entry,
            }));
            log.info("Reminder 到期 → Layer1", { id: reminder.id, desc: reminder.description.slice(0, 80), chatId: reminder.chatId });
        }

        // ── 清理过期已触发 Reminder（超过 7 天） ──
        const purgeBefore = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const evt of globalState.getSchedulerEvents()) {
            if (evt.type !== "reminder" || !evt.triggered || !evt.triggerAt) continue;
            const triggerAtMs = new Date(evt.triggerAt).getTime();
            if (!Number.isFinite(triggerAtMs)) continue;
            if (triggerAtMs < purgeBefore) {
                globalState.cancelSchedulerEvent(evt.id);
            }
        }

        // ── Cron 检查 ──
        const allEvents = globalState.getSchedulerEvents();
        for (const evt of allEvents) {
            if (evt.type !== "cron" || !evt.cronExpr) continue;

            // 防止同一分钟内重复触发
            if (evt.lastTriggeredAt) {
                const lastTrig = new Date(evt.lastTriggeredAt);
                if (
                    lastTrig.getFullYear() === now.getFullYear() &&
                    lastTrig.getMonth() === now.getMonth() &&
                    lastTrig.getDate() === now.getDate() &&
                    lastTrig.getHours() === now.getHours() &&
                    lastTrig.getMinutes() === now.getMinutes()
                ) continue;
            }

            if (!matchesCron(evt.cronExpr, now)) continue;

            globalState.markCronTriggered(evt.id);
            const taskDesc = evt.callback ?? evt.taskTemplate ?? evt.description;
            const cronBindingId = evt.bindingId ?? (evt.chatId === "__meta__" ? "meta" : evt.chatId);

            if (evt.chatId === "__meta__" || evt.callback || evt.bindingId) {
                accumulator.ingest(1, {
                    chatId: "__meta__",
                    source: "SCHEDULER",
                    enqueuedAt: Date.now(),
                    payload: {
                        id: evt.id,
                        type: "cron",
                        description: taskDesc,
                        callback: taskDesc,
                        bindingId: cronBindingId,
                        data: evt.data,
                    },
                });
                log.info("Cron 触发 → Meta Layer1", { id: evt.id, name: evt.name ?? evt.description, bindingId: cronBindingId });
                continue;
            }

            const sub = subagentManager.getOrCreate(evt.chatId);
            const entry = sub.buildQueueEntry("SCHEDULER_TRIGGER");
            entry.schedulerTriggers = [{
                id: evt.id,
                type: "cron",
                description: taskDesc,
            }];
            accumulator.ingest(1, createSchedulerItem(evt.chatId, {
                type: "cron",
                id: evt.id,
                description: taskDesc,
                queueEntry: entry,
            }));
            log.info("Cron 触发 → Layer1", { id: evt.id, name: evt.description, chatId: evt.chatId });
        }
    }, 30_000);
    if (schedulerWatchdogInterval.unref) schedulerWatchdogInterval.unref();

    // ─── Background Agent 定时做梦 ───
    let backgroundDreamingInterval: ReturnType<typeof setInterval> | null = null;
    if (harnessManager) {
        const dreamSchedule = appConfig.backgroundAgent?.schedule ?? "0 3 * * *";
        let lastDreamingMinute = -1;
        backgroundDreamingInterval = setInterval(() => {
            const now = new Date();
            const minuteKey = now.getFullYear() * 1000000 + now.getMonth() * 10000 + now.getDate() * 100 + now.getHours() * 60 + now.getMinutes();
            if (minuteKey === lastDreamingMinute) return;
            if (!matchesCron(dreamSchedule, now)) return;
            lastDreamingMinute = minuteKey;
            log.info("Background Agent 定时做梦触发", { schedule: dreamSchedule });
            harnessManager!.triggerScheduled();
        }, 30_000);
        if (backgroundDreamingInterval.unref) backgroundDreamingInterval.unref();
        log.info("Background Agent 定时做梦已注册", { schedule: dreamSchedule });
    }

    // ─── 启动（并行 + 超时容错） ───
    const ADAPTER_START_TIMEOUT_MS = 30_000;
    const adapterStatuses: Array<{ platform: string; status: "ok" | "failed" | "timeout"; error?: string }> = [];

    await Promise.all(adapters.map(async (adapter) => {
        log.info(`启动 ${adapter.platform} adapter...`);
        try {
            await Promise.race([
                adapter.start(),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error(`启动超时 (${ADAPTER_START_TIMEOUT_MS / 1000}s)`)), ADAPTER_START_TIMEOUT_MS)
                ),
            ]);
            log.info(`${adapter.platform} adapter 就绪`);
            adapterStatuses.push({ platform: adapter.platform, status: "ok" });
        } catch (err) {
            const errMsg = String((err as Error)?.message ?? err);
            log.error(`${adapter.platform} adapter 启动失败，已跳过`, { error: errMsg });
            adapterStatuses.push({ platform: adapter.platform, status: errMsg.includes("超时") ? "timeout" : "failed", error: errMsg });
        }
    }));

    // 广播 adapter 状态到 dashboard
    nc.push({ type: "system.adapter_status", adapters: adapterStatuses });
    const failedAdapters = adapterStatuses.filter(a => a.status !== "ok");
    if (failedAdapters.length > 0) {
        log.warn("部分 adapter 未就绪", { failed: failedAdapters.map(a => `${a.platform}: ${a.error}`) });
    }
    if (adapterStatuses.every(a => a.status !== "ok")) {
        log.error("所有 adapter 均启动失败，但保持进程运行以允许 dashboard 访问");
    }

    // ─── 启动主 Agent 注意力循环 ───
    log.info("启动 MainAgentLoop...");
    mainLoop.start();
    log.info("🤖 CyberGroupmate 运行中 (Subagent Architecture)");

    const runWithTimeout = async (name: string, fn: () => Promise<void>, timeoutMs = 15_000): Promise<void> => {
        await Promise.race([
            fn(),
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`${name} timeout (${timeoutMs}ms)`)), timeoutMs);
            }),
        ]);
    };

    _gracefulShutdown = async (signal: string) => {
        shuttingDown = true;
        log.info("Graceful shutdown 开始", { signal });

        // 先停主循环，停止新的 dispatch/attend
        mainLoop.stop();

        // 停止本进程定时任务
        clearInterval(topicCleanupInterval);
        clearInterval(reflectionInterval);
        clearInterval(schedulerWatchdogInterval);
        if (backgroundDreamingInterval) clearInterval(backgroundDreamingInterval);

        // 停止 Background Agent harness
        if (harnessManager) {
            await harnessManager.shutdown();
        }

        // 停止 MCP server
        if (mcpServerInstance) {
            mcpServerInstance.httpServer.close();
        }

        // 先停止平台输入，避免新消息继续进入系统
        await Promise.allSettled(adapters.map((adapter) =>
            runWithTimeout(`adapter.stop:${adapter.platform}`, () => adapter.stop(), 10_000)
        ));

        // 终止所有 sandbox，避免并发 host call 在收尾期继续写状态
        await runWithTimeout("sandboxPool.dispose", () => sandboxPool.dispose(), 15_000);

        // 强制 flush 每个群的 RecordingPipeline 缓冲，避免尾部消息丢失
        const flushTasks = subagentManager.getAllSubagents().map(async (sub) => {
            const pipeline = sub.recordingPipeline;
            if (!pipeline || pipeline.bufferSize === 0) return;
            await runWithTimeout(
                `recording.flush:${sub.chatId}`,
                () => pipeline.flush(),
                20_000,
            );
        });
        const flushResults = await Promise.allSettled(flushTasks);
        const flushFailed = flushResults.filter(r => r.status === "rejected");
        if (flushFailed.length > 0) {
            log.warn("部分 RecordingPipeline flush 失败", {
                failed: flushFailed.length,
                total: flushResults.length,
            });
        }

        postTaskWindows.dispose();

        // 释放 subagent（含 pipeline 计时器）
        subagentManager.dispose();

        // 停止 dashboard / metrics 导出
        try {
            dashboardServer?.stop();
        } catch (err) {
            log.warn("Dashboard stop 失败", { error: String(err) });
        }
        _metricsStopFn?.();

        // 保存全局状态并释放其自动保存计时器
        accumulator.dispose();
        globalState.dispose();

        // 释放其余资源
        nc.dispose();
        try {
            hostRL.close();
        } catch {
            // ignore
        }

        // DB 最后关闭，确保前序写入已完成
        memory.close();

        log.info("Graceful shutdown 完成");
    };

    // ─── 保持进程活跃 ───
    // MainAgentLoop 使用 setTimeout 自驱动，这里用一个 keep-alive 防止进程退出
    await new Promise(() => {
        // 永不 resolve，保持进程运行
        // 由 SIGINT/SIGTERM 终止
    });
}

// ─── Graceful shutdown ───
process.once("SIGINT", () => {
    void requestGracefulShutdown("SIGINT");
});

process.once("SIGTERM", () => {
    void requestGracefulShutdown("SIGTERM");
});

main().catch((err) => {
    log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
