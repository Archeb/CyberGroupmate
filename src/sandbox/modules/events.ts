/**
 * modules/events.ts — 事件监听器模块
 *
 * 通过 callHost 将注册信息传递到 Host 侧的 Sandbox。
 * Host 侧 Sandbox 维护 eventListeners Map 并进行事件匹配和转发。
 */

export interface EventsCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: EventsCallbacks | null = null;

/**
 * 注入 Host 通信回调（由 sandbox-worker 调用）
 */
export function setEventsCallbacks(callbacks: EventsCallbacks): void {
    _callbacks = callbacks;
}

export const eventsModule = {
    /**
     * 注册事件监听器
     */
    on: async (typePrefix: string, handlerCode: string): Promise<string> => {
        if (!_callbacks) throw new Error("Events module not initialized");
        const result = await _callbacks.callHost("events.on", [typePrefix, handlerCode]);
        return result as string;
    },

    /**
     * 移除监听器
     */
    off: async (listenerId: string): Promise<void> => {
        if (!_callbacks) throw new Error("Events module not initialized");
        await _callbacks.callHost("events.off", [listenerId]);
    },

    /**
     * 列出当前监听器
     */
    list: async (): Promise<Array<{ id: string; typePrefix: string }>> => {
        if (!_callbacks) return [];
        const result = await _callbacks.callHost("events.list", []);
        return result as Array<{ id: string; typePrefix: string }>;
    },
};
