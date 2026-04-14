/**
 * shared/cron.d.ts — 定时任务管理模块类型定义
 *
 * 通过 Host 侧 GlobalState 持久化 cron 任务。
 * 触发时以自然语言任务描述唤醒 agent，由 agent 自主决策执行。
 */

declare const cron: {
    /**
     * 添加持久化定时任务。触发时以自然语言任务描述唤醒 agent，agent 在当时的上下文中自主决定如何执行。
     *
     * ⚠️ taskDescription 必须是详细的自然语言描述，不是代码。
     * 写清楚：要做什么、给谁发、发什么内容、从哪里获取信息等。
     * agent 会在每次触发时收到这段描述作为新任务。
     *
     * 限制：最短间隔 1 小时，每个群最多 10 个 cron 任务。
     * 
     * 一次性定时任务请使用 runtime.remind
     *
     * @param name - 任务名称（用于显示和管理）
     * @param cronExpr - cron 表达式（最短间隔 1 小时），如 "0 9 * * *"（每天 9:00）
     * @param taskDescription - 触发时的自然语言任务描述
     * @returns 创建的任务信息
     *
     * @example
     * // 每天早上 9 点发送早安
     * await cron.add("每日早安", "0 8 * * *",
     *   "给群里发一条早安消息，可以根据当天日期说点应景的话");
     *
     * @example
     * // 工作日早 9 点播报新闻
     * await cron.add("新闻播报", "0 9 * * 1-5",
     *   "用 tavily 搜索今日科技新闻，整理成简短的播报发送到群里");
     */
    add(name: string, cronExpr: string, taskDescription: string): Promise<{ id: string }>;

    /**
     * 移除定时任务
     * @param id - 任务 ID（由 add 返回）
     *
     * @example
     * await cron.remove("some-task-id");
     */
    remove(id: string): Promise<void>;

    /**
     * 列出当前 chat 的所有定时任务
     *
     * @example
     * const tasks = await cron.list();
     * for (const t of tasks) {
     *   console.log(`${t.name} (${t.cronExpr})`);
     * }
     */
    list(): Promise<Array<{
        id: string;
        name: string;
        cronExpr: string;
    }>>;
};
