/**
 * modules/runtime.ts — Runtime 模块
 *
 * 提供 notify, input, print, spawn, kill, ps, remind 等系统级能力。
 */

import type { CapabilityRegistryEnv } from "../../capability-registry.js";

/** Runtime 回调（由 sandbox-worker 注入） */
interface RuntimeCallbacks {
    spawnPersistent: (name: string, code: string) => void;
    getHome: () => string;
    getWorkspace: () => string;
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

let _callbacks: RuntimeCallbacks | null = null;

export function setRuntimeCallbacks(callbacks: RuntimeCallbacks): void {
    _callbacks = callbacks;
}

export function installRuntime(env: CapabilityRegistryEnv) {
    return {
        notify: env.notifyHost,
        input: env.requestInput,
        print: env.printToHost,
        resetShell: async () => {
            if (!_callbacks) throw new Error("Runtime not initialized");
            await _callbacks.callHost("runtime.resetShell");
        },
        spawn: env.spawnTask,
        kill: env.killTask,
        ps: env.listTasks,
        spawnPersistent: (name: string, code: string) => {
            if (!_callbacks) throw new Error("Runtime not initialized");
            _callbacks.spawnPersistent(name, code);
        },
        home: () => _callbacks ? _callbacks.getHome() : process.cwd(),
        workspace: () => _callbacks ? _callbacks.getWorkspace() : process.cwd(),
        env: {
            list: async (): Promise<Array<{ key: string; value: string; scope: "both" | "host" | "sandbox" }>> => {
                if (!_callbacks) throw new Error("Runtime not initialized");
                const result = await _callbacks.callHost("runtime.env.list");
                return result as Array<{ key: string; value: string; scope: "both" | "host" | "sandbox" }>;
            },
            get: async (key: string): Promise<{ key: string; value: string; scope: "both" | "host" | "sandbox" } | null> => {
                if (!_callbacks) throw new Error("Runtime not initialized");
                const result = await _callbacks.callHost("runtime.env.get", [key]);
                return (result as { key: string; value: string; scope: "both" | "host" | "sandbox" } | null) ?? null;
            },
            set: async (
                key: string,
                value: string,
                scope: "both" | "host" | "sandbox" = "both",
            ): Promise<{ ok: true; key: string; value: string; scope: "both" | "host" | "sandbox" }> => {
                if (!_callbacks) throw new Error("Runtime not initialized");
                const result = await _callbacks.callHost("runtime.env.set", [key, value, scope]);
                return result as { ok: true; key: string; value: string; scope: "both" | "host" | "sandbox" };
            },
            delete: async (key: string): Promise<{ ok: true; deleted: boolean }> => {
                if (!_callbacks) throw new Error("Runtime not initialized");
                const result = await _callbacks.callHost("runtime.env.delete", [key]);
                return result as { ok: true; deleted: boolean };
            },
        },

        /**
         * 设置一次性定时提醒（自然语言）。
         * 到期后 agent 将被唤醒并收到 description 作为新任务。
         *
         * @param description - 详细的自然语言任务描述（到期时 agent 会据此决策）
         * @param delayMinutes - 延迟分钟数（1 ~ 525600，即 365 天）
         * @returns { reminderId, triggerAt }
         */
        remind: async (description: string, delayMinutes: number): Promise<{ reminderId: string; triggerAt: string }> => {
            if (!_callbacks) throw new Error("Runtime not initialized");
            const result = await _callbacks.callHost("runtime.remind", [description, delayMinutes]);
            return result as { reminderId: string; triggerAt: string };
        },
    };
}
