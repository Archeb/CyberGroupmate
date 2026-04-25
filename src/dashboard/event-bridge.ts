/**
 * event-bridge.ts — NC/组件事件 → WebSocket 桥接
 *
 * Hook 到 NC.onPush、Q5 callback、MainLoop tick 等事件，
 * 将精简后的数据广播给所有 WebSocket 客户端。
 */

import type { WebSocket } from "ws";
import type { DashboardDeps, WsEvent } from "./types.js";
import { createLogger } from "../core/logger.js";
import { llmEvents, type LLMCallEvent, type LLMResponseEvent, type LLMRetryEvent, cancelLLMCall } from "../core/llm.js";
import { codeActEvents, type CodeActProgressEvent } from "../sandbox/session-runner.js";
import { getGroupModelKey } from "../core/chat-id.js";

const log = createLogger("dashboard-bridge");

// ─── LLM Log 专用环形缓冲 ───

export interface LLMLogEntry {
    callId: string;
    caller: string;
    model: string;
    temperature: number;
    maxTokens: number;
    provider: string;
    timestamp: string;
    messageSummaries: LLMCallEvent["messageSummaries"];
    response: LLMResponseEvent | null;
    retries: LLMRetryEvent[];
}

export class LLMLogBuffer {
    private buffer: LLMLogEntry[] = [];
    private readonly maxSize: number;

    constructor(maxSize = 2000) {
        this.maxSize = maxSize;
    }

    /** 添加新的 LLM 调用记录 */
    addCall(data: LLMCallEvent): void {
        const entry: LLMLogEntry = {
            callId: data.callId,
            caller: data.caller,
            model: data.model,
            temperature: data.temperature,
            maxTokens: data.maxTokens,
            provider: data.provider,
            timestamp: data.timestamp,
            messageSummaries: data.messageSummaries,
            response: null,
            retries: [],
        };
        this.buffer.unshift(entry);
        if (this.buffer.length > this.maxSize) {
            this.buffer.pop();
        }
    }

    /** 关联响应到对应的调用记录 */
    addResponse(data: LLMResponseEvent): void {
        const entry = this.buffer.find(e => e.callId === data.callId);
        if (entry) {
            entry.response = data;
        }
    }

    /** 关联重试到对应的调用记录 */
    addRetry(data: LLMRetryEvent): void {
        const entry = this.buffer.find(e => e.callId === data.callId);
        if (entry) {
            entry.retries.push(data);
        }
    }

    /** 分页获取 log 列表（最新在前，index 0 = 最新） */
    getPage(offset: number, limit: number): { logs: LLMLogEntry[]; total: number; hasMore: boolean } {
        const total = this.buffer.length;
        const logs = this.buffer.slice(offset, offset + limit);
        return { logs, total, hasMore: offset + limit < total };
    }

    /** 获取单条 log */
    getByCallId(callId: string): LLMLogEntry | undefined {
        return this.buffer.find(e => e.callId === callId);
    }

    /** 获取时间范围内的所有 log */
    getByTimeRange(from: string, to: string): LLMLogEntry[] {
        const fromMs = new Date(from).getTime();
        const toMs = new Date(to).getTime();
        return this.buffer.filter(e => {
            const t = new Date(e.timestamp).getTime();
            return t >= fromMs && t <= toMs;
        });
    }

    /** 导出统计 CSV（时间范围） */
    exportStatsCSV(from: string, to: string): string {
        const logs = this.getByTimeRange(from, to);
        const header = "timestamp,caller,model,provider,temperature,maxTokens,promptTokens,completionTokens,cachedTokens,cacheCreationTokens,totalTokens,durationMs,error";
        const rows = logs.map(e => {
            const r = e.response;
            const u = r?.usage;
            return [
                e.timestamp,
                e.caller,
                `"${e.model}"`,
                e.provider,
                e.temperature,
                e.maxTokens,
                u?.promptTokens ?? "",
                u?.completionTokens ?? "",
                u?.cachedTokens ?? "",
                u?.cacheCreationTokens ?? "",
                u?.totalTokens ?? "",
                r?.durationMs ?? "",
                r?.error ? `"${r.error.replace(/"/g, '""')}"` : "",
            ].join(",");
        });
        return [header, ...rows].join("\n");
    }

    /** 导出完整日志 JSON 列表（时间范围） */
    exportFullLogs(from: string, to: string): LLMLogEntry[] {
        return this.getByTimeRange(from, to);
    }

    /** 获取汇总统计 */
    getStats(): { total: number; success: number; error: number; totalTokens: number; totalCachedTokens: number } {
        let total = 0, success = 0, error = 0, totalTokens = 0, totalCachedTokens = 0;
        for (const e of this.buffer) {
            total++;
            if (e.response) {
                if (e.response.error) error++;
                else success++;
                if (e.response.usage?.totalTokens) totalTokens += e.response.usage.totalTokens;
                if (e.response.usage?.cachedTokens) totalCachedTokens += e.response.usage.cachedTokens;
            }
        }
        return { total, success, error, totalTokens, totalCachedTokens };
    }

