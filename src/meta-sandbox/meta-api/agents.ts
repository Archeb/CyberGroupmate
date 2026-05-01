import type { StickinessLevel } from "../../subagent/types.js";
import type { SubagentManager } from "../../subagent/subagent-manager.js";

export interface AgentStatus {
    chatId: string;
    chatTitle?: string;
    queueSize: number;
    isProcessing: boolean;
    lastActiveAt: string;
    stickinessLevel: StickinessLevel;
}

type ExecutorReader = {
    getQueueSize?: () => number;
    isProcessing?: () => boolean;
};

type SubagentReader = {
    chatId: string;
    lastActivityAt: number;
    stickiness?: {
        level?: StickinessLevel;
    };
    codeActExecutor?: ExecutorReader | null;
};

type SubagentManagerReader = Pick<SubagentManager, "getAllSubagents">;

export function createAgentsApi(subagentManager: SubagentManagerReader) {
    return {
        listStatus: async (): Promise<AgentStatus[]> => {
            return subagentManager.getAllSubagents()
                .map((subagent) => toAgentStatus(subagent as SubagentReader))
                .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
        },
    };
}

function toAgentStatus(subagent: SubagentReader): AgentStatus {
    return {
        chatId: subagent.chatId,
        queueSize: subagent.codeActExecutor?.getQueueSize?.() ?? 0,
        isProcessing: subagent.codeActExecutor?.isProcessing?.() ?? false,
        lastActiveAt: new Date(subagent.lastActivityAt).toISOString(),
        stickinessLevel: subagent.stickiness?.level ?? "STRANGER",
    };
}