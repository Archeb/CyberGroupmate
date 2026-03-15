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
import { MessageLogWriter } from "./event/message-log-writer.js";
import { SandboxPool } from "./sandbox/sandbox-pool.js";
import { createTaskListSkill, buildTaskListHostCalls } from "./sandbox/skills/task-list.js";
import { MemoryStoreV2 } from "./memory-v2/index.js";
import { loadConfig, resolveTierProfile, type AppConfig, type LLMConfig } from "./core/config.js";
import {
    TopicRegistry,
    RecordingPipeline,
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
import { CodeActExecutor } from "./subagent/code-act-executor.js";
import { FastPathHandler } from "./subagent/fast-path-handler.js";
import { MainAgentLoop } from "./main-agent/main-agent-loop.js";
import { GlobalState } from "./main-agent/global-state.js";
import { calculateDepth } from "./main-agent/cosine-decay.js";
import { estimateReplyMode, buildReplyDecisions, buildObserveDecision } from "./main-agent/decision-maker.js";
import { buildGroupContext } from "./main-agent/context-builder.js";
import { renderPrompt, buildAttentionVariables } from "./main-agent/prompt-renderer.js";
import { callLLM, type ChatMessage } from "./core/llm.js";
import type { AttendResult, CodeActReplyTask, SubagentCallback, TopicDigest } from "./subagent/types.js";
import type { FastPathEvent } from "./subagent/fast-path-handler.js";

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
                    case "actions.getTopicContext":
                        return serializeTopic(topicRegistry.get(String(args[0])));
                    case "actions.listActiveTopics": {
                        const cid = args[0];
                        if (typeof cid === "string" && cid.length > 0) {
                            return topicRegistry.getActive(cid).map(serializeTopic);
                        }
                        return topicRegistry.getAll().map(serializeTopic);
                    }
                    case "actions.recallForTopic": {
                        const topic = topicRegistry.get(String(args[0]));
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

    // ─── Pipeline 组件（话题聚类 + 反馈追踪） ───
    const topicRegistry = new TopicRegistry();
    const recordingPipeline = new RecordingPipeline(topicRegistry, cheapConfig, appConfig.persona?.description ?? "赛博群友", memory);
    const feedbackLoop = new FeedbackLoop(topicRegistry, memory, nc);

    // Phase 6 TopicRegistry 事件
    topicRegistry.on("topic:archived", (topic: any) => {
        memory.finalizeTopic(topic.id);
        log.debug("话题归档，标记 ended_at", { topicId: topic.id, label: topic.label });
    });

    // ─── Subagent 架构组件初始化 ───
    const messageLogWriter = new MessageLogWriter(memory, {
        eventTypes: ["nc.message", "telegram.message", "system.agent_message_sent"],
        agentUserId: "agent",
        agentDisplayName: appConfig.persona?.name ?? "赛博群友",
    });
    const subagentManager = new SubagentManager({
        observerConfig: {
            engagementWindowMs: 5 * 60 * 1000,
            alertEngagementThreshold: appConfig.subagent?.alertEngagementThreshold ?? 60,
            fastPathEngagementThreshold: appConfig.subagent?.fastPath?.engagementThreshold ?? 70,
            mentionKeywords: appConfig.notification?.urgentWords ?? ["?", "？", "呢", "吗"],
        },
    });
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

    // ─── NC.onPush: 消息实时处理管线 ───

    // Hook 1: 消息实时落盘到 message_log
    nc.onPush(event => messageLogWriter.write(event));

    // Hook 2: 消息分发到 per-group Observer → 更新 Q3
    nc.onPush(event => {
        const chatId = String(event.chatId ?? "");
        if (!chatId) return;
        // 接收所有消息类型事件（TelegramAdapter 使用 "nc.message"）
        const eventType = String(event.type ?? "");
        if (eventType !== "nc.message" && eventType !== "telegram.message") return;

        const sub = subagentManager.getOrCreate(chatId);
        sub.observer.onMessage(event);
        q3.enqueueOrUpdate(sub.buildQueueEntry());

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

        // TODO [AUDIT]: 将 RecordingPipeline 话题聚类内嵌到 Observer (subagent.md §3.1)
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

    // ─── Recording Pipeline → Observer Bridge ───
    // 话题 triage 完成后，将活跃话题摘要注入对应群组的 Observer（保留此 bridge）
    recordingPipeline.on("topic:triage-passed", (topic: any, decision: any) => {
        log.info("话题通过 Triage", { topicId: topic.id, label: topic.label, type: decision.intervention_type });

        const chatId = String(topic.chatId ?? "");
        if (chatId) {
            const sub = subagentManager.get(chatId);
            if (sub) {
                const activeTopics = topicRegistry.getActive(chatId);
                const digests: TopicDigest[] = activeTopics.map((t: any) => ({
                    topicId: String(t.id),
                    label: String(t.label ?? ""),
                    summary: String(t.summary ?? t.recentContext ?? ""),
                    state: String(t.state ?? "ACTIVE"),
                    participants: [...(t.participantIds ?? [])].map(String),
                    keywords: Array.isArray(t.keywords) ? t.keywords : [],
                    messageCount: t.messageIds?.length ?? 0,
                    lastActivityAt: String(t.lastMessageAt ?? new Date().toISOString()),
                    triageDecision: decision?.should_intervene ? "ENGAGE" as const : "IGNORE" as const,
                    triageConfidence: decision?.confidence ?? 0,
                }));
                sub.observer.setTopicDigests(digests);
                q3.enqueueOrUpdate(sub.buildQueueEntry());
            }
        }
    });

    // TopicRegistry 定时清理
    setInterval(() => topicRegistry.cleanup(), 60_000);

    // SubagentManager 定时空闲回收
    setInterval(() => {
        const released = subagentManager.releaseIdle();
        if (released.length > 0) {
            for (const chatId of released) {
                q3.remove(chatId);
            }
        }
    }, 300_000);

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

    // Attend handler: 主 Agent LLM 决策逻辑（Fix 8: subagent.md §12.2 ➛➜➝）
    mainLoop.setAttendHandler(async (entry): Promise<AttendResult | null> => {
        const subagent = subagentManager.get(entry.chatId);
        if (!subagent) return buildObserveDecision(entry.chatId);



        const depth = calculateDepth(
            entry.attendCount,
            subagent.stickiness.depthCyclePeriod,
            entry.alert ? { forceMinDepth: 2 } : undefined,
        );

        const contextPkg = buildGroupContext({
            chatId: entry.chatId,
            depth,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: entry.topicDigests,
            engagementScore: entry.priority,
        });

        // 算法预估 replyMode（作为 LLM 参考信号 + fallback）
        const suggestedReplyMode = estimateReplyMode(
            contextPkg,
            entry.newMessageCount,
            entry.hasFastPathRequest,
            entry.stickinessLevel,
            entry.topicDigests.filter(d => d.state === "ACTIVE").length,
            entry.lastAttendedAt ? Date.now() - new Date(entry.lastAttendedAt).getTime() : Infinity,
            0,
        );

        // 算法 fallback 结果（LLM 失败时使用）
        const algorithmicResult = suggestedReplyMode === "NONE"
            ? buildObserveDecision(entry.chatId)
            : buildReplyDecisions(
                entry.chatId,
                suggestedReplyMode,
                entry.topicDigests.map(d => ({ topicId: d.topicId, label: d.label })),
                `${suggestedReplyMode} (engagement=${Math.round(entry.priority)}, depth=L${depth})`,
            );

        // ═══ Fix 8: LLM 决策路径 (subagent.md §12.2 ➋➌➍) ═══
        try {
            // 构建消息原文（L2+ 深度）
            let messagesText = "";
            if (depth >= 2) {
                const recentMsgs = memory.getRecentMessages(entry.chatId, 20);
                if (recentMsgs.length > 0) {
                    messagesText = recentMsgs.map(
                        (m: any) => `[${m.timestamp ?? ""}] ${m.displayName ?? "(uid:" + m.userId + ")"}: ${m.text ?? ""}`
                    ).join("\n");
                }
            }

            // 构建 FastPath 历史
            const fpHandler = subagent.fastPathHandler as FastPathHandler | null;
            const fpHistory = fpHandler?.getSentMessages()
                .map(m => `- [${m.timestamp}] ${m.text}`)
                .join("\n") ?? "";

            // 计算时间差
            const timeSinceLastAttend = entry.lastAttendedAt
                ? `${Math.round((Date.now() - new Date(entry.lastAttendedAt).getTime()) / 60_000)}分钟`
                : "从未关注";

            // ➌ Attend 上下文注入 + ➍ Decision 输出格式
            const promptVars = buildAttentionVariables(contextPkg, entry.newMessageCount, {
                persona: `你是「${appConfig.persona.name}」。${appConfig.persona.description}`,
                lastAttendedAt: entry.lastAttendedAt,
                timeSinceLastAttend,
                stickinessLevel: entry.stickinessLevel,
                priorityMultiplier: subagent.stickiness.priorityMultiplier,
                tonePreset: subagent.stickiness.level === "CORE" ? "随意友好" :
                    subagent.stickiness.level === "FAMILIAR" ? "轻松" : "礼貌得体",
                callbacks: undefined, // TODO: 从 globalState 获取最近 callbacks
                fastPathHistory: fpHistory,
                alertReason: entry.alert?.reason,
                messages: messagesText || undefined,
                suggestedReplyMode,
            });

            const attentionPrompt = renderPrompt("ATTENTION", promptVars);
            const decisionPrompt = renderPrompt("DECISION", promptVars);

            // ➋ 主 Agent 系统 Prompt — 含全局状态注入 (subagent.md §12.2 ➋)
            const recentDecisionsText = globalState.getRecentDecisions().slice(-5)
                .map(d => `- [${d.chatId}] ${d.decision}`).join("\n") || "（无）";
            const activeTasksText = globalState.getTaskList()
                .filter(t => t.status !== "DONE" && t.status !== "CANCELLED")
                .map(t => `- [${t.priority}][${t.status}] ${t.description}${t.chatId ? ` (群:${t.chatId})` : ""}`)
                .join("\n") || "（无待办任务）";

            const mainSystemPrompt = `你是 CyberGroupmate 的主调度 Agent「${appConfig.persona.name}」。你的职责是快速审视多个群组的消息状态，做出是否回复、怎么回复的决策，并将执行任务分派给各群组的 Subagent。

${appConfig.persona.description}

## 核心规则
1. 你是唯一的决策者。审视消息 → 判断 → 分派。不亲自回复消息。
2. 你的注意力是串行的。一次只处理一个群组。
3. 你看到的消息截止至 snapshotTimestamp，处理期间的新消息你看不到。
4. 你可以一次生成多条回复指令（BATCH 模式），模拟用户看完一段对话后批量回复。
5. 对于简单和复杂回复，都通过 CODEACT_REPLY 分派给 subagent 执行。你在 contentDirection 中给出明确的内容方向。
6. 只有在高 engagement 场景下才授权 FastPath。
7. 对话历史中的 [Callback] 消息是上一轮 subagent 执行的结果反馈，请参考它们避免重复决策。

## 当前全局状态
${globalState.getAttentionSummary() || "（无）"}

## 最近决策记录
${recentDecisionsText}

## 当前任务列表
${activeTasksText}

仅返回 JSON，不要包含其他文本。`;

            // ➝ 构建 messages: [system, ...历史对话, 当前轮 attend prompt]
            const currentTurnPrompt = `${attentionPrompt}\n\n${decisionPrompt}`;
            const messages: ChatMessage[] = [
                { role: "system", content: mainSystemPrompt },
                ...(mainLoop.getConversationHistory() as ChatMessage[]),
                { role: "user", content: currentTurnPrompt },
            ];

            const llmResponse = await callLLM(
                messages,
                sotaConfig,
                { temperature: 0.3 },
            );


            // 解析 LLM 返回的 JSON
            const jsonContent = llmResponse.content.trim();
            // 尝试提取 JSON（处理 markdown 围栏情况）
            const jsonMatch = jsonContent.match(/```(?:json)?\s*\n?([\s\S]*?)```/) ?? [null, jsonContent];
            const parsed = JSON.parse(jsonMatch[1] ?? jsonContent);

            const llmResult: AttendResult = {
                chatId: entry.chatId,
                replyMode: parsed.replyMode ?? suggestedReplyMode,
                decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((d: any) => ({
                    action: d.action ?? "REPLY",
                    topicId: d.topicId,
                    contentDirection: d.contentDirection,
                    confidence: d.confidence ?? 0.5,
                    reason: d.reason ?? "",
                })) : algorithmicResult.decisions,
                reasoning: parsed.reasoning ?? "",
            };

            // ═══ 追加本轮对话到历史（下轮 LLM 可见） ═══
            mainLoop.appendToHistory({ role: "user", content: currentTurnPrompt });
            mainLoop.appendToHistory({ role: "assistant", content: jsonContent });

            globalState.recordDecision(entry.chatId,
                `LLM_DECISION: ${llmResult.replyMode} (${llmResult.decisions.length} decisions, engagement=${Math.round(entry.priority)}, depth=L${depth})`);
            log.info("LLM 决策完成", {
                chatId: entry.chatId,
                replyMode: llmResult.replyMode,
                decisions: llmResult.decisions.length,
                reasoning: llmResult.reasoning,
                decisionDetails: llmResult.decisions.map(d =>
                    `[${d.action}] ${d.contentDirection ?? d.reason ?? "(无方向)"} (topic=${d.topicId ?? "N/A"}, conf=${d.confidence})`
                ),
            });
            return llmResult;

        } catch (err) {
            // LLM 决策失败 → fallback 到算法结果
            log.warn("LLM 决策失败，fallback 到算法", {
                chatId: entry.chatId,
                error: String(err),
            });
            globalState.recordDecision(entry.chatId,
                `ALGO_FALLBACK: ${suggestedReplyMode} (engagement=${Math.round(entry.priority)}, depth=L${depth}, llm_error=${String(err).slice(0, 100)})`);
            return algorithmicResult;
        }
    });

    // Dispatch handler: 分派任务到 CodeActExecutor / FastPath / Deferred Re-entry
    mainLoop.setDispatchHandler(async (result) => {
        const subagent = subagentManager.get(result.chatId);
        if (!subagent) return;

        let hasCodeActTask = false;

        for (const decision of result.decisions) {
            if (decision.action === "REPLY") {
                // Fix 3: 构建符合 subagent.md §13.2 B1 规格的 contextSnapshot
                // 获取话题摘要
                const activeTopics = topicRegistry.getActive(result.chatId);
                const topicForDecision = decision.topicId
                    ? activeTopics.find((t: any) => String(t.id) === decision.topicId)
                    : activeTopics[0];
                const topicSummary = topicForDecision
                    ? `${topicForDecision.label ?? ""}: ${topicForDecision.recentContext ?? ""}`
                    : "";

                // 获取最近消息
                const recentMsgs = memory.getRecentMessages(result.chatId, 20);
                const formattedMessages = recentMsgs.map((m: any) => ({
                    id: String(m.id ?? m.message_id ?? ""),
                    sender: String(m.display_name ?? m.displayName ?? m.sender ?? m.user_id ?? "?"),
                    text: String(m.text ?? ""),
                    timestamp: String(m.timestamp ?? ""),
                }));

                // 获取人物信息
                let personContext = "";
                try {
                    const persons = await memory.recall(result.chatId, { type: "person", limit: 5 } as any);
                    personContext = JSON.stringify(persons, null, 2);
                } catch { /* 非关键路径 */ }

                const contextSnapshot = buildGroupContext({
                    chatId: result.chatId,
                    depth: 2, // 提供足够上下文
                    snapshotTimestamp: new Date().toISOString(),
                    topicDigests: subagent.observer.getDigest(),
                    engagementScore: subagent.observer.getEngagementScore(),
                });

                // 增强 contextSnapshot：注入 spec 要求的额外上下文
                (contextSnapshot as any).topicSummary = topicSummary;
                (contextSnapshot as any).recentMessages = formattedMessages;
                (contextSnapshot as any).personContext = personContext;
                (contextSnapshot as any).toneGuidance = subagent.stickiness.level === "CORE" ? "随意友好" : "礼貌得体";
                (contextSnapshot as any).contentDirection = decision.contentDirection ?? "";

                // 构建 CodeActReplyTask
                const task: CodeActReplyTask = {
                    type: "CODEACT_REPLY",
                    chatId: result.chatId,
                    taskId: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    decisions: [decision],
                    contextSnapshot,
                    replyMode: result.replyMode === "BATCH" ? "BATCH" : "SINGLE",
                    createdAt: new Date().toISOString(),
                };

                // 获取或创建 CodeActExecutor
                let executor = subagent.codeActExecutor as CodeActExecutor | null;
                if (!executor) {
                    executor = new CodeActExecutor(result.chatId);
                    executor.setCallbackHandler((cb: SubagentCallback) => {
                        q5.enqueue(cb);
                        log.info("Subagent 执行完成 → Q5", {
                            chatId: cb.chatId,
                            taskId: cb.taskId,
                            status: cb.status,
                            summary: cb.summary,
                            sentMessages: cb.sentMessages?.length ?? 0,
                            sentPreviews: cb.sentMessages?.map(m => m.text.length > 60 ? m.text.slice(0, 60) + "..." : m.text),
                            durationMs: cb.durationMs,
                        });
                        // Unblock in Q3 when callback arrives
                        q3.unblock(cb.chatId);
                        globalState.recordDecision(cb.chatId, `CALLBACK: ${cb.executionType} ${cb.status} (${cb.summary})`);
                    });
                    // Fix 9: 注入 Sandbox + NC + LLM 依赖
                    executor.setDependencies(sandboxPool, nc, llmConfig, join(DATA_DIR, "sessions"), appConfig.persona);
                    subagent.codeActExecutor = executor;
                }

                executor.enqueue(task);
                hasCodeActTask = true;

                log.info("分派 CodeActReplyTask", {
                    chatId: result.chatId,
                    taskId: task.taskId,
                    replyMode: task.replyMode,
                    action: decision.action,
                    topicId: decision.topicId,
                    contentDirection: decision.contentDirection ?? "(无)",
                    reason: decision.reason ?? "",
                    confidence: decision.confidence,
                    contextMessageCount: formattedMessages.length,
                    topicSummary: topicSummary ? topicSummary.slice(0, 100) : "(无)",
                });
            } else if (decision.action === "FAST_PATH_AUTH" && result.fastPathAuth) {
                // 授权 FastPath
                let fp = subagent.fastPathHandler as FastPathHandler | null;
                if (!fp) {
                    fp = new FastPathHandler(result.chatId);
                    fp.setCallbackHandler((cb: SubagentCallback) => q5.enqueue(cb));
                    fp.setLLMConfig(cheapConfig, appConfig.persona);
                    subagent.fastPathHandler = fp;
                }
                fp.authorize(result.fastPathAuth);
                log.info("授权 FastPath", { chatId: result.chatId });
            } else if (decision.action === "DEFER") {
                // Fix 2: DEFERRED_RE_ENTRY — 延迟重新入队 (subagent.md §13.1 D1)
                q3.enqueueOrUpdate({
                    chatId: result.chatId,
                    source: "DEFERRED_RE_ENTRY",
                    priority: Math.max(0, (subagent.observer.getEngagementScore() * subagent.stickiness.priorityMultiplier) * 0.5),
                    basePriority: Math.max(0, (subagent.observer.getEngagementScore() * subagent.stickiness.priorityMultiplier) * 0.5),
                });
                log.info("DEFER → 重新入队", {
                    chatId: result.chatId,
                    reason: decision.reason,
                    topicId: decision.topicId,
                });
                globalState.recordDecision(result.chatId, `DEFERRED: ${decision.reason}`);
            } else if (decision.action === "OBSERVE" || decision.action === "IGNORE") {
                // 仅记录，不分派
                log.debug("决策: 不操作", {
                    chatId: result.chatId,
                    action: decision.action,
                    reason: decision.reason,
                });
            }
        }

        if (hasCodeActTask) {
            q3.block(result.chatId, "CodeAct executing");
        }
    });

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