    get size(): number {
        return this.buffer.length;
    }
}

export class EventBridge {
    private clients = new Set<WebSocket>();
    private deps: DashboardDeps;
    /** 最近 NC 事件（环形缓冲，用于新连接回放） */
    private recentEvents: WsEvent[] = [];
    private maxRecent = 200;
    /** LLM 日志专用缓冲（10000 条） */
    readonly llmLogBuffer = new LLMLogBuffer(10000);

    constructor(deps: DashboardDeps) {
        this.deps = deps;
        this.hookNC();
        this.hookLLMEvents();
        this.hookCodeActEvents();
        this.hookRecordingPipelineEvents();
    }

    addClient(ws: WebSocket): void {
        this.clients.add(ws);
        // 发送初始状态快照
        this.sendSnapshot(ws);
        ws.on("close", () => this.clients.delete(ws));
    }

    /** 广播给所有客户端 */
    broadcast(event: WsEvent, skipRecentBuffer = false): void {
        const payload = JSON.stringify(event);
        for (const ws of this.clients) {
            if (ws.readyState === ws.OPEN) {
                ws.send(payload);
            }
        }
        // LLM 事件不存入通用环形缓冲（由专用 llmLogBuffer 管理）
        if (!skipRecentBuffer) {
            this.recentEvents.push(event);
            if (this.recentEvents.length > this.maxRecent) {
                this.recentEvents.shift();
            }
        }
    }

    private hookNC(): void {
        // NC 消息事件 + Adapter 状态事件
        this.deps.nc.onPush(event => {
            const type = String(event.type ?? "");

            // Adapter 状态广播到 dashboard
            if (type === "system.adapter_status") {
                this.broadcast({
                    type: "adapter:status",
                    timestamp: new Date().toISOString(),
                    data: event,
                });
                return;
            }

            if (type !== "nc.message") return;
            this.broadcast({
                type: "nc:message",
                timestamp: new Date().toISOString(),
                data: {
                    chatId: String(event.chatId ?? ""),
                    messageId: String(event.messageId ?? event.id ?? ""),
                    userId: String(event.userId ?? event.user_id ?? event.senderId ?? ""),
                    displayName: String(event.displayName ?? event.senderName ?? event.userName ?? ""),
                    text: String(event.text ?? event.message ?? ""),
                    isDirectMessage: !!event.isDirectMessage,
                    mentionsAgent: !!event.mentionsAgent,
                    chatTitle: String(event.chatTitle ?? ""),
                },
            });
        });
    }

    /** 订阅 LLM 事件并广播到 WebSocket */
    private hookLLMEvents(): void {
        /** callId → model 映射（用于在 response 中还原 model） */
        const callIdToModel = new Map<string, string>();

        llmEvents.on("llm:call", (data: LLMCallEvent) => {
            callIdToModel.set(data.callId, data.model);
            // 存入专用缓冲
            this.llmLogBuffer.addCall(data);
            this.broadcast({
                type: "llm:call",
                timestamp: data.timestamp,
                data,
            }, /* skipLLMBuffer */ true);
        });

        llmEvents.on("llm:response", (data: LLMResponseEvent) => {
            // 存入专用缓冲
            this.llmLogBuffer.addResponse(data);
            this.broadcast({
                type: "llm:response",
                timestamp: data.timestamp,
                data,
            }, /* skipLLMBuffer */ true);

            // 持久化 token 统计
            const model = callIdToModel.get(data.callId) ?? "unknown";
            callIdToModel.delete(data.callId);
            if (data.usage && !data.error) {
                this.deps.tokenStats.record(model, data.caller ?? "unknown", data.usage);
            }
        });

        llmEvents.on("llm:retry", (data: LLMRetryEvent) => {
            // 存入专用缓冲
            this.llmLogBuffer.addRetry(data);
            this.broadcast({
                type: "llm:retry",
                timestamp: data.timestamp,
                data,
            }, /* skipLLMBuffer */ true);
        });
    }

    /** 处理来自 Dashboard 前端的 WebSocket 命令 */
    handleCommand(msg: Record<string, unknown>): void {
        const type = String(msg.type ?? "");
        switch (type) {
            case "llm:cancel": {
                const callId = String(msg.callId ?? "");
                if (callId) {
                    const ok = cancelLLMCall(callId);
                    log.info("llm:cancel command", { callId, success: ok });
                }
                break;
            }
            default:
                break;
        }
    }

    /** 订阅 CodeAct 进度事件并广播到 WebSocket */
    private hookCodeActEvents(): void {
        codeActEvents.on("codeact:progress", (data: CodeActProgressEvent) => {
            this.broadcast({
                type: "codeact:progress",
                timestamp: data.timestamp,
                data,
            });
        });
    }

