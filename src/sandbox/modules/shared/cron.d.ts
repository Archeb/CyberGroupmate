/**
 * shared/cron.d.ts — 定时任务管理模块类型定义
 *
 * 通过 Host 侧 GlobalState 持久化 cron 任务。
 * 触发时在对应 sandbox 中执行 code 字符串。
 */

declare const cron: {
    /**
     * 添加一个持久化定时任务（cron 表达式）。
     * 任务以代码字符串形式存储，触发时在 sandbox 中执行。
     *
     * @param name - 任务名称（用于显示和管理）
     * @param cronExpr - cron 表达式，如 "0 9 * * *"（每天 9:00）、"*/5 * * * *"（每 5 分钟）
     * @param code - 触发时执行的 JavaScript 代码字符串
     * @returns 创建的任务信息
     *
     * @example
     * // 每天早上 9 点发送天气播报
     * const task = await cron.add("daily-weather", "0 9 * * *", `
     *   const weather = await fetch("https://api.weather.com/today").then(r => r.json());
     *   await telegram.sendText(chatId, "☀️ 今日天气: " + weather.summary);
     * `);
     * console.log("已创建:", task.id);
     *
     * @example
     * // 每 30 分钟检查一次
     * await cron.add("health-check", "*/30 * * * *", `
     *   console.log("健康检查 at " + new Date().toISOString());
     * `);
     */
    add(name: string, cronExpr: string, code: string): Promise<{ id: string }>;

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
     *   console.log(`${t.name} (${t.cronExpr}) → next: ${t.nextRun}`);
     * }
     */
    list(): Promise<Array<{
        id: string;
        name: string;
        cronExpr: string;
        nextRun?: string;
    }>>;
};
