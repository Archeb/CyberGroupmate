import type { GroundingConfig } from "../../core/config.js";
import { shortUuid } from "../../core/ids.js";
import { runParallelGrounding } from "../../main-agent/grounding-util.js";
import type { AttentionAccumulator } from "../../accumulator/attention-accumulator.js";
import { CodeActExecutor } from "../../subagent/code-act-executor.js";
import type { ActiveUserProfile, GroupContextPackage, CodeActReplyTask, DispatchedSubagentTaskRecord } from "../../subagent/types.js";
import type { MemoryStoreV2 } from "../../memory-v2/index.js";
import type { GlobalState } from "../../main-agent/global-state.js";
import type { SubagentManager } from "../../subagent/subagent-manager.js";
import { getGroupModelKey } from "../../core/chat-id.js";
import { toUnixTimestampMs } from "../../core/timezone.js";
import {
    collectQuoteRefs,
    resolveQuoteRefs,
    type QuoteExecutionOutput,
} from "./quotes.js";

export interface DispatchTrackingSpec {
    key?: string;
    content: string;
    remindAfterMinutes?: number;
    callback?: string;
    data?: unknown;
}

export interface DispatchTaskSpec {
    contentDirection: string;
    toneGuidance?: string;
    suggestedEmojis?: string[];
    quotes?: string[];
    useSkills?: string[];
    tracking?: DispatchTrackingSpec;
}

export interface DispatchTaskResult {
    taskId: string;
    trackingKey?: string;
    reminderId?: string;
}

export interface DispatchSource {
    type: "meta" | "subagent";
    chatId?: string;
    taskId?: string;
}

export interface DispatchTaskOptions {
    source?: DispatchSource;
}

export type DispatchedTaskStatusForPrompt = Omit<
    DispatchedSubagentTaskRecord,
    "createdAt" | "updatedAt" | "completedAt" | "sentMessages"
> & {
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    sentMessages?: Array<{
        messageId?: string;
        text: string;
        timestamp: number;
    }>;
};

type ExecutorLike = Pick<CodeActExecutor,
    "enqueue" |
    "setSessionFilePath" |
    "getSessionFilePath" |
    "loadSession"
>;

type SubagentLike = {
    chatId: string;
    codeActExecutor?: unknown;
};

type SubagentManagerReader = Pick<SubagentManager, "getOrCreate" | "getSessionFilePath">;

export interface DispatchApiDeps {
    subagentManager: SubagentManagerReader;
    memory: MemoryStoreV2;
    globalState?: Pick<GlobalState,
        "addReminder" |
        "recordDispatchedSubagentTask" |
        "getDispatchedSubagentTask" |
        "listDispatchedSubagentTasks" |
        "getSessionDigests" |
        "addSessionDigest"
    >;
    accumulator: AttentionAccumulator;
    onTaskDispatched?: (task: CodeActReplyTask) => void | Promise<void>;
    groundingConfig?: GroundingConfig;
    groundingRunner?: (
        config: GroundingConfig,
        messagesText: string,
    ) => Promise<string | undefined>;
    getQuoteOutput?: (index: number) => QuoteExecutionOutput | null | undefined;
    workspaceRoot?: string;
    executorFactory?: (chatId: string) => ExecutorLike;
    initializeExecutor?: (executor: ExecutorLike, chatId: string) => void | Promise<void>;
    taskIdFactory?: () => string;
    getActiveUserProfilesForChat?: (chatId: string) => ActiveUserProfile[] | undefined;
}

