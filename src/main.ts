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
import { ensureCompositeId, getRawId, getPlatform, getGroupModelKey } from "./core/chat-id.js";
import { SandboxPool } from "./sandbox/sandbox-pool.js";
import { installSkillsDependencies } from "./sandbox/skill-loader.js";
import { createTaskListSkill, buildTaskListHostCalls } from "./sandbox/skills/task-list.js";
import { MemoryStoreV2 } from "./memory-v2/index.js";
import {
    loadConfig,
    resolveComponentProfiles,
    saveConfig,
    validateConfig,
    type AppConfig,
    type EnvironmentVariable,
} from "./core/config.js";
import { describeImage, ensureSupportedFormat } from "./core/vision-processor.js";
import {
    TopicRegistry,
    FeedbackLoop,
    type AgentMessageSentEvent,
} from "./pipeline/index.js";
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
import type { PlatformAdapter } from "./adapter/platform-adapter.js";

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
import { matchesCron, validateCronMinInterval } from "./core/cron-matcher.js";

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

    // 共享 MediaDownloader 实例（用于 sendSticker、Dashboard 等）
    const { MediaDownloader } = await import("./core/media-downloader.js");
    const sharedMediaDownloader = new MediaDownloader({
        retentionDays: appConfig.vision?.mediaRetentionDays ?? 3,
        maxFileSize: (appConfig.vision?.maxMediaDownloadSize ?? 20) * 1024 * 1024,
    });

    const nc = new NotificationCenter(EVENTS_PATH);

    // ─── 自动检查并安装 Skills 依赖 ───
    await installSkillsDependencies(join(process.cwd(), "workspace", "skills"));

    const sandboxPool = new SandboxPool({
        maxInstances: appConfig.subagent?.maxSandboxInstances ?? 5,
        idleTimeout: appConfig.subagent?.sandboxIdleTimeout ?? 600_000,
        sandboxEnv: currentEnvPlan.sandboxVisible,
        hostOnlyKeys: currentEnvPlan.managedKeys.filter((k) => !(k in currentEnvPlan.sandboxVisible)),
        onAcquire: (sandbox, chatId) => {
            // 每个新建的 sandbox 实例注册事件处理和 host call handler
            sandbox.on("notify", (event: Record<string, unknown>) => {
                nc.push(event as { type: string;[key: string]: unknown });
            });
            // 恢复持久化的事件监听器
            sandbox.loadEventListeners();
            // 恢复持久化的 webhook
            sandbox.loadWebhooks();
            sandbox.setHostCallHandler(async (method, args) => {
                // ── Platform adapter routing: 按 method 前缀路由到对应 adapter ──
                const adapter = adapters.find(a => a.canHandle(method));
                if (adapter) {
                    // Write 操作安全检查：只允许向绑定的 chatId 发送
                    const writeMethods = adapter.getWriteMethods();
                    if (writeMethods.includes(method)) {
                        const rawTarget = String(args[0] ?? "");
                        const targetChatId = ensureCompositeId(getPlatform(chatId), rawTarget);
                        if (targetChatId !== chatId) {
                            throw new Error(
                                `[Sandbox 安全限制] ${method} 被拦截：当前 sandbox 绑定 chat=${chatId}，` +
                                `不允许向 chat=${targetChatId} 发送消息。`
                            );
                        }
                    }
                    return adapter.handleCall(method, args);
                }
                switch (method) {
                    case "runtime.resetShell":
                        await sandbox.resetShell();
                        return;
                    case "memory.recall":
                        return memory.recall(args[0] as string, args[1] as any);
                    case "memory.browseHistory":
                        return memory.browseHistory(args[0] as any);
                    case "memory.reflect":
                        return memory.reflect(String(args[0]), undefined, appConfig.reflection);
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
                        // ── Cron API host calls ──
                        if (method === "cron.add") {
                            const [name, cronExpr, taskDescription] = args as [string, string, string];
                            // 最短间隔校验：cron 至少 1 小时
                            if (!validateCronMinInterval(cronExpr, 60)) {
                                throw new Error("cron 最短触发间隔为 1 小时");
                            }
                            // 数量限制
                            const maxCrons = appConfig.subagent?.scheduler?.maxCrons ?? 10;
                            const existing = globalState.getSchedulerEvents(chatId)
                                .filter(e => e.type === "cron");
                            if (existing.length >= maxCrons) {
                                throw new Error(`cron 数量上限 ${maxCrons}，请先删除不需要的任务`);
                            }
                            const event = globalState.addCron(chatId, name, cronExpr, taskDescription);
                            return { id: event.id };
                        }
                        if (method === "cron.remove") {
                            const id = String(args[0]);
                            globalState.cancelSchedulerEvent(id);
                            return;
                        }
                        if (method === "cron.list") {
                            const events = globalState.getSchedulerEvents(chatId)
                                .filter(e => e.type === "cron")
                                .map(e => ({
                                    id: e.id,
                                    name: e.description,
                                    cronExpr: e.cronExpr,
                                }));
                            return events;
                        }

                        // ── Runtime.remind host call ──
                        if (method === "runtime.remind") {
                            const [description, delayMinutes] = args as [string, number];
                            if (typeof delayMinutes !== "number" || delayMinutes < 1) {
                                throw new Error("remind 最短 1 分钟");
                            }
                            if (delayMinutes > 525600) {
                                throw new Error("remind 最长 365 天（525600 分钟）");
                            }
                            // 数量限制
                            const maxReminders = appConfig.subagent?.scheduler?.maxReminders ?? 10;
                            const existingReminders = globalState.getSchedulerEvents(chatId)
                                .filter(e => e.type === "reminder" && !e.triggered);
                            if (existingReminders.length >= maxReminders) {
                                throw new Error(`remind 数量上限 ${maxReminders}，请等待已有提醒触发或手动取消`);
                            }
                            const triggerAt = new Date(Date.now() + delayMinutes * 60000).toISOString();
                            const event = globalState.addReminder(chatId, description, triggerAt);
                            log.info("runtime.remind 已设置", { id: event.id, chatId, triggerAt, description: description.slice(0, 80) });
                            return { reminderId: event.id, triggerAt };
                        }

                        // ── Runtime.env host calls ──
                        if (method === "runtime.env.list") {
                            const cfg = loadConfig("config.yaml", true);
                            return normalizeEnvVars(cfg.envVars);
                        }
                        if (method === "runtime.env.get") {
                            const key = String(args[0] ?? "").trim();
                            if (!key) return null;
                            const cfg = loadConfig("config.yaml", true);
                            const list = normalizeEnvVars(cfg.envVars);
                            const found = list.find((ev) => ev.key === key);
                            return found ?? null;
                        }
                        if (method === "runtime.env.set") {
                            const key = String(args[0] ?? "").trim();
                            const value = String(args[1] ?? "");
                            const scopeRaw = String(args[2] ?? "both").trim().toLowerCase();
                            const scope = (scopeRaw === "host" || scopeRaw === "sandbox" || scopeRaw === "both")
                                ? scopeRaw as EnvironmentVariable["scope"]
                                : "both";
                            if (!isValidEnvKey(key)) {
                                throw new Error(`非法 env key: ${key}`);
                            }

                            const cfg = loadConfig("config.yaml", true);
                            const list = normalizeEnvVars(cfg.envVars);
                            const nextList = list.filter((ev) => ev.key !== key);
                            nextList.push({ key, value, scope });
                            cfg.envVars = nextList.length > 0 ? nextList : undefined;

                            const validation = validateConfig(cfg);
                            if (!validation.valid) {
                                throw new Error(validation.errors.join("; "));
                            }
                            const save = saveConfig(cfg);
                            if (!save.ok) {
                                throw new Error(save.error || "saveConfig failed");
                            }

                            currentEnvPlan = buildEnvPlan(nextList);
                            applyHostManagedEnv(currentEnvPlan);
                            await sandboxPool.updateManagedEnv(
                                currentEnvPlan.sandboxVisible,
                                currentEnvPlan.managedKeys,
                            );
                            log.info("runtime.env.set 已应用", { key, scope });
                            return { ok: true, key, scope, value };
                        }
                        if (method === "runtime.env.delete") {
                            const key = String(args[0] ?? "").trim();
                            if (!key) return { ok: true, deleted: false };
                            const cfg = loadConfig("config.yaml", true);
                            const list = normalizeEnvVars(cfg.envVars);
                            const had = list.some((ev) => ev.key === key);
                            const nextList = list.filter((ev) => ev.key !== key);
                            cfg.envVars = nextList.length > 0 ? nextList : undefined;

                            const save = saveConfig(cfg);
                            if (!save.ok) {
                                throw new Error(save.error || "saveConfig failed");
                            }

                            currentEnvPlan = buildEnvPlan(nextList);
                            applyHostManagedEnv(currentEnvPlan);
                            await sandboxPool.updateManagedEnv(
                                currentEnvPlan.sandboxVisible,
                                currentEnvPlan.managedKeys,
                            );
                            log.info("runtime.env.delete 已应用", { key, deleted: had });
                            return { ok: true, deleted: had };
                        }

                        // ── Events API host calls ──
                        if (method === "events.on") {
                            const [typePrefix, handlerCode] = args as [string, string];
                            const listenerId = sandbox.registerEventListener(typePrefix, handlerCode);
                            return listenerId;
                        }
                        if (method === "events.off") {
                            const listenerId = String(args[0]);
                            sandbox.removeEventListener(listenerId);
                            return;
                        }
                        if (method === "events.list") {
                            return sandbox.listEventListeners();
                        }

                        // ── KV Store host calls ──
                        if (method === "kv.get") {
                            return memory.kvGet(chatId, String(args[0]));
                        }
                        if (method === "kv.set") {
                            const [key, value, ttl] = args as [string, string, number | undefined];
                            memory.kvSet(chatId, key, value, ttl);
                            return;
                        }
                        if (method === "kv.del") {
                            memory.kvDel(chatId, String(args[0]));
                            return;
                        }
                        if (method === "kv.keys") {
                            return memory.kvKeys(chatId, args[0] as string | undefined);
                        }

                        // ── HTTP Webhook host calls ──
                        if (method === "http.onWebhook") {
                            const [path, handlerCode] = args as [string, string];
                            const webhookId = sandbox.registerWebhook(path, handlerCode);
                            return webhookId;
                        }
                        if (method === "http.removeWebhook") {
                            const webhookId = String(args[0]);
                            sandbox.removeWebhook(webhookId);
                            return;
                        }
                        if (method === "http.listWebhooks") {
                            return sandbox.listWebhooks();
                        }

                        // ── Vision API host call ──
                        if (method === "vision.see") {
                            const imagePaths = args as string[];
                            if (!imagePaths || imagePaths.length === 0) {
                                throw new Error("vision.see() 至少需要传入一个图片路径");
                            }
                            const workspaceRoot = resolve("workspace");
                            const visionConfigs = resolveComponentProfiles("vision");

                            const results = await Promise.all(imagePaths.map(async (userPath) => {
                                // 安全路径解析（与 filesystem.ts safePath 逻辑一致）
                                let resolved: string;
                                if (userPath.startsWith("/")) {
                                    resolved = resolve(userPath);
                                } else {
                                    resolved = resolve(workspaceRoot, userPath);
                                }
                                const rel = relative(workspaceRoot, resolved);
                                if (rel.startsWith("..") || resolve(workspaceRoot, rel) !== resolved) {
                                    throw new Error(
                                        `[vision 安全限制] 路径 "${userPath}" 超出 workspace 范围。`,
                                    );
                                }
                                if (!existsSync(resolved)) {
                                    throw new Error(`文件不存在: ${userPath}`);
                                }

                                // 读取文件
                                const rawBuffer = readFileSync(resolved);
                                // 推断 MIME 类型
                                const ext = resolved.split(".").pop()?.toLowerCase() ?? "";
                                const mimeMap: Record<string, string> = {
                                    jpg: "image/jpeg", jpeg: "image/jpeg",
                                    png: "image/png",
                                    webp: "image/webp",
                                    gif: "image/gif",
                                    bmp: "image/bmp",
                                    tiff: "image/tiff", tif: "image/tiff",
                                    avif: "image/avif",
                                    svg: "image/svg+xml",
                                };
                                const mimeType = mimeMap[ext] ?? "image/png";

                                // 转码 + 描述
                                const { buffer, mimeType: finalMime } = await ensureSupportedFormat(rawBuffer, mimeType);
                                return describeImage(buffer, finalMime, visionConfigs);
                            }));

                            return results;
                        }

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
        const discordAdapter = new DiscordAdapter(appConfig.discord, nc);
        adapters.push(discordAdapter);
    }

    if (adapters.length === 0) {
        throw new Error("至少需要配置一个平台 adapter（telegram 或 discord）");
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
            personaName: appConfig.persona?.name ?? "赛博群友",
            personaDescription: appConfig.persona?.description ?? "赛博群友",
            memory,
            pipelineConfig: appConfig.recordingPipeline,
        },
        memory,  // 用于启动时恢复 TopicRegistry
        sessionsDir: SESSIONS_DIR,

        // Stickiness 恢复：从 GroupModel 查询 avgMessagesPerDay 推断级别（architecture_v2.md §2.2）
        stickinessProvider: (chatId: string) => {
            const gm = memory.getGroupModel(getGroupModelKey(chatId));
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
            // Fix: sandbox 发出的 agent_message_sent 事件中 chatId 是 raw ID（因为
            // code-act-executor 用 getRawId 注入 prompt），但 message_log 需要
            // composite key 才能被 getRecentMessages(compositeId) 查询到。
            // 从 event.scene 动态获取平台名（sandbox 模块设置：telegram.ts → "telegram"，
            // 未来 discord.ts → "discord"），用 ensureCompositeId 补全前缀。
            const platform = String(event.scene ?? "") as import("./core/chat-id.js").PlatformName;
            const compositeChatId = ensureCompositeId(platform, chatId);
            try {
                memory.storeMessageBatch([{
                    messageId: String(event.messageId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
                    chatId: compositeChatId,
                    userId: appConfig.persona?.name ?? "agent",
                    displayName: appConfig.persona?.name ?? "赛博群友",
                    text: String(event.text ?? ""),
                    replyToMessageId: event.replyToMessageId ? String(event.replyToMessageId) : undefined,
                    timestamp: String(event.timestamp ?? new Date().toISOString()),
                }]);
            } catch (err) {
                log.warn("Agent 消息落盘失败", { chatId: compositeChatId, error: String(err) });
            }

            // 同步喂给 RecordingPipeline buffer，使 flush 时 LLM prompt 能看到 agent 消息
            // （与普通消息双路写入一致：即时落盘 DB + 喂给 buffer）
            const agentSub = subagentManager.get(compositeChatId);
            if (agentSub?.recordingPipeline) {
                const agentMsg: import("./pipeline/types.js").Message = {
                    id: String(event.messageId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
                    chatId: compositeChatId,
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

        // ─── username 持久化到 PersonIdentity（供 attend-handler activePersons 使用） ───
        const eventUsername = event.username as string | undefined;
        if (eventUsername) {
            const eventUserId = String(event.userId ?? event.user_id ?? event.senderId ?? "");
            if (eventUserId) {
                try {
                    memory.upsertPersonIdentity(eventUserId, { username: eventUsername });
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
        // 监听 triage-engage 事件：RecordingPipeline flush 后 triage 通过时触发 Q3 重入队
        if (!sub.listenerCount("triage-engage")) {
            sub.on("triage-engage", (cid: string) => {
                const isBlocked = q3.isBlocked(cid);
                const entry = sub.buildQueueEntry();
                log.info("triage-engage → Q3 入队", {
                    chatId: cid,
                    isBlocked,
                    priority: entry.priority,
                    source: entry.source,
                    topicDigestCount: entry.topicDigests?.length,
                    hasTriageEngaged: sub.hasTriageEngaged,
                });
                if (!isBlocked) {
                    q3.enqueueOrUpdate(entry);
                } else {
                    log.warn("triage-engage: Q3 入队被阻塞，chatId 在 blockedChatIds 中", { chatId: cid });
                }
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
                const userId = String(event.userId ?? event.senderId ?? "");
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
            const fbPlatform = String(sentEvent.scene ?? "") as import("./core/chat-id.js").PlatformName;
            const fbCompositeChatId = ensureCompositeId(fbPlatform, String(sentEvent.chatId ?? ""));
            feedbackLoop.recordAgentMessage({
                scene: String(sentEvent.scene ?? ""),
                chatId: fbCompositeChatId,
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
        if (eventType !== "nc.message") return;
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
                    const result = await memory.reflect(chatId, undefined, reflCfg);
                    lastReflectedAtMap.set(chatId, Date.now());

                    // Stickiness 重评估（architecture_v2.md §2.2）
                    const sub = subagentManager.get(chatId);
                    if (sub) {
                        const gm = memory.getGroupModel(getGroupModelKey(chatId));
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



    // Attend handler: 主 Agent LLM 决策逻辑（subagent.md §12.2 ➛➜➝）
    mainLoop.setAttendHandler(createAttendHandler({
        memory,
        globalState,
        subagentManager,
        mainLoop,

        persona: appConfig.persona,
        adapters,
        mediaDownloader: sharedMediaDownloader,

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

        persona: appConfig.persona,
        appConfig,
        adapters,
        sendTyping: async (chatId: string) => {
            const adapter = getAdapterForChat(chatId);
            if (adapter) {
                const typingMethod = `${adapter.platform}.sendTyping`;
                await adapter.handleCall(typingMethod, [chatId]);
            }
        },
        mediaDownloader: sharedMediaDownloader,
    }));

    log.info("MainAgentLoop 配置完成");

    // ─── Dashboard 监控仪表盘 ───
    const dashboardEnabled = appConfig.dashboard?.enabled !== false;
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

        const dashboard = new DashboardServer(
            {
                nc,
                subagentManager,
                q3,
                q5,
                mainLoop,
                globalState,
                sandboxPool,
                memory,
                feedbackLoop,
                tokenStats,
                mediaDownloader: sharedMediaDownloader,
                adapters,
                onConfigSaved: async (config) => {
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
            },
            { host: dashboardHost, port: dashboardPort, token: dashboardToken, enabled: true },
        );
        await dashboard.start();
        const displayHost = dashboardHost === "0.0.0.0" || dashboardHost === "::" ? "localhost" : dashboardHost;
        log.info("Dashboard 已启动", { listen: `${dashboardHost}:${dashboardPort}`, url: `http://${displayHost}:${dashboardPort}?token=${dashboardToken}` });
    }

    // ─── Prometheus Metrics Exporter ───
    let metricsInstance: import("./metrics/index.js").MetricsInstance | null = null;
    const metricsEnabled = appConfig.metrics?.enabled !== false;
    if (metricsEnabled) {
        const { startMetrics } = await import("./metrics/index.js");
        metricsInstance = await startMetrics(
            { subagentManager, sandboxPool, q3, q5, mainLoop, feedbackLoop },
            appConfig.metrics,
        );

        // Hook 1: 消息到达时更新 group_messages_total
        nc.onPush(event => {
            const eventType = String(event.type ?? "");
            if (eventType !== "nc.message") return;
            const chatId = String(event.chatId ?? "");
            if (chatId) metricsInstance!.groupCollector.onMessage(chatId);
        });

        // Hook 2: attend 决策后更新 group_attends_total
        mainLoop.setOnAttendComplete((chatId, result) => {
            for (const d of result.decisions) {
                metricsInstance!.groupCollector.onAttend(chatId, d.action);
            }
        });

        // Hook 3: FastPath 快回复发送时更新 fast_path_replies_total
        // q5 的回调包含 sentMessages，可通过 CallbackQueue 读取
        // 简化：在 NC.onPush 中检测 system.agent_message_sent + fastPath flag
        nc.onPush(event => {
            if (String(event.type ?? "") !== "system.agent_message_sent") return;
            const chatId = String(event.chatId ?? "");
            // FastPathHandler 在 dispatch-handler 中设置 scene: "fastpath"
            if (event.scene === "fastpath" && chatId) {
                metricsInstance!.groupCollector.onFastPathReply(chatId);
            }
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

    // ─── NC → Sandbox Event Forwarding ───
    // 将 NC 事件转发到所有活跃 sandbox 的事件监听器
    nc.onPush(event => {
        for (const { sandbox } of sandboxPool.entries()) {
            sandbox.pushEvent(event as Record<string, unknown>).catch(() => {});
        }
    });

    // ─── 统一调度器 Watchdog ───
    // 每 30 秒检查到期 reminder 和匹配的 cron 事件
    // 触发时通过 Q3 注意力队列唤醒主 Agent，而非直接执行代码
    const schedulerWatchdogInterval = setInterval(() => {
        const now = new Date();

        // ── Reminder 检查 ──
        const dueReminders = globalState.getDueReminders();
        for (const reminder of dueReminders) {
            globalState.markReminderTriggered(reminder.id);

            const sub = subagentManager.getOrCreate(reminder.chatId);
            const entry = sub.buildQueueEntry("SCHEDULER_TRIGGER");
            entry.schedulerTriggers = [{
                id: reminder.id,
                type: "reminder",
                description: reminder.description,
            }];
            q3.enqueueOrUpdate(entry);
            q3.boost(reminder.chatId, 80);
            log.info("Reminder 到期 → Q3", { id: reminder.id, desc: reminder.description.slice(0, 80), chatId: reminder.chatId });
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
            const taskDesc = evt.taskTemplate ?? evt.description;

            const sub = subagentManager.getOrCreate(evt.chatId);
            const entry = sub.buildQueueEntry("SCHEDULER_TRIGGER");
            entry.schedulerTriggers = [{
                id: evt.id,
                type: "cron",
                description: taskDesc,
            }];
            q3.enqueueOrUpdate(entry);
            q3.boost(evt.chatId, 80);
            log.info("Cron 触发 → Q3", { id: evt.id, name: evt.description, chatId: evt.chatId });
        }
    }, 30_000);
    if (schedulerWatchdogInterval.unref) schedulerWatchdogInterval.unref();

    // ─── 启动 ───
    for (const adapter of adapters) {
        log.info(`启动 ${adapter.platform} adapter...`);
        await adapter.start();
        log.info(`${adapter.platform} adapter 就绪`);
    }

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
let _metricsStopFn: (() => void) | null = null;

process.on("SIGINT", () => {
    console.log("\n🛑 Shutting down...");
    _metricsStopFn?.();
    process.exit(0);
});

process.on("SIGTERM", () => {
    console.log("\n🛑 Shutting down...");
    _metricsStopFn?.();
    process.exit(0);
});

main().catch((err) => {
    log.error("Fatal error", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
