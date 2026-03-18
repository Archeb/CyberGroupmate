/**
 * capability-registry.ts — Sandbox 能力注册入口
 *
 * 从 modules/ 导入各模块的 install 函数，统一注册到 sandbox 环境。
 * 每个模块的实现细节在各自的文件中，这里只负责编排。
 */

import { installRuntime } from "./modules/runtime.js";
import { installMemory } from "./modules/memory.js";
import { installActions } from "./modules/actions.js";
import { installSkills } from "./modules/skills.js";
import { installScene } from "./modules/scene.js";
import { createTelegramClientProxy } from "./modules/telegram.js";

// ─── 环境接口 ───

export interface CapabilityRegistryEnv {
    ctx: Record<string, unknown>;
    emitOutput: (line: string) => void;
    notifyHost: (event: Record<string, unknown>) => void;
    requestInput: (prompt: string) => Promise<string>;
    printToHost: (message: string) => void;
    spawnTask: (name: string, fn: (signal: AbortSignal) => Promise<void>) => void;
    killTask: (name: string) => void;
    listTasks: () => string[];
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

// ─── 注册入口 ───

export function installCapabilityRegistry(env: CapabilityRegistryEnv): Record<string, unknown> {
    // 创建 session 级别的发送历史，用于去重检测
    const sentHistory = new Map<string, Set<string>>();

    // 挂载 ctx.tg（Telegram 客户端代理）
    if (!env.ctx.tg) {
        env.ctx.tg = createTelegramClientProxy(env, sentHistory);
    }

    return {
        runtime: installRuntime(env),
        memory: installMemory(env),
        actions: installActions(env),
        skills: installSkills(env, sentHistory),
        scene: installScene(env),
    };
}