export function createDispatchApi(deps: DispatchApiDeps) {
    return {
        taskToGroup: async (chatId: string, taskSpec: DispatchTaskSpec, options?: DispatchTaskOptions): Promise<DispatchTaskResult> => {
            assertNoLegacyContext(taskSpec);
            const source = normalizeDispatchSource(options?.source);
            const subagent = deps.subagentManager.getOrCreate(chatId) as SubagentLike;
            const executor = await ensureExecutor(subagent, chatId, deps);
            const taskId = deps.taskIdFactory?.() ?? shortUuid();
            const groundingContext = await maybeRunGrounding(deps, taskSpec.contentDirection);
            const contextSnapshot = await buildDispatchContext(
                deps.memory,
                chatId,
                taskSpec,
                groundingContext,
                deps.getActiveUserProfilesForChat?.(chatId),
                deps,
            );

            const task: CodeActReplyTask = {
                type: "CODEACT_REPLY",
                chatId,
                taskId,
                decisions: [{
                    action: "REPLY",
                    contentDirection: taskSpec.contentDirection,
                    toneGuidance: taskSpec.toneGuidance,
                    suggestedEmojis: taskSpec.suggestedEmojis,
                    confidence: 1.0,
                    reason: "Meta-CodeAct dispatch",
                }],
                contextSnapshot,
                replyMode: "SINGLE",
                useSkills: taskSpec.useSkills,
                createdAt: new Date().toISOString(),
            };

            deps.globalState?.recordDispatchedSubagentTask?.({
                taskId,
                chatId,
                sourceType: source.type,
                sourceChatId: source.chatId,
                sourceTaskId: source.taskId,
                contentDirection: taskSpec.contentDirection,
                toneGuidance: taskSpec.toneGuidance,
                quotes: taskSpec.quotes,
                quoteWarnings: contextSnapshot.quoteWarnings,
                suggestedEmojis: taskSpec.suggestedEmojis,
                useSkills: taskSpec.useSkills,
                tracking: taskSpec.tracking,
                createdAt: task.createdAt,
            });
            deps.globalState?.addSessionDigest?.(formatDispatchCreatedDigest(source, chatId, taskId, taskSpec));

            executor.enqueue(task);
            deps.accumulator.markActioned(chatId);
            await deps.onTaskDispatched?.(task);

            const tracking = recordDispatchTracking(deps, chatId, taskId, taskSpec.tracking);

            return { taskId, ...tracking };
        },
        getTask: async (taskId: string) => {
            const task = deps.globalState?.getDispatchedSubagentTask(taskId);
            if (!task) {
                return null;
            }
            return toPromptTaskStatus(task);
        },
        listTasks: async (options?: { chatId?: string; status?: string; limit?: number; offset?: number }) => {
            const page = deps.globalState?.listDispatchedSubagentTasks(options) ?? { tasks: [], total: 0, hasMore: false };
            return {
                ...page,
                tasks: page.tasks.map(toPromptTaskStatus),
            };
        },
    };
}

function normalizeDispatchSource(source?: DispatchSource): DispatchSource {
    if (source?.type === "subagent" && source.chatId) {
        return {
            type: "subagent",
            chatId: source.chatId,
            taskId: source.taskId,
        };
    }
    return { type: "meta" };
}

function formatDispatchCreatedDigest(
    source: DispatchSource,
    targetChatId: string,
    taskId: string,
    taskSpec: DispatchTaskSpec,
): string {
    const sourceLabel = source.type === "subagent"
        ? `Subagent ${source.chatId}${source.taskId ? ` task=${source.taskId}` : ""}`
        : "Meta";
    const quoteCount = taskSpec.quotes?.length ?? 0;
    return [
        `[DISPATCH] ${sourceLabel} -> ${targetChatId}: task=${taskId}`,
        `direction=${taskSpec.contentDirection.slice(0, 180)}`,
        quoteCount ? `quotes=${quoteCount}` : "",
        taskSpec.tracking ? "tracking=true" : "",
    ].filter(Boolean).join("；");
}

function assertNoLegacyContext(taskSpec: DispatchTaskSpec): void {
    if (taskSpec && typeof taskSpec === "object" && "context" in (taskSpec as unknown as Record<string, unknown>)) {
        throw new Error("dispatch.taskToGroup 已移除 taskSpec.context；请使用 quotes 或在 contentDirection/toneGuidance 中写 quote 引用。");
    }
}

function toPromptTaskStatus(task: DispatchedSubagentTaskRecord): DispatchedTaskStatusForPrompt {
    return {
        ...task,
        createdAt: timestampOrZero(task.createdAt),
        updatedAt: timestampOrZero(task.updatedAt),
        completedAt: task.completedAt ? timestampOrZero(task.completedAt) : undefined,
        sentMessages: task.sentMessages?.map((message) => ({
            ...message,
            timestamp: timestampOrZero(message.timestamp),
        })),
    };
}

function timestampOrZero(value: string | number | Date | null | undefined): number {
    return toUnixTimestampMs(value) ?? 0;
}

async function ensureExecutor(
    subagent: SubagentLike,
    chatId: string,
    deps: DispatchApiDeps,
): Promise<ExecutorLike> {
    let executor = subagent.codeActExecutor as ExecutorLike | null | undefined;
    if (!executor) {
        executor = deps.executorFactory?.(chatId) ?? new CodeActExecutor(chatId);
        subagent.codeActExecutor = executor;
    }

    const sessionFilePath = deps.subagentManager.getSessionFilePath(chatId);
    if (!executor.getSessionFilePath?.()) {
        executor.setSessionFilePath?.(sessionFilePath);
        executor.loadSession?.();
    }

    await deps.initializeExecutor?.(executor, chatId);
    return executor;
}

