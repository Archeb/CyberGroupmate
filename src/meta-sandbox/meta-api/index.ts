import type { GroundingConfig } from "../../core/config.js";
import type { AttentionAccumulator } from "../../accumulator/attention-accumulator.js";
import type { MemoryStoreV2 } from "../../memory-v2/index.js";
import type { GlobalState } from "../../main-agent/global-state.js";
import type { SubagentManager } from "../../subagent/subagent-manager.js";
import { createAgentsApi } from "./agents.js";
import { createConversationsApi } from "./conversations.js";
import { createDispatchApi, type DispatchApiDeps } from "./dispatch.js";
import { createMemoryApi } from "./memory.js";
import { createCronApi, createReminderApi } from "./scheduler.js";
import { createTodoApi } from "./todo.js";

export { createAgentsApi } from "./agents.js";
export { createConversationsApi } from "./conversations.js";
export { createDispatchApi } from "./dispatch.js";
export { createMemoryApi } from "./memory.js";
export { createCronApi, createReminderApi } from "./scheduler.js";
export { createTodoApi } from "./todo.js";

export interface BuildMetaApiContextDeps extends Omit<DispatchApiDeps, "subagentManager" | "accumulator" | "memory" | "groundingConfig"> {
    memory: MemoryStoreV2;
    subagentManager: SubagentManager;
    globalState: GlobalState;
    accumulator: AttentionAccumulator;
    groundingConfig?: GroundingConfig;
}

export function buildMetaApiContext(deps: BuildMetaApiContextDeps) {
    return {
        conversations: createConversationsApi(deps.memory),
        memory: createMemoryApi(deps.memory, deps.globalState),
        agents: createAgentsApi(deps.subagentManager, deps.memory),
        dispatch: createDispatchApi({
            memory: deps.memory,
            globalState: deps.globalState,
            subagentManager: deps.subagentManager,
            accumulator: deps.accumulator,
            onTaskDispatched: deps.onTaskDispatched,
            groundingConfig: deps.groundingConfig,
            groundingRunner: deps.groundingRunner,
            executorFactory: deps.executorFactory,
            initializeExecutor: deps.initializeExecutor,
            taskIdFactory: deps.taskIdFactory,
        }),
        todo: createTodoApi(deps.memory),
        remind: createReminderApi(deps.globalState),
        cron: createCronApi(deps.globalState),
    };
}
