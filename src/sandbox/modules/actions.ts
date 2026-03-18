/**
 * modules/actions.ts — Actions 模块
 *
 * 通过 callHost 转发 getTopicContext, listActiveTopics, recallForTopic 调用到 Host 进程。
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";

export function installActions(env: CapabilityRegistryEnv) {
    return {
        getTopicContext: async (topicId: string) =>
            env.callHost("actions.getTopicContext", [topicId]),
        listActiveTopics: async (chatId?: string) =>
            env.callHost("actions.listActiveTopics", [chatId]),
        recallForTopic: async (topicId: string, options?: Record<string, unknown>) =>
            env.callHost("actions.recallForTopic", [topicId, options]),
    };
}
