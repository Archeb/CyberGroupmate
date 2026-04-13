/**
 * modules/http.ts — HTTP Webhook 模块
 *
 * 通过 callHost 代理到 Host 侧的 Webhook 管理器。
 * Webhook 持久化在 sandbox 实例中，触发时在 sandbox 中执行 handlerCode。
 */

export interface HttpCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: HttpCallbacks | null = null;

/**
 * 注入 Host 通信回调（由 sandbox-worker 调用）
 */
export function setHttpCallbacks(callbacks: HttpCallbacks): void {
    _callbacks = callbacks;
}

export const httpModule = {
    /**
     * 注册 webhook 端点
     */
    onWebhook: async (path: string, handlerCode: string): Promise<string> => {
        if (!_callbacks) throw new Error("HTTP module not initialized");
        const result = await _callbacks.callHost("http.onWebhook", [path, handlerCode]);
        return result as string;
    },

    /**
     * 移除 webhook
     */
    removeWebhook: async (webhookId: string): Promise<void> => {
        if (!_callbacks) throw new Error("HTTP module not initialized");
        await _callbacks.callHost("http.removeWebhook", [webhookId]);
    },

    /**
     * 列出当前所有 webhook
     */
    listWebhooks: async (): Promise<Array<{ id: string; path: string }>> => {
        if (!_callbacks) throw new Error("HTTP module not initialized");
        const result = await _callbacks.callHost("http.listWebhooks", []);
        return result as Array<{ id: string; path: string }>;
    },
};
