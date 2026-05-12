/**
 * capability-registry.ts — Sandbox 能力注册入口
 *
 * 从 modules/ 导入各模块的 install 函数，统一注册到 sandbox 环境。
 * 每个模块的实现细节在各自的文件中，这里只负责编排。
 */

import { installRuntime } from "./modules/runtime/index.js";
import { installSkills } from "./modules/skills/index.js";
import { createTelegramClientProxy } from "./modules/telegram/index.js";
import { createDiscordClientProxy } from "./modules/discord/index.js";
import { createOneBotClientProxy } from "./modules/onebot/index.js";

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

// ─── 内部状态（跨 executeCode 持久化，不暴露给 LLM） ───

/** 全局重复消息去重 Map（per-worker 生命周期） */
let sentHistory: Map<string, Set<string>> | null = null;

/** 当前平台标识（由 host 在执行前设置） */
let currentPlatform: string = "telegram";

/** 当前 worker 是否启用重复发送拦截。默认开启。 */
let currentDeduplicateSentMessages = true;

/** 设置当前平台（由 sandbox-worker 调用） */
export function setPlatform(platform: string): void {
    currentPlatform = platform;
}

/** 设置重复发送拦截开关（由 sandbox-worker 调用）。 */
export function setDuplicateMessageBlocking(enabled: boolean): void {
    currentDeduplicateSentMessages = enabled !== false;
}

/** 获取当前平台（供 scene.ts 等内部模块使用） */
export function getPlatformValue(): string {
    return currentPlatform;
}

// ─── 注册入口 ───

export function installCapabilityRegistry(env: CapabilityRegistryEnv): Record<string, unknown> {
    // sentHistory 在 worker 生命周期内持久化（跨 executeCode 调用保留）。
    // 原因：LLM 生成的 unawaited async 函数可能在 executeCode 返回后
    // 继续执行 sendText（"逃逸"），导致 tracker.flush() 之后的消息无法追踪。
    // 持久化 sentHistory 可以保证下一个 turn 的 isDuplicate() 检测到
    // 这些逃逸消息已发送过，从而拦截 LLM 的重复发送。
    if (!sentHistory) {
        sentHistory = new Map<string, Set<string>>();
    }

    // 每次 executeCode 都重建平台 proxy，确保使用当前 turn 的 env 闭包
    // （emitOutput、notifyHost 等是 per-executeCode 的局部变量）
    const platform = currentPlatform;
    let telegram: unknown = undefined;
    let discord: unknown = undefined;
    let onebot: unknown = undefined;

    if (platform === "discord") {
        discord = createDiscordClientProxy(env, sentHistory, currentDeduplicateSentMessages);
    } else if (platform === "onebot") {
        onebot = createOneBotClientProxy(env, sentHistory, currentDeduplicateSentMessages);
    } else {
        // 默认 telegram（向后兼容）
        telegram = createTelegramClientProxy(env, sentHistory, currentDeduplicateSentMessages);
    }

    return {
        runtime: installRuntime(env),
        skills: installSkills(env, sentHistory, currentDeduplicateSentMessages),
        telegram,
        discord,
        onebot,
    };
}
