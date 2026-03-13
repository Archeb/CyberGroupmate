/**
 * subagent-manager.ts — Subagent 实例管理器
 *
 * 管理所有群组的 GroupSubagent 实例生命周期：
 * - 按需创建（getOrCreate）
 * - 空闲回收（releaseIdle）
 * - 获取全部实例列表
 *
 * 参考设计：subagent.md §2
 */

import { GroupSubagent, type GroupSubagentOptions } from "./group-subagent.js";
import type { SubagentConfig, GroupStickiness, StickinessLevel } from "./types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("subagent-manager");

/** SubagentManager 配置 */
export interface SubagentManagerConfig {
    /** Subagent 空闲超时 (ms)。默认 600,000 (10min) */
    idleTimeout: number;
    /** Observer 配置 */
    observerConfig?: ConstructorParameters<typeof GroupSubagent>[0]["observerConfig"];
    /** 默认 stickiness 工厂（可注入 MemoryV2 lookup） */
    stickinessProvider?: (chatId: string) => GroupStickiness | undefined;
}

const DEFAULT_MANAGER_CONFIG: SubagentManagerConfig = {
    idleTimeout: DEFAULT_SUBAGENT_CONFIG.sandboxIdleTimeout,
};

/**
 * SubagentManager — 群组 Subagent 实例管理器
 */
export class SubagentManager {
    private subagents = new Map<string, GroupSubagent>();
    private config: SubagentManagerConfig;

    constructor(config?: Partial<SubagentManagerConfig>) {
        this.config = { ...DEFAULT_MANAGER_CONFIG, ...config };
    }

    /**
     * 获取或创建指定 chatId 的 GroupSubagent
     */
    getOrCreate(chatId: string): GroupSubagent {
        let subagent = this.subagents.get(chatId);

        if (!subagent) {
            const stickiness = this.config.stickinessProvider?.(chatId);
            subagent = new GroupSubagent({
                chatId,
                observerConfig: this.config.observerConfig,
                stickiness,
            });
            this.subagents.set(chatId, subagent);
            log.info("getOrCreate: 创建新 Subagent", { chatId, total: this.subagents.size });
        }

        subagent.touch();
        return subagent;
    }

    /**
     * 获取指定 chatId 的 GroupSubagent（不创建）
     */
    get(chatId: string): GroupSubagent | undefined {
        return this.subagents.get(chatId);
    }

    /**
     * 获取所有 Subagent 实例
     */
    getAllSubagents(): GroupSubagent[] {
        return Array.from(this.subagents.values());
    }

    /**
     * 获取所有 chatId
     */
    getChatIds(): string[] {
        return Array.from(this.subagents.keys());
    }

    /**
     * 释放空闲超时的 Subagent
     * @returns 释放的 chatId 列表
     */
    releaseIdle(maxIdleMs?: number): string[] {
        const timeout = maxIdleMs ?? this.config.idleTimeout;
        const released: string[] = [];

        for (const [chatId, subagent] of this.subagents.entries()) {
            if (subagent.isIdle(timeout)) {
                this.subagents.delete(chatId);
                released.push(chatId);
                log.info("releaseIdle: 释放 Subagent", { chatId });
            }
        }

        if (released.length > 0) {
            log.info("releaseIdle: 完成", { released: released.length, remaining: this.subagents.size });
        }

        return released;
    }

    /**
     * 手动移除指定 chatId 的 Subagent
     */
    remove(chatId: string): boolean {
        const result = this.subagents.delete(chatId);
        if (result) {
            log.info("remove: 移除 Subagent", { chatId, remaining: this.subagents.size });
        }
        return result;
    }

    /**
     * 当前实例数
     */
    get size(): number {
        return this.subagents.size;
    }

    /**
     * 释放所有实例
     */
    dispose(): void {
        this.subagents.clear();
        log.info("dispose: 所有 Subagent 已释放");
    }
}
