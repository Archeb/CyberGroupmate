/**
 * sandbox-pool.ts — Sandbox 多实例管理器
 *
 * 管理多个独立的 Sandbox worker 进程实例：
 * - 按 chatId acquire/release
 * - LRU 淘汰策略
 * - 空闲超时自动回收
 * - 最大并发实例数限制
 *
 * 参考设计：subagent.md §3.1, subtask.md S3.1
 */

import { Sandbox } from "./sandbox.js";
import type { SubagentConfig } from "../subagent/types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "../subagent/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("sandbox-pool");

/** SandboxPool 配置 */
export interface SandboxPoolConfig {
    /** 最大同时运行的 sandbox 实例数。默认 5 */
    maxInstances: number;
    /** 空闲超时 (ms)，超过后自动回收。默认 600000 (10min) */
    idleTimeout: number;
    /** Sandbox 工作脚本路径 */
    workerScript?: string;
    /** Sandbox 工作目录 */
    workDir?: string;
    /**
     * 新 sandbox 实例创建后的初始化回调。
     * 用于注册 hostCallHandler、event listener 等。
     * 在 sandbox.start() 之后调用。
     */
    onAcquire?: (sandbox: Sandbox, chatId: string) => void;
}

const DEFAULT_POOL_CONFIG: SandboxPoolConfig = {
    maxInstances: DEFAULT_SUBAGENT_CONFIG.maxSandboxInstances,
    idleTimeout: DEFAULT_SUBAGENT_CONFIG.sandboxIdleTimeout,
};

/** 池中的 Sandbox 条目 */
interface PoolEntry {
    sandbox: Sandbox;
    chatId: string;
    lastUsedAt: number;
    /** 是否正在使用中 */
    inUse: boolean;
}

/**
 * SandboxPool — Sandbox 实例池
 *
 * 使用方式：
 * ```ts
 * const pool = new SandboxPool({ maxInstances: 3 });
 * const sandbox = await pool.acquire("chatA");
 * // ... 使用 sandbox 执行代码 ...
 * pool.release("chatA");
 * ```
 */
export class SandboxPool {
    private pool = new Map<string, PoolEntry>();
    private config: SandboxPoolConfig;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config?: Partial<SandboxPoolConfig>) {
        this.config = { ...DEFAULT_POOL_CONFIG, ...config };

        // 定期清理空闲实例
        this.cleanupTimer = setInterval(() => {
            this.cleanupIdle();
        }, Math.max(30000, this.config.idleTimeout / 2));
        // 允许进程退出
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    /**
     * 获取或创建 sandbox 实例
     * 如果 chatId 已有实例，复用它。否则创建新实例（可能淘汰 LRU）。
     */
    async acquire(chatId: string): Promise<Sandbox> {
        // 复用已有实例
        const existing = this.pool.get(chatId);
        if (existing) {
            existing.lastUsedAt = Date.now();
            existing.inUse = true;

            // 检查是否还活着
            if (existing.sandbox.isAlive()) {
                log.debug("acquire: 复用", { chatId });
                return existing.sandbox;
            }

            // 死掉了，移除后重新创建
            log.warn("acquire: 已有实例已死，重新创建", { chatId });
            this.pool.delete(chatId);
        }

        // 检查是否达到上限
        if (this.pool.size >= this.config.maxInstances) {
            // 淘汰最久未使用的非活跃实例
            this.evictLRU();
        }

        // 创建新实例
        const sandbox = new Sandbox(
            this.config.workDir,
        );
        await sandbox.start();

        // 调用 onAcquire 初始化新实例（注册 hostCallHandler、event listener 等）
        if (this.config.onAcquire) {
            this.config.onAcquire(sandbox, chatId);
        }

        this.pool.set(chatId, {
            sandbox,
            chatId,
            lastUsedAt: Date.now(),
            inUse: true,
        });

        log.info("acquire: 创建新实例", { chatId, poolSize: this.pool.size });
        return sandbox;
    }

    /**
     * 释放 sandbox（标记为不使用中，但不停止）
     */
    release(chatId: string): void {
        const entry = this.pool.get(chatId);
        if (entry) {
            entry.inUse = false;
            entry.lastUsedAt = Date.now();
            log.debug("release", { chatId });
        }
    }

    /**
     * 强制停止并移除指定 chatId 的 sandbox
     */
    async destroy(chatId: string): Promise<void> {
        const entry = this.pool.get(chatId);
        if (entry) {
            await entry.sandbox.stop();
            this.pool.delete(chatId);
            log.info("destroy", { chatId, poolSize: this.pool.size });
        }
    }

    /**
     * 获取指定 chatId 的 sandbox（不创建）
     */
    get(chatId: string): Sandbox | undefined {
        return this.pool.get(chatId)?.sandbox;
    }

    /**
     * 检查指定 chatId 是否有活跃 sandbox
     */
    has(chatId: string): boolean {
        const entry = this.pool.get(chatId);
        return !!entry && entry.sandbox.isAlive();
    }

    /**
     * 当前池大小
     */
    get size(): number {
        return this.pool.size;
    }

    /**
     * 获取池状态
     */
    getStats(): { total: number; inUse: number; idle: number; instances: Array<{ chatId: string; inUse: boolean; lastUsedAt: number }> } {
        let inUse = 0;
        let idle = 0;
        const instances: Array<{ chatId: string; inUse: boolean; lastUsedAt: number }> = [];
        for (const entry of this.pool.values()) {
            if (entry.inUse) inUse++;
            else idle++;
            instances.push({ chatId: entry.chatId, inUse: entry.inUse, lastUsedAt: entry.lastUsedAt });
        }
        return { total: this.pool.size, inUse, idle, instances };
    }

    /**
     * 停止所有 sandbox 并清空池
     */
    async dispose(): Promise<void> {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }

        const stopPromises: Promise<void>[] = [];
        for (const entry of this.pool.values()) {
            stopPromises.push(entry.sandbox.stop().catch(() => {}));
        }
        await Promise.all(stopPromises);
        this.pool.clear();
        log.info("dispose: 池已清空");
    }

    // ─── 内部方法 ───

    /**
     * 淘汰最久未使用的非活跃实例
     */
    private evictLRU(): void {
        let oldest: PoolEntry | null = null;
        for (const entry of this.pool.values()) {
            if (!entry.inUse) {
                if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) {
                    oldest = entry;
                }
            }
        }

        if (oldest) {
            log.info("evictLRU: 淘汰", { chatId: oldest.chatId });
            oldest.sandbox.stop().catch(() => {});
            this.pool.delete(oldest.chatId);
        } else {
            // 所有实例都在使用中，淘汰全局最老的
            let globalOldest: PoolEntry | null = null;
            for (const entry of this.pool.values()) {
                if (!globalOldest || entry.lastUsedAt < globalOldest.lastUsedAt) {
                    globalOldest = entry;
                }
            }
            if (globalOldest) {
                log.warn("evictLRU: 强制淘汰使用中实例", { chatId: globalOldest.chatId });
                globalOldest.sandbox.stop().catch(() => {});
                this.pool.delete(globalOldest.chatId);
            }
        }
    }

    /**
     * 清理超时空闲实例
     */
    private cleanupIdle(): void {
        const now = Date.now();
        const toRemove: string[] = [];

        for (const [chatId, entry] of this.pool.entries()) {
            if (!entry.inUse && (now - entry.lastUsedAt) > this.config.idleTimeout) {
                toRemove.push(chatId);
            }
        }

        for (const chatId of toRemove) {
            const entry = this.pool.get(chatId);
            if (entry) {
                entry.sandbox.stop().catch(() => {});
                this.pool.delete(chatId);
                log.info("cleanupIdle: 回收", { chatId });
            }
        }
    }
}
