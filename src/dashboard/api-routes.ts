/**
 * api-routes.ts — Dashboard REST API
 *
 * All routes require ?token= query param matching config (handled by middleware).
 */

import { Router } from "express";
import type { DashboardDeps } from "./types.js";
import type { EventBridge } from "./event-bridge.js";
import type { FastPathHandler } from "../subagent/fast-path-handler.js";
import type { CodeActExecutor } from "../subagent/code-act-executor.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("dashboard-api");

function qs(val: unknown): string {
    if (Array.isArray(val)) return String(val[0] ?? "");
    return String(val ?? "");
}

function serializeTopic(topic: any): Record<string, unknown> | null {
    if (!topic) return null;
    return {
        ...topic,
        participantIds: [...(topic.participantIds ?? [])].map(String),
        messageIds: (topic.messageIds ?? []).map(String),
        pendingMessages: (topic.pendingMessages ?? []).map((msg: any) => ({
            ...msg,
            id: String(msg.id),
            chatId: String(msg.chatId),
            senderId: String(msg.senderId),
        })),
    };
}

export function createApiRouter(deps: DashboardDeps, bridge: EventBridge): Router {
    const router = Router();

    // ─── Overview ───
    router.get("/overview", (_req, res) => {
        res.json(bridge.buildSnapshot());
    });

    // ─── Messages ───
    router.get("/messages/:chatId", (req, res) => {
        const limit = Math.min(parseInt(qs(req.query.limit)) || 50, 200);
        const messages = deps.memory.getRecentMessages(req.params.chatId, limit);
        res.json(messages);
    });

    // ─── Topics ───
    router.get("/topics/:chatId", (req, res) => {
        const sub = deps.subagentManager.get(req.params.chatId);
        if (!sub) { res.json([]); return; }
        const topics = sub.topicRegistry.getByChat(req.params.chatId);
        res.json(topics.map(serializeTopic));
    });

    router.get("/topics", (_req, res) => {
        const all: Record<string, unknown>[] = [];
        for (const sub of deps.subagentManager.getAllSubagents()) {
            for (const t of sub.topicRegistry.getAll()) {
                all.push({ chatId: sub.chatId, ...serializeTopic(t) });
            }
        }
        res.json(all);
    });

    // ─── Attention Queue (Q3) ───
    router.get("/queue", (_req, res) => {
        res.json(deps.q3.getAll());
    });

    router.post("/queue/enqueue", (req, res) => {
        const { chatId, priority } = req.body;
        if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }
        const sub = deps.subagentManager.get(chatId);
        if (!sub) { res.status(404).json({ error: "chat not found" }); return; }
        const entry = sub.buildQueueEntry();
        if (priority) entry.priority = Number(priority);
        deps.q3.enqueueOrUpdate(entry);
        bridge.broadcast({ type: "queue:update", timestamp: new Date().toISOString(), data: deps.q3.getAll() });
        log.info("手动入队 Q3", { chatId, priority });
        res.json({ ok: true });
    });

    router.post("/queue/boost", (req, res) => {
        const { chatId, amount } = req.body;
        if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }
        deps.q3.boost(chatId, Number(amount) || 20);
        bridge.broadcast({ type: "queue:update", timestamp: new Date().toISOString(), data: deps.q3.getAll() });
        res.json({ ok: true });
    });

    router.delete("/queue/:chatId", (req, res) => {
        deps.q3.remove(req.params.chatId);
        bridge.broadcast({ type: "queue:update", timestamp: new Date().toISOString(), data: deps.q3.getAll() });
        res.json({ ok: true });
    });

    // ─── Decisions & GlobalState ───
    router.get("/decisions", (_req, res) => {
        res.json(deps.globalState.getRecentDecisions());
    });

    router.get("/global-state", (_req, res) => {
        res.json(deps.globalState.getState());
    });

    // ─── Memory: User / Group ───
    router.get("/memory/user/:userId", async (req, res) => {
        try {
            const userId = req.params.userId;
            const chatId = qs(req.query.chatId) || undefined;
            const identity = deps.memory.getPersonIdentity(userId);
            let profiles: unknown[] = [];
            if (chatId) {
                profiles = deps.memory.getProfilesForChat(chatId).filter((p: any) => p.userId === userId);
            }
            const facts = await deps.memory.recall(userId, { maxResults: 20 });
            res.json({ identity, profiles, facts });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.get("/memory/group/:chatId", (req, res) => {
        const chatId = req.params.chatId;
        const model = deps.memory.getGroupModel(chatId);
        const profiles = deps.memory.getProfilesForChat(chatId);
        res.json({ model, profiles });
    });

    // ─── CodeAct ───
    router.get("/codeact/:chatId", (req, res) => {
        const sub = deps.subagentManager.get(req.params.chatId);
        if (!sub) { res.status(404).json({ error: "chat not found" }); return; }
        const executor = sub.codeActExecutor as CodeActExecutor | null;
        if (!executor) { res.json({ session: [], queueSize: 0 }); return; }
        res.json({
            session: executor.session,
            queueSize: executor.getQueueSize(),
            sessionSize: executor.getSessionSize(),
            executionCount: executor.getExecutionCount(),
            isProcessing: executor.isProcessing(),
            lastCompactedAt: executor.lastCompactedAt,
        });
    });

    router.post("/codeact/:chatId/cancel", async (req, res) => {
        const chatId = req.params.chatId;
        try {
            await deps.sandboxPool.destroy(chatId);
            deps.q3.unblock(chatId);
            log.info("CodeAct 手动取消", { chatId });
            res.json({ ok: true, message: "Sandbox destroyed, queue unblocked" });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // ─── Sandbox Pool ───
    router.get("/sandbox/pool", (_req, res) => {
        res.json(deps.sandboxPool.getStats());
    });

    // ─── FastPath ───
    router.post("/fastpath/:chatId/revoke", (req, res) => {
        const sub = deps.subagentManager.get(req.params.chatId);
        if (!sub) { res.status(404).json({ error: "chat not found" }); return; }
        const fp = sub.fastPathHandler as FastPathHandler | null;
        if (fp) {
            fp.revoke();
            log.info("FastPath 手动撤销", { chatId: req.params.chatId });
        }
        res.json({ ok: true });
    });

    // ─── FeedbackLoop ───
    router.get("/feedbackloop", (_req, res) => {
        res.json({ activeWindows: deps.feedbackLoop.getActiveWindows() });
    });

    // ─── Main Agent Conversation History ───
    router.get("/main-agent/history", (_req, res) => {
        res.json(deps.mainLoop.getConversationHistory());
    });

    // ─── Callbacks (Q5) ───
    router.get("/callbacks", (_req, res) => {
        res.json(deps.q5.peek());
    });

    return router;
}
