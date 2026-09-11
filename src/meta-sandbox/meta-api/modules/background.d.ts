/**
 * background — Background Agent（做梦系统）控制 API。
 *
 * 用于向 Background Agent 派发任务，或查询其运行状态。
 * Background Agent 在后台执行重活：写 skill、深度研究、自进化等。
 */

interface BackgroundEnqueueResult {
    queued: boolean;
    queueLength?: number;
    reason?: string;
}

interface BackgroundStatus {
    enabled: boolean;
    running?: boolean;
    queueLength?: number;
    historyCount?: number;
    harness?: string;
    consecutiveFailures?: number;
    lastError?: string | null;
}

interface BackgroundEnqueueOptions {
    actorId?: string;
    runId?: string;
    triggerReason?: string;
    sourceChatId?: string;
    sourceChatTitle?: string;
    taskId?: string;
    metadata?: Record<string, unknown>;
}

declare const background: {
    /**
     * 向 Background Agent 派发一个任务。任务会进入队列，
     * 如果没有正在运行的实例则立即拉起，否则等当前实例结束后处理。
     *
     * @param content 任务描述。写清楚需要做什么。必须是字符串——
     *   传对象（含 null/undefined）会抛 TypeError。不要写 background.enqueue({content, source})，
     *   要结构化传参请展开位置参数：background.enqueue(payload.content, payload.source, payload.options)。
     * @param source 来源标识，默认 "meta"。
     * @param options 结构化上下文，会写入 harness pending 文件，供启动后的意识流读取。
     * @returns queued=true 表示已入队；queued=false 表示 Background Agent 未配置。
     * @example
     * await background.enqueue("学到了新的搜索技巧，整理成 skill");
     * @example
     * await background.enqueue("帮露露深入查一下 Reaclisna 世界观的资料", "proactive-idle");
     */
    enqueue(content: string, source?: string, options?: BackgroundEnqueueOptions): Promise<BackgroundEnqueueResult>;

    /**
     * 查询 Background Agent 当前状态。
     *
     * @returns enabled=false 表示未配置；否则包含运行状态、队列长度、历史等。
     * @example
     * const status = await background.getStatus();
     * if (status.running) console.log("Background Agent 正在工作");
     */
    getStatus(): Promise<BackgroundStatus>;
};
