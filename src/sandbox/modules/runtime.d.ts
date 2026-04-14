/**
 * shared/runtime.d.ts — 所有 scene 共享的 runtime 能力
 */

declare const runtime: {
    /** 推送事件到通知中心 */
    notify(event: { type: string; [key: string]: unknown }): void;

    /** 请求用户输入 */
    input(prompt: string): Promise<string>;

    /** 直接打印到宿主 */
    print(msg: string): void;

    /** 启动一个命名后台任务 */
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void;

    /**
     * 启动持久化后台任务（Worker 重启后自动恢复）。
     * 代码以字符串形式存储，触发时在 sandbox 中执行。
     * 代码中可通过 `signal` 变量访问 AbortSignal。
     *
     * @param name - 任务名称（唯一标识，同名会替换）
     * @param code - JavaScript 代码字符串
     *
     * @example
     * runtime.spawnPersistent("monitor", `
     *   while (!signal.aborted) {
     *     console.log("heartbeat at " + new Date().toISOString());
     *     await new Promise(r => setTimeout(r, 60000));
     *   }
     * `);
     */
    spawnPersistent(name: string, code: string): void;

    /** 停止一个后台任务（同时清除持久化记录） */
    kill(name: string): void;

    /** 列出后台任务 */
    ps(): string[];

    /** 返回当前 sandbox 的 home 目录路径（per-chat 隔离） */
    home(): string;

    /** 返回 workspace 根目录路径 */
    workspace(): string;

    /**
     * 设置一次性定时提醒（自然语言）。到期后 agent 将被唤醒并收到 description 作为新任务。重复定时提醒请用 cron
     *
     * ⚠️ description 必须是详细的自然语言描述，不是代码。
     * 写清楚：要做什么、给谁发、发什么内容、如何获取信息等。
     *
     * 限制：最短 1 分钟，最长 365 天，每个群最多 10 个活跃提醒。
     *
     * @param description - 详细的自然语言任务描述
     * @param delayMinutes - 延迟分钟数（1 ~ 525600，即 365 天）
     * @returns { reminderId, triggerAt }
     *
     * @example
     * // 3 分钟后提醒
     * await runtime.remind("提醒群友该起床了，用活泼的语气叫他", 3);
     *
     * @example
     * // 1 小时后提醒
     * await runtime.remind("用 tavily 搜索刚才讨论的那个开源项目的最新版本，然后把结果发到群里", 60);
     */
    remind(description: string, delayMinutes: number): Promise<{ reminderId: string; triggerAt: string }>;
};
