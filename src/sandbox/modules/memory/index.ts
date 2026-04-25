/**
 * modules/memory.ts — 记忆检索模块
 *
 * 通过 callHost 代理到 Host 侧的 MemoryStoreV2 检索能力。
 */

export interface MemoryCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: MemoryCallbacks | null = null;

export function setMemoryCallbacks(callbacks: MemoryCallbacks): void {
    _callbacks = callbacks;
}

export const memoryModule = {
    searchFacts: async (query: string, options?: {
        subject?: string;
        categories?: string[];
        limit?: number;
    }) => {
        if (!_callbacks) throw new Error("Memory module not initialized");
        const result = await _callbacks.callHost("memory.searchFacts", [query, options]);
        return result as Array<Record<string, unknown>>;
    },

    searchTopics: async (query: string, options?: {
        chatId?: string;
        after?: string;
        before?: string;
        limit?: number;
    }) => {
        if (!_callbacks) throw new Error("Memory module not initialized");
        const result = await _callbacks.callHost("memory.searchTopics", [query, options]);
        return result as Array<Record<string, unknown>>;
    },

    searchMessages: async (query: string, options?: {
        chatId?: string;
        userId?: string;
        after?: string;
        before?: string;
        limit?: number;
    }) => {
        if (!_callbacks) throw new Error("Memory module not initialized");
        const result = await _callbacks.callHost("memory.searchMessages", [query, options]);
        return result as Array<Record<string, unknown>>;
    },

    getUserProfile: async (userId: string, chatId?: string) => {
        if (!_callbacks) throw new Error("Memory module not initialized");
        const result = await _callbacks.callHost("memory.getUserProfile", [userId, chatId]);
        return result as Record<string, unknown>;
    },

    getRecentInteractions: async (chatId?: string, userId?: string, limit?: number) => {
        if (!_callbacks) throw new Error("Memory module not initialized");
        const result = await _callbacks.callHost("memory.getRecentInteractions", [chatId, userId, limit]);
        return result as Array<Record<string, unknown>>;
    },

    semanticSearch: async (query: string, options?: {
        scope?: "facts" | "topics" | "all";
        limit?: number;
    }) => {
        if (!_callbacks) throw new Error("Memory module not initialized");
        const result = await _callbacks.callHost("memory.semanticSearch", [query, options]);
        return result as Array<Record<string, unknown>>;
    },
};