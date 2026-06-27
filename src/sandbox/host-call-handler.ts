import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ensureCompositeId, getGroupModelKey, getPlatform, isValidCompositeChatId } from "../core/chat-id.js";
import {
    assertEgressAllowed,
    isExplicitReadBlocked,
    makePolicyContext,
    scrubFactsByVisibility,
    scrubRowsByVisibility,
    type PolicyContext,
} from "../core/visibility-policy.js";
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
import { createMemoryApi, scrubDossiers, scrubIdentityMatches } from "../meta-sandbox/meta-api/memory.js";
import { createPrivacyApi } from "../meta-sandbox/meta-api/privacy.js";
import type { AttentionAccumulator } from "../accumulator/attention-accumulator.js";
import type { PlatformAdapter } from "../adapter/platform-adapter.js";
import { getTelegramMtcuteWriteTarget, TELEGRAM_MTCUTE_WRITE_METHODS } from "../core/telegram-mtcute-passthrough.js";
import { timestampInputToIso } from "../core/timezone.js";
import { resolveTodoDueAt } from "../core/todo-expiry.js";
import { prefixedShortUuid } from "../core/ids.js";
import { SandboxPool } from "./sandbox-pool.js";
import { type Sandbox } from "./sandbox.js";
import { getPendingMessageSignal, SendInterruptedError, type InterruptedSendPayload } from "./send-interrupt.js";

const log = createLogger("sandbox-host-calls");

const humanizedLastSendTimes = new Map<string, number>();

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

interface DispatchApiLike {
    taskToGroup(chatId: string, taskSpec: unknown, options?: unknown): Promise<unknown>;
    getTask(taskId: string): Promise<unknown>;
    listTasks(options?: unknown): Promise<unknown>;
}

