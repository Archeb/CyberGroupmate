import { randomUUID } from "node:crypto";
import type { GroundingConfig } from "../../core/config.js";
import { runParallelGrounding } from "../../main-agent/grounding-util.js";
import type { AttentionAccumulator } from "../../accumulator/attention-accumulator.js";
import { CodeActExecutor } from "../../subagent/code-act-executor.js";
import type { GroupContextPackage, CodeActReplyTask } from "../../subagent/types.js";
import type { MemoryStoreV2 } from "../../memory-v2/index.js";
import type { SubagentManager } from "../../subagent/subagent-manager.js";

export interface DispatchTaskSpec {
    contentDirection: string;
    toneGuidance?: string;
    context?: unknown;
    useSkills?: string[];
}

export interface DispatchTaskResult {
    taskId: string;
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

            return { taskId };
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