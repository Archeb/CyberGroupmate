/**
 * event-bridge.ts — NC/组件事件 → WebSocket 桥接
 *
 * Hook 到 NC.onPush、Q5 callback、MainLoop tick 等事件，
 * 将精简后的数据广播给所有 WebSocket 客户端。
 */

import type { WebSocket } from "ws";
import type { DashboardDeps, WsEvent } from "./types.js";
import { createLogger } from "../core/logger.js";
import { llmEvents, type LLMCallEvent, type LLMResponseEvent } from "../core/llm.js";
import { codeActEvents, type CodeActProgressEvent } from "../sandbox/session-runner.js";
import { getGroupModelKey } from "../core/chat-id.js";

const log = createLogger("dashboard-bridge");

export class EventBridge {
    private clients = new Set<WebSocket>();
    private deps: DashboardDeps;
    /** 最近 NC 事件（环形缓冲，用于新连接回放） */
    private recentEvents: WsEvent[] = [];
    private maxRecent = 200;

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
    broadcast(event: WsEvent): void {
        const payload = JSON.stringify(event);
        for (const ws of this.clients) {
            if (ws.readyState === ws.OPEN) {
                ws.send(payload);
            }
        }
        // 存入环形缓冲
        this.recentEvents.push(event);
        if (this.recentEvents.length > this.maxRecent) {
            this.recentEvents.shift();
        }
    }

    private hookNC(): void {
        // NC 消息事件
        this.deps.nc.onPush(event => {
            const type = String(event.type ?? "");
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
            this.broadcast({
                type: "llm:call",
                timestamp: data.timestamp,
                data,
            });
        });

        llmEvents.on("llm:response", (data: LLMResponseEvent) => {
            this.broadcast({
                type: "llm:response",
                timestamp: data.timestamp,
                data,
            });

            // 持久化 token 统计
            const model = callIdToModel.get(data.callId) ?? "unknown";
            callIdToModel.delete(data.callId);
            if (data.usage && !data.error) {
                this.deps.tokenStats.record(model, data.usage);
            }
        });
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

            pipeline.on("topic:triage-passed", (topic: any, decision: any) => {
                this.broadcast({
                    type: "recording:triage-passed",
                    timestamp: new Date().toISOString(),
                    data: {
                        chatId: sub.chatId,
                        topicId: topic.id,
                        topicLabel: topic.label,
                        decision: {
                            should_intervene: decision.should_intervene,
                            intervention_type: decision.intervention_type,
                            confidence: decision.confidence,
                            reason: decision.reason,
                        },
                    },
                });
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
            // 回放最近事件
            for (const ev of this.recentEvents) {
                ws.send(JSON.stringify(ev));
            }
        } catch (err) {
            log.warn("sendSnapshot error", { error: String(err) });
        }
    }

    buildSnapshot(): Record<string, unknown> {
        const { subagentManager, q3, q5, mainLoop, globalState, sandboxPool, feedbackLoop } = this.deps;

        // 群组概览
        const groups: Record<string, unknown>[] = [];
        for (const sub of subagentManager.getAllSubagents()) {
            const fp = sub.fastPathHandler as any;
            const gm = this.deps.memory.getGroupModel(getGroupModelKey(sub.chatId));
            groups.push({
                chatId: sub.chatId,
                chatTitle: gm?.chatTitle || "",
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
                fastPathStatus: fp?.getStatus?.() ?? { authorized: false, repliesSent: 0, maxReplies: 0, expiresAt: null },
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