interface CreateSandboxHostCallHandlerDeps {
    appConfig: AppConfig;
    globalState: GlobalState;
    accumulator: AttentionAccumulator;
    memory: MemoryStoreV2;
    adapters: PlatformAdapter[];
    sandbox: Sandbox;
    sandboxPool: SandboxPool;
    mcpBridge: McpBridgeLike;
    dispatchApi?: DispatchApiLike;
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

/**
 * 为当前 host 调用构建 visibility 兜底上下文（boundChatId = 当前 sandbox 绑定的 chatId）。
 * 用缓存的 loadConfig（隐私配置无需比应用其余部分更激进地绕过缓存）。
 */
function buildPolicyContext(chatId: string, memory: MemoryStoreV2): PolicyContext {
    return makePolicyContext({
        boundChatId: chatId,
        privacy: loadConfig().privacy,
        getGroupModel: (key: string) => memory.getGroupModel(key),
        onViolation: (v) => log.warn("[visibility] 隐私兜底命中", { ...v }),
    });
}

function getRestrictedWriteTarget(method: string, args: unknown[], adapter: PlatformAdapter): unknown {
    if (adapter.getWriteMethods().includes(method)) return args[0];
    if (method === "telegram.mtcute") {
        const mtcuteMethod = String(args[0] ?? "");
        if (!TELEGRAM_MTCUTE_WRITE_METHODS.has(mtcuteMethod)) return undefined;
        return getTelegramMtcuteWriteTarget(mtcuteMethod, args.slice(1));
    }
    return undefined;
}

function isSelfTarget(target: unknown): boolean {
    return typeof target === "string" && /^(me|self)$/i.test(target.trim());
}

function enforceBackgroundWriteRestriction(method: string, args: unknown[], adapter: PlatformAdapter): void {
    if (adapter.getWriteMethods().includes(method)) {
        throw new Error(
            `[Background sandbox] ${method} 不允许：请使用 notify 工具发送消息。`,
        );
    }
    if (method === "telegram.mtcute") {
        const mtcuteMethod = String(args[0] ?? "");
        if (TELEGRAM_MTCUTE_WRITE_METHODS.has(mtcuteMethod)) {
            const target = getTelegramMtcuteWriteTarget(mtcuteMethod, args.slice(1));
            if (target != null && !isSelfTarget(target)) {
                throw new Error(
                    `[Background sandbox] telegram.mtcute('${mtcuteMethod}') 不允许操作其他 chat，只允许自操作。`,
                );
            }
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCaptionLength(value: unknown): number {
    return value && typeof value === "object" && "caption" in value && typeof (value as { caption?: unknown }).caption === "string"
        ? ((value as { caption: string }).caption.length)
        : 0;
}

function getSendIntent(platform: string, method: string, args: unknown[]): (InterruptedSendPayload & { textLength: number }) | null {
    const chatId = String(args[0] ?? "");
    if (!chatId) return null;

    if (platform === "telegram") {
        switch (method) {
            case "telegram.sendText": {
                const text = String(args[1] ?? "");
                return { method, chatId, text, textLength: text.length };
            }
            case "telegram.sendMedia": {
                const text = getCaptionLength(args[1]) > 0 ? String((args[1] as { caption: string }).caption) : "[media]";
                return { method, chatId, text, textLength: getCaptionLength(args[1]) };
            }
            case "telegram.sendFile": {
                const opts = args[2] as Record<string, unknown> | undefined;
                const text = typeof opts?.caption === "string" ? opts.caption : `[file:${String(args[1] ?? "")}]`;
                return { method, chatId, text, textLength: typeof opts?.caption === "string" ? opts.caption.length : 0 };
            }
            case "telegram.sendSticker":
                return { method, chatId, text: `[sticker:${String(args[1] ?? "")}]`, textLength: 0 };
            case "telegram.sendInlineBotResult":
                return { method, chatId, text: `[inline-bot-result:${String(args[2] ?? "")}]`, textLength: 0 };
            case "telegram.forwardMessage":
                return { method, chatId, text: `[forward:${String(args[2] ?? "")}]`, textLength: 0 };
            case "telegram.sendPoll": {
                const text = String(args[1] ?? "");
                return { method, chatId, text: `[poll:${text}]`, textLength: text.length };
            }
            default:
                return null;
        }
    }

    if (platform === "onebot") {
        switch (method) {
            case "onebot.sendText":
            case "qq.sendText": {
                const text = String(args[1] ?? "");
                return { method, chatId, text, textLength: text.length };
            }
            case "onebot.sendMedia":
            case "qq.sendMedia": {
                const text = getCaptionLength(args[1]) > 0 ? String((args[1] as { caption: string }).caption) : "[media]";
                return { method, chatId, text, textLength: getCaptionLength(args[1]) };
            }
            case "onebot.sendFile":
            case "qq.sendFile": {
                const opts = args[2] as Record<string, unknown> | undefined;
                const text = typeof opts?.caption === "string" ? opts.caption : `[file:${String(args[1] ?? "")}]`;
                return { method, chatId, text, textLength: typeof opts?.caption === "string" ? opts.caption.length : 0 };
            }
            case "onebot.sendSticker":
            case "qq.sendSticker": {
                const opts = args[2] as Record<string, unknown> | undefined;
                const text = typeof opts?.caption === "string" ? opts.caption : `[sticker:${String(args[1] ?? "")}]`;
                return { method, chatId, text, textLength: typeof opts?.caption === "string" ? opts.caption.length : 0 };
            }
            case "onebot.sendFace":
            case "qq.sendFace":
                return { method, chatId, text: `[face:${String(args[1] ?? "")}]`, textLength: 0 };
            default:
                return null;
        }
    }

    return null;
}

export function createSandboxHostCallHandler(chatId: string, deps: CreateSandboxHostCallHandlerDeps) {
    const {
        appConfig,
        globalState,
        accumulator,
        memory,
        adapters,
        sandbox,
        sandboxPool,
        mcpBridge,
        dispatchApi,
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

    const applyInterruptibleHumanizedDelay = async (
        adapter: PlatformAdapter,
        method: string,
        args: unknown[],
    ): Promise<void> => {
        const intent = getSendIntent(adapter.platform, method, args);
        if (!intent) return;

        const cfg = adapter.platform === "telegram"
            ? appConfig.telegram?.humanizedDelay
            : adapter.platform === "onebot"
                ? appConfig.onebot?.humanizedDelay
                : undefined;
        if (!cfg?.enabled) return;
        const targetPlatform = adapter.platform === "telegram" ? "telegram" : "onebot";
        if (adapter.isChatMuted?.(ensureCompositeId(targetPlatform, intent.chatId))) return;

        const targetDelay = Math.max(cfg.minDelay, Math.min(cfg.maxDelay, intent.textLength * cfg.msPerChar));
        let waitMs = targetDelay;

        if (adapter.platform === "telegram") {
            const targetChatId = ensureCompositeId("telegram", intent.chatId);
            const lastSend = humanizedLastSendTimes.get(targetChatId) ?? 0;
            waitMs = Math.max(0, targetDelay - (Date.now() - lastSend));
        }

        const signal = getPendingMessageSignal(chatId);
        if (signal?.getPendingCount()) {
            throw new SendInterruptedError(intent);
        }
        if (waitMs <= 0) {
            if (adapter.platform === "telegram") {
                humanizedLastSendTimes.set(ensureCompositeId("telegram", intent.chatId), Date.now());
            }
            return;
        }

        const sinceVersion = signal?.getVersion() ?? 0;
        log.debug("interruptible humanized delay: waiting", {
            chatId,
            method,
            waitMs,
            textLength: intent.textLength,
        });
        const interrupted = signal
            ? await signal.waitForChange(sinceVersion, waitMs)
            : (await sleep(waitMs), false);
        if (interrupted) {
            throw new SendInterruptedError(intent);
        }
        if (adapter.platform === "telegram") {
            humanizedLastSendTimes.set(ensureCompositeId("telegram", intent.chatId), Date.now());
        }
    };

    return async (method: string, args: unknown[]) => {
        // 每次 host 调用最多构建一次 visibility 兜底上下文（懒加载，仅隐私相关分支会触发）。
        let _policy: PolicyContext | undefined;
        const policy = (): PolicyContext => (_policy ??= buildPolicyContext(chatId, memory));

        const adapter = adapters.find((item) => item.canHandle(method));
        if (adapter) {
            // 提取一次写目标，R2 隔离与全局严格开关共用。
            const writeTarget = getRestrictedWriteTarget(method, args, adapter);
            const externalTarget = writeTarget != null && !isSelfTarget(writeTarget)
                && chatId !== "__background__" && isValidCompositeChatId(chatId)
                ? ensureCompositeId(getPlatform(chatId), String(writeTarget))
                : null;

            // R2 写隔离：私密会话内容不得外发（始终生效，独立于 restrictAdapterWritesToBoundChat 全局开关）。
            if (externalTarget) {
                assertEgressAllowed("egress-write", method, externalTarget, policy());
            }
            // 全局严格开关：限制写操作只能发往绑定 chat。
            if (isBoundChatWriteRestrictionEnabled()) {
                if (chatId === "__background__") {
                    enforceBackgroundWriteRestriction(method, args, adapter);
                } else if (externalTarget && externalTarget !== chatId) {
                    throw new Error(
                        `[Sandbox 安全限制] ${method} 被拦截：当前 sandbox 绑定 chat=${chatId}，` +
                        `不允许向 chat=${externalTarget} 发送消息。`
                    );
                }
            }
            await applyInterruptibleHumanizedDelay(adapter, method, args);
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
            case "shell.runBackground":
                return sandbox.runShellBackground(
                    String(args[0]),
                    (args[1] as { tabId?: string; idleTimeout?: number; maxDuration?: number }) ?? undefined,
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

        if (method === "runtime.elevate") {
            const [request, options] = args as [string, { urgency?: string; data?: unknown } | undefined];
            const description = String(request ?? "").trim();
            if (!description) {
                throw new Error("runtime.elevate request 不能为空");
            }
            const urgency = options?.urgency === "high" ? "high" : "normal";
            const now = Date.now();
            const id = prefixedShortUuid("elevate:");
            accumulator.ingest(0, {
                chatId: "__meta__",
                source: "WAKE_CONDITION",
                enqueuedAt: now,
                pressure: urgency === "high" ? 100 : 80,
                payload: {
                    id,
                    type: "wake_condition",
                    description,
                    bindingId: chatId,
                    callback: description,
                    data: {
                        type: "subagent_elevation",
                        sourceChatId: chatId,
                        urgency,
                        data: options?.data ?? null,
                    },
                },
            });
            const enqueuedAt = new Date(now).toISOString();
            log.info("runtime.elevate 已入队 Meta attention", { id, chatId, urgency, description: description.slice(0, 120) });
            return { ok: true, id, enqueuedAt };
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
            const [key, content, options] = args as [string, string, { dueAt?: string | number | Date | null; forever?: boolean } | undefined];
            return memory.todoUpsert(chatId, key, content, resolveTodoDueAt(options));
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
            // R1：丢弃 visibility=private 且来源 ≠ 当前会话的 fact（跨私聊/敏感群泄露兜底）。
            const facts = memory.searchFacts(query, {
                ...options,
                categories: options?.categories as any,
            });
            return scrubFactsByVisibility(facts, policy(), method).kept;
        }
        if (method === "memory.searchTopics") {
            const [query, options] = args as [string, { chatId?: string; after?: string | number | Date; before?: string | number | Date; limit?: number } | undefined];
            const ctx = policy();
            // R1（显式 target）：显式请求其它私密会话的话题 → 直接拦截返回空。
            if (options?.chatId && isExplicitReadBlocked(options.chatId, ctx)) return [];
            const rows = memory.searchTopics(query, {
                ...options,
                after: timestampInputToIso(options?.after) ?? undefined,
                before: timestampInputToIso(options?.before) ?? undefined,
                chatId: options?.chatId ?? chatId,
            });
            return scrubRowsByVisibility(rows, (r) => r.chatId, ctx, method).kept;
        }
        if (method === "memory.searchMessages") {
            const [query, options] = args as [string, { chatId?: string; userId?: string; after?: string | number | Date; before?: string | number | Date; limit?: number } | undefined];
            const ctx = policy();
            // R1（显式 target）：显式请求其它私密会话的消息记录 → 直接拦截返回空。
            if (options?.chatId && isExplicitReadBlocked(options.chatId, ctx)) return [];
            const rows = memory.searchMessages(query, {
                ...options,
                after: timestampInputToIso(options?.after) ?? undefined,
                before: timestampInputToIso(options?.before) ?? undefined,
                chatId: options?.chatId ?? chatId,
            });
            return scrubRowsByVisibility(rows, (r) => r.chatId, ctx, method).kept;
        }
        if (method === "memory.getUserProfile") {
            const [userId, targetChatId] = args as [string, string | undefined];
            const ctx = policy();
            // R1（显式 target）：显式查别的私密会话的群内画像 → 收窄回当前会话视角。
            const effective = (targetChatId && isExplicitReadBlocked(targetChatId, ctx)) ? chatId : (targetChatId ?? chatId);
            const profile = memory.getUserProfile(userId, effective) as unknown as Record<string, unknown> | null;
            if (profile && Array.isArray((profile as { recentFacts?: unknown[] }).recentFacts)) {
                (profile as { recentFacts: unknown[] }).recentFacts =
                    scrubFactsByVisibility((profile as { recentFacts: any[] }).recentFacts, ctx, method).kept;
            }
            return profile;
        }
        if (method === "memory.getRecentInteractions") {
            const [targetChatId, userId, limit] = args as [string | null | undefined, string | undefined, number | undefined];
            const ctx = policy();
            const explicitChatId = typeof targetChatId === "string" && targetChatId.trim().length > 0 ? targetChatId : undefined;
            // R1（显式 target）：显式拉别的私密会话的交互记录 → 拦截返回空。
            if (explicitChatId && isExplicitReadBlocked(explicitChatId, ctx)) return [];
            const mapped = memory.getRecentInteractions(explicitChatId, userId, limit).map((interaction) => {
                const identity = memory.getPersonIdentity(interaction.userId);
                const displayName = identity?.displayName ?? interaction.userId;
                const groupModel = memory.getGroupModel(getGroupModelKey(interaction.chatId));
                const chatTitle = groupModel?.chatTitle?.trim() || interaction.chatId;
                return {
                    ...interaction,
                    displayName,
                    userLabel: `${displayName}(${interaction.userId})`,
                    chatLabel: `${chatTitle}(${interaction.chatId})`,
                };
            });
            // R1（聚合）：丢弃来源私密且 ≠ 当前会话的交互行。
            return scrubRowsByVisibility(mapped, (r) => r.chatId, ctx, method).kept;
        }
        if (method === "memory.resolvePerson") {
            const [query, options] = args as [string, { chatId?: string; limit?: number } | undefined];
            const api = createMemoryApi(memory);
            const result = await api.resolvePerson(query, { ...options, chatId: options?.chatId ?? chatId });
            scrubIdentityMatches(result.matches, policy()); // matches[].profile.recentFacts 泄露点
            return result;
        }
        if (method === "memory.getPersonDossier") {
            const [queryOrUserId, options] = args as [string, {
                chatId?: string;
                limit?: number;
                factsLimit?: number;
                interactionsLimit?: number;
                topicsLimit?: number;
                messagesLimit?: number;
                groupProfilesLimit?: number;
            } | undefined];
            const api = createMemoryApi(memory);
            const result = await api.getPersonDossier(queryOrUserId, { ...options, chatId: options?.chatId ?? chatId });
            // R1（聚合）：人物档案跨所有会话聚合，逐项丢弃来源私密且 ≠ 当前会话的数据。
            scrubDossiers(result.dossiers, policy());
            return result;
        }
        if (method === "memory.semanticSearch") {
            const [rawQuery, options] = args as [string, { scope?: "facts" | "topics" | "all"; limit?: number } | undefined];
            const query = String(rawQuery ?? "").slice(0, 200);
            const limit = options?.limit ?? 5;
            const embeddingConfig = memory.getEmbeddingConfig();

            if (embeddingConfig) {
                try {
                    const [queryEmbedding] = await embed([query], embeddingConfig);
                    // 本地向量话题检索：按当前会话收窄。
                    const topicChatId = chatId;
                    // 向量快路径绕过了 recall 的可见性守卫，这里在源头补上兜底。
                    const ctx = policy();
                    const rawFacts = options?.scope === "topics"
                        ? []
                        : scrubFactsByVisibility(memory.vectorSearchFacts(queryEmbedding, limit), ctx, method).kept;
                    const rawTopics = options?.scope === "facts"
                        ? []
                        : scrubRowsByVisibility(memory.vectorSearchTopics(queryEmbedding, limit, topicChatId), (t) => t.chatId, ctx, method).kept;
                    const factResults = rawFacts.map((fact) => ({
                        type: "fact" as const,
                        content: `[${fact.subject} · ${fact.category}] ${fact.content}`,
                        score: fact.similarity,
                    }));
                    const topicResults = rawTopics.map((topic) => ({
                        type: "topic" as const,
                        content: `${topic.label} — ${topic.summary}`,
                        score: topic.similarity,
                    }));

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

        if (method === "dispatch.taskToGroup") {
            if (!dispatchApi) {
                throw new Error("dispatch module is not available in this host context");
            }
            const targetChatId = String(args[0] ?? "").trim();
            if (!isValidCompositeChatId(targetChatId)) {
                throw new Error(`dispatch.taskToGroup 需要 composite chatId，收到: ${targetChatId || "(empty)"}`);
            }
            if (targetChatId === chatId) {
                throw new Error("当前 Subagent 不能 dispatch 给自己；当前群内行动请直接调用平台 API。");
            }
            // R2 dispatch 隔离：私密会话不得把任务派出去，也不得把任务派进别人的私密会话。
            assertEgressAllowed("egress-dispatch", method, targetChatId, policy());
            return dispatchApi.taskToGroup(targetChatId, args[1], {
                source: {
                    type: "subagent",
                    chatId,
                },
            });
        }
        if (method === "dispatch.getTask") {
            if (!dispatchApi) {
                throw new Error("dispatch module is not available in this host context");
            }
            return dispatchApi.getTask(String(args[0] ?? ""));
        }
        if (method === "dispatch.listTasks") {
            if (!dispatchApi) {
                throw new Error("dispatch module is not available in this host context");
            }
            return dispatchApi.listTasks(args[0]);
        }

        // privacy.* 复用 Meta 侧的 createPrivacyApi（同一套 source/visibility 计算）；
        // 唯一差异是当前会话默认 chatId（Meta 无"当前会话"，需显式传）。
        if (method === "privacy.markSensitive" || method === "privacy.status") {
            const privacyApi = createPrivacyApi(
                memory,
                () => policy().deps,
                () => loadConfig().privacy?.allowLlmMarkSensitive !== false,
            );
            const rawTarget = args[0] as string | undefined;
            const target = typeof rawTarget === "string" && rawTarget.trim().length > 0 ? rawTarget.trim() : chatId;
            if (method === "privacy.markSensitive") {
                const rawReason = args[1] as string | undefined;
                const reason = typeof rawReason === "string" && rawReason.trim().length > 0 ? rawReason.trim() : undefined;
                log.info("privacy.markSensitive", { boundChatId: chatId, target, reason: reason?.slice(0, 120) });
                return privacyApi.markSensitive(target, reason);
            }
            return privacyApi.status(target);
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
