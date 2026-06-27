/**
 * modules/privacy.ts — 隐私分级模块
 *
 * 通过 callHost 代理到 Host 侧的全局 visibility 兜底。让 agent 可以把某个会话
 * 标记为敏感/私密（只进不出），以及查询某会话当前的 visibility 状态。
 */

export interface PrivacyCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: PrivacyCallbacks | null = null;

export function setPrivacyCallbacks(callbacks: PrivacyCallbacks): void {
    _callbacks = callbacks;
}

export const privacyModule = {
    markSensitive: async (chatId?: string, reason?: string): Promise<{
        chatId: string;
        visibility: "private" | "shared";
        markedSensitive: boolean;
        reason?: string;
    }> => {
        if (!_callbacks) throw new Error("Privacy module not initialized");
        const result = await _callbacks.callHost("privacy.markSensitive", [chatId, reason]);
        return result as { chatId: string; visibility: "private" | "shared"; markedSensitive: boolean; reason?: string };
    },

    status: async (chatId?: string): Promise<{
        chatId: string;
        visibility: "private" | "shared";
        isDirectMessage: boolean;
        markedSensitive: boolean;
        reason?: string;
        source: "dm" | "config" | "marked" | "none";
    }> => {
        if (!_callbacks) throw new Error("Privacy module not initialized");
        const result = await _callbacks.callHost("privacy.status", [chatId]);
        return result as {
            chatId: string;
            visibility: "private" | "shared";
            isDirectMessage: boolean;
            markedSensitive: boolean;
            reason?: string;
            source: "dm" | "config" | "marked" | "none";
        };
    },
};
