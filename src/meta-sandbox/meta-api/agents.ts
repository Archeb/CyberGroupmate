import { getGroupModelKey } from "../../core/chat-id.js";
import type { IMemoryStoreV2 } from "../../memory-v2/index.js";
import type { StickinessLevel } from "../../subagent/types.js";

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

type SubagentManagerReader = {
    getAllSubagents: () => SubagentReader[];
};
type MemoryReader = Pick<IMemoryStoreV2, "getGroupModel">;

export function createAgentsApi(subagentManager: SubagentManagerReader, memory: MemoryReader) {
    return {
        listStatus: async (): Promise<AgentStatus[]> => {
            return subagentManager.getAllSubagents()
                .map((subagent) => toAgentStatus(subagent as SubagentReader, memory))
                .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
        },
    };
}

function toAgentStatus(subagent: SubagentReader, memory: MemoryReader): AgentStatus {
    const groupModel = memory.getGroupModel(getGroupModelKey(subagent.chatId));

    return {
        chatId: subagent.chatId,
        chatTitle: groupModel?.chatTitle || undefined,
        queueSize: subagent.codeActExecutor?.getQueueSize?.() ?? 0,
        isProcessing: subagent.codeActExecutor?.isProcessing?.() ?? false,
        lastActiveAt: new Date(subagent.lastActivityAt).toISOString(),
        stickinessLevel: subagent.stickiness?.level ?? "STRANGER",
    };
}