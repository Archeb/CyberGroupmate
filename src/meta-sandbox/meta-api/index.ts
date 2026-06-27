import { type GroundingConfig, loadConfig } from "../../core/config.js";
import { buildVisibilityDeps } from "../../core/visibility-policy.js";
import type { AttentionAccumulator } from "../../accumulator/attention-accumulator.js";
import type { MemoryStoreV2 } from "../../memory-v2/index.js";
import type { GlobalState } from "../../main-agent/global-state.js";
import type { SubagentManager } from "../../subagent/subagent-manager.js";
import type { ActiveUserProfile } from "../../subagent/types.js";
import type { HarnessManager } from "../../harness/manager.js";
import { createAgentsApi } from "./agents.js";
import { createBackgroundApi } from "./background.js";
import { createConversationsApi } from "./conversations.js";
import { createDispatchApi, type DispatchApiDeps } from "./dispatch.js";
import { createMemoryApi } from "./memory.js";
import { createPrivacyApi } from "./privacy.js";
import { createCronApi, createReminderApi } from "./scheduler.js";
import { createTodoApi } from "./todo.js";

// ── 隐私模型说明 ──
// Meta 是「只调度、不亲自动手」的可信编排者，要服务某个会话就必须读到它的内容——因此 Meta 的「读」
// 不再遮蔽（早期对 conversations/dossier 的来源端遮蔽会让 bot 无法在私密群内回复，已移除）。
// 真正的跨会话外泄兜底在「出口」：
//   ① 派发引用（dispatch quotes）按「派发目标会话」做 target-aware scrub（见 quotes.ts / dispatch.ts）——
//      引用别的私密会话的内容进入某任务会被拦/scrub；引用目标会话自己的内容放行。
//   ② Subagent 的 host-call chokepoint（host-call-handler.ts）按其绑定会话做 R1/R2 兜底（codeart 外泄面）。
// Meta 把私密内容手抄进自由文本 contentDirection 再派给别的会话，是不可代码强制的残余（可信 Meta 的取舍）。

export { createAgentsApi } from "./agents.js";
export { createBackgroundApi } from "./background.js";
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
    getActiveUserProfilesForChat?: (chatId: string) => ActiveUserProfile[] | undefined;
    getHarnessManager?: () => HarnessManager | null;
}

export function buildMetaApiContext(deps: BuildMetaApiContextDeps) {
    return {
        conversations: createConversationsApi(deps.memory, deps.subagentManager),
        memory: createMemoryApi(deps.memory, deps.globalState),
        privacy: createPrivacyApi(
            deps.memory,
            () => {
                const privacy = loadConfig().privacy;
                return buildVisibilityDeps({
                    getGroupModel: (key: string) => deps.memory.getGroupModel(key),
                    sensitiveChats: privacy?.sensitiveChats,
                    dmAutoPrivate: privacy?.dmAutoPrivate,
                });
            },
            () => loadConfig().privacy?.allowLlmMarkSensitive !== false,
        ),
        agents: createAgentsApi(deps.subagentManager, deps.memory),
        background: createBackgroundApi(deps.getHarnessManager ?? (() => null)),
        dispatch: createDispatchApi({
            memory: deps.memory,
            globalState: deps.globalState,
            subagentManager: deps.subagentManager,
            accumulator: deps.accumulator,
            onTaskDispatched: deps.onTaskDispatched,
            groundingConfig: deps.groundingConfig,
            groundingRunner: deps.groundingRunner,
            getQuoteOutput: deps.getQuoteOutput,
            workspaceRoot: deps.workspaceRoot,
            executorFactory: deps.executorFactory,
            initializeExecutor: deps.initializeExecutor,
            taskIdFactory: deps.taskIdFactory,
            getActiveUserProfilesForChat: deps.getActiveUserProfilesForChat,
        }),
        todo: createTodoApi(deps.memory),
        remind: createReminderApi(deps.globalState),
        cron: createCronApi(deps.globalState),
    };
}
