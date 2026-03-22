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
import { loadConfig, resolveComponentProfiles, type AppConfig, type LLMConfig } from "./core/config.js";
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
import { setGlobalTimezone, getGlobalTimezone } from "./core/timezone.js";
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
import { evaluateStickiness, createStickiness, updateStickiness } from "./subagent/stickiness.js";

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
    const attendConfigs = resolveComponentProfiles("attend", appConfig);
    const sessionConfigs = resolveComponentProfiles("session", appConfig);
    const fastPathConfig = resolveComponentProfiles("fast_path", appConfig)[0];
    const recordingConfig = resolveComponentProfiles("recording", appConfig)[0];
    const compactConfig = resolveComponentProfiles("compact", appConfig)[0];
    const memoryConfig = resolveComponentProfiles("memory", appConfig)[0];
    const reflectionConfig = resolveComponentProfiles("reflection", appConfig)[0];
    const visionConfigs = resolveComponentProfiles("vision", appConfig);

    // ─── 全局时区初始化 ───
    setGlobalTimezone(appConfig.timezone);

    // ─── Tavily API key → 环境变量（供 sandbox worker 继承） ───
    if (appConfig.tavilyApiKey) {
        process.env.TAVILY_API_KEY = appConfig.tavilyApiKey;
    }

    log.info("LLM Profiles 加载完成", {
        profiles: Object.keys(appConfig.llmProfiles).join(", "),
        routing: Object.entries(appConfig.llmRouting)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}→${Array.isArray(v) ? `[${v.join(",")}]` : v}`)
            .join(", "),
    });
    log.info("Telegram 配置", {
        mode: appConfig.telegram.mode,
        apiId: appConfig.telegram.apiId ? "✓" : "✗",
        apiHash: appConfig.telegram.apiHash ? "✓" : "✗",
        botToken: appConfig.telegram.botToken ? "✓" : "✗",
    });

    // 共享 MediaDownloader 实例（用于 sendSticker、Dashboard 等）
    const { MediaDownloader } = await import("./core/media-downloader.js");
    const sharedMediaDownloader = new MediaDownloader({
        retentionDays: appConfig.vision?.mediaRetentionDays ?? 3,
        maxFileSize: (appConfig.vision?.maxMediaDownloadSize ?? 20) * 1024 * 1024,
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
                // ── telegram.sendSticker: 通过 uniqueFileId 发送贴纸 ──
                if (method === "telegram.sendSticker") {
                    const targetChatId = String(args[0] ?? "");
                    if (targetChatId !== chatId) {
                        throw new Error(`[Sandbox 安全限制] sendSticker 被拦截：sandbox 绑定 chat=${chatId}，不允许向 chat=${targetChatId} 发送。`);
                    }
                    const uniqueFileId = String(args[1] ?? "");
                    if (!uniqueFileId) throw new Error("sendSticker: uniqueFileId 为空");
                    const stickerPath = sharedMediaDownloader.getExistingPath(uniqueFileId);
                    if (!stickerPath) throw new Error(`sendSticker: 未找到贴纸文件 uniqueFileId=${uniqueFileId}`);
                    const { readFileSync, existsSync } = await import("node:fs");
                    if (!existsSync(stickerPath)) throw new Error(`sendSticker: 文件不存在 ${stickerPath}`);
                    const buffer = readFileSync(stickerPath);
                    const opts = args[2] ?? undefined;
                    // 直接调用底层 client.sendMedia，绕过 adapter 的本地路径处理
                    // mtcute 需要 type: 'sticker' 来正确发送贴纸
                    return telegramAdapter.handleCall("telegram.sendMedia", [
                        targetChatId,
                        { type: "sticker", file: buffer },
                        opts,
                    ]);
                }

                if (telegramAdapter.canHandle(method)) {
                    // ── ChatId 发送限制：write 操作只允许绑定的 chatId ──
                    const writeMethods = telegramAdapter.getWriteMethods();
                    if (writeMethods.includes(method)) {
                        const targetChatId = String(args[0] ?? "");
                        if (targetChatId !== chatId) {
                            throw new Error(
                                `[Sandbox 安全限制] ${method} 被拦截：当前 sandbox 绑定 chat=${chatId}，` +
                                `不允许向 chat=${targetChatId} 发送消息。`
                            );
                        }
                    }
                    return telegramAdapter.handleCall(method, args);
                }
                switch (method) {
                    case "memory.recall":
                        return memory.recall(args[0] as string, args[1] as any);
                    case "memory.browseHistory":
                        return memory.browseHistory(args[0] as any);
                    case "memory.reflect":
                        return memory.reflect(String(args[0]), reflectionConfig, appConfig.reflection);
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
    const memory = new MemoryStoreV2(join(DATA_DIR, "memory.db"), {
        cheapLlmConfig: memoryConfig,
    });
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
            mentionKeywords: appConfig.notification?.mentionKeywords ?? [],
        },
        recordingDeps: {
            llmConfig: recordingConfig,
            personaDescription: appConfig.persona?.description ?? "赛博群友",
            memory,
        },
        memory,  // 用于启动时恢复 TopicRegistry
        sessionsDir: SESSIONS_DIR,
        platformName: "telegram",
        // Stickiness 恢复：从 GroupModel 查询 avgMessagesPerDay 推断级别（architecture_v2.md §2.2）
        stickinessProvider: (chatId: string) => {
            const gm = memory.getGroupModel(chatId);
            if (!gm) return undefined;
            const level = evaluateStickiness(gm, 0, "STRANGER");
            if (level !== "STRANGER") {
                log.info("stickinessProvider: 从 GroupModel 恢复", { chatId, level, avgMsgs: gm.avgMessagesPerDay });
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
    // architecture_v2.md §3 Q3 路径 (5): 追问检测 → Q3 入队
    const feedbackLoop = new FeedbackLoop(
        memory,
        nc,
        (chatId: string) => subagentManager.get(chatId)?.topicRegistry ?? null,
        3 * 60 * 1000,  // evaluationDelayMs
        (chatId: string, triggerText: string) => {
            const sub = subagentManager.get(chatId);
            if (!sub) return;
            // 重置 lastAgentReplyAt 使 triage 允许介入（绕过防重复守卫）
            sub.updateLastAgentReplyAt(0);
            q3.enqueueOrUpdate(sub.buildQueueEntry());
            q3.boost(chatId, 15);
            log.info("追问检测 → Q3 入队", { chatId, triggerText: triggerText.slice(0, 50) });
        },
    );

    // ─── NC.onPush: 消息实时处理管线 ───
    // mentionKeywords 现在在每次消息到达时动态从 loadConfig() 读取（支持热重载）

    // Hook 2: 消息分发到 per-group GroupSubagent (Observer + RecordingPipeline) → 更新 Q3
    nc.onPush(event => {
        const chatId = String(event.chatId ?? "");
        if (!chatId) return;

        // ─── Agent 发出消息的即时落盘（Fix: 修复 agent 消息不可见导致重复回复） ───
        // system.agent_message_sent 事件之前只被 FeedbackLoop 消费，
        // 不写入 message_log，导致 getRecentMessages() 缺少 agent 消息。
        const eventType = String(event.type ?? "");
        if (eventType === "system.agent_message_sent") {
            try {
                memory.storeMessageBatch([{
                    messageId: String(event.messageId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
                    chatId,
                    userId: appConfig.persona?.name ?? "agent",
                    displayName: appConfig.persona?.name ?? "赛博群友",
                    text: String(event.text ?? ""),
                    replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
                    timestamp: String(event.timestamp ?? new Date().toISOString()),
                }]);
            } catch (err) {
                log.warn("Agent 消息落盘失败", { chatId, error: String(err) });
            }

            // 同步喂给 RecordingPipeline buffer，使 flush 时 LLM prompt 能看到 agent 消息
            // （与普通消息双路写入一致：即时落盘 DB + 喂给 buffer）
            const agentSub = subagentManager.get(chatId);
            if (agentSub?.recordingPipeline) {
                const agentMsg: import("./pipeline/types.js").Message = {
                    id: String(event.messageId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
                    chatId,
                    senderId: appConfig.persona?.name ?? "agent",
                    senderName: appConfig.persona?.name ?? "赛博群友",
                    text: String(event.text ?? ""),
                    timestamp: Date.now(),
                    replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
                };
                agentSub.recordingPipeline.onMessage(agentMsg);
            }

            return; // agent 消息不走后续 Observer/Q3 逻辑
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
                userId: String(event.userId ?? event.user_id ?? event.senderId ?? ""),
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

        // ─── chatTitle 持久化：确保 group_models 表有群名/私聊对象名 ───
        // 群聊: event.chatTitle 来自 chat.title
        // 私聊: chatTitle 为对方 displayName（normalizeChat fallback），也可以用 event.displayName
        const isDMChat = !!event.isDirectMessage;
        const incomingTitle = isDMChat
            ? String(event.displayName ?? event.chatTitle ?? "")
            : String(event.chatTitle ?? "");
        if (incomingTitle) {
            try {
                const existing = memory.getGroupModel(chatId);
                if (!existing || existing.chatTitle !== incomingTitle) {
                    memory.upsertGroupModel(chatId, { chatTitle: incomingTitle, isDirectMessage: isDMChat });
                    log.debug("chatTitle 已更新", { chatId, chatTitle: incomingTitle, isDM: isDMChat });
                }
            } catch (err) {
                log.warn("chatTitle 持久化失败", { chatId, error: String(err) });
            }
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
        // - 紧急路径：DM / @mention / 文本提及 agent 名字 → 立即 Q3 入队
        // Observer engagement 仅用于 Q3 内部优先级排序，不作为入队触发条件。
        const isDM = !!event.isDirectMessage;
        const isMention = !!event.mentionsAgent;
        // 文本提及检测：检查消息内容是否包含配置的 mention_keywords（agent 名字等）
        // 动态读取（支持热重载）
        const mentionKeywords = (loadConfig().notification?.mentionKeywords ?? []).map(k => k.toLowerCase()).filter(k => k.length > 0);
        const messageText = String(event.text ?? event.message ?? "").toLowerCase();
        const hasNameMention = mentionKeywords.length > 0 && mentionKeywords.some(kw => messageText.includes(kw));

        if (isDM || isMention || hasNameMention) {
            q3.enqueueOrUpdate(sub.buildQueueEntry("DIRECT_ADDRESS"));
            log.info("即时 → Q3 入队", {
                chatId,
                reason: isDM ? "DM" : isMention ? "@mention" : "文本提及",
                engagement: sub.observer.getEngagementScore(),
            });

            // 记录入方向交互（用户 → agent，此刻已发生）
            // 配合 feedback-loop.ts 的 agent_replied 出方向记录，构成完整双向交互链
            try {
                memory.storeInteraction({
                    chatId,
                    userId: String(event.userId ?? event.senderId ?? ""),
                    topicId: null,
                    type: isDM ? "direct_message" : "agent_mentioned",
                    summary: String(event.text ?? event.message ?? "").slice(0, 200),
                    sentiment: "neutral",
                    significance: isDM ? 0.8 : 0.6,
                    date: new Date().toISOString(),
                });
            } catch { /* 非关键路径 */ }
        }

        // 层 2 消息前送：如果该 chatId 的 CodeActExecutor 正在执行，推入 pending buffer
        const executor = sub.codeActExecutor as import("./subagent/code-act-executor.js").CodeActExecutor | null;
        if (executor?.isProcessing()) {
            executor.pushPendingMessage({
                id: String(event.messageId ?? event.id ?? `msg_${Date.now()}`),
                sender: String(event.displayName ?? event.senderName ?? event.userName ?? "?"),
                text: String(event.text ?? event.message ?? ""),
                timestamp: String(event.timestamp ?? new Date().toISOString()),
                mediaType: (event as any).mediaInfo?.type ?? undefined,
                mediaInfo: (event as any).mediaInfo ? JSON.stringify((event as any).mediaInfo) : undefined,
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

    // Hook 4: 追问实时检测 (architecture_v2.md §3 Q3 路径 5)
    // 在 FeedbackLoop 的追问窗口内检测同群用户消息并触发 Q3 入队
    nc.onPush(event => {
        const chatId = String(event.chatId ?? "");
        if (!chatId) return;
        const eventType = String(event.type ?? "");
        if (eventType !== "nc.message" && eventType !== "telegram.message") return;
        const userId = String(event.userId ?? event.user_id ?? event.senderId ?? "");
        const text = String(event.text ?? event.message ?? "");
        feedbackLoop.checkFollowUp(chatId, userId, text);
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
                    const result = await memory.reflect(chatId, reflectionConfig, reflCfg);
                    lastReflectedAtMap.set(chatId, Date.now());

                    // Stickiness 重评估（architecture_v2.md §2.2）
                    const sub = subagentManager.get(chatId);
                    if (sub) {
                        const gm = memory.getGroupModel(chatId);
                        if (gm) {
                            const daysSinceLastInteraction = gm.lastReflectedAt
                                ? (Date.now() - new Date(gm.lastReflectedAt).getTime()) / 86400_000
                                : 0;
                            const newLevel = evaluateStickiness(gm, daysSinceLastInteraction, sub.stickiness.level);
                            if (newLevel !== sub.stickiness.level) {
                                const oldLevel = sub.stickiness.level;
                                sub.stickiness = updateStickiness(sub.stickiness, newLevel);
                                log.info("Stickiness 变更", { chatId, from: oldLevel, to: newLevel, avgMsgs: gm.avgMessagesPerDay });
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

    // ─── MainAgentLoop 配置 ───
    const mainLoop = new MainAgentLoop(q3, q5, subagentManager, {
        pollInterval: appConfig.subagent?.pollInterval ?? 5000,
        maxAttendsPerTick: 3,
        cosineDecayCyclePeriod: appConfig.subagent?.cosineDecay?.defaultCyclePeriod ?? 20,
    }, globalState);
    mainLoop.setLLMConfig(compactConfig);  // 对话历史 compact

    // Attend handler: 主 Agent LLM 决策逻辑（subagent.md §12.2 ➛➜➝）
    mainLoop.setAttendHandler(createAttendHandler({
        memory,
        globalState,
        subagentManager,
        mainLoop,
        sotaConfigs: attendConfigs,
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
        llmConfigs: sessionConfigs,
        fastPathConfig,
        persona: appConfig.persona,
        appConfig,
        telegramAdapter,
        sendTyping: async (chatId: string) => {
            await telegramAdapter.handleCall("telegram.sendTyping", [chatId]);
        },
        mediaDownloader: sharedMediaDownloader,
    }));

    log.info("MainAgentLoop 配置完成");

    // ─── Dashboard 监控仪表盘 ───
    const dashboardEnabled = appConfig.dashboard?.enabled !== false;
    if (dashboardEnabled) {
        const { DashboardServer } = await import("./dashboard/dashboard-server.js");
        const { TokenStatsCollector } = await import("./dashboard/token-stats.js");
        const dashboardToken = appConfig.dashboard?.token ?? "cybergroupmate";
        const dashboardPort = appConfig.dashboard?.port ?? 6767;

        const tokenStats = new TokenStatsCollector(
            join(DATA_DIR, "token-stats.json"),
            appConfig.llmProfiles,
        );

        // 进程退出时保存统计
        process.on("exit", () => tokenStats.shutdown());

        const dashboard = new DashboardServer(
            { nc, subagentManager, q3, q5, mainLoop, globalState, sandboxPool, memory, feedbackLoop, tokenStats, mediaDownloader: sharedMediaDownloader },
            { port: dashboardPort, token: dashboardToken, enabled: true },
        );
        await dashboard.start();
        log.info("Dashboard 已启动", { port: dashboardPort, url: `http://localhost:${dashboardPort}?token=${dashboardToken}` });
    }

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
