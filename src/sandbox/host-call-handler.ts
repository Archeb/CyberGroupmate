import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ensureCompositeId, getPlatform } from "../core/chat-id.js";
import {
    loadConfig,
    resolveComponentProfiles,
    saveConfig,
    validateConfig,
    type AppConfig,
    type EnvironmentVariable,
} from "../core/config.js";
import { validateCronMinInterval } from "../core/cron-matcher.js";
import { createLogger } from "../core/logger.js";
import { describeImage, ensureSupportedFormat } from "../core/vision-processor.js";
import { MemoryStoreV2 } from "../memory-v2/index.js";
import { embed } from "../memory-v2/embedding.js";
import { GlobalState } from "../main-agent/global-state.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";
import { SandboxPool } from "./sandbox-pool.js";
import { type Sandbox } from "./sandbox.js";

const log = createLogger("sandbox-host-calls");

export interface ManagedEnvPlan {
    hostVisible: Record<string, string>;
    sandboxVisible: Record<string, string>;
    managedKeys: string[];
}

interface McpBridgeLike {
    list(): unknown;
    connect(config: unknown): Promise<{ name: string; tools: unknown }>;
    disconnect(name: string): Promise<void>;
    call(serverName: string, toolName: string, toolArgs: Record<string, unknown>): Promise<unknown>;
}

