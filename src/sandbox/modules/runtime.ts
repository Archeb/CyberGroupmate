/**
 * modules/runtime.ts — Runtime 模块
 *
 * 提供 notify, input, print, spawn, kill, ps 等系统级能力。
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";

export function installRuntime(env: CapabilityRegistryEnv) {
    return {
        notify: env.notifyHost,
        input: env.requestInput,
        print: env.printToHost,
        spawn: env.spawnTask,
        kill: env.killTask,
        ps: env.listTasks,
    };
}
