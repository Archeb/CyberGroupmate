/**
 * modules/runtime.ts — Runtime 模块
 *
 * 提供 notify, input, print, spawn, kill, ps 等系统级能力。
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";

/** 持久化任务启动器（由 sandbox-worker 注入） */
let _spawnPersistent: ((name: string, code: string) => void) | null = null;
/** home() 返回值（由 sandbox-worker 注入） */
let _getHome: (() => string) | null = null;
/** workspace() 返回值（由 sandbox-worker 注入） */
let _getWorkspace: (() => string) | null = null;

export function setRuntimeCallbacks(callbacks: {
    spawnPersistent: (name: string, code: string) => void;
    getHome: () => string;
    getWorkspace: () => string;
}): void {
    _spawnPersistent = callbacks.spawnPersistent;
    _getHome = callbacks.getHome;
    _getWorkspace = callbacks.getWorkspace;
}

export function installRuntime(env: CapabilityRegistryEnv) {
    return {
        notify: env.notifyHost,
        input: env.requestInput,
        print: env.printToHost,
        spawn: env.spawnTask,
        kill: env.killTask,
        ps: env.listTasks,
        spawnPersistent: (name: string, code: string) => {
            if (!_spawnPersistent) throw new Error("Runtime not initialized");
            _spawnPersistent(name, code);
        },
        home: () => _getHome ? _getHome() : process.cwd(),
        workspace: () => _getWorkspace ? _getWorkspace() : process.cwd(),
    };
}
