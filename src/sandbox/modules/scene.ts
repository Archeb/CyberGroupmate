/**
 * modules/scene.ts — Scene 模块
 *
 * 提供当前场景信息。Agent 不再主动切换场景，框架根据角色自动注入对应的 API。
 * `current` 从 capability-registry 的 getPlatformValue() 动态读取。
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";
import { getPlatformValue } from "../capability-registry.js";

export function installScene(_env: CapabilityRegistryEnv) {
    return {
        /** 当前场景名称（从 capability-registry 内部状态动态读取） */
        get current(): string {
            return getPlatformValue();
        },
        /** 列出所有可用场景 */
        list: () => {
            _env.emitOutput("[Available scenes: home, telegram, memory]");
        },
        /** 展示当前场景完整类型定义 */
        showFullTypes: () => {
            _env.emitOutput("[Full type definitions for current scene]");
        },
    };
}
