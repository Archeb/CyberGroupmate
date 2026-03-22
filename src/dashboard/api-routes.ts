/**
 * api-routes.ts — Dashboard REST API
 *
 * All routes require ?token= query param matching config (handled by middleware).
 */

import { Router } from "express";
import * as fs from "node:fs";
import type { DashboardDeps } from "./types.js";
import type { EventBridge } from "./event-bridge.js";
import type { FastPathHandler } from "../subagent/fast-path-handler.js";
import type { CodeActExecutor } from "../subagent/code-act-executor.js";
import { createLogger } from "../core/logger.js";
import { loadConfig, validateConfig, saveConfig } from "../core/config.js";

const log = createLogger("dashboard-api");

function qs(val: unknown): string {
    if (Array.isArray(val)) return String(val[0] ?? "");
    return String(val ?? "");
}

function fromJSONSafe(val: string | null | undefined): unknown[] {
    try { return JSON.parse(String(val || "[]")); } catch { return []; }
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
    router.get("/topics/:chatId/search", (req, res) => {
        try {
            const chatId = req.params.chatId;
            const query = qs(req.query.q).trim();
            if (!query) { res.json({ topics: [] }); return; }

            const db = (deps.memory as any).db;
            if (!db) { res.status(500).json({ error: "db not available" }); return; }

            const results: Record<string, unknown>[] = [];
            const seenIds = new Set<string>();

            // 1) Pipeline in-memory topics (JS filter)
            const sub = deps.subagentManager.get(chatId);
            if (sub) {
                const pipelineTopics = sub.topicRegistry.getByChat(chatId) as any[];
                const lowerQ = query.toLowerCase();
                for (const t of pipelineTopics) {
                    const match = (t.label || "").toLowerCase().includes(lowerQ)
                        || (t.summary || "").toLowerCase().includes(lowerQ)
                        || (t.keywords || []).some((k: string) => k.toLowerCase().includes(lowerQ));
                    if (match) {
                        seenIds.add(t.id);
                        results.push({ ...serializeTopic(t), source: "pipeline" });
                    }
                }
            }

            // 2) FTS5 search
            try {
                const ftsRows = db.prepare(`
                    SELECT t.* FROM topics t
                    INNER JOIN topics_fts fts ON t.rowid = fts.rowid
                    WHERE topics_fts MATCH ? AND t.chat_id = ?
                    ORDER BY t.started_at DESC LIMIT 20
                `).all(query, chatId) as Record<string, unknown>[];
                for (const row of ftsRows) {
                    const id = row.id as string;
                    if (seenIds.has(id) || seenIds.has(row.pipeline_topic_id as string)) continue;
                    seenIds.add(id);
                    results.push({
                        id, label: row.label, summary: row.summary,
                        state: row.ended_at ? "ARCHIVED" : "ACTIVE",
                        keywords: fromJSONSafe(row.keywords as string),
                        participantIds: fromJSONSafe(row.participants as string),
                        messageIds: fromJSONSafe(row.message_ids as string),
                        sentiment: row.sentiment, startedAt: row.started_at, endedAt: row.ended_at,
                        source: "history",
                        wasEngaged: !!(row.was_engaged as number),
                        interventionCount: row.intervention_count ?? 0,
                    });
                }
            } catch { /* FTS5 not available, fall through */ }

            // 3) LIKE fallback (if FTS5 yielded nothing)
            if (results.length === 0) {
                try {
                    const likePattern = `%${query}%`;
                    const likeRows = db.prepare(`
                        SELECT * FROM topics
                        WHERE chat_id = ? AND (label LIKE ? OR summary LIKE ? OR keywords LIKE ?)
                        ORDER BY started_at DESC LIMIT 20
                    `).all(chatId, likePattern, likePattern, likePattern) as Record<string, unknown>[];
                    for (const row of likeRows) {
                        const id = row.id as string;
                        if (seenIds.has(id)) continue;
                        seenIds.add(id);
                        results.push({
                            id, label: row.label, summary: row.summary,
                            state: row.ended_at ? "ARCHIVED" : "ACTIVE",
                            keywords: fromJSONSafe(row.keywords as string),
                            participantIds: fromJSONSafe(row.participants as string),
                            messageIds: fromJSONSafe(row.message_ids as string),
                            sentiment: row.sentiment, startedAt: row.started_at, endedAt: row.ended_at,
                            source: "history",
                            wasEngaged: !!(row.was_engaged as number),
                            interventionCount: row.intervention_count ?? 0,
                        });
                    }
                } catch { /* LIKE fallback */ }
            }

            res.json({ topics: results });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.get("/topics/:chatId", (req, res) => {
        const chatId = req.params.chatId;
        const limit = Math.min(parseInt(qs(req.query.limit)) || 10, 100);
        const offset = Math.max(parseInt(qs(req.query.offset)) || 0, 0);
        const sub = deps.subagentManager.get(chatId);

        // 1) Pipeline in-memory topics
        const pipelineTopics = sub ? sub.topicRegistry.getByChat(chatId) : [];
        const pipelineIds = new Set(pipelineTopics.map((t: any) => t.id));

        // 2) Historical topics from SQLite (all time, no 7-day limit)
        const db = (deps.memory as any).db;
        let historyTopics: any[] = [];
        if (db) {
            try {
                const rows = db.prepare(
                    "SELECT * FROM topics WHERE chat_id = ? ORDER BY started_at DESC"
                ).all(chatId) as Record<string, unknown>[];
                historyTopics = rows.map((row: Record<string, unknown>) => ({
                    id: row.id, pipelineTopicId: row.pipeline_topic_id,
                    label: row.label, summary: row.summary,
                    state: row.ended_at ? "ARCHIVED" : "ACTIVE",
                    keywords: fromJSONSafe(row.keywords as string),
                    participants: fromJSONSafe(row.participants as string),
                    messageRange: { messageIds: fromJSONSafe(row.message_ids as string) },
                    sentiment: row.sentiment, startedAt: row.started_at, endedAt: row.ended_at,
                    wasEngaged: !!(row.was_engaged as number),
                    interventionCount: row.intervention_count ?? 0,
                }));
            } catch {}
        } else {
            // Fallback to getTopicsSince if db not directly accessible
            const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
            try { historyTopics = deps.memory.getTopicsSince(chatId, since); } catch {}
        }

        // Merge: pipeline topics first, then history topics not already in pipeline
        const allTopics: Record<string, unknown>[] = pipelineTopics.map((t: any) => {
            const hist = historyTopics.find((h: any) => h.pipelineTopicId === t.id);
            return {
                ...serializeTopic(t),
                source: "pipeline",
                wasEngaged: hist?.wasEngaged ?? false,
                interventionCount: hist?.interventionCount ?? 0,
                startedAt: t.startedAt ?? t.createdAt,
            };
        });

        for (const h of historyTopics) {
            if (h.pipelineTopicId && pipelineIds.has(h.pipelineTopicId)) continue;
            allTopics.push({
                id: h.id,
                label: h.label,
                summary: h.summary,
                state: h.endedAt ? "ARCHIVED" : "ACTIVE",
                keywords: h.keywords ?? [],
                participantIds: h.participants ?? [],
                messageIds: h.messageRange?.messageIds ?? [],
                sentiment: h.sentiment,
                startedAt: h.startedAt,
                endedAt: h.endedAt,
                source: "history",
                wasEngaged: h.wasEngaged ?? false,
                interventionCount: h.interventionCount ?? 0,
            });
        }

        // Sort by startedAt descending (most recent first)
        allTopics.sort((a, b) => {
            const ta = a.startedAt ? new Date(a.startedAt as string | number).getTime() : 0;
            const tb = b.startedAt ? new Date(b.startedAt as string | number).getTime() : 0;
            return tb - ta;
        });

        const total = allTopics.length;
        const paginated = allTopics.slice(offset, offset + limit);

        res.json({
            topics: paginated,
            total,
            hasMore: offset + limit < total,
        });
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

    // ─── Single Topic Detail (with related messages) ───
    router.get("/topic/:topicId", async (req, res) => {
        try {
            const topicId = req.params.topicId;
            const db = (deps.memory as any).db;
            if (!db) { res.status(500).json({ error: "db not available" }); return; }

            // Query topic by id or pipeline_topic_id
            const topicRow = db.prepare(
                "SELECT * FROM topics WHERE id = ? OR pipeline_topic_id = ?"
            ).get(topicId, topicId) as Record<string, unknown> | undefined;

            if (!topicRow) {
                res.status(404).json({ error: "topic not found" });
                return;
            }

            // Parse message_ids
            let messageIds: string[] = [];
            try {
                messageIds = JSON.parse(String(topicRow.message_ids || "[]"));
            } catch {}

            // Fetch related messages
            let messages: Record<string, unknown>[] = [];
            if (messageIds.length > 0) {
                const placeholders = messageIds.map(() => "?").join(", ");
                const chatId = topicRow.chat_id as string;
                messages = db.prepare(`
                    SELECT message_id, user_id, display_name, text, timestamp
                    FROM message_log
                    WHERE chat_id = ? AND message_id IN (${placeholders})
                    ORDER BY timestamp ASC
                `).all(chatId, ...messageIds) as Record<string, unknown>[];
            }

            // Parse other JSON fields safely
            const parseJSON = (v: unknown) => { try { return JSON.parse(String(v || "[]")); } catch { return []; } };

            res.json({
                topicId: topicRow.id,
                pipelineTopicId: topicRow.pipeline_topic_id,
                label: topicRow.label,
                summary: topicRow.summary,
                chatId: topicRow.chat_id,
                state: topicRow.ended_at ? "ARCHIVED" : "ACTIVE",
                sentiment: topicRow.sentiment,
                keywords: parseJSON(topicRow.keywords),
                participants: parseJSON(topicRow.participants),
                keyPoints: parseJSON(topicRow.key_points),
                wasEngaged: !!(topicRow.was_engaged as number),
                interventionCount: topicRow.intervention_count ?? 0,
                startedAt: topicRow.started_at,
                endedAt: topicRow.ended_at,
                messageCount: messageIds.length,
                messages: messages.map(m => ({
                    messageId: m.message_id,
                    userId: m.user_id,
                    displayName: m.display_name,
                    text: m.text,
                    timestamp: m.timestamp,
                })),
            });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // ─── Attention Queue (Q3) ───
    router.get("/queue", (_req, res) => {
        res.json({ active: deps.q3.getAll(), dequeued: deps.q3.getDequeueHistory() });
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

    // ─── Memory: Recall (keyword/semantic search) ───
    router.post("/memory/recall", async (req, res) => {
        try {
            const { query, chatId, daysBack, categories, maxResults } = req.body;
            if (!query) { res.status(400).json({ error: "query required" }); return; }
            const result = await deps.memory.recall(String(query), {
                chatId: chatId ? String(chatId) : undefined,
                daysBack: daysBack ? Number(daysBack) : undefined,
                categories: Array.isArray(categories) ? categories : undefined,
                maxResults: maxResults ? Math.min(Number(maxResults), 50) : 20,
            });
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
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

    // ─── Sticker Management ───
    router.get("/stickers", (_req, res) => {
        const stickers = deps.memory.getAllStickerDescriptions();
        // 附加 hasImage 标记
        const result = stickers.map(s => ({
            ...s,
            hasImage: deps.mediaDownloader ? !!deps.mediaDownloader.getExistingPath(s.uniqueFileId) : false,
        }));
        res.json(result);
    });

    router.get("/stickers/:uniqueFileId/image", (req, res) => {
        if (!deps.mediaDownloader) { res.status(404).json({ error: "mediaDownloader not available" }); return; }
        const filePath = deps.mediaDownloader.getExistingPath(req.params.uniqueFileId);
        if (!filePath || !fs.existsSync(filePath)) { res.status(404).json({ error: "sticker image not found" }); return; }
        try {
            res.setHeader("Content-Type", "image/webp");
            res.setHeader("Cache-Control", "public, max-age=86400");
            fs.createReadStream(filePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.delete("/stickers/:uniqueFileId", (req, res) => {
        const ok = deps.memory.deleteStickerDescription(req.params.uniqueFileId);
        res.json({ ok });
    });

    router.put("/stickers/:uniqueFileId", (req, res) => {
        const { description, emoji } = req.body;
        if (!description) { res.status(400).json({ error: "description required" }); return; }
        const ok = deps.memory.updateStickerDescription(req.params.uniqueFileId, description, emoji);
        res.json({ ok });
    });


    // ─── Memory: List / Edit / Delete ───

    // Person Identities
    router.get("/memory/persons", (req, res) => {
        const limit = Math.min(parseInt(qs(req.query.limit)) || 50, 200);
        const offset = Math.max(parseInt(qs(req.query.offset)) || 0, 0);
        res.json(deps.memory.listPersonIdentities(limit, offset));
    });

    router.put("/memory/person/:userId", (req, res) => {
        const userId = req.params.userId;
        try {
            deps.memory.upsertPersonIdentity(userId, req.body);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.delete("/memory/person/:userId", (req, res) => {
        const ok = deps.memory.deletePersonIdentity(req.params.userId);
        res.json({ ok });
    });

    // Person Group Profiles
    router.get("/memory/profiles/:chatId", (req, res) => {
        const profiles = deps.memory.getProfilesForChat(req.params.chatId);
        res.json(profiles);
    });

    router.put("/memory/profile/:userId/:chatId", (req, res) => {
        try {
            deps.memory.upsertPersonGroupProfile(req.params.userId, req.params.chatId, req.body);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.delete("/memory/profile/:userId/:chatId", (req, res) => {
        const ok = deps.memory.deletePersonGroupProfile(req.params.userId, req.params.chatId);
        res.json({ ok });
    });

    // Group Models
    router.get("/memory/groups", (_req, res) => {
        res.json(deps.memory.listGroupModels());
    });

    router.put("/memory/group/:chatId", (req, res) => {
        try {
            deps.memory.upsertGroupModel(req.params.chatId, req.body);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // Core Facts
    router.get("/memory/facts", (req, res) => {
        const limit = Math.min(parseInt(qs(req.query.limit)) || 50, 200);
        const offset = Math.max(parseInt(qs(req.query.offset)) || 0, 0);
        const subject = qs(req.query.subject) || undefined;
        const category = qs(req.query.category) || undefined;
        res.json(deps.memory.listCoreFacts({ subject, category, limit, offset }));
    });

    router.put("/memory/fact/:id", (req, res) => {
        const ok = deps.memory.updateFact(req.params.id, req.body);
        res.json({ ok });
    });

    router.delete("/memory/fact/:id", (req, res) => {
        const ok = deps.memory.deleteFact(req.params.id);
        res.json({ ok });
    });

    // Interactions
    router.get("/memory/interactions", (req, res) => {
        const limit = Math.min(parseInt(qs(req.query.limit)) || 50, 200);
        const offset = Math.max(parseInt(qs(req.query.offset)) || 0, 0);
        const chatId = qs(req.query.chatId) || undefined;
        const userId = qs(req.query.userId) || undefined;
        res.json(deps.memory.listInteractions({ chatId, userId, limit, offset }));
    });

    router.delete("/memory/interaction/:id", (req, res) => {
        const ok = deps.memory.deleteInteraction(req.params.id);
        res.json({ ok });
    });

    // ─── Token Stats ───
    router.get("/token-stats", (_req, res) => {
        res.json(deps.tokenStats.getStats());
    });

    router.post("/token-stats/reset", (_req, res) => {
        deps.tokenStats.reset();
        log.info("Token 统计已清零");
        res.json({ ok: true });
    });

    router.get("/token-pricing", (_req, res) => {
        res.json(deps.tokenStats.getPricing() ?? {});
    });

    // ─── Config Editor ───
    router.get("/config", (_req, res) => {
        try {
            const config = loadConfig();
            res.json(config);
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.put("/config", (req, res) => {
        try {
            const newConfig = req.body;
            const validation = validateConfig(newConfig);
            if (!validation.valid) {
                res.status(400).json({ ok: false, errors: validation.errors });
                return;
            }
            const result = saveConfig(newConfig);
            if (!result.ok) {
                res.status(500).json({ ok: false, error: result.error });
                return;
            }
            log.info("配置已保存并热重载");
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ ok: false, error: String(err) });
        }
    });

    router.post("/config/test-profile", async (req, res) => {
        try {
            const profile = req.body;
            if (!profile.provider || !profile.baseUrl || !profile.apiKey || !profile.model) {
                res.status(400).json({ ok: false, error: "provider, baseUrl, apiKey, model 为必填" });
                return;
            }
            const start = Date.now();
            const isAnthropic = profile.provider === "anthropic";
            const url = isAnthropic
                ? `${profile.baseUrl.replace(/\/$/, "")}/messages`
                : `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (isAnthropic) {
                headers["x-api-key"] = profile.apiKey;
                headers["anthropic-version"] = "2023-06-01";
            } else {
                headers["Authorization"] = `Bearer ${profile.apiKey}`;
            }
            const body = isAnthropic
                ? { model: profile.model, max_tokens: 10, messages: [{ role: "user", content: "ping" }] }
                : { model: profile.model, max_tokens: 10, messages: [{ role: "user", content: "ping" }] };

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            const response = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeout);
            const latency = Date.now() - start;

            if (response.ok) {
                const data = await response.json();
                const model = isAnthropic ? data.model : data.model;
                res.json({ ok: true, latency, model, status: response.status });
            } else {
                const text = await response.text().catch(() => "");
                res.json({ ok: false, latency, status: response.status, error: text.slice(0, 500) });
            }
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            res.json({ ok: false, error: errMsg.includes("abort") ? "连接超时 (15s)" : errMsg });
        }
    });

    router.post("/restart", (_req, res) => {
        log.info("收到重启请求，进程将在 1 秒后退出");
        res.json({ ok: true, message: "进程将在 1 秒后退出，请确保有进程管理器（pm2/systemd）自动重启" });
        setTimeout(() => process.exit(0), 1000);
    });

    return router;
}
