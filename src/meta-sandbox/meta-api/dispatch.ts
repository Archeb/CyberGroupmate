import { randomUUID } from "node:crypto";
import type { GroundingConfig } from "../../core/config.js";
import { runParallelGrounding } from "../../main-agent/grounding-util.js";
import type { AttentionAccumulator } from "../../accumulator/attention-accumulator.js";
import { CodeActExecutor } from "../../subagent/code-act-executor.js";
import type { GroupContextPackage, CodeActReplyTask } from "../../subagent/types.js";
import type { MemoryStoreV2 } from "../../memory-v2/index.js";
import type { GlobalState } from "../../main-agent/global-state.js";
import type { SubagentManager } from "../../subagent/subagent-manager.js";

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
    context?: unknown;
    useSkills?: string[];
    tracking?: DispatchTrackingSpec;
}

export interface DispatchTaskResult {
    taskId: string;
    trackingKey?: string;
    reminderId?: string;
}

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
    globalState?: Pick<GlobalState, "addReminder">;
    accumulator: AttentionAccumulator;
    onTaskDispatched?: (task: CodeActReplyTask) => void | Promise<void>;
    groundingConfig?: GroundingConfig;
    groundingRunner?: (
        config: GroundingConfig,
        messagesText: string,
    ) => Promise<string | undefined>;
    executorFactory?: (chatId: string) => ExecutorLike;
    initializeExecutor?: (executor: ExecutorLike, chatId: string) => void | Promise<void>;
    taskIdFactory?: () => string;
}

export function createDispatchApi(deps: DispatchApiDeps) {
    return {
        taskToGroup: async (chatId: string, taskSpec: DispatchTaskSpec): Promise<DispatchTaskResult> => {
            const subagent = deps.subagentManager.getOrCreate(chatId) as SubagentLike;
            const executor = await ensureExecutor(subagent, chatId, deps);
            const taskId = deps.taskIdFactory?.() ?? randomUUID();
            const groundingContext = await maybeRunGrounding(deps, taskSpec.contentDirection);

            const task: CodeActReplyTask = {
                type: "CODEACT_REPLY",
                chatId,
                taskId,
                decisions: [{
                    action: "REPLY",
                    contentDirection: taskSpec.contentDirection,
                    toneGuidance: taskSpec.toneGuidance,
                    confidence: 1.0,
                    reason: "Meta-CodeAct dispatch",
                }],
                contextSnapshot: buildDispatchContext(chatId, taskSpec, groundingContext),
                replyMode: "SINGLE",
                useSkills: taskSpec.useSkills,
                createdAt: new Date().toISOString(),
            };

            executor.enqueue(task);
            deps.accumulator.markActioned(chatId);
            await deps.onTaskDispatched?.(task);

            const tracking = recordDispatchTracking(deps, chatId, taskId, taskSpec.tracking);

            return { taskId, ...tracking };
        },
    };
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

function buildDispatchContext(
    chatId: string,
    taskSpec: DispatchTaskSpec,
    groundingContext?: string,
): GroupContextPackage {
    return {
        depth: 2,
        chatId,
        snapshotTimestamp: new Date().toISOString(),
        topicDigests: [],
        engagementScore: 0,
        personContext: taskSpec.context ? JSON.stringify(taskSpec.context) : undefined,
        toneGuidance: taskSpec.toneGuidance,
        contentDirection: taskSpec.contentDirection,
        groundingContext,
    };
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
