/**
 * dispatch — Meta 任务派发 API。
 *
 * Meta 不能直接发消息；所有写操作必须通过 dispatch.taskToGroup() 派发给目标群的 Subagent。
 */

interface DispatchTrackingSpec {
    /** 默认 dispatch:<taskId>。 */
    key?: string;
    /** 待跟进内容。 */
    content: string;
    /** 若设置，则自动注册一次性唤醒。 */
    remindAfterMinutes?: number;
    /** reminder 唤醒后给 Meta 的明确动作。 */
    callback?: string;
    /** 附带结构化数据。 */
    data?: unknown;
}

interface DispatchTaskSpec {
    /** 必填：行动方向，告诉 Subagent 往哪个方向回复或互动。 */
    contentDirection: string;
    /** 语气指导，如轻松、正式、简短等。 */
    toneGuidance?: string;
    /** 建议用于召回可发送贴纸的 emoji 候选，如 ["😂", "🤣", "😅"]。 */
    suggestedEmojis?: string[];
    /** 跨群上下文，会直接注入给 Subagent 的 prompt。 */
    context?: unknown;
    /** 需要额外加载的 Skill 模块名。基础模块不需要重复填写。 */
    useSkills?: string[];
    /** 派发后自动记录待跟进 todo / remind。 */
    tracking?: DispatchTrackingSpec;
}

interface DispatchTaskResult {
    taskId: string;
    trackingKey?: string;
    reminderId?: string;
}

interface DispatchedTaskStatus {
    taskId: string;
    chatId: string;
    contentDirection: string;
    toneGuidance?: string;
    status: "PENDING" | "RUNNING" | "COMPLETED" | "ERROR" | "SKIPPED" | "TIMEOUT";
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    sessionId?: string;
    summary?: string;
    sentMessages?: Array<{ messageId?: string; text: string; timestamp: string }>;
    error?: string;
}

declare const dispatch: {
    /**
     * 向指定群组派发一个任务，由该群的 Subagent 执行回复、reaction 或其他群内行动。
     *
     * chatId 必须使用注意力切换头部里的 composite chatId，例如 "telegram:-1001234567890"。
     * dispatch 会自动将 context 序列化后注入 Subagent 的任务 prompt。
     * 当派发的是提问、跨群转述、等待群友回应或重要回复时，优先在同一次调用里填写 tracking。
     *
     * @param chatId 目标 composite chatId。
     * @param taskSpec 任务方向、语气、上下文、技能和跟踪信息。
     * @returns 派发任务 ID，以及可选的 trackingKey / reminderId。
     * @example
     * const task = await dispatch.taskToGroup("telegram:-1001111111111", {
     *   contentDirection: "回答关于 API 网关选型的问题，参考 context 中的跨群讨论结论",
     *   toneGuidance: "专业但不生硬，给出结论同时简要解释理由",
     *   suggestedEmojis: ["🤔", "💡", "👍"],
     *   context: { source: "memory", summary: "D 群倾向 Kong" },
     *   tracking: {
     *     content: "等待 C 群 API 网关回复后的后续反馈",
     *     remindAfterMinutes: 15,
     *     callback: "检查 C 群 API 网关选型回复结果；如果有追问，决定是否再次派发。"
     *   }
     * });
     * console.log(task.taskId, task.trackingKey, task.reminderId);
     */
    taskToGroup(chatId: string, taskSpec: DispatchTaskSpec): Promise<DispatchTaskResult>;

    /**
     * 查询已派发任务的原始方向、上下文和执行结果。
     *
     * 后续如果只拿到 callback 的 taskId，需要回看原始任务方向、上下文或 Subagent 的 summary 时使用。
     *
     * @param taskId 派发任务 ID。
     * @returns 任务状态；不存在时返回 null。
     * @example
     * const task = await dispatch.getTask("task-123");
     * console.log(task?.status, task?.summary);
     */
    getTask(taskId: string): Promise<DispatchedTaskStatus | null>;

    /**
     * 列出已派发任务。
     *
     * @param options 可按 chatId、status、limit、offset 过滤。
     * @returns 任务分页结果。
     * @example
     * const running = await dispatch.listTasks({ status: "RUNNING", limit: 10 });
     * console.log(running.total);
     */
    listTasks(options?: { chatId?: string; status?: string; limit?: number; offset?: number }): Promise<{
        tasks: DispatchedTaskStatus[];
        total: number;
        hasMore: boolean;
    }>;
};
