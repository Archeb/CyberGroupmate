import type { GroundingConfig } from "../../core/config.js";
import type { AttentionAccumulator } from "../../accumulator/attention-accumulator.js";
import type { MemoryStoreV2 } from "../../memory-v2/index.js";
import type { GlobalState } from "../../main-agent/global-state.js";
import type { SubagentManager } from "../../subagent/subagent-manager.js";
import { createAgentsApi } from "./agents.js";
import { createConversationsApi } from "./conversations.js";
import { createDispatchApi, type DispatchApiDeps } from "./dispatch.js";
import { createMemoryApi } from "./memory.js";
import { createMemoApi } from "./memo.js";
import { createScheduleApi } from "./schedule.js";

export { createAgentsApi } from "./agents.js";
export { createConversationsApi } from "./conversations.js";
export { createDispatchApi } from "./dispatch.js";
export { createMemoryApi } from "./memory.js";
export { createMemoApi } from "./memo.js";
export { createScheduleApi } from "./schedule.js";

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
        memory: createMemoryApi(deps.memory),
        agents: createAgentsApi(deps.subagentManager),
        dispatch: createDispatchApi({
            memory: deps.memory,
            subagentManager: deps.subagentManager,
            accumulator: deps.accumulator,
            groundingConfig: deps.groundingConfig,
            groundingRunner: deps.groundingRunner,
            executorFactory: deps.executorFactory,
            initializeExecutor: deps.initializeExecutor,
            taskIdFactory: deps.taskIdFactory,
        }),
        memo: createMemoApi(deps.globalState),
        schedule: createScheduleApi(deps.globalState),
    };
}