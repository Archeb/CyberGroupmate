/**
 * modules/todo.ts — per-chat Todo 模块
 *
 * 通过 callHost 代理到 Host 侧的 MemoryStoreV2 todo 操作。
 * 数据存储在 SQLite 中，per-chat 隔离。
 */

export interface TodoCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: TodoCallbacks | null = null;

/**
 * 注入 Host 通信回调（由 sandbox-worker 调用）
 */
export function setTodoCallbacks(callbacks: TodoCallbacks): void {
    _callbacks = callbacks;
}

export const todoModule = {
    /**
     * 读取单个 todo
     */
    get: async (key: string): Promise<{
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    } | null> => {
        if (!_callbacks) throw new Error("Todo module not initialized");
        const result = await _callbacks.callHost("todo.get", [key]);
        return result as {
            key: string;
            content: string;
            dueAt: string | null;
            createdAt: string;
            updatedAt: string;
            expired: boolean;
        } | null;
    },

    /**
     * 列出 todo
     */
    list: async (options?: { includeExpired?: boolean }): Promise<Array<{
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    }>> => {
        if (!_callbacks) throw new Error("Todo module not initialized");
        const result = await _callbacks.callHost("todo.list", [options]);
        return result as Array<{
            key: string;
            content: string;
            dueAt: string | null;
            createdAt: string;
            updatedAt: string;
            expired: boolean;
        }>;
    },

    /**
     * 新增或更新 todo
     */
    upsert: async (key: string, content: string, options?: { dueAt?: string | null }): Promise<{
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    }> => {
        if (!_callbacks) throw new Error("Todo module not initialized");
        const result = await _callbacks.callHost("todo.upsert", [key, content, options]);
        return result as {
            key: string;
            content: string;
            dueAt: string | null;
            createdAt: string;
            updatedAt: string;
            expired: boolean;
        };
    },

    /**
     * 删除 todo
     */
    remove: async (key: string): Promise<void> => {
        if (!_callbacks) throw new Error("Todo module not initialized");
        await _callbacks.callHost("todo.remove", [key]);
    },
};
