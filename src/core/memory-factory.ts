/**
 * core/memory-factory.ts — 记忆存储工厂
 *
 * 统一构建 MemoryStoreV2（结构化存储 + 本地 SQLite 语义检索），并注入全局隐私分级。
 * 所有 MemoryStoreV2 实例化都应经由此工厂，以保证隐私分级生效。
 */

import { MemoryStoreV2 } from "../memory-v2/memory-v2.js";
import {
    loadConfig,
    type AppConfig,
    type EmbeddingConfig,
} from "./config.js";

export interface CreateMemoryStoreOptions {
    /** 显式 AppConfig（默认 loadConfig()） */
    config?: AppConfig;
    /**
     * embedding 配置。**不自动解析**——由调用方显式传入，由各调用点自行决定是否启用。
     */
    embeddingConfig?: EmbeddingConfig;
}

/**
 * 构建一个 MemoryStoreV2，并注入全局隐私分级。
 */
export function createMemoryStore(dbPath: string, options?: CreateMemoryStoreOptions): MemoryStoreV2 {
    const config = options?.config ?? loadConfig();
    const embeddingConfig = options?.embeddingConfig;

    const store = new MemoryStoreV2(dbPath, embeddingConfig ? { embeddingConfig } : undefined);
    // 注入全局隐私分级（驱动 recall / 可见性守卫，与 chokepoint 同一定义）。
    store.setPrivacyClassification({
        sensitiveChats: config.privacy?.sensitiveChats,
        dmAutoPrivate: config.privacy?.dmAutoPrivate,
        enforce: config.privacy?.enforce,
    });
    return store;
}
