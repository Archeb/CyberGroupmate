/**
 * modules/scene.ts — Scene 模块
 *
 * 提供当前场景信息。Agent 不再主动切换场景，框架根据角色自动注入对应的 API。
 * `current` 从 ctx._platform 动态读取（由 code-act-executor 在执行前设置）。
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";

export function installScene(env: CapabilityRegistryEnv) {
    return {
        /** 当前场景名称（从 ctx._platform 动态读取，fallback 为 "telegram"） */
        get current(): string {
            return String((env.ctx as Record<string, unknown>)._platform ?? "telegram");
        },
        /** 列出所有可用场景 */
        list: () => {
            env.emitOutput("[Available scenes: home, telegram, memory]");
        },
        /** 展示当前场景完整类型定义 */
        showFullTypes: () => {
            env.emitOutput("[Full type definitions for current scene]");
        },
    };
}
