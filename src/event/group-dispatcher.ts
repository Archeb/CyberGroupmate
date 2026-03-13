/**
 * group-dispatcher.ts — per-chatId 事件分发器
 *
 * 管理 chatId → handler 的注册表，当 NC push 事件时，
 * 自动分发到对应 chatId 的 handler。
 *
 * 与 NotificationCenter 的关系：
 * - NC 仍然是事件的单一入口（push/drain）
 * - GroupDispatcher 通过 NC.onPush 钩子接收所有事件
 * - 按 chatId 路由到已注册的 handler
 * - catchAll handler 接收所有事件（供主 Agent 循环使用）
 */

import type { NotificationEvent } from "./notification-center.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("group-dispatcher");

/** 事件处理器函数类型 */
export type EventHandler = (event: NotificationEvent) => void;

/** GroupDispatcher 配置 */
export interface GroupDispatcherConfig {
    /** 需要提取 chatId 的事件类型前缀列表 */
    chatIdEventTypes?: string[];
}

const DEFAULT_CONFIG: Required<GroupDispatcherConfig> = {
    chatIdEventTypes: ["telegram.message"],
};

/**
 * GroupDispatcher — chatId 级别的事件路由器
 *
 * 使用方式：
 * ```ts
 * const dispatcher = new GroupDispatcher();
 * dispatcher.subscribe("chat123", (event) => observer.onMessage(event));
 * dispatcher.subscribeCatchAll((event) => mainAgentQueue.push(event));
 * // 在 NC.onPush 中调用
 * nc.onPush(event => dispatcher.dispatch(event));
 * ```
 */
export class GroupDispatcher {
    /** chatId → handler[] 注册表 */
    private handlers = new Map<string, Set<EventHandler>>();
    /** 全局 catch-all handler 列表 */
    private catchAllHandlers = new Set<EventHandler>();
    /** 配置 */
    private config: Required<GroupDispatcherConfig>;
    /** 分发统计 */
    private stats = {
        totalDispatched: 0,
        matchedDispatches: 0,
        catchAllDispatches: 0,
        unmatchedEvents: 0,
    };

    constructor(config?: GroupDispatcherConfig) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 注册一个 chatId 的事件处理器
     * @returns 取消注册的函数
     */
    subscribe(chatId: string, handler: EventHandler): () => void {
        if (!this.handlers.has(chatId)) {
            this.handlers.set(chatId, new Set());
        }
        this.handlers.get(chatId)!.add(handler);
        log.debug("subscribe", { chatId, handlerCount: this.handlers.get(chatId)!.size });

        // 返回取消注册函数
        return () => {
            const set = this.handlers.get(chatId);
            if (set) {
                set.delete(handler);
                if (set.size === 0) {
                    this.handlers.delete(chatId);
                }
            }
            log.debug("unsubscribe", { chatId });
        };
    }

    /**
     * 注册一个 catch-all 处理器（接收所有事件）
     * @returns 取消注册的函数
     */
    subscribeCatchAll(handler: EventHandler): () => void {
        this.catchAllHandlers.add(handler);
        log.debug("subscribeCatchAll", { handlerCount: this.catchAllHandlers.size });

        return () => {
            this.catchAllHandlers.delete(handler);
            log.debug("unsubscribeCatchAll", { handlerCount: this.catchAllHandlers.size });
        };
    }

    /**
     * 注销指定 chatId 的所有处理器
     */
    unsubscribeAll(chatId: string): void {
        this.handlers.delete(chatId);
        log.debug("unsubscribeAll", { chatId });
    }

    /**
     * 分发事件到已注册的处理器
     * 1. 提取事件中的 chatId
     * 2. 如果有匹配的 chatId handler，调用之
     * 3. 始终调用所有 catchAll handler
     */
    dispatch(event: NotificationEvent): void {
        this.stats.totalDispatched++;

        // 提取 chatId
        const chatId = this.extractChatId(event);

        // 分发到 chatId 级 handler
        if (chatId) {
            const handlers = this.handlers.get(chatId);
            if (handlers && handlers.size > 0) {
                this.stats.matchedDispatches++;
                for (const handler of handlers) {
                    try {
                        handler(event);
                    } catch (err) {
                        log.error("dispatch: chatId handler 异常", {
                            chatId,
                            error: String(err),
                        });
                    }
                }
            } else {
                this.stats.unmatchedEvents++;
            }
        }

        // 始终调用 catchAll
        if (this.catchAllHandlers.size > 0) {
            this.stats.catchAllDispatches++;
            for (const handler of this.catchAllHandlers) {
                try {
                    handler(event);
                } catch (err) {
                    log.error("dispatch: catchAll handler 异常", {
                        error: String(err),
                    });
                }
            }
        }
    }

    /**
     * 获取当前已注册的 chatId 列表
     */
    getSubscribedChatIds(): string[] {
        return Array.from(this.handlers.keys());
    }

    /**
     * 检查指定 chatId 是否有注册的 handler
     */
    hasSubscription(chatId: string): boolean {
        const handlers = this.handlers.get(chatId);
        return !!handlers && handlers.size > 0;
    }

    /**
     * 获取分发统计
     */
    getStats(): Readonly<typeof this.stats> {
        return { ...this.stats };
    }

    /**
     * 重置统计
     */
    resetStats(): void {
        this.stats = {
            totalDispatched: 0,
            matchedDispatches: 0,
            catchAllDispatches: 0,
            unmatchedEvents: 0,
        };
    }

    /**
     * 释放所有注册
     */
    dispose(): void {
        this.handlers.clear();
        this.catchAllHandlers.clear();
        log.debug("dispose: 所有注册已清除");
    }

    // ─── 内部方法 ───

    /**
     * 从事件中提取 chatId
     */
    private extractChatId(event: NotificationEvent): string | null {
        // 只对配置中的事件类型提取 chatId
        const isRelevant = this.config.chatIdEventTypes.some(
            prefix => event.type.startsWith(prefix)
        );

        if (!isRelevant) return null;

        const chatId = event.chatId ?? event.chat_id;
        if (chatId === undefined || chatId === null) return null;
        return String(chatId);
    }
}
