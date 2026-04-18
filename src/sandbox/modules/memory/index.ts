/**
 * modules/memory.ts — Memory 模块
 *
 * 通过 callHost 转发 recall, browseHistory, reflect 调用到 Host 进程。
 */

import type { CapabilityRegistryEnv } from "../../capability-registry.js";

export function installMemory(env: CapabilityRegistryEnv) {
    return {
        recall: async (query: string, options?: Record<string, unknown>) =>
            env.callHost("memory.recall", [query, options]),
        browseHistory: async (request: Record<string, unknown>) =>
            env.callHost("memory.browseHistory", [request]),
        reflect: async (chatId: string) =>
            env.callHost("memory.reflect", [chatId]),
    };
}