async function maybeRunGrounding(
    deps: DispatchApiDeps,
    contentDirection: string,
): Promise<string | undefined> {
    if (!deps.groundingConfig?.apiKey) {
        return undefined;
    }

    const runner = deps.groundingRunner ?? runParallelGrounding;
    return runner(deps.groundingConfig, contentDirection);
}

async function buildDispatchContext(
    memory: MemoryStoreV2,
    chatId: string,
    taskSpec: DispatchTaskSpec,
    groundingContext?: string,
    activeUserProfiles?: ActiveUserProfile[],
    deps?: Pick<DispatchApiDeps, "globalState" | "getQuoteOutput" | "workspaceRoot">,
): Promise<GroupContextPackage> {
    const groupModel = typeof memory.getGroupModel === "function"
        ? memory.getGroupModel(getGroupModelKey(chatId))
        : null;
    const quoteContext = await resolveDispatchQuoteContext(memory, chatId, taskSpec, deps);
    return {
        depth: 2,
        chatId,
        snapshotTimestamp: new Date().toISOString(),
        topicDigests: [],
        engagementScore: 0,
        groupModel: groupModel ?? undefined,
        chatTitle: groupModel?.chatTitle,
        isDirectMessage: groupModel?.isDirectMessage,
        activeUserProfiles: activeUserProfiles && activeUserProfiles.length > 0 ? activeUserProfiles : undefined,
        quotedContext: quoteContext.renderedMarkdown,
        quoteWarnings: quoteContext.warnings.length > 0 ? quoteContext.warnings : undefined,
        toneGuidance: taskSpec.toneGuidance,
        contentDirection: taskSpec.contentDirection,
        groundingContext,
    };
}

async function resolveDispatchQuoteContext(
    memory: MemoryStoreV2,
    targetChatId: string,
    taskSpec: DispatchTaskSpec,
    deps?: Pick<DispatchApiDeps, "globalState" | "getQuoteOutput" | "workspaceRoot">,
) {
    const refs = collectQuoteRefs({
        contentDirection: taskSpec.contentDirection,
        toneGuidance: taskSpec.toneGuidance,
        quotes: taskSpec.quotes,
    });
    if (refs.length === 0) {
        return { items: [], warnings: [], renderedMarkdown: undefined };
    }
    return resolveQuoteRefs(refs, {
        memory,
        // 派发目标会话：引用「目标会话自己」的私密内容放行（在本会话内服务），跨别的私密会话才拦/scrub。
        boundChatId: targetChatId,
        globalState: deps?.globalState,
        getOutput: deps?.getQuoteOutput,
        workspaceRoot: deps?.workspaceRoot,
    });
}

function recordDispatchTracking(
    deps: DispatchApiDeps,
    chatId: string,
    taskId: string,
    tracking: DispatchTrackingSpec | undefined,
): { trackingKey?: string; reminderId?: string } {
    if (!tracking) {
        return {};
    }

    const content = tracking.content.trim();
    if (!content) {
        throw new Error("dispatch tracking.content 不能为空");
    }

    const trackingKey = tracking.key?.trim() || `dispatch:${taskId}`;
    const now = new Date();
    const delayMinutes = tracking.remindAfterMinutes;
    const triggerAt = typeof delayMinutes === "number" && Number.isFinite(delayMinutes) && delayMinutes > 0
        ? new Date(now.getTime() + delayMinutes * 60_000).toISOString()
        : null;
    const todoContent = JSON.stringify({
        type: "dispatch_tracking",
        taskId,
        bindingId: chatId,
        content,
        data: tracking.data ?? null,
        createdAt: now.toISOString(),
    });

    deps.memory.todoUpsert(chatId, trackingKey, todoContent, triggerAt);

    let reminderId: string | undefined;
    if (triggerAt) {
        if (!deps.globalState) {
            throw new Error("dispatch tracking.remindAfterMinutes 需要 globalState.addReminder");
        }
        const callback = tracking.callback?.trim()
            || `检查 dispatch tracking ${trackingKey}：${content}`;
        const reminder = deps.globalState.addReminder(
            "__meta__",
            callback,
            triggerAt,
            "dispatch-tracking",
            {
                bindingId: chatId,
                name: `dispatch tracking ${trackingKey}`,
                callback,
                data: {
                    type: "dispatch_tracking",
                    taskId,
                    trackingKey,
                    bindingId: chatId,
                    content,
                    data: tracking.data ?? null,
                },
            },
        );
        reminderId = reminder.id;
    }

    return { trackingKey, reminderId };
}
