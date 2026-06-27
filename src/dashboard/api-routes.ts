/**
 * api-routes.ts — Dashboard REST API
 *
 * All routes require ?token= query param matching config (handled by middleware).
 */

import { Router } from "express";
import * as fs from "node:fs";
import { join } from "node:path";
import type { DashboardDeps } from "./types.js";
import type { EventBridge } from "./event-bridge.js";
import type { CodeActExecutor } from "../subagent/code-act-executor.js";
import { refreshModuleRegistryCache } from "../subagent/code-act-executor.js";
import { createLogger } from "../core/logger.js";
import { loadConfig, validateConfig, saveConfig } from "../core/config.js";
import { DEFAULT_BANNED_WORDS } from "../core/banned-words.js";
import { rateLimiter } from "../core/llm-rate-limiter.js";
import { discoverSkills } from "../sandbox/skill-loader.js";
import {
    listAllPrompts,
    loadOriginalPrompt,
    loadOverridePrompt,
    saveOverride,
    deleteOverride,
    reloadAllPrompts,
} from "../core/prompt-loader.js";
import { getConnectionConfigs, mcpBridge, replaceConnectionConfigs, type McpServerConfig } from "../sandbox/modules/mcp-bridge/index.js";
import {
    META_CODEACT_CHAT_ID,
    getMetaCodeActState,
    requestCancelMetaCodeActSession,
    resetMetaCodeActState,
} from "../meta-sandbox/meta-session-runner.js";
import { getMetaHistoryWindowStatus } from "../main-agent/meta-history-retention.js";
import { getPlatform } from "../core/chat-id.js";
import { extractAnimatedStickerFrames } from "../core/vision-processor.js";
import type { MainAgentGlobalState, SchedulerEvent } from "../subagent/types.js";
import { createCronApi, createReminderApi } from "../meta-sandbox/meta-api/scheduler.js";
import { createTodoApi } from "../meta-sandbox/meta-api/todo.js";

const log = createLogger("dashboard-api");
const SKILLS_ROOT = join(process.cwd(), "workspace", "skills");
const DEBUG_EXECUTION_LOCKS = new Set<string>();
const dynamicStickerPreviewCache = new Map<string, { mtimeMs: number; buffer: Buffer }>();

const DEFAULT_CODEACT_DEBUG_TIMEOUT_MS = 30_000;
const MAX_CODEACT_DEBUG_TIMEOUT_MS = 120_000;
const DEFAULT_SUBAGENT_DEBUG_MODULES = [
    "runtime", "fs", "skills", "mcp", "cron", "todo", "memory", "privacy", "dispatch", "vision", "shell",
];
const BUILTIN_DEBUG_DTS: Record<string, string> = {
    runtime: "runtime/runtime.d.ts",
    fs: "filesystem/filesystem.d.ts",
    filesystem: "filesystem/filesystem.d.ts",
    skills: "skills/skills.d.ts",
    mcp: "mcp-bridge/mcp-bridge.d.ts",
    "mcp-bridge": "mcp-bridge/mcp-bridge.d.ts",
    cron: "cron/cron.d.ts",
    todo: "kv/todo.d.ts",
    kv: "kv/todo.d.ts",
    memory: "memory/memory.d.ts",
    dispatch: "dispatch/dispatch.d.ts",
    vision: "vision/vision.d.ts",
    shell: "shell/shell.d.ts",
    telegram: "telegram/telegram.d.ts",
    discord: "discord/discord.d.ts",
    onebot: "onebot/onebot.d.ts",
};

function qs(val: unknown): string {
    if (Array.isArray(val)) return String(val[0] ?? "");
    return String(val ?? "");
}

const EMOJI_SEARCH_CHAR_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;

function parseStickerSearchTerms(raw: string): string[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];

    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const candidates: string[] = [];

    for (const { segment } of segmenter.segment(trimmed)) {
        const token = segment.trim();
        if (!token || !EMOJI_SEARCH_CHAR_RE.test(token) || candidates.includes(token)) continue;
        candidates.push(token);
    }

    return candidates;
}

function stickerFileKind(filePath?: string): "static" | "animated" | null {
    if (!filePath) return null;
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".webm") || isTgsStickerFile(filePath)) return "animated";
    return "static";
}

function stickerContentType(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".png")) return "image/png";
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".gif")) return "image/gif";
    if (lower.endsWith(".webm")) return "video/webm";
    if (isTgsStickerFile(filePath)) return "application/x-tgsticker";
    return "image/webp";
}

function isTgsStickerFile(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".tgs")) return true;
    if (!lower.endsWith(".bin")) return false;
    try {
        const fd = fs.openSync(filePath, "r");
        try {
            const header = Buffer.allocUnsafe(2);
            return fs.readSync(fd, header, 0, 2, 0) === 2 && header[0] === 0x1f && header[1] === 0x8b;
        } finally {
            fs.closeSync(fd);
        }
    } catch {
        return false;
    }
}

async function renderDynamicStickerPreview(filePath: string): Promise<Buffer> {
    const stat = fs.statSync(filePath);
    const cached = dynamicStickerPreviewCache.get(filePath);
    if (cached?.mtimeMs === stat.mtimeMs) return cached.buffer;

    const raw = fs.readFileSync(filePath);
    const frames = await extractAnimatedStickerFrames(raw, isTgsStickerFile(filePath), 1);
    const buffer = frames[0];
    if (!buffer) throw new Error("dynamic sticker preview produced no frames");
    dynamicStickerPreviewCache.set(filePath, { mtimeMs: stat.mtimeMs, buffer });
    return buffer;
}

function fromJSONSafe(val: string | null | undefined): unknown[] {
    try { return JSON.parse(String(val || "[]")); } catch { return []; }
}

function isSafeSkillId(skillId: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(skillId);
}

function ensureSkillId(skillId: string): string {
    const trimmed = skillId.trim();
    if (!trimmed || !isSafeSkillId(trimmed)) {
        throw new Error("invalid skill id");
    }
    return trimmed;
}

