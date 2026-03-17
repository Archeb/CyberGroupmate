/**
 * main.ts — Orchestrator / Main Agent ↔ Subagent Architecture
 *
 * 系统入口点。管理 agent 的完整生命周期：
 * PlatformAdapter → NC → MessageLogWriter + GroupDispatcher → Observer → Q3
 * → MainAgentLoop → DecisionMaker → CodeActExecutor/FastPath → Q5 → GlobalState
 *
 * 架构切换自 subagent.md v0.5.0:
 * - 主 Agent: 快层·决策者，拥有全局上下文，串行轮询 Q3 做出决策
 * - Subagent: 慢层·执行者，per-group Observer + CodeActExecutor + FastPath
 */

import { NotificationCenter, type NotificationEvent } from "./event/notification-center.js";

import { SandboxPool } from "./sandbox/sandbox-pool.js";
import { createTaskListSkill, buildTaskListHostCalls } from "./sandbox/skills/task-list.js";
import { MemoryStoreV2 } from "./memory-v2/index.js";
import { loadConfig, resolveTierProfile, type AppConfig, type LLMConfig } from "./core/config.js";
import {
    TopicRegistry,
    FeedbackLoop,
    type AgentMessageSentEvent,
} from "./pipeline/index.js";
import {
    existsSync,
    mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "./core/logger.js";
import { TelegramAdapter } from "./adapter/telegram-adapter.js";

import { SubagentManager } from "./subagent/subagent-manager.js";
import { DynamicAttentionQueue } from "./subagent/attention-queue.js";
import { CallbackQueue } from "./subagent/callback-queue.js";
import { MainAgentLoop } from "./main-agent/main-agent-loop.js";
import { GlobalState } from "./main-agent/global-state.js";
import { createAttendHandler } from "./main-agent/attend-handler.js";
import { createDispatchHandler } from "./main-agent/dispatch-handler.js";
import type { FastPathEvent } from "./subagent/fast-path-handler.js";
import { FastPathHandler } from "./subagent/fast-path-handler.js";

const log = createLogger("main");

// ─── 常量 ───

/** 数据目录 */
const DATA_DIR = "workspace";

/** 事件日志路径 */
const EVENTS_PATH = join(DATA_DIR, "events.jsonl");

/** Session transcript 目录 */
const SESSIONS_DIR = join(DATA_DIR, "sessions");

// ─── 辅助函数 ───

/**
 * 确保数据目录结构存在
 */
function ensureDataDirs(): void {
    const dirs = [
        DATA_DIR,
        join(DATA_DIR, "tg-session"),
        SESSIONS_DIR,
    ];
    for (const dir of dirs) {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    }
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
    const llmConfig = resolveTierProfile("mid", appConfig);
    const cheapConfig = resolveTierProfile("cheap", appConfig);
    const midConfig = resolveTierProfile("mid", appConfig);
    const sotaConfig = resolveTierProfile("sota", appConfig);

    log.info("LLM Profiles 加载完成", {
        profiles: Object.keys(appConfig.llmProfiles).join(", "),
        tiers: Object.entries(appConfig.modelTiers).map(([k, v]) => `${k}→${v}`).join(", "),
    });
    log.info("Telegram 配置", {
        mode: appConfig.telegram.mode,
        apiId: appConfig.telegram.apiId ? "✓" : "✗",
        apiHash: appConfig.telegram.apiHash ? "✓" : "✗",
        botToken: appConfig.telegram.botToken ? "✓" : "✗",
    });


    const nc = new NotificationCenter(EVENTS_PATH);
    const sandboxPool = new SandboxPool({
        maxInstances: appConfig.subagent?.maxSandboxInstances ?? 5,
        idleTimeout: appConfig.subagent?.sandboxIdleTimeout ?? 600_000,
        onAcquire: (sandbox, chatId) => {
            // 每个新建的 sandbox 实例注册事件处理和 host call handler
            sandbox.on("notify", (event: Record<string, unknown>) => {
                nc.push(event as { type: string;[key: string]: unknown });
            });
            sandbox.setHostCallHandler(async (method, args) => {
                if (telegramAdapter.canHandle(method)) {
                    return telegramAdapter.handleCall(method, args);
                }
                switch (method) {
                    case "memory.recall":
                        return memory.recall(args[0] as string, args[1] as any);
                    case "memory.browseHistory":
                        return memory.browseHistory(args[0] as any);
                    case "memory.reflect":
                        return memory.reflect(String(args[0]), llmConfig, appConfig.reflection);
                    case "actions.getTopicContext": {
                        // 在所有 per-group topicRegistries 中查找
                        const topicId = String(args[0]);
                        for (const sub of subagentManager.getAllSubagents()) {
                            const t = sub.topicRegistry.get(topicId);
                            if (t) return serializeTopic(t);
                        }
                        return null;
                    }
                    case "actions.listActiveTopics": {
                        const cid = args[0];
                        if (typeof cid === "string" && cid.length > 0) {
                            const sub = subagentManager.get(cid);
                            return sub ? sub.topicRegistry.getActive(cid).map(serializeTopic) : [];
                        }
                        // 聚合所有群组的话题
                        return subagentManager.getAllSubagents()
                            .flatMap(s => s.topicRegistry.getAll())
                            .map(serializeTopic);
                    }
                    case "actions.recallForTopic": {
                        // 在所有 per-group topicRegistries 中查找
                        let topic: any = null;
                        for (const sub of subagentManager.getAllSubagents()) {
                            topic = sub.topicRegistry.get(String(args[0]));
                            if (topic) break;
                        }
                        if (!topic) return null;
                        const query = [topic.label, ...topic.keywords].filter(Boolean).join(" ");
                        return memory.recall(query, {
                            chatId: String(topic.chatId),
                            ...(args[1] as Record<string, unknown> ?? {}),
                        } as any);
                    }
                    default: {
                        // skills.taskList.* host calls
                        const taskListSkill = createTaskListSkill(globalState);
                        const taskListCalls = buildTaskListHostCalls(taskListSkill);
                        if (method in taskListCalls) {
                            return taskListCalls[method](args[0]);
                        }
                        throw new Error(`Unsupported host call: ${method}`);
                    }
                }
            });
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
    const memory = new MemoryStoreV2(join(DATA_DIR, "memory.db"));
    const { createInterface: createRL } = await import("node:readline");
    const hostRL = createRL({ input: process.stdin, output: process.stdout });

    const promptUser = async (prompt: string): Promise<string> =>
        new Promise((resolve) => {
            hostRL.question(`🤖 ${prompt}`, (answer: string) => {
                resolve(answer.trim());
            });
        });

    const telegramAdapter = new TelegramAdapter(
        appConfig.telegram,
        nc,
        promptUser,
        (message) => console.log(`🤖 ${message}`),
    );

    // ─── Subagent 架构组件初始化 ───
    // 注意: message_log 落盘由 RecordingPipeline Step 4 负责，不再需要独立的 MessageLogWriter hook
    const subagentManager = new SubagentManager({
        observerConfig: {
            engagementWindowMs: 5 * 60 * 1000,
            alertEngagementThreshold: appConfig.subagent?.alertEngagementThreshold ?? 60,
            fastPathEngagementThreshold: appConfig.subagent?.fastPath?.engagementThreshold ?? 70,
            mentionKeywords: appConfig.notification?.urgentWords ?? ["?", "？", "呢", "吗"],
        },
        recordingDeps: {
            llmConfig: cheapConfig,
            personaDescription: appConfig.persona?.description ?? "赛博群友",
            memory,
        },
        sessionsDir: SESSIONS_DIR,
        platformName: "telegram",
    });
    // 启动时恢复已保存的 subagent sessions
    const restoredChatIds = subagentManager.restoreAll();
    if (restoredChatIds.length > 0) {
        log.info("已恢复 subagent sessions", { count: restoredChatIds.length, chatIds: restoredChatIds });
    }
    const q3 = new DynamicAttentionQueue({
        timeDecayPerSecond: appConfig.subagent?.attentionQueue?.timeDecayPerSecond ?? 0.001,
        maxSize: appConfig.subagent?.attentionQueue?.maxSize ?? 100,
    });
    const q5 = new CallbackQueue();
    const globalState = new GlobalState({
        filePath: join(DATA_DIR, "global-state.json"),
        autoSaveInterval: 30000,
    });

    log.info("Subagent 组件初始化完成", {
        attentionQueueMaxSize: appConfig.subagent?.attentionQueue?.maxSize ?? 100,
    });

    // FeedbackLoop 创建（需要在 subagentManager 之后，以支持 per-group registryLookup）
    const feedbackLoop = new FeedbackLoop(
        memory,
        nc,
        (chatId: string) => subagentManager.get(chatId)?.topicRegistry ?? null,
    );

    // ─── NC.onPush: 消息实时处理管线 ───
    const personaName = appConfig.persona?.name ?? "";

    // Hook 2: 消息分发到 per-group GroupSubagent (Observer + RecordingPipeline) → 更新 Q3
    nc.onPush(event => {
        const chatId = String(event.chatId ?? "");
        if (!chatId) return;
        // 接收所有消息类型事件（TelegramAdapter 使用 "nc.message"）
        const eventType = String(event.type ?? "");
        if (eventType !== "nc.message" && eventType !== "telegram.message") return;

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
                userId: String(event.userId ?? event.user_id ?? event.senderId ?? ""),
                displayName: String(event.displayName ?? event.senderName ?? event.userName ?? ""),
                text: String(event.text ?? event.message ?? ""),
                replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
                timestamp: new Date().toISOString(),
            }]);
        } catch (err) {
            log.warn("即时消息落盘失败", { chatId, error: String(err) });
        }

        const sub = subagentManager.getOrCreate(chatId);
        // 监听 triage-engage 事件：RecordingPipeline flush 后 triage 通过时触发 Q3 重入队
        if (!sub.listenerCount("triage-engage")) {
            sub.on("triage-engage", (cid: string) => {
                q3.enqueueOrUpdate(sub.buildQueueEntry());
                log.info("triage-engage → Q3 入队", { chatId: cid });
            });
        }
        // Per-group: Observer + RecordingPipeline 同时处理消息 (subagent.md §3.1)
        sub.onMessage(event);

        // Q3 入队策略（architecture_v2.md §3）：
        // - 正常路径：RecordingPipeline flush → triage → triage-engage 事件 → Q3 入队
        // - 紧急路径：Observer 告警 / DM / @mention / 文本提及 agent 名字 → 立即 Q3 入队
        // 不对每条消息无条件入队，避免绕过 triage 看门人
        const isDM = !!event.isDirectMessage;
        const isMention = !!event.mentionsAgent;
        const alert = sub.observer.checkAlert();
        // 文本提及检测：检查消息内容是否包含 agent 的名字
        // 注意：不使用完整的 urgentWords 列表（含 ?/呢/吗 等常见词会导致误触发）
        const messageText = String(event.text ?? event.message ?? "").toLowerCase();
        const hasNameMention = personaName.length > 0 && messageText.includes(personaName.toLowerCase());

        if (alert || isDM || isMention || hasNameMention) {
            q3.enqueueOrUpdate(sub.buildQueueEntry());
            log.info("即时 → Q3 入队", {
                chatId,
                reason: isDM ? "DM" : isMention ? "@mention" : hasNameMention ? "文本提及" : "Observer 告警",
                engagement: sub.observer.getEngagementScore(),
            });
        }

        // Fix 7: FastPath 触发路径 — 消息到达时检查是否有已授权的 FastPath
        const fp = sub.fastPathHandler as FastPathHandler | null;
        if (fp && fp.isAuthorized()) {
            const fpEvent: FastPathEvent = {
                chatId,
                messageId: String(event.messageId ?? event.id ?? ""),
                userId: String(event.userId ?? event.user_id ?? event.senderId ?? ""),
                text: String(event.text ?? event.message ?? ""),
                timestamp: String(event.timestamp ?? new Date().toISOString()),
            };
            fp.handle(fpEvent).catch(err => {
                log.warn("FastPath handle error", { chatId, error: String(err) });
            });
        }
    });

    // Hook 3: FeedbackLoop 消息追踪
    nc.onPush(event => {
        if ((event as any).type === "system.agent_message_sent" && feedbackLoop) {
            const sentEvent = event as Record<string, unknown>;
            feedbackLoop.recordAgentMessage({
                scene: String(sentEvent.scene ?? "telegram"),
                chatId: String(sentEvent.chatId ?? ""),
                messageId: sentEvent.messageId ? String(sentEvent.messageId) : undefined,
                text: String(sentEvent.text ?? ""),
                timestamp: String(sentEvent.timestamp ?? new Date().toISOString()),
                replyToMessageId: sentEvent.replyToMessageId ? String(sentEvent.replyToMessageId) : undefined,
            } satisfies AgentMessageSentEvent);
        }
    });

    // Per-group TopicRegistry 定时清理（遍历所有 subagent 的 topicRegistry）
    setInterval(() => {
        for (const sub of subagentManager.getAllSubagents()) {
            sub.topicRegistry.cleanup();
        }
    }, 60_000);

    // Subagent 实例是 chat-bound 的，不做空闲回收。
    // Sandbox 空闲回收由 SandboxPool 独立管理。

    // ─── Reflection 定时器 ───
    const reflectionCfg = appConfig.reflection ?? {};
    const silenceThreshold = reflectionCfg.silenceThreshold ?? 7200;
    const maxInterval = reflectionCfg.maxInterval ?? 86400;
    const awakeHours = reflectionCfg.awakeHours;
    const agentTimezone = reflectionCfg.timezone;
    const checkInterval = (reflectionCfg.checkInterval ?? 300) * 1000;
    const lastActivityPerChat = new Map<string, number>();
    const lastReflectedAtMap = new Map<string, number>();
    const reflectionInProgress = new Set<string>();

    function isOutsideAwakeHours(): boolean {
        if (!awakeHours) return false;
        const [start, end] = awakeHours;
        let currentHour: number;
        if (agentTimezone) {
            try {
                const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: agentTimezone });
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
        const chatId = String(event.chatId ?? "");
        if (chatId) lastActivityPerChat.set(chatId, Date.now());
    });

    setInterval(async () => {
        const now = Date.now();
        for (const [chatId, lastActive] of lastActivityPerChat) {
            if (reflectionInProgress.has(chatId)) continue;

            const silentSec = (now - lastActive) / 1000;
            const lastReflected = lastReflectedAtMap.get(chatId) ?? 0;
            const sinceReflectionSec = lastReflected > 0 ? (now - lastReflected) / 1000 : Infinity;

            const silenceTriggered = silentSec >= silenceThreshold;
            const maxIntervalTriggered = sinceReflectionSec >= maxInterval;
            const scheduleTriggered = isOutsideAwakeHours() && sinceReflectionSec > 3600;

            if (silenceTriggered || maxIntervalTriggered || scheduleTriggered) {
                reflectionInProgress.add(chatId);
                const reason = silenceTriggered ? "冷场触发" : maxIntervalTriggered ? "最大间隔触发" : "作息触发";
                log.info(`${reason} Reflection`, { chatId });
                try {
                    const result = await memory.reflect(chatId, llmConfig, reflectionCfg);
                    lastReflectedAtMap.set(chatId, Date.now());
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

    // ─── MainAgentLoop 配置 ───
    const mainLoop = new MainAgentLoop(q3, q5, subagentManager, {
        pollInterval: appConfig.subagent?.pollInterval ?? 5000,
        maxAttendsPerTick: 3,
        cosineDecayCyclePeriod: appConfig.subagent?.cosineDecay?.defaultCyclePeriod ?? 20,
    }, globalState);
    mainLoop.setLLMConfig(cheapConfig);  // 对话历史 compact 使用 cheapConfig

    // Attend handler: 主 Agent LLM 决策逻辑（subagent.md §12.2 ➛➜➝）
    mainLoop.setAttendHandler(createAttendHandler({
        memory,
        globalState,
        subagentManager,
        mainLoop,
        sotaConfig,
        persona: appConfig.persona,
    }));

    // Dispatch handler: 分派任务到 CodeActExecutor / FastPath / Deferred Re-entry
    mainLoop.setDispatchHandler(createDispatchHandler({
        memory,
        globalState,
        subagentManager,
        sandboxPool,
        nc,
        q3,
        q5,
        llmConfig,
        cheapConfig,
        persona: appConfig.persona,
        sessionsDir: SESSIONS_DIR,
    }));

    log.info("MainAgentLoop 配置完成");

    // NOTE: Sandbox 事件处理和 host call handler 已通过 SandboxPool.onAcquire 回调注册
    // sandbox 实例在 CodeActExecutor.executeWithSandbox() 中按需创建，不再全局启动
    log.info("SandboxPool 已配置", {
        maxInstances: appConfig.subagent?.maxSandboxInstances ?? 5,
        idleTimeout: appConfig.subagent?.sandboxIdleTimeout ?? 600_000,
    });

    // ─── 启动 ───
    log.info("启动 TelegramAdapter...");
    await telegramAdapter.start();
    log.info("TelegramAdapter 就绪");

    // ─── 启动主 Agent 注意力循环 ───
    log.info("启动 MainAgentLoop...");
    mainLoop.start();
    log.info("🤖 CyberGroupmate 运行中 (Subagent Architecture)");

    // ─── 保持进程活跃 ───
    // MainAgentLoop 使用 setTimeout 自驱动，这里用一个 keep-alive 防止进程退出
    await new Promise(() => {
        // 永不 resolve，保持进程运行
        // 由 SIGINT/SIGTERM 终止
    });
}

// ─── Graceful shutdown ───
process.on("SIGINT", () => {
    console.log("\n🛑 Shutting down...");
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("\n🛑 Shutting down...");
    process.exit(0);
});

main().catch((err) => {
    log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
