/**
 * modules/cron.ts — 定时任务管理模块
 *
 * 通过 callHost 代理到 Host 侧的 GlobalState scheduler。
 * Cron 任务持久化在 GlobalState 中，触发时在 sandbox 中执行 code。
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
     * 添加一个持久化定时任务
     */
    add: async (name: string, cronExpr: string, code: string): Promise<{ id: string }> => {
        if (!_callbacks) throw new Error("Cron module not initialized");
        const result = await _callbacks.callHost("cron.add", [name, cronExpr, code]);
        return result as { id: string };
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
