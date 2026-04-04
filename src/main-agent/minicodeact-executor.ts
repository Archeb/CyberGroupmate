/**
 * minicodeact-executor.ts — MiniCodeAct 中央执行器
 *
 * 路由 "namespace.method" 调用到具体处理函数，
 * 提供限流和异常隔离。
 */

import type { MiniCodeActCall, MiniCodeActResult } from "../subagent/types.js";
import type { GlobalState } from "./global-state.js";
import type { MemoryStoreV2 } from "../memory-v2/memory-v2.js";
import type { DynamicAttentionQueue } from "../subagent/attention-queue.js";
import type { SubagentManager } from "../subagent/subagent-manager.js";

/** 每次 attend 最多执行的 MiniCodeAct 数量 */
const MAX_PER_ATTEND = 8;

/** 执行器依赖 */
export interface MiniCodeActDeps {
    globalState: GlobalState;
    memory: MemoryStoreV2;
    attentionQueue: DynamicAttentionQueue;
    subagentManager: SubagentManager;
}

/** 单个处理器签名 */
export type MiniCodeActHandler = {
    (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps): unknown;
    /** 返回人类可读的调用描述 */
    describe(args: Record<string, unknown>): string;
};

/** namespace → { method → handler } 映射表 */
const HANDLER_MAP: Record<string, Record<string, MiniCodeActHandler>> = {};

/**
 * 注册处理器（每个命名空间模块调用一次）。
 */
export function registerHandlers(
    namespace: string,
    handlers: Record<string, MiniCodeActHandler>,
): void {
    HANDLER_MAP[namespace] = { ...HANDLER_MAP[namespace], ...handlers };
}

/**
 * 获取当前已注册的所有命名空间（测试用）。
 */
export function getRegisteredNamespaces(): string[] {
    return Object.keys(HANDLER_MAP);
}

/**
 * 清除所有已注册的处理器（测试用）。
 */
export function clearHandlers(): void {
    for (const key of Object.keys(HANDLER_MAP)) {
        delete HANDLER_MAP[key];
    }
}

/**
 * 执行 MiniCodeAct 调用列表。
 *
 * - 限流：每次最多 MAX_PER_ATTEND 条
 * - 异常隔离：单个 handler 失败不影响后续
 * - 未知 namespace/method 返回 success: false
 */
export function executeMiniCodeActs(
    calls: MiniCodeActCall[],
    chatId: string,
    deps: MiniCodeActDeps,
): MiniCodeActResult[] {
    const limited = calls.slice(0, MAX_PER_ATTEND);
    const results: MiniCodeActResult[] = [];

    for (const call of limited) {
        const dotIdx = call.call.indexOf(".");
        if (dotIdx === -1) {
            results.push({
                call: call.call,
                success: false,
                error: `Invalid call format: "${call.call}" (expected "namespace.method")`,
                summary: `格式错误: ${call.call}`,
            });
            continue;
        }

        const namespace = call.call.slice(0, dotIdx);
        const method = call.call.slice(dotIdx + 1);
        const handler = HANDLER_MAP[namespace]?.[method];

        if (!handler) {
            results.push({
                call: call.call,
                success: false,
                error: `Unknown method: "${call.call}"`,
                summary: `未知方法: ${call.call}`,
            });
            continue;
        }

        try {
            const result = handler(call.args, chatId, deps);
            results.push({
                call: call.call,
                success: true,
                result,
                summary: handler.describe(call.args),
            });
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            results.push({
                call: call.call,
                success: false,
                error: message,
                summary: `执行失败: ${message}`,
            });
        }
    }

    return results;
}
