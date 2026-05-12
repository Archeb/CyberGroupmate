/**
 * agents — Meta 下属状态查询 API。
 *
 * 用于查看各群 Subagent 队列、处理状态和最近活跃时间，帮助 Meta 决定派发优先级。
 */

interface AgentStatus {
    chatId: string;
    /** 群标题 / 私聊对象名。 */
    chatTitle?: string;
    /** Q4 积压任务数。 */
    queueSize: number;
    /** 当前是否在执行。 */
    isProcessing: boolean;
    /** 最后活跃时间，ISO 字符串。 */
    lastActiveAt: string;
    stickinessLevel: "CORE" | "FAMILIAR" | "ACQUAINTANCE" | "STRANGER";
}

declare const agents: {
    /**
     * 查询所有下属 Subagent 的当前状态。
     *
     * @returns 按最近活跃时间排序的 Subagent 状态列表。
     * @example
     * const statuses = await agents.listStatus();
     * console.log(statuses.map(s => `${s.chatId}: queue=${s.queueSize}`));
     */
    listStatus(): Promise<AgentStatus[]>;
};
