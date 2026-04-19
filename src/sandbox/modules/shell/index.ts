/**
 * modules/shell/index.ts — Shell 模块（Worker 侧）
 *
 * 通过 callHost 将所有 shell 操作代理到 Host 侧的 Sandbox PTY 管理器。
 */

interface ShellCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: ShellCallbacks | null = null;

export function setShellCallbacks(callbacks: ShellCallbacks): void {
    _callbacks = callbacks;
}

export function installShell() {
    return {
        listTabs: async (): Promise<Array<{ id: string; state: "idle" | "busy"; recentOutput: string }>> => {
            if (!_callbacks) throw new Error("Shell not initialized");
            return (await _callbacks.callHost("shell.listTabs")) as Array<{
                id: string;
                state: "idle" | "busy";
                recentOutput: string;
            }>;
        },
        detach: async (newTabId: string): Promise<void> => {
            if (!_callbacks) throw new Error("Shell not initialized");
            await _callbacks.callHost("shell.detach", [newTabId]);
        },
        read: async (tabId?: string, lines?: number): Promise<string> => {
            if (!_callbacks) throw new Error("Shell not initialized");
            return (await _callbacks.callHost("shell.read", [tabId, lines])) as string;
        },
        sendInput: async (input: string, tabId?: string): Promise<void> => {
            if (!_callbacks) throw new Error("Shell not initialized");
            await _callbacks.callHost("shell.sendInput", [input, tabId]);
        },
        kill: async (tabId?: string): Promise<void> => {
            if (!_callbacks) throw new Error("Shell not initialized");
            await _callbacks.callHost("shell.kill", [tabId]);
        },
        cwd: async (): Promise<string> => {
            if (!_callbacks) throw new Error("Shell not initialized");
            return (await _callbacks.callHost("shell.cwd")) as string;
        },
    };
}
