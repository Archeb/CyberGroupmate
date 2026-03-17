/**
 * event-bridge.ts — NC/组件事件 → WebSocket 桥接
 *
 * Hook 到 NC.onPush、Q5 callback、MainLoop tick 等事件，
 * 将精简后的数据广播给所有 WebSocket 客户端。
 */

import type { WebSocket } from "ws";
import type { DashboardDeps, WsEvent } from "./types.js";
import { createLogger } from "../core/logger.js";

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
            if (type !== "nc.message" && type !== "telegram.message") return;
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
            const gm = this.deps.memory.getGroupModel(sub.chatId);
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
        };
    }
}
