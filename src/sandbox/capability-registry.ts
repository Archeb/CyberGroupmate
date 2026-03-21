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
    // sentHistory 持久化到 ctx 上，跨 executeCode 调用保留。
    // 原因：LLM 生成的 unawaited async 函数可能在 executeCode 返回后
    // 继续执行 sendText（"逃逸"），导致 tracker.flush() 之后的消息无法追踪。
    // 持久化 sentHistory 可以保证下一个 turn 的 isDuplicate() 检测到
    // 这些逃逸消息已发送过，从而拦截 LLM 的重复发送。
    if (!env.ctx._sentHistory) {
        env.ctx._sentHistory = new Map<string, Set<string>>();
    }
    const sentHistory = env.ctx._sentHistory as Map<string, Set<string>>;

    // 每次 executeCode 都重建 ctx.tg，确保使用当前 turn 的 env 闭包
    // （emitOutput、notifyHost 等是 per-executeCode 的局部变量）
    env.ctx.tg = createTelegramClientProxy(env, sentHistory);

    return {
        runtime: installRuntime(env),
        memory: installMemory(env),
        actions: installActions(env),
        skills: installSkills(env, sentHistory),
        scene: installScene(env),
    };
}