interface CreateSandboxHostCallHandlerDeps {
    appConfig: AppConfig;
    globalState: GlobalState;
    memory: MemoryStoreV2;
    adapters: PlatformAdapter[];
    sandbox: Sandbox;
    sandboxPool: SandboxPool;
    mcpBridge: McpBridgeLike;
    buildEnvPlan: (envVars?: EnvironmentVariable[]) => ManagedEnvPlan;
    getCurrentEnvPlan: () => ManagedEnvPlan;
    setCurrentEnvPlan: (plan: ManagedEnvPlan) => void;
    applyHostManagedEnv: (plan: ManagedEnvPlan) => void;
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

function isBoundChatWriteRestrictionEnabled(): boolean {
    return loadConfig("config.yaml", true).subagent?.restrictAdapterWritesToBoundChat === true;
}

export function createSandboxHostCallHandler(chatId: string, deps: CreateSandboxHostCallHandlerDeps) {
    const {
        appConfig,
        globalState,
        memory,
        adapters,
        sandbox,
        sandboxPool,
        mcpBridge,
        buildEnvPlan,
        getCurrentEnvPlan,
        setCurrentEnvPlan,
        applyHostManagedEnv,
    } = deps;

    const listSchedulerItems = () => globalState.getSchedulerEvents()
        .filter((event) => (event.bindingId ?? event.chatId) === chatId)
        .map((event) => ({
        id: event.id,
        type: event.type,
        description: event.callback ?? event.taskTemplate ?? event.description,
        bindingId: event.bindingId ?? event.chatId,
        triggerAt: event.triggerAt,
        cronExpr: event.cronExpr,
        taskDescription: event.callback ?? event.taskTemplate,
        createdAt: event.createdAt,
        triggered: event.triggered,
    }));

    const listSchedulerItemsForRemind = () => {
        const items = listSchedulerItems();
        const untriggered = items.filter((event) => !event.triggered);
        const latestTriggered = items
            .filter((event) => !!event.triggered)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
            .slice(0, 10);
        return [...untriggered, ...latestTriggered];
    };

    return async (method: string, args: unknown[]) => {
        const adapter = adapters.find((item) => item.canHandle(method));
        if (adapter) {
            const writeMethods = adapter.getWriteMethods();
            if (isBoundChatWriteRestrictionEnabled() && writeMethods.includes(method)) {
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
            case "shell.listTabs":
                return sandbox.listShellTabs();
            case "shell.detach":
                return sandbox.detachDefaultTab(String(args[0]));
            case "shell.read":
                return sandbox.readShellTab(
                    args[0] != null ? String(args[0]) : undefined,
                    args[1] != null ? Number(args[1]) : undefined,
                );
            case "shell.sendInput":
                sandbox.sendShellInput(String(args[0]), args[1] != null ? String(args[1]) : undefined);
                return;
            case "shell.kill":
                return sandbox.killShellTab(args[0] != null ? String(args[0]) : undefined);
            case "shell.cwd":
                return sandbox.getShellCwd();
            default:
                break;
        }

        if (method === "cron.add") {
            const [name, cronExpr, taskDescription] = args as [string, string, string];
            if (!validateCronMinInterval(cronExpr, 60)) {
                throw new Error("cron 最短触发间隔为 1 小时");
            }
            const maxCrons = appConfig.subagent?.scheduler?.maxCrons ?? 10;
            const existing = globalState.getSchedulerEvents()
                .filter((event) => (event.bindingId ?? event.chatId) === chatId)
                .filter((event) => event.type === "cron");
            if (existing.length >= maxCrons) {
                throw new Error(`cron 数量上限 ${maxCrons}，请先删除不需要的任务`);
            }
            const duplicate = existing.find((event) => event.taskTemplate === taskDescription);
            if (duplicate) {
                throw new Error(`已存在完全相同的 cron 任务描述: ${duplicate.id}`);
            }
            const event = globalState.addCron("__meta__", name, cronExpr, taskDescription, {
                bindingId: chatId,
                name,
                callback: taskDescription,
            });
            return { id: event.id, items: listSchedulerItems() };
        }
        if (method === "cron.remove") {
            const id = String(args[0]);
            globalState.cancelSchedulerEvent(id);
            return;
        }
        if (method === "cron.list") {
            return globalState.getSchedulerEvents()
                .filter((event) => (event.bindingId ?? event.chatId) === chatId)
                .filter((event) => event.type === "cron")
                .map((event) => ({
                    id: event.id,
                    name: event.name ?? event.description,
                    cronExpr: event.cronExpr,
                }));
        }

        if (method === "runtime.remind") {
            const [description, delayMinutes] = args as [string, number];
            if (typeof delayMinutes !== "number" || delayMinutes < 1) {
                throw new Error("remind 最短 1 分钟");
            }
            if (delayMinutes > 525600) {
                throw new Error("remind 最长 365 天（525600 分钟）");
            }
            const maxReminders = appConfig.subagent?.scheduler?.maxReminders ?? 10;
            const existingReminders = globalState.getSchedulerEvents()
                .filter((event) => (event.bindingId ?? event.chatId) === chatId)
                .filter((event) => event.type === "reminder" && !event.triggered);
            if (existingReminders.length >= maxReminders) {
                throw new Error(`remind 数量上限 ${maxReminders}，请等待已有提醒触发或手动取消`);
            }
            const duplicate = existingReminders.find((event) => event.description === description);
            if (duplicate) {
                throw new Error(`已存在完全相同的提醒描述: ${duplicate.id}`);
            }
            const triggerAt = new Date(Date.now() + delayMinutes * 60000).toISOString();
            const event = globalState.addReminder("__meta__", description, triggerAt, undefined, {
                bindingId: chatId,
                name: description.slice(0, 60),
                callback: description,
            });
            log.info("runtime.remind 已设置", { id: event.id, chatId, triggerAt, description: description.slice(0, 80) });
            return { reminderId: event.id, triggerAt, items: listSchedulerItemsForRemind() };
        }

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

            const nextPlan = buildEnvPlan(nextList);
            setCurrentEnvPlan(nextPlan);
            applyHostManagedEnv(nextPlan);
            await sandboxPool.updateManagedEnv(nextPlan.sandboxVisible, nextPlan.managedKeys);
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

            const nextPlan = buildEnvPlan(nextList);
            setCurrentEnvPlan(nextPlan);
            applyHostManagedEnv(nextPlan);
            await sandboxPool.updateManagedEnv(nextPlan.sandboxVisible, nextPlan.managedKeys);
            log.info("runtime.env.delete 已应用", { key, deleted: had });
            return { ok: true, deleted: had };
        }

        if (method === "todo.list") {
            const options = (args[0] as { includeExpired?: boolean } | undefined) ?? undefined;
            return memory.todoList(chatId, options);
        }
        if (method === "todo.get") {
            return memory.todoGet(chatId, String(args[0]));
        }
        if (method === "todo.upsert") {
            const [key, content, options] = args as [string, string, { dueAt?: string | null } | undefined];
            return memory.todoUpsert(chatId, key, content, options?.dueAt ?? null);
        }
        if (method === "todo.remove") {
            memory.todoRemove(chatId, String(args[0]));
            return;
        }

        if (method === "vision.see") {
            const imagePaths = args as string[];
            if (!imagePaths || imagePaths.length === 0) {
                throw new Error("vision.see() 至少需要传入一个图片路径");
            }
            const workspaceRoot = resolve("workspace");
            const visionConfigs = resolveComponentProfiles("vision");

            const results = await Promise.all(imagePaths.map(async (userPath) => {
                let resolvedPath: string;
                if (userPath.startsWith("/")) {
                    resolvedPath = resolve(userPath);
                } else {
                    resolvedPath = resolve(workspaceRoot, userPath);
                }
                const rel = relative(workspaceRoot, resolvedPath);
                if (rel.startsWith("..") || resolve(workspaceRoot, rel) !== resolvedPath) {
                    throw new Error(`[vision 安全限制] 路径 "${userPath}" 超出 workspace 范围。`);
                }
                if (!existsSync(resolvedPath)) {
                    throw new Error(`文件不存在: ${userPath}`);
                }

                const rawBuffer = readFileSync(resolvedPath);
                const ext = resolvedPath.split(".").pop()?.toLowerCase() ?? "";
                const mimeMap: Record<string, string> = {
                    jpg: "image/jpeg",
                    jpeg: "image/jpeg",
                    png: "image/png",
                    webp: "image/webp",
                    gif: "image/gif",
                    bmp: "image/bmp",
                    tiff: "image/tiff",
                    tif: "image/tiff",
                    avif: "image/avif",
                    svg: "image/svg+xml",
                };
                const mimeType = mimeMap[ext] ?? "image/png";
                const { buffer, mimeType: finalMime } = await ensureSupportedFormat(rawBuffer, mimeType);
                return describeImage(buffer, finalMime, visionConfigs);
            }));

            return results;
        }

        if (method === "memory.searchFacts") {
            const [query, options] = args as [string, { subject?: string; categories?: string[]; limit?: number } | undefined];
            return memory.searchFacts(query, {
                ...options,
                categories: options?.categories as any,
            });
        }
        if (method === "memory.searchTopics") {
            const [query, options] = args as [string, { chatId?: string; after?: string; before?: string; limit?: number } | undefined];
            return memory.searchTopics(query, { ...options, chatId: options?.chatId ?? chatId });
        }
        if (method === "memory.searchMessages") {
            const [query, options] = args as [string, { chatId?: string; userId?: string; after?: string; before?: string; limit?: number } | undefined];
            return memory.searchMessages(query, { ...options, chatId: options?.chatId ?? chatId });
        }
        if (method === "memory.getUserProfile") {
            const [userId, targetChatId] = args as [string, string | undefined];
            return memory.getUserProfile(userId, targetChatId ?? chatId);
        }
        if (method === "memory.getRecentInteractions") {
            const [targetChatId, userId, limit] = args as [string | undefined, string | undefined, number | undefined];
            return memory.getRecentInteractions(targetChatId ?? chatId, userId, limit);
        }
        if (method === "memory.semanticSearch") {
            const [query, options] = args as [string, { scope?: "facts" | "topics" | "all"; limit?: number } | undefined];
            const limit = options?.limit ?? 5;
            const embeddingConfig = memory.getEmbeddingConfig();

            if (embeddingConfig) {
                try {
                    const [queryEmbedding] = await embed([query], embeddingConfig);
                    const factResults = (options?.scope === "topics"
                        ? []
                        : memory.vectorSearchFacts(queryEmbedding, limit).map((fact) => ({
                            type: "fact" as const,
                            content: `[${fact.subject} · ${fact.category}] ${fact.content}`,
                            score: fact.similarity,
                        })));
                    const topicResults = (options?.scope === "facts"
                        ? []
                        : memory.vectorSearchTopics(queryEmbedding, limit, chatId).map((topic) => ({
                            type: "topic" as const,
                            content: `${topic.label} — ${topic.summary}`,
                            score: topic.similarity,
                        })));

                    return [...factResults, ...topicResults]
                        .sort((a, b) => b.score - a.score)
                        .slice(0, limit);
                } catch (err) {
                    log.warn("memory.semanticSearch 向量检索失败，fallback recall", { error: String(err) });
                }
            }

            const recallResult = await memory.recall(query, { chatId, maxResults: limit });
            const factResults = (options?.scope === "topics"
                ? []
                : recallResult.facts.map((fact) => ({
                    type: "fact" as const,
                    content: `[${fact.subject} · ${fact.category}] ${fact.content}`,
                    score: fact.confidence,
                })));
            const topicResults = (options?.scope === "facts"
                ? []
                : recallResult.topics.map((topic) => ({
                    type: "topic" as const,
                    content: `${topic.label} — ${topic.summary}`,
                    score: (topic.callbackPotential ?? 0) / 100,
                })));
            return [...factResults, ...topicResults].slice(0, limit);
        }

        if (method === "mcp.list") {
            return mcpBridge.list();
        }
        if (method === "mcp.connect") {
            const [config] = args;
            const server = await mcpBridge.connect(config);
            return { name: server.name, tools: server.tools };
        }
        if (method === "mcp.disconnect") {
            await mcpBridge.disconnect(String(args[0] ?? ""));
            return;
        }
        if (method === "mcp.call") {
            const [serverName, toolName, toolArgs] = args as [string, string, Record<string, unknown> | undefined];
            return mcpBridge.call(serverName, toolName, toolArgs ?? {});
        }

        const currentEnvPlan = getCurrentEnvPlan();
        if (!currentEnvPlan) {
            throw new Error(`Unsupported host call: ${method}`);
        }
        throw new Error(`Unsupported host call: ${method}`);
    };
}
