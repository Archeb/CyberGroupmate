/**
 * shared/actions.d.ts — 所有 scene 共享的 actions 能力
 */

declare const actions: {
    /** 获取某个话题的结构化上下文 */
    getTopicContext(topicId: string): Promise<Record<string, unknown> | null>;

    /** 列出当前活跃话题 */
    listActiveTopics(chatId?: string): Promise<Array<Record<string, unknown> | null>>;

    /** 以话题为中心触发一次记忆检索 */
    recallForTopic(topicId: string, options?: Record<string, unknown>): Promise<unknown>;
};