    /** 订阅 Recording Pipeline 事件并广播到 WebSocket */
    private hookRecordingPipelineEvents(): void {
        // 已挂载的 chatId 集合，避免重复 hook
        const hooked = new Set<string>();

        const hookSubagent = (sub: any) => {
            if (hooked.has(sub.chatId)) return;
            const pipeline = sub.recordingPipeline;
            if (!pipeline) return;
            hooked.add(sub.chatId);

            pipeline.on("flush:start", (messageCount: number) => {
                this.broadcast({
                    type: "recording:flush-start",
                    timestamp: new Date().toISOString(),
                    data: { chatId: sub.chatId, messageCount },
                });
            });

            pipeline.on("flush:complete", (topics: any[]) => {
                this.broadcast({
                    type: "recording:flush-complete",
                    timestamp: new Date().toISOString(),
                    data: {
                        chatId: sub.chatId,
                        topicCount: topics.length,
                        topics: topics.map(t => ({
                            id: t.id,
                            label: t.label,
                            state: t.state,
                            messageCount: t.messageCount,
                        })),
                    },
                });
            });

            pipeline.on("flush:error", (error: Error) => {
                this.broadcast({
                    type: "recording:flush-error",
                    timestamp: new Date().toISOString(),
                    data: { chatId: sub.chatId, error: error instanceof Error ? error.message : String(error) },
                });
            });

            pipeline.on("topics:triage-passed", (passedTopics: Array<{ topic: any; decision: any }>) => {
                for (const { topic, decision } of passedTopics) {
                    this.broadcast({
                        type: "recording:triage-passed",
                        timestamp: new Date().toISOString(),
                        data: {
                            chatId: sub.chatId,
                            topicId: topic.id,
                            topicLabel: topic.label,
                            decision: {
                                should_intervene: decision.should_intervene,
                                reason: decision.reason,
                                callbackPotential: topic.callbackPotential ?? 0,
                            },
                        },
                    });
                }
            });
        };

        // Hook 已有全部 subagent
        for (const sub of this.deps.subagentManager.getAllSubagents()) {
            hookSubagent(sub);
        }

        // 定期检查新加入的 subagent
        setInterval(() => {
            for (const sub of this.deps.subagentManager.getAllSubagents()) {
                hookSubagent(sub);
            }
        }, 10000);
    }

    /** 发送当前系统全状态快照 */
    private sendSnapshot(ws: WebSocket): void {
        try {
            const snapshot = this.buildSnapshot();
            ws.send(JSON.stringify({ type: "snapshot", timestamp: new Date().toISOString(), data: snapshot }));
            // 回放最近非 LLM 事件
            for (const ev of this.recentEvents) {
                ws.send(JSON.stringify(ev));
            }
            // 发送最近 30 条 LLM log 作为初始页
            const { logs, total, hasMore } = this.llmLogBuffer.getPage(0, 30);
            const stats = this.llmLogBuffer.getStats();
            ws.send(JSON.stringify({
                type: "llm:init",
                timestamp: new Date().toISOString(),
                data: { logs, total, hasMore, stats },
            }));
        } catch (err) {
            log.warn("sendSnapshot error", { error: String(err) });
        }
    }

    buildSnapshot(): Record<string, unknown> {
        const { subagentManager, q3, q5, mainLoop, globalState, sandboxPool, feedbackLoop } = this.deps;

        // 群组概览
        const groups: Record<string, unknown>[] = [];
        for (const sub of subagentManager.getAllSubagents()) {
            const gm = this.deps.memory.getGroupModel(getGroupModelKey(sub.chatId));
            groups.push({
                chatId: sub.chatId,
                chatTitle: gm?.chatTitle || "",
                isDirectMessage: !!gm?.isDirectMessage,
                engagement: sub.observer.getEngagementScore(),
                bufferSize: sub.observer.getBufferSize(),
                topicCount: sub.topicRegistry.getAll().length,
                stickiness: sub.stickiness.level,
                lastAttendedAt: sub.lastAttendedAt,
                attendCount: sub.attendCount,
                hasTriageEngaged: sub.hasTriageEngaged,
                lastAgentReplyAt: sub.lastAgentReplyAt,
                codeActQueueSize: (sub.codeActExecutor as any)?.getQueueSize?.() ?? 0,
                codeActProcessing: (sub.codeActExecutor as any)?.isProcessing?.() ?? false,
                codeActSessionSize: (sub.codeActExecutor as any)?.getSessionSize?.() ?? 0,
                dispatchedTopicIds: [...sub.getDispatchedTopicIds()],
                lastCallbacks: sub.lastCallbacks,
            });
        }

        return {
            groups,
            queue: { active: q3.getAll(), dequeued: q3.getDequeueHistory() },
            pendingCallbacks: q5.peek(),
            globalState: globalState.getState(),
            sandboxPool: sandboxPool.getStats(),
            mainLoop: {
                running: mainLoop.isRunning(),
                tickCount: mainLoop.getTickCount(),
                conversationHistorySize: mainLoop.getConversationHistorySize(),
            },
            feedbackLoop: {
                activeWindows: feedbackLoop.getActiveWindows(),
            },
            tokenPricing: this.deps.tokenStats.getPricing() ?? {},
        };
    }
}
