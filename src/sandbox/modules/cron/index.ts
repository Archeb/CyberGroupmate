/**
 * modules/cron.ts — 定时任务管理模块
 *
 * 通过 callHost 代理到 Host 侧的 GlobalState scheduler。
 * Cron 任务持久化在 GlobalState 中，触发时以自然语言任务描述唤醒 agent。
 */

export interface CronCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: CronCallbacks | null = null;

/**
 * 注入 Host 通信回调（由 sandbox-worker 调用）
 */
export function setCronCallbacks(callbacks: CronCallbacks): void {
    _callbacks = callbacks;
}

export const cronModule = {
    /**
     * 添加持久化定时任务。触发时以自然语言任务描述唤醒 agent，
     * agent 在当时的上下文中自主决定如何执行。
     *
     * ⚠️ taskDescription 必须是详细的自然语言描述，不是代码。
     *
     * @param name - 任务名称
     * @param cronExpr - cron 表达式（最短间隔 1 小时）
     * @param taskDescription - 触发时的任务描述（自然语言）
     */
    add: async (name: string, cronExpr: string, taskDescription: string): Promise<{
        id: string;
        items: Array<{
            id: string;
            type: "reminder" | "cron";
            description: string;
            triggerAt?: string;
            cronExpr?: string;
            taskDescription?: string;
            createdAt: string;
            triggered?: boolean;
        }>;
    }> => {
        if (!_callbacks) throw new Error("Cron module not initialized");
        const result = await _callbacks.callHost("cron.add", [name, cronExpr, taskDescription]);
        return result as {
            id: string;
            items: Array<{
                id: string;
                type: "reminder" | "cron";
                description: string;
                triggerAt?: string;
                cronExpr?: string;
                taskDescription?: string;
                createdAt: string;
                triggered?: boolean;
            }>;
        };
    },

    /**
     * 移除定时任务
     */
    remove: async (id: string): Promise<void> => {
        if (!_callbacks) throw new Error("Cron module not initialized");
        await _callbacks.callHost("cron.remove", [id]);
    },

    /**
     * 列出当前 chat 的所有定时任务
     */
    list: async (): Promise<Array<{ id: string; name: string; cronExpr: string; nextRun?: string }>> => {
        if (!_callbacks) throw new Error("Cron module not initialized");
        const result = await _callbacks.callHost("cron.list", []);
        return result as Array<{ id: string; name: string; cronExpr: string; nextRun?: string }>;
    },
};
