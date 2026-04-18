/**
 * modules/kv.ts — 持久化键值存储模块
 *
 * 通过 callHost 代理到 Host 侧的 MemoryStoreV2 KV 操作。
 * 数据存储在 SQLite 中，per-chat 隔离。
 */

export interface KvCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: KvCallbacks | null = null;

/**
 * 注入 Host 通信回调（由 sandbox-worker 调用）
 */
export function setKvCallbacks(callbacks: KvCallbacks): void {
    _callbacks = callbacks;
}

export const kvModule = {
    /**
     * 读取键值
     */
    get: async (key: string): Promise<string | null> => {
        if (!_callbacks) throw new Error("KV module not initialized");
        const result = await _callbacks.callHost("kv.get", [key]);
        return result as string | null;
    },

    /**
     * 写入键值
     */
    set: async (key: string, value: string, ttlSeconds?: number): Promise<void> => {
        if (!_callbacks) throw new Error("KV module not initialized");
        await _callbacks.callHost("kv.set", [key, value, ttlSeconds]);
    },

    /**
     * 删除键
     */
    del: async (key: string): Promise<void> => {
        if (!_callbacks) throw new Error("KV module not initialized");
        await _callbacks.callHost("kv.del", [key]);
    },

    /**
     * 列出键名
     */
    keys: async (prefix?: string): Promise<string[]> => {
        if (!_callbacks) throw new Error("KV module not initialized");
        const result = await _callbacks.callHost("kv.keys", [prefix]);
        return result as string[];
    },
};