function listSkillEntries(): Array<{
    id: string;
    entryFileName: "index.ts" | "index.js";
    dtsFileName: string;
    hasSkillMd: boolean;
}> {
    if (!fs.existsSync(SKILLS_ROOT)) return [];

    return fs.readdirSync(SKILLS_ROOT)
        .filter((entry) => {
            const fullPath = join(SKILLS_ROOT, entry);
            return fs.statSync(fullPath).isDirectory() && entry !== "node_modules" && !entry.startsWith(".");
        })
        .map((entry) => {
            const dirPath = join(SKILLS_ROOT, entry);
            const files = fs.readdirSync(dirPath);
            const entryFileName: "index.ts" | "index.js" = files.includes("index.ts") ? "index.ts" : "index.js";
            const dtsFileName = files.find((file) => file === `${entry}.d.ts`) ?? files.find((file) => file.endsWith(".d.ts")) ?? `${entry}.d.ts`;
            return {
                id: entry,
                entryFileName,
                dtsFileName,
                hasSkillMd: files.includes("SKILL.md"),
            };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
}

function readTextIfExists(filePath: string): string {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
}

function normalizeDebugTimeout(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_CODEACT_DEBUG_TIMEOUT_MS;
    return Math.max(1_000, Math.min(Math.floor(parsed), MAX_CODEACT_DEBUG_TIMEOUT_MS));
}

function acquireDebugLock(key: string): boolean {
    if (DEBUG_EXECUTION_LOCKS.has(key)) {
        return false;
    }
    DEBUG_EXECUTION_LOCKS.add(key);
    return true;
}

function releaseDebugLock(key: string): void {
    DEBUG_EXECUTION_LOCKS.delete(key);
}

function readDebugDts(pathFromModulesRoot: string): { path: string; content: string } | null {
    const path = join(process.cwd(), "src", "sandbox", "modules", pathFromModulesRoot);
    const content = readTextIfExists(path);
    return content ? { path: `file:///codeact-debug/${pathFromModulesRoot.replace(/\\/g, "/")}`, content } : null;
}

function buildSubagentDebugTypeLibs(chatId: string): Array<{ path: string; content: string }> {
    const config = loadConfig("config.yaml", true);
    const platform = getPlatform(chatId);
    const modules = new Set<string>([
        ...(config.subagent?.baseSkills ?? DEFAULT_SUBAGENT_DEBUG_MODULES),
        platform,
    ].filter(Boolean));
    const libs: Array<{ path: string; content: string }> = [];

    for (const moduleName of modules) {
        const dtsPath = BUILTIN_DEBUG_DTS[moduleName];
        if (!dtsPath) continue;
        const lib = readDebugDts(dtsPath);
        if (lib) libs.push(lib);
    }

    for (const skill of listSkillEntries()) {
        const content = readTextIfExists(join(SKILLS_ROOT, skill.id, skill.dtsFileName));
        if (content) {
            libs.push({
                path: `file:///codeact-debug/skills/${skill.id}/${skill.dtsFileName}`,
                content,
            });
        }
    }

    return libs;
}

function buildMetaDebugTypeLibs(): Array<{ path: string; content: string }> {
    const dirPath = join(process.cwd(), "src", "meta-sandbox", "meta-api", "modules");
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
        .filter((file) => file.endsWith(".d.ts"))
        .sort()
        .map((file) => ({
            path: `file:///codeact-debug/meta/${file}`,
            content: readTextIfExists(join(dirPath, file)),
        }))
        .filter((lib) => lib.content.length > 0);
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

function previewText(value: unknown, limit = 180): string {
    let text: string;
    if (typeof value === "string") {
        text = value;
    } else {
        try {
            text = JSON.stringify(value);
        } catch {
            text = String(value ?? "");
        }
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function buildGlobalStateSummary(state: Readonly<MainAgentGlobalState>): Record<string, unknown> {
    const schedulerEvents = state.schedulerEvents ?? [];
    const reminders = schedulerEvents.filter((event) => event.type === "reminder");
    const crons = schedulerEvents.filter((event) => event.type === "cron");
    const activeReminders = reminders.filter((event) => !event.triggered);
    const triggeredReminders = reminders.length - activeReminders.length;
    const memos = state.memos ?? [];
    const sessionDigests = state.sessionDigests ?? [];
    const metaSessionHistory = state.metaSessionHistory ?? [];
    const signalPool = state.signalPool ?? [];
    const wakeConditions = state.wakeConditions ?? [];
    const dispatchedSubagentTasks = state.dispatchedSubagentTasks ?? [];
    const taskStatusCounts = dispatchedSubagentTasks.reduce<Record<string, number>>((counts, task) => {
        counts[task.status] = (counts[task.status] ?? 0) + 1;
        return counts;
    }, {});

    return {
        generatedAt: new Date().toISOString(),
        sections: [
            {
                key: "schedulerEvents",
                label: "调度事件",
                count: schedulerEvents.length,
                detail: `${activeReminders.length} active reminders, ${triggeredReminders} triggered, ${crons.length} crons`,
            },
            {
                key: "memos",
                label: "全局备忘录",
                count: memos.length,
                detail: `${memos.filter((memo) => !!memo.expiresAt).length} with expiry`,
            },
            {
                key: "sessionDigests",
                label: "Session Digests",
                count: sessionDigests.length,
            },
            {
                key: "metaSessionHistory",
                label: "Meta History",
                count: metaSessionHistory.length,
                detail: getMetaHistoryWindowStatus(metaSessionHistory).currentChars + " chars",
            },
            {
                key: "signalPool",
                label: "Signal Pool",
                count: signalPool.length,
            },
            {
                key: "wakeConditions",
                label: "Wake Conditions",
                count: wakeConditions.length,
            },
            {
                key: "dispatchedSubagentTasks",
                label: "Dispatch Tasks",
                count: dispatchedSubagentTasks.length,
                detail: Object.entries(taskStatusCounts).map(([status, count]) => `${status}:${count}`).join(", "),
            },
        ],
        recent: {
            memos: memos.slice(-5).reverse().map((memo) => ({
                key: memo.key,
                createdAt: memo.createdAt,
                expiresAt: memo.expiresAt,
                value: previewText(memo.value),
            })),
            sessionDigests: sessionDigests.slice(-5).reverse().map((digest) => ({
                createdAt: digest.createdAt,
                content: previewText(digest.content),
            })),
            metaSessionHistory: metaSessionHistory.slice(-5).reverse().map((entry) => ({
                role: entry.role,
                timestamp: entry.timestamp,
                content: previewText(entry.content),
            })),
            dispatchedSubagentTasks: dispatchedSubagentTasks.slice(-5).reverse().map((task) => ({
                taskId: task.taskId,
                chatId: task.chatId,
                status: task.status,
                updatedAt: task.updatedAt,
                summary: previewText(task.summary ?? task.error ?? task.contentDirection),
            })),
        },
    };
}

function getSchedulerBindingId(event: SchedulerEvent): string {
    return event.bindingId ?? (event.chatId === "__meta__" ? "meta" : event.chatId);
}

function serializeSchedulerEvent(event: SchedulerEvent): Record<string, unknown> {
    const callback = event.callback ?? event.taskTemplate ?? event.description;
    return {
        id: event.id,
        type: event.type,
        chatId: event.chatId,
        bindingId: getSchedulerBindingId(event),
        name: event.name ?? event.description,
        description: event.description,
        callback,
        data: event.data,
        triggerAt: event.triggerAt,
        triggered: !!event.triggered,
        cronExpr: event.cronExpr,
        taskTemplate: event.taskTemplate,
        lastTriggeredAt: event.lastTriggeredAt,
        createdAt: event.createdAt,
        requestedBy: event.requestedBy,
    };
}

function normalizeTodoBindingId(value: unknown): string {
    const bindingId = String(value ?? "").trim();
    return bindingId || "meta";
}

function requireTodoBindingId(value: unknown): string {
    const bindingId = String(value ?? "").trim();
    if (!bindingId) {
        throw new Error("bindingId 不能为空");
    }
    return bindingId;
}

function requiredString(value: unknown, fieldName: string): string {
    const text = String(value ?? "").trim();
    if (!text) throw new Error(`${fieldName} 不能为空`);
    return text;
}

export function createApiRouter(deps: DashboardDeps, bridge: EventBridge): Router {
    const router = Router();

    // ─── Overview ───
    router.get("/overview", (_req, res) => {
        res.json(bridge.buildSnapshot());
    });

    // ─── Subagent Task History ───
    router.get("/subagent-tasks", (req, res) => {
        const limit = Math.min(parseInt(qs(req.query.limit)) || 50, 200);
        const offset = Math.max(parseInt(qs(req.query.offset)) || 0, 0);
        const chatId = qs(req.query.chatId) || undefined;
        const status = qs(req.query.status) || undefined;
        res.json(deps.globalState.listDispatchedSubagentTasks({ chatId, status, limit, offset }));
    });

    router.get("/subagent-tasks/:taskId", (req, res) => {
        const task = deps.globalState.getDispatchedSubagentTask(req.params.taskId);
        if (!task) {
            res.status(404).json({ error: "task not found" });
            return;
        }
        res.json(task);
    });

    // ─── Skills ───
    router.get("/skills", (_req, res) => {
        try {
            const discovered = new Set(discoverSkills().map((skill) => skill.id));
            const skills = listSkillEntries().map((skill) => ({
                ...skill,
                loaded: discovered.has(skill.id),
            }));
            res.json({ skills });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.get("/skills/:skillId", (req, res) => {
        try {
            const skillId = ensureSkillId(req.params.skillId);
            const info = listSkillEntries().find((skill) => skill.id === skillId) ?? {
                id: skillId,
                entryFileName: "index.ts" as const,
                dtsFileName: `${skillId}.d.ts`,
                hasSkillMd: false,
            };
            const skillDir = join(SKILLS_ROOT, skillId);
            const entryPath = join(skillDir, info.entryFileName);
            const dtsPath = join(skillDir, info.dtsFileName);
            const skillMdPath = join(skillDir, "SKILL.md");

            res.json({
                skill: {
                    id: skillId,
                    entryFileName: info.entryFileName,
                    dtsFileName: info.dtsFileName,
                    files: {
                        entry: {
                            path: info.entryFileName,
                            exists: fs.existsSync(entryPath),
                            content: readTextIfExists(entryPath),
                        },
                        dts: {
                            path: info.dtsFileName,
                            exists: fs.existsSync(dtsPath),
                            content: readTextIfExists(dtsPath),
                        },
                        skillMd: {
                            path: "SKILL.md",
                            exists: fs.existsSync(skillMdPath),
                            content: readTextIfExists(skillMdPath),
                        },
                    },
                },
            });
        } catch (err) {
            res.status(400).json({ error: String(err) });
        }
    });

    router.put("/skills/:skillId", (req, res) => {
        try {
            const skillId = ensureSkillId(req.params.skillId);
            const entryFileName = req.body?.entryFileName === "index.js" ? "index.js" : "index.ts";
            const dtsFileNameRaw = typeof req.body?.dtsFileName === "string" ? req.body.dtsFileName.trim() : `${skillId}.d.ts`;
            const dtsFileName = dtsFileNameRaw.endsWith(".d.ts") ? dtsFileNameRaw : `${skillId}.d.ts`;
            const entryContent = typeof req.body?.entryContent === "string" ? req.body.entryContent : "";
            const dtsContent = typeof req.body?.dtsContent === "string" ? req.body.dtsContent : "";
            const skillMdContent = typeof req.body?.skillMdContent === "string" ? req.body.skillMdContent : "";
            const skillDir = join(SKILLS_ROOT, skillId);

            fs.mkdirSync(skillDir, { recursive: true });
            fs.writeFileSync(join(skillDir, entryFileName), entryContent, "utf-8");
            fs.writeFileSync(join(skillDir, dtsFileName), dtsContent, "utf-8");
            fs.writeFileSync(join(skillDir, "SKILL.md"), skillMdContent, "utf-8");

            log.info("Skill 文件已保存", { skillId, entryFileName, dtsFileName });
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: String(err) });
        }
    });

    router.post("/skills/reload", async (_req, res) => {
        try {
            const activeSandboxes = deps.sandboxPool.entries();
            const results = await Promise.all(activeSandboxes.map(async ({ chatId, sandbox }) => {
                try {
                    const result = await sandbox.execute("const loaded = await skills.reload(); console.log(JSON.stringify(loaded));", 15000);
                    if (result.error) {
                        return { chatId, ok: false, error: result.output };
                    }
                    return { chatId, ok: true };
                } catch (err) {
                    return { chatId, ok: false, error: String(err) };
                }
            }));
            refreshModuleRegistryCache();

            res.json({
                ok: true,
                activeSandboxCount: activeSandboxes.length,
                reloadedSkills: discoverSkills().map((skill) => ({
                    id: skill.id,
                    bindingName: skill.bindingName,
                    path: skill.path,
                })),
                sandboxResults: results,
            });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
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
                }));
            } catch { }
        } else {
            // Fallback to getTopicsSince if db not directly accessible
            const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
            try { historyTopics = deps.memory.getTopicsSince(chatId, since); } catch { }
        }

        // Merge: pipeline topics first, then history topics not already in pipeline
        const allTopics: Record<string, unknown>[] = pipelineTopics.map((t: any) => {
            const hist = historyTopics.find((h: any) => h.pipelineTopicId === t.id);
            return {
                ...serializeTopic(t),
                source: "pipeline",
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
            } catch { }

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
                associatedMemories: parseJSON(topicRow.associated_memories),
                callbackPotential: Number(topicRow.callback_potential ?? 0),
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

    // ─── Attention Queue ───
    router.get("/queue", (_req, res) => {
        res.json(deps.accumulator.getSnapshot());
    });

    router.post("/queue/enqueue", (req, res) => {
        const { chatId, priority, note } = req.body;
        if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }
        const sub = deps.subagentManager.get(chatId);
        if (!sub) { res.status(404).json({ error: "chat not found" }); return; }
        deps.accumulator.ingest(0, {
            chatId,
            source: "DIRECT_ADDRESS",
            payload: { reason: typeof note === "string" && note.trim() ? `dashboard-manual: ${note.trim()}` : "dashboard-manual" },
            enqueuedAt: Date.now(),
            pressure: Number(priority) || 0,
        });
        bridge.broadcast({ type: "queue:update", timestamp: new Date().toISOString(), data: deps.accumulator.getSnapshot() });
        log.info("手动注入 accumulator", { chatId, priority, note: typeof note === "string" ? note.slice(0, 200) : undefined });
        res.json({ ok: true });
    });

    router.post("/queue/boost", (req, res) => {
        const { chatId, amount } = req.body;
        if (!chatId) { res.status(400).json({ error: "chatId required" }); return; }
        deps.accumulator.ingest(0, {
            chatId,
            source: "DIRECT_ADDRESS",
            payload: { reason: "dashboard-boost" },
            enqueuedAt: Date.now(),
            pressure: Number(amount) || 20,
        });
        bridge.broadcast({ type: "queue:update", timestamp: new Date().toISOString(), data: deps.accumulator.getSnapshot() });
        res.json({ ok: true });
    });

    router.delete("/queue/:chatId", (req, res) => {
        deps.accumulator.remove(req.params.chatId);
        bridge.broadcast({ type: "queue:update", timestamp: new Date().toISOString(), data: deps.accumulator.getSnapshot() });
        res.json({ ok: true });
    });

    // ─── Decisions & GlobalState ───
    router.get("/decisions", (_req, res) => {
        res.json(
            deps.globalState.getSessionDigests().map((digest) => ({
                chatId: "__meta__",
                decision: digest.content,
                content: digest.content,
                timestamp: digest.createdAt,
            }))
        );
    });

    router.get("/global-state/summary", (_req, res) => {
        res.json(buildGlobalStateSummary(deps.globalState.getState()));
    });

    router.get("/global-state", (_req, res) => {
        res.json(deps.globalState.getState());
    });

    // ─── Scheduler Events ───
    router.get("/scheduler", (_req, res) => {
        const events = deps.globalState.getSchedulerEvents();
        const reminders = events.filter(e => e.type === "reminder");
        const crons = events.filter(e => e.type === "cron");
        res.json({
            reminders: reminders.map(serializeSchedulerEvent),
            crons: crons.map(serializeSchedulerEvent),
            summary: {
                totalReminders: reminders.length,
                activeReminders: reminders.filter(e => !e.triggered).length,
                triggeredReminders: reminders.filter(e => e.triggered).length,
                totalCrons: crons.length,
            },
        });
    });

    router.put("/scheduler/:id", async (req, res) => {
        try {
            const event = deps.globalState.getSchedulerEvents().find((item) => item.id === req.params.id);
            if (!event) {
                res.status(404).json({ error: "scheduler event not found" });
                return;
            }

            const body = req.body ?? {};
            const schedulerPatch: { name?: string; callback?: string; bindingId?: string; data?: unknown } = {};
            const currentBindingId = getSchedulerBindingId(event);
            const currentCallback = event.callback ?? event.taskTemplate ?? event.description;
            if (Object.prototype.hasOwnProperty.call(body, "name") && body.name !== (event.name ?? event.description)) {
                schedulerPatch.name = body.name;
            }
            if (Object.prototype.hasOwnProperty.call(body, "callback") && body.callback !== currentCallback) {
                schedulerPatch.callback = body.callback;
            }
            if (Object.prototype.hasOwnProperty.call(body, "bindingId") && body.bindingId !== currentBindingId) {
                schedulerPatch.bindingId = body.bindingId;
            }
            if (Object.prototype.hasOwnProperty.call(body, "data")) schedulerPatch.data = body.data;

            let updated: unknown;
            if (event.type === "reminder") {
                const reminderPatch: typeof schedulerPatch & { triggerAt?: string | number | Date } = { ...schedulerPatch };
                if (Object.prototype.hasOwnProperty.call(body, "triggerAt")) reminderPatch.triggerAt = body.triggerAt;
                updated = await createReminderApi(deps.globalState).update(event.id, reminderPatch);
            } else {
                const cronPatch: typeof schedulerPatch & { cronExpr?: string } = { ...schedulerPatch };
                if (Object.prototype.hasOwnProperty.call(body, "cronExpr")) cronPatch.cronExpr = body.cronExpr;
                updated = await createCronApi(deps.globalState).update(event.id, cronPatch);
            }

            if (!updated) {
                res.status(404).json({ error: "scheduler event not found" });
                return;
            }

            deps.globalState.save();
            res.json({ ok: true, event: updated });
        } catch (err) {
            res.status(400).json({ error: String(err) });
        }
    });

    router.delete("/scheduler/:id", (req, res) => {
        const ok = deps.globalState.cancelSchedulerEvent(req.params.id);
        if (ok) deps.globalState.save();
        res.json({ ok });
    });

    // ─── Todo Rules ───
    router.get("/todos", async (req, res) => {
        try {
            const rawBindingId = qs(req.query.bindingId).trim();
            const bindingId = rawBindingId ? normalizeTodoBindingId(rawBindingId) : undefined;
            const includeExpired = qs(req.query.includeExpired) === "true";
            const items = bindingId
                ? deps.memory.todoList(bindingId, { includeExpired }).map((item) => ({ bindingId, ...item }))
                : await createTodoApi(deps.memory).list({ includeExpired });
            res.json({
                items,
                summary: {
                    bindingId: bindingId ?? "all",
                    total: items.length,
                    expired: items.filter((item) => item.expired).length,
                },
            });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.put("/todos", async (req, res) => {
        try {
            const body = req.body ?? {};
            const oldBindingId = body.oldKey ? requireTodoBindingId(body.oldBindingId ?? body.bindingId) : "";
            const oldKey = String(body.oldKey ?? "").trim();
            const bindingId = requireTodoBindingId(body.bindingId);
            const key = requiredString(body.key, "key");
            const content = requiredString(body.content, "content");
            const api = createTodoApi(deps.memory);
            const hasDueAt = Object.prototype.hasOwnProperty.call(body, "dueAt");
            const dueAt = hasDueAt ? body.dueAt : undefined;
            const todoPatch: { bindingId: string; key: string; content: string; dueAt?: string | number | Date | null; forever?: boolean } = {
                bindingId,
                key,
                content,
            };
            if (hasDueAt) todoPatch.dueAt = dueAt;
            if (Object.prototype.hasOwnProperty.call(body, "forever")) todoPatch.forever = body.forever === true;

            const item = oldKey
                ? await api.update(oldKey, todoPatch, oldBindingId)
                : await api.set({ bindingId, key, content, dueAt, forever: body.forever === true });
            if (!item) {
                res.status(404).json({ error: "todo not found" });
                return;
            }
            res.json({ ok: true, item });
        } catch (err) {
            res.status(400).json({ error: String(err) });
        }
    });

    router.delete("/todos", (req, res) => {
        try {
            const bindingId = requireTodoBindingId(req.body?.bindingId);
            const key = requiredString(req.body?.key, "key");
            deps.memory.todoRemove(bindingId, key);
            res.json({ ok: true });
        } catch (err) {
            res.status(400).json({ error: String(err) });
        }
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

    // ─── Memory: Message Log CRUD ───
    router.get("/memory/messages", (req, res) => {
        try {
            const chatId = qs(req.query.chatId) || undefined;
            const userId = qs(req.query.userId) || undefined;
            const keyword = qs(req.query.keyword) || undefined;
            const limit = req.query.limit ? Math.min(Number(req.query.limit), 200) : 50;
            const offset = req.query.offset ? Number(req.query.offset) : 0;
            const result = deps.memory.listMessages({ chatId, userId, keyword, limit, offset });
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.put("/memory/message/:chatId/:messageId", (req, res) => {
        try {
            const { chatId, messageId } = req.params;
            const { text, displayName } = req.body;
            const ok = deps.memory.updateMessage(chatId, messageId, { text, displayName });
            res.json({ ok });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.delete("/memory/messages", (req, res) => {
        try {
            const { chatId, messageIds } = req.body;
            if (!chatId || !Array.isArray(messageIds)) {
                res.status(400).json({ error: "chatId and messageIds[] required" });
                return;
            }
            const deleted = deps.memory.deleteMessages(chatId, messageIds);
            res.json({ ok: true, deleted });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // ─── CodeAct ───
    router.get("/codeact/:chatId", (req, res) => {
        if (req.params.chatId === META_CODEACT_CHAT_ID) {
            res.json({
                ...getMetaCodeActState(),
                historyBudget: getMetaHistoryWindowStatus(deps.globalState.getMetaSessionHistory()),
            });
            return;
        }

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

    router.get("/codeact/:chatId/debug-types", (req, res) => {
        try {
            const chatId = req.params.chatId;
            const libs = chatId === META_CODEACT_CHAT_ID
                ? buildMetaDebugTypeLibs()
                : buildSubagentDebugTypeLibs(chatId);
            res.json({ libs });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.post("/codeact/:chatId/debug-execute", async (req, res) => {
        const chatId = req.params.chatId;
        const code = typeof req.body?.code === "string" ? req.body.code : "";
        const timeoutMs = normalizeDebugTimeout(req.body?.timeoutMs);
        const lockKey = chatId === META_CODEACT_CHAT_ID ? "meta" : `subagent:${chatId}`;
        const startedAt = new Date().toISOString();
        const startTime = Date.now();

        if (!code.trim()) {
            res.status(400).json({ ok: false, error: "code is required" });
            return;
        }
        if (!acquireDebugLock(lockKey)) {
            res.status(409).json({ ok: false, error: "debug execution already running" });
            return;
        }

        try {
            if (chatId === META_CODEACT_CHAT_ID) {
                const state = getMetaCodeActState();
                if (state.isProcessing) {
                    res.status(409).json({ ok: false, error: "meta codeact is processing" });
                    return;
                }
                if (!deps.metaSandbox) {
                    res.status(503).json({ ok: false, error: "meta sandbox is not available" });
                    return;
                }

                const result = await deps.metaSandbox.execute(code, { timeoutMs });
                res.json({
                    ok: !result.error,
                    chatId,
                    target: "meta",
                    output: result.output,
                    error: result.error,
                    logs: result.logs,
                    timeoutMs,
                    startedAt,
                    completedAt: new Date().toISOString(),
                    durationMs: Date.now() - startTime,
                });
                return;
            }

            const sub = deps.subagentManager.get(chatId);
            if (!sub) {
                res.status(404).json({ ok: false, error: "chat not found" });
                return;
            }
            const executor = sub.codeActExecutor as CodeActExecutor | null;
            if (executor?.isProcessing()) {
                res.status(409).json({ ok: false, error: "codeact is processing" });
                return;
            }

            const sandbox = await deps.sandboxPool.acquire(chatId);
            try {
                const platform = getPlatform(chatId);
                const cfg = loadConfig("config.yaml", true);
                const deduplicateSentMessages = cfg.subagent?.deduplicateSentMessages !== false;
                const bannedWords = cfg.subagent?.bannedWords ?? DEFAULT_BANNED_WORDS;
                await sandbox.execute(`__setPlatform(${JSON.stringify(platform)})`, 5_000);
                await sandbox.execute(`__setDuplicateMessageBlocking(${JSON.stringify(deduplicateSentMessages)})`, 5_000);
                await sandbox.execute(`__setBannedWords(${JSON.stringify(bannedWords)})`, 5_000);

                const result = await sandbox.execute(code, timeoutMs);
                res.json({
                    ok: !result.error,
                    chatId,
                    target: "subagent",
                    output: result.output,
                    error: result.error,
                    timeoutMs,
                    startedAt,
                    completedAt: new Date().toISOString(),
                    durationMs: Date.now() - startTime,
                });
            } finally {
                deps.sandboxPool.release(chatId);
            }
        } catch (err) {
            res.status(200).json({
                ok: false,
                chatId,
                target: chatId === META_CODEACT_CHAT_ID ? "meta" : "subagent",
                output: err instanceof Error ? err.stack ?? err.message : String(err),
                error: true,
                timeoutMs,
                startedAt,
                completedAt: new Date().toISOString(),
                durationMs: Date.now() - startTime,
            });
        } finally {
            releaseDebugLock(lockKey);
        }
    });

    router.post("/codeact/:chatId/cancel", async (req, res) => {
        const chatId = req.params.chatId;
        if (chatId === META_CODEACT_CHAT_ID) {
            const ok = requestCancelMetaCodeActSession();
            res.json({
                ok: true,
                message: ok
                    ? "Meta execution cancel requested"
                    : "No active Meta execution",
            });
            return;
        }

        try {
            const sub = deps.subagentManager.get(chatId);
            const executor = sub?.codeActExecutor as CodeActExecutor | null;

            if (executor) {
                await executor.cancelCurrentRun();
            } else {
                await deps.sandboxPool.destroy(chatId);
            }

            deps.accumulator.unblock(chatId);
            log.info("CodeAct 手动取消", { chatId });
            res.json({ ok: true, message: "Execution cancel requested, queue cleared and sandbox destroyed" });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.post("/codeact/:chatId/reset-session", (req, res) => {
        if (req.params.chatId === META_CODEACT_CHAT_ID) {
            const state = getMetaCodeActState();
            if (state.isProcessing) {
                res.status(409).json({ error: "meta codeact is processing, cancel it before resetting session" });
                return;
            }

            resetMetaCodeActState();
            const clearedHistory = deps.globalState.clearMetaSessionHistory();
            const clearedDigests = deps.globalState.clearSessionDigests();
            const resetContext = deps.mainLoop.resetMetaSessionContext();
            deps.globalState.save();
            log.info("Meta CodeAct session 已重置", { clearedHistory, clearedDigests, resetContext });
            res.json({
                ok: true,
                message: "Meta session cleared",
                clearedHistory,
                clearedDigests,
                resetContext,
            });
            return;
        }

        const sub = deps.subagentManager.get(req.params.chatId);
        if (!sub) { res.status(404).json({ error: "chat not found" }); return; }
        const executor = sub.codeActExecutor as CodeActExecutor | null;
        if (!executor) { res.status(400).json({ error: "no codeact executor" }); return; }
        if (executor.isProcessing()) {
            res.status(409).json({ error: "codeact is processing, cancel it before resetting session" });
            return;
        }

        executor.clearSession();
        log.info("CodeAct session 已重置", { chatId: req.params.chatId });
        res.json({ ok: true, message: "Session cleared" });
    });

    // ─── Recording Pipeline ───
    router.get("/recording/:chatId", (req, res) => {
        const sub = deps.subagentManager.get(req.params.chatId);
        if (!sub) { res.status(404).json({ error: "chat not found" }); return; }
        const pipeline = (sub as any).recordingPipeline;
        if (!pipeline) { res.json({ bufferSize: 0, isEagerMode: false, isFlushing: false, disposed: true }); return; }
        res.json(pipeline.getStatus());
    });

    // ─── Sandbox Pool ───
    router.get("/sandbox/pool", (_req, res) => {
        res.json(deps.sandboxPool.getStats());
    });

    // ─── Manual Flush / Reflection ───
    router.post("/recording/flush/:chatId", (req, res) => {
        const sub = deps.subagentManager.get(req.params.chatId);
        if (!sub) { res.status(404).json({ error: "chat not found" }); return; }
        if (!sub.recordingPipeline) { res.status(400).json({ error: "no recording pipeline" }); return; }
        sub.recordingPipeline.flush().then(() => {
            log.info("手动 flush 完成", { chatId: req.params.chatId });
            res.json({ ok: true });
        }).catch(err => {
            log.error("手动 flush 失败", { chatId: req.params.chatId, error: String(err) });
            res.status(500).json({ error: String(err) });
        });
    });

    router.post("/reflection/:chatId", async (req, res) => {
        const chatId = req.params.chatId;
        try {
            const config = loadConfig();
            const { resolveComponentProfiles } = await import("../core/config.js");
            const reflectionLlmConfigs = resolveComponentProfiles("reflection", config);
            const result = await deps.memory.reflect(chatId, reflectionLlmConfigs, config.reflection);
            log.info("手动 Reflection 完成", { chatId, personUpdates: result.personUpdates.length, newFacts: result.newCoreFacts.length });
            res.json({ ok: true, ...result });
        } catch (err) {
            log.error("手动 Reflection 失败", { chatId, error: String(err) });
            res.status(500).json({ error: String(err) });
        }
    });

    // ─── Dispatch tracking summary (details live in todo/remind) ───
    router.get("/dispatch-tracking", (_req, res) => {
        res.json({ activeWindows: [] });
    });

    // ─── Callbacks (Q5) ───
    router.get("/callbacks", (_req, res) => {
        res.json(deps.q5.peek());
    });

    // ─── Sticker Management ───
    router.get("/stickers", (req, res) => {
        const searchQuery = qs(req.query.q).trim();
        const allStickers = deps.memory.getAllStickerDescriptions();
        const searchTerms = parseStickerSearchTerms(searchQuery);
        const matchedIds = searchQuery
            ? new Set(
                searchTerms.length > 0
                    ? deps.memory.searchStickersByEmoji(searchTerms, Math.max(allStickers.length, 1)).map(item => item.uniqueFileId)
                    : []
            )
            : null;
        const stickers = matchedIds
            ? allStickers.filter(sticker => matchedIds.has(sticker.uniqueFileId))
            : allStickers;
        // Dynamic sticker previews are rendered by /stickers/:id/image.
        const result = stickers.map(s => {
            const filePath = deps.mediaDownloader?.getExistingPath(s.uniqueFileId);
            const kind = stickerFileKind(filePath ?? undefined);
            return {
                ...s,
                hasImage: !!filePath,
                stickerKind: kind,
            };
        });
        res.json(result);
    });

    router.get("/stickers/:uniqueFileId/image", async (req, res) => {
        if (!deps.mediaDownloader) { res.status(404).json({ error: "mediaDownloader not available" }); return; }
        const filePath = deps.mediaDownloader.getExistingPath(req.params.uniqueFileId);
        if (!filePath || !fs.existsSync(filePath)) { res.status(404).json({ error: "sticker image not found" }); return; }
        try {
            res.setHeader("Cache-Control", "public, max-age=86400");
            if (stickerFileKind(filePath) === "animated") {
                const preview = await renderDynamicStickerPreview(filePath);
                res.setHeader("Content-Type", "image/png");
                res.end(preview);
                return;
            }
            res.setHeader("Content-Type", stickerContentType(filePath));
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
        const { description, emoji, enabled } = req.body;
        if (!description) { res.status(400).json({ error: "description required" }); return; }
        const ok = deps.memory.updateStickerDescription(req.params.uniqueFileId, description, emoji, enabled);
        res.json({ ok });
    });

    router.patch("/stickers/batch-enabled", (req, res) => {
        const { enabled, uniqueFileIds } = req.body;
        if (enabled === undefined) { res.status(400).json({ error: "enabled required" }); return; }
        // 如果提供了 uniqueFileIds 则只更新指定的，否则更新全部
        if (Array.isArray(uniqueFileIds)) {
            let count = 0;
            for (const id of uniqueFileIds) {
                if (deps.memory.setStickerEnabled(id, !!enabled)) count++;
            }
            res.json({ ok: true, count });
        } else {
            // 全部更新
            const all = deps.memory.getAllStickerDescriptions();
            let count = 0;
            for (const s of all) {
                if (deps.memory.setStickerEnabled(s.uniqueFileId, !!enabled)) count++;
            }
            res.json({ ok: true, count });
        }
    });

    router.patch("/stickers/:uniqueFileId/enabled", (req, res) => {
        const { enabled } = req.body;
        if (enabled === undefined) { res.status(400).json({ error: "enabled required" }); return; }
        const ok = deps.memory.setStickerEnabled(req.params.uniqueFileId, !!enabled);
        res.json({ ok });
    });

    // ─── Image Catalog (表情包频率追踪) ───

    router.get("/image-catalog/stats", (_req, res) => {
        if (!deps.imageCatalog) { res.status(404).json({ error: "imageCatalog not available" }); return; }
        res.json(deps.imageCatalog.getStats());
    });

    router.get("/image-catalog", (req, res) => {
        if (!deps.imageCatalog) { res.status(404).json({ error: "imageCatalog not available" }); return; }
        const limit = Math.min(parseInt(qs(req.query.limit)) || 50, 200);
        const offset = parseInt(qs(req.query.offset)) || 0;
        const filter = qs(req.query.filter);
        let result;
        if (filter === "pending") {
            const items = deps.imageCatalog.getPendingStickerCandidates(1);
            result = { items, total: items.length };
        } else if (filter === "stickers") {
            const items = deps.imageCatalog.getStickerEntries();
            result = { items, total: items.length };
        } else {
            result = deps.imageCatalog.getAllEntries(limit, offset);
        }
        res.json(result);
    });

    router.get("/image-catalog/:contentHash/image", (req, res) => {
        if (!deps.imageCatalog) { res.status(404).json({ error: "imageCatalog not available" }); return; }
        const entry = deps.imageCatalog.getByContentHash(req.params.contentHash);
        if (!entry?.filePath || !fs.existsSync(entry.filePath)) {
            res.status(404).json({ error: "image not found" });
            return;
        }
        try {
            const ext = entry.filePath.toLowerCase();
            const contentType = ext.endsWith(".png") ? "image/png"
                : ext.endsWith(".jpg") || ext.endsWith(".jpeg") ? "image/jpeg"
                : ext.endsWith(".gif") ? "image/gif"
                : "image/webp";
            res.setHeader("Content-Type", contentType);
            res.setHeader("Cache-Control", "public, max-age=86400");
            fs.createReadStream(entry.filePath).pipe(res);
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    router.patch("/image-catalog/:contentHash/verdict", (req, res) => {
        if (!deps.imageCatalog) { res.status(404).json({ error: "imageCatalog not available" }); return; }
        const { isSticker, description, emoji } = req.body;
        if (isSticker === undefined) { res.status(400).json({ error: "isSticker required" }); return; }
        deps.imageCatalog.setStickerVerdict({
            contentHash: req.params.contentHash,
            isSticker: !!isSticker,
            description,
            emoji,
        });
        if (isSticker && deps.mediaDownloader && deps.memory) {
            const entry = deps.imageCatalog.getByContentHash(req.params.contentHash);
            if (entry?.filePath && fs.existsSync(entry.filePath)) {
                try {
                    const rawBuffer = fs.readFileSync(entry.filePath);
                    const saved = deps.mediaDownloader.saveMedia(rawBuffer, {
                        chatId: entry.sourceChatId ?? undefined,
                        uniqueFileId: entry.uniqueFileId ?? entry.contentHash,
                        mediaType: "sticker",
                        mimeType: entry.mimeType ?? "image/jpeg",
                    });
                    if (saved) {
                        const newStickerEnabledByDefault = loadConfig().vision?.newStickerDefault !== "disabled";
                        deps.memory.setStickerDescription(
                            entry.uniqueFileId ?? entry.contentHash,
                            description ?? "",
                            emoji,
                            newStickerEnabledByDefault,
                            saved.contentHash ?? entry.contentHash,
                        );
                        deps.imageCatalog.markPromoted(
                            entry.contentHash,
                            entry.uniqueFileId ?? entry.contentHash,
                            saved.path,
                        );
                    }
                } catch (err) {
                    log.warn("手动提升贴纸失败", { contentHash: req.params.contentHash, error: String(err) });
                }
            }
        }
        res.json({ ok: true });
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

    // ─── LLM Logs (paginated + export) ───
    router.get("/llm-logs", (_req, res) => {
        const limit = Math.min(parseInt(qs(_req.query.limit)) || 30, 100);
        const offset = Math.max(parseInt(qs(_req.query.offset)) || 0, 0);
        const result = bridge.llmLogBuffer.getPage(offset, limit);
        res.json(result);
    });

    router.get("/llm-logs/export/stats", (_req, res) => {
        const from = qs(_req.query.from);
        const to = qs(_req.query.to);
        if (!from || !to) {
            res.status(400).json({ error: "from and to query params required (ISO datetime)" });
            return;
        }
        const csv = bridge.llmLogBuffer.exportStatsCSV(from, to);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="llm-stats-${from.slice(0, 10)}_${to.slice(0, 10)}.csv"`);
        res.send(csv);
    });

    router.get("/llm-logs/export/full", (_req, res) => {
        const from = qs(_req.query.from);
        const to = qs(_req.query.to);
        if (!from || !to) {
            res.status(400).json({ error: "from and to query params required (ISO datetime)" });
            return;
        }
        const logs = bridge.llmLogBuffer.exportFullLogs(from, to);

        // 构建 tar.gz 格式（使用 Node.js 内置 zlib）
        import("node:zlib").then(async ({ createGzip }) => {
            const { Readable } = await import("node:stream");

            // 简易 tar 格式：每个文件一个 512 字节头 + 内容（512 对齐）
            const chunks: Buffer[] = [];
            for (const entry of logs) {
                const content = JSON.stringify(entry, null, 2);
                const buf = Buffer.from(content, "utf-8");
                const name = `llm-logs/${entry.callId}.json`;

                // tar header (512 bytes)
                const header = Buffer.alloc(512);
                header.write(name.slice(0, 100), 0, 100);                            // name
                header.write("0000644\0", 100, 8);                                     // mode
                header.write("0001000\0", 108, 8);                                     // uid
                header.write("0001000\0", 116, 8);                                     // gid
                header.write(buf.length.toString(8).padStart(11, "0") + "\0", 124, 12); // size
                const mtime = Math.floor(new Date(entry.timestamp).getTime() / 1000);
                header.write(mtime.toString(8).padStart(11, "0") + "\0", 136, 12);     // mtime
                header.write("        ", 148, 8);                                       // checksum placeholder
                header[156] = 0x30;                                                     // typeflag '0' = regular file

                // Calculate checksum
                let chksum = 0;
                for (let i = 0; i < 512; i++) chksum += header[i];
                header.write(chksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);

                chunks.push(header);
                chunks.push(buf);
                // Pad to 512 boundary
                const padding = 512 - (buf.length % 512);
                if (padding < 512) chunks.push(Buffer.alloc(padding));
            }
            // End of archive (two 512-byte zero blocks)
            chunks.push(Buffer.alloc(1024));

            const tarBuf = Buffer.concat(chunks);

            res.setHeader("Content-Type", "application/gzip");
            res.setHeader("Content-Disposition", `attachment; filename="llm-logs-${from.slice(0, 10)}_${to.slice(0, 10)}.tar.gz"`);

            const gzip = createGzip();
            const source = Readable.from(tarBuf);
            source.pipe(gzip).pipe(res);
        }).catch(err => {
            res.status(500).json({ error: String(err) });
        });
    });

    router.get("/llm-logs/:callId", (req, res) => {
        const entry = bridge.llmLogBuffer.getByCallId(req.params.callId);
        if (!entry) {
            res.status(404).json({ error: "log not found" });
            return;
        }
        res.json(entry);
    });

    // ─── Token Stats ───
    router.get("/token-stats", (req, res) => {
        const groupBy = qs(req.query.groupBy) || "model";
        const period = qs(req.query.period) || "all";
        const from = qs(req.query.from) || undefined;
        const to = qs(req.query.to) || undefined;
        const sortBy = qs(req.query.sortBy) || "cost";
        const sortDir = qs(req.query.sortDir) || "desc";
        const filterModel = qs(req.query.filterModel) || undefined;
        const filterCaller = qs(req.query.filterCaller) || undefined;
        res.json(deps.tokenStats.query({
            groupBy: groupBy as any,
            period: period as any,
            from,
            to,
            sortBy: sortBy as any,
            sortDir: sortDir as any,
            filterModel,
            filterCaller,
        }));
    });

    router.get("/token-stats/meta", (_req, res) => {
        res.json(deps.tokenStats.listMeta());
    });

    router.post("/token-stats/reset", (_req, res) => {
        deps.tokenStats.reset();
        log.info("Token 统计已清零");
        res.json({ ok: true });
    });

    router.get("/token-pricing", (_req, res) => {
        res.json(deps.tokenStats.getPricing() ?? {});
    });

    // ─── Rate Limiter Stats ───
    router.get("/rate-limiter/stats", (_req, res) => {
        res.json(rateLimiter.getStats());
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

    router.put("/config", async (req, res) => {
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
            if (deps.onConfigSaved) {
                await deps.onConfigSaved(newConfig);
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
            const isGoogle = profile.provider === "google";
            const resolvedProject = profile.vertexProject
                ?? (profile.vertexCredentials?.project_id as string | undefined);
            const hasVertexProject = !!resolvedProject;

            // 基本验证：provider + model 始终必填；baseUrl/apiKey 对 google 可选
            if (!profile.provider || !profile.model) {
                res.status(400).json({ ok: false, error: "provider, model 为必填" });
                return;
            }
            if (!isGoogle && (!profile.baseUrl || !profile.apiKey)) {
                res.status(400).json({ ok: false, error: "baseUrl, apiKey 为必填" });
                return;
            }
            if (isGoogle && !hasVertexProject && !profile.apiKey) {
                res.status(400).json({ ok: false, error: "AI Studio 模式需要 apiKey，或配置 Vertex AI 凭据" });
                return;
            }

            const { callLLM } = await import("../core/llm.js");
            const start = Date.now();

            try {
                // 使用内部真实的 callLLM 调用，确保应用所有的系统配置（如 customHeaders, extraBody）
                await callLLM(
                    [{ role: "user", content: "ping" }],
                    profile,
                    { timeoutMs: 15000, caller: "dashboard-test" }
                );
                const latency = Date.now() - start;
                res.json({ ok: true, latency, model: profile.model, status: 200 });
            } catch (err: unknown) {
                const latency = Date.now() - start;
                const errMsg = err instanceof Error ? err.message : String(err);
                const isTimeout = errMsg.toLowerCase().includes("timeout") || errMsg.includes("abort");
                res.json({
                    ok: false,
                    latency,
                    status: isTimeout ? 408 : 500,
                    error: isTimeout ? "连接超时 (15s)" : errMsg.slice(0, 500)
                });
            }
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            res.json({ ok: false, error: errMsg.includes("abort") ? "连接超时 (15s)" : errMsg });
        }
    });

    // ─── Mute Control ───
    // 获取所有 muted 聊天状态
    router.get("/mute/status", (_req, res) => {
        const allMuted: Array<{ chatId: string; expiry: number; remaining: string; platform: string }> = [];
        for (const adapter of (deps.adapters ?? [])) {
            if (typeof adapter.getMutedChats === "function") {
                for (const m of adapter.getMutedChats()) {
                    allMuted.push({ ...m, platform: adapter.platform });
                }
            }
        }
        res.json({ muted: allMuted });
    });

    // 检查单个 chatId 的 mute 状态
    router.get("/mute/chat/:chatId", (req, res) => {
        const chatId = req.params.chatId;
        for (const adapter of (deps.adapters ?? [])) {
            if (typeof adapter.isChatMuted === "function" && adapter.isChatMuted(chatId)) {
                const mutedList = adapter.getMutedChats?.() ?? [];
                const entry = mutedList.find(m => m.chatId === chatId);
                res.json({ muted: true, remaining: entry?.remaining ?? "?" });
                return;
            }
        }
        res.json({ muted: false });
    });

    // Mute 单个聊天
    router.post("/mute/chat/:chatId", (req, res) => {
        const chatId = req.params.chatId;
        const hours = Number(req.body?.hours) || 1;
        for (const adapter of (deps.adapters ?? [])) {
            if (typeof adapter.muteChat === "function") {
                // 找到对应平台的 adapter
                if (chatId.startsWith(`${adapter.platform}:`)) {
                    adapter.muteChat(chatId, hours);
                    log.info("Dashboard mute chat", { chatId, hours });
                    res.json({ ok: true });
                    return;
                }
            }
        }
        res.status(404).json({ error: "no adapter found for chatId" });
    });

    // Unmute 单个聊天
    router.post("/mute/chat/:chatId/unmute", (req, res) => {
        const chatId = req.params.chatId;
        for (const adapter of (deps.adapters ?? [])) {
            if (typeof adapter.unmuteChat === "function" && chatId.startsWith(`${adapter.platform}:`)) {
                adapter.unmuteChat(chatId);
                log.info("Dashboard unmute chat", { chatId });
                res.json({ ok: true });
                return;
            }
        }
        res.status(404).json({ error: "no adapter found for chatId" });
    });

    // 全局 mute：对所有已知 chatId 设置 mute
    router.post("/mute/all", (req, res) => {
        const hours = Number(req.body?.hours) || 1;
        const allChatIds = new Set<string>();
        for (const sub of deps.subagentManager.getAllSubagents()) {
            allChatIds.add(sub.chatId);
        }
        let count = 0;
        for (const chatId of allChatIds) {
            for (const adapter of (deps.adapters ?? [])) {
                if (typeof adapter.muteChat === "function" && chatId.startsWith(`${adapter.platform}:`)) {
                    adapter.muteChat(chatId, hours);
                    count++;
                    break;
                }
            }
        }
        log.info("Dashboard mute all", { count, hours });
        res.json({ ok: true, mutedCount: count });
    });

    // 全局 unmute
    router.post("/mute/clear", (_req, res) => {
        let count = 0;
        for (const adapter of (deps.adapters ?? [])) {
            if (typeof adapter.getMutedChats === "function" && typeof adapter.unmuteChat === "function") {
                const muted = adapter.getMutedChats();
                for (const m of muted) {
                    adapter.unmuteChat(m.chatId);
                    count++;
                }
            }
        }
        log.info("Dashboard unmute all", { count });
        res.json({ ok: true, unmutedCount: count });
    });

    // ─── System Prompts Override ───

    // 列出所有 prompt 文件（含 override 状态）
    router.get("/system-prompts", (_req, res) => {
        try {
            const prompts = listAllPrompts();
            res.json({ prompts });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // 获取指定 prompt 的原始和 override 内容
    router.get("/system-prompts/{*promptPath}", (req, res) => {
        try {
            const raw = (req.params as Record<string, string | string[]>)["promptPath"];
            const relativePath = Array.isArray(raw) ? raw.join("/") : raw;
            if (!relativePath) { res.status(400).json({ error: "path required" }); return; }
            const original = loadOriginalPrompt(relativePath);
            if (original === null) { res.status(404).json({ error: "prompt not found" }); return; }
            const override = loadOverridePrompt(relativePath);
            res.json({
                relativePath,
                original,
                override,
                hasOverride: override !== null,
            });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // 保存 override
    router.put("/system-prompts/{*promptPath}", (req, res) => {
        try {
            const raw = (req.params as Record<string, string | string[]>)["promptPath"];
            const relativePath = Array.isArray(raw) ? raw.join("/") : raw;
            if (!relativePath) { res.status(400).json({ error: "path required" }); return; }
            const { content } = req.body;
            if (typeof content !== "string") { res.status(400).json({ error: "content (string) required" }); return; }
            // 验证原始文件存在
            const original = loadOriginalPrompt(relativePath);
            if (original === null) { res.status(404).json({ error: "original prompt not found" }); return; }
            saveOverride(relativePath, content);
            // 自动清除缓存使更改即时生效
            reloadAllPrompts();
            log.info("System prompt override 已保存", { relativePath, length: content.length });
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // 删除 override（恢复原始版本）
    router.delete("/system-prompts/{*promptPath}", (req, res) => {
        try {
            const raw = (req.params as Record<string, string | string[]>)["promptPath"];
            const relativePath = Array.isArray(raw) ? raw.join("/") : raw;
            if (!relativePath) { res.status(400).json({ error: "path required" }); return; }
            const deleted = deleteOverride(relativePath);
            if (deleted) {
                reloadAllPrompts();
                log.info("System prompt override 已删除", { relativePath });
            }
            res.json({ ok: true, deleted });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // 手动重载所有 prompt 缓存
    router.post("/system-prompts-reload", (_req, res) => {
        reloadAllPrompts();
        log.info("System prompts 缓存已手动清除");
        res.json({ ok: true });
    });

    router.post("/restart", (_req, res) => {
        log.info("收到重启请求，进程将在 1 秒后退出");
        res.json({ ok: true, message: "进程将在 1 秒后退出，请确保有进程管理器（pm2/systemd）自动重启" });
        setTimeout(() => process.exit(0), 1000);
    });

    // ─── MCP Server 管理 ───

    /** 列出全局 MCP Servers */
    router.get("/mcp", async (_req, res) => {
        try {
            res.json({ ok: true, servers: mcpBridge.list() });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    /** 读取当前全局 MCP 安装配置（可直接 JSON 编辑） */
    router.get("/mcp/configs", (_req, res) => {
        try {
            res.json({ ok: true, configs: getConnectionConfigs() });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    /** 连接新的全局 MCP Server */
    router.post("/mcp/connect", async (req, res) => {
        try {
            const { name, description, transport, command, args, env, url, headers } = req.body ?? {};
            if (!name || (!command && !url)) {
                res.status(400).json({ error: "name 必填，且必须提供 command（stdio）或 url（Streamable HTTP）" });
                return;
            }
            const server = await mcpBridge.connect({ name, description, transport, command, args, env, url, headers });
            res.json({ ok: true, name: server.name, tools: server.tools });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    /** 用 JSON 批量替换全局 MCP 安装配置 */
    router.put("/mcp/configs", async (req, res) => {
        try {
            const { configs } = req.body ?? {};
            if (!Array.isArray(configs)) {
                res.status(400).json({ error: "configs 必须是 JSON 数组" });
                return;
            }
            const normalized = configs as McpServerConfig[];
            for (const config of normalized) {
                if (!config?.name || (!config.command && !config.url)) {
                    res.status(400).json({ error: `非法 MCP 配置: ${JSON.stringify(config)}` });
                    return;
                }
            }
            await replaceConnectionConfigs(normalized);
            res.json({ ok: true, servers: mcpBridge.list(), configs: getConnectionConfigs() });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    /** 断开指定全局 MCP Server */
    router.delete("/mcp/:name", async (req, res) => {
        try {
            const serverName = req.params.name;
            await mcpBridge.disconnect(serverName);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    // ─── Background Agent ───

    router.get("/background-agent", (_req, res) => {
        if (!deps.harnessManager) {
            return res.json({ enabled: false });
        }
        res.json({
            enabled: true,
            ...deps.harnessManager.getStatus(),
            currentRun: deps.harnessManager.getCurrentRun(),
            runs: deps.harnessManager.getRecentRuns(20),
        });
    });

    router.post("/background-agent/trigger", (req, res) => {
        if (!deps.harnessManager) {
            return res.status(404).json({ error: "HarnessManager not configured" });
        }
        // 可选的收集起点：
        //   省略         → 默认（上次做梦起始时间起）
        //   "all"        → 收集全部留存任务（不限起点）
        //   ISO / epoch  → 从该时刻起
        const sinceRaw = req.body?.since ?? qs(req.query.since);
        let sinceTs: number | null | undefined = undefined;
        if (sinceRaw !== undefined && sinceRaw !== null && String(sinceRaw).trim() !== "") {
            const value = String(sinceRaw).trim();
            if (value === "all") {
                sinceTs = null;
            } else {
                const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
                if (!Number.isFinite(ms)) {
                    return res.status(400).json({ error: `invalid 'since': ${value}` });
                }
                sinceTs = ms;
            }
        }
        deps.harnessManager.triggerManual(
            { content: "manual-trigger-from-dashboard", source: "dashboard" },
            sinceTs,
        );
        res.json({ ok: true, queueLength: deps.harnessManager.queueLength, sinceTs: sinceTs ?? null });
    });

    router.get("/background-agent/runs/:runId/events", (req, res) => {
        if (!deps.harnessManager) {
            return res.status(404).json({ error: "HarnessManager not configured" });
        }
        const run = deps.harnessManager.getRun(req.params.runId);
        if (!run) {
            return res.status(404).json({ error: "run not found" });
        }
        const after = Number(qs(req.query.after));
        if (!run.logPath || !fs.existsSync(run.logPath)) {
            const events = Number.isFinite(after)
                ? run.events.filter((event) => event.id > after)
                : run.events;
            return res.json({ runId: run.id, events, source: "memory" });
        }
        try {
            const events = fs.readFileSync(run.logPath, "utf-8")
                .split(/\r?\n/)
                .filter(Boolean)
                .map((line) => JSON.parse(line))
                .filter((event) => !Number.isFinite(after) || Number(event.id) > after);
            res.json({ runId: run.id, events, source: "log", logPath: run.logPath });
        } catch (err) {
            res.status(500).json({ error: String(err) });
        }
    });

    return router;
}
