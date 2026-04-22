/**
 * shared/todo.d.ts — 不只是代办，可以当你的记事本用。
 *
 * 用于持久化当前群的待办、规则和长期约定（比如群规、话语风格、被教导的/发现的事实性记忆）。
 * 数据按群隔离，可选设置到期时间。“定期、到期提醒”类请使用 remind 或者 cron 模块。
 */

interface TodoItem {
    key: string;
    content: string;
    dueAt: string | null;
    createdAt: string;
    updatedAt: string;
    expired: boolean;
}

declare const todo: {
    /**
     * 列出当前群的 todo。
     * @param options.includeExpired 设为 true 时包含已过期条目
     * @example
     * const items = await todo.list();
     */
    list(options?: { includeExpired?: boolean }): Promise<TodoItem[]>;

    /**
     * 获取单个 todo。
     * @example
     * const rule = await todo.get("群规");
     */
    get(key: string): Promise<TodoItem | null>;

    /**
     * 新增或更新 todo。
     * @param key 逻辑键，同群内唯一
     * @param content 内容
     * @param options.dueAt 可选到期时间，必须是 ISO 时间字符串
     * @example
     * await todo.upsert("周五提醒", "提醒大家周五 8 点开黑", {
     *   dueAt: "2026-04-24T12:00:00.000Z",
     * }); // 有到期时间，一般是阶段性的安排/规则。
     * 
     * await todo.upsert("大A昵称", "大A指的是Arc"); // 事实性记忆/规则，没有到期时间
     */
    upsert(key: string, content: string, options?: { dueAt?: string | null }): Promise<TodoItem>;

    /**
     * 删除 todo。
     * @example
     * await todo.remove("过期安排");
     */
    remove(key: string): Promise<void>;
};