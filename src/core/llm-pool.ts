/**
 * llm-pool.ts — LLM API Key 负载均衡调度器
 *
 * 为同一个 LLM profile 管理多个 API key 的负载均衡。
 * 支持 round_robin / least_pending / random 三种调度策略。
 * 自动检测 429/quota 错误并对故障 key 进行指数退避冷却。
 */

import type { PoolConfig, PoolMemberConfig, PoolStrategy } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("llm-pool");

// ─── 运行时成员状态 ───

/** 连续失败多少次后永久禁用该 key（直到配置重载） */
const MAX_CONSECUTIVE_ERRORS = 5;

interface PoolMemberState {
    /** 配置 */
    config: PoolMemberConfig;
    /** 当前 pending 请求数 */
    pendingRequests: number;
    /** 连续错误次数（用于指数退避） */
    consecutiveErrors: number;
    /** 冷却到期时间戳（ms），在此之前不可用 */
    cooldownUntil: number;
    /** 是否被永久禁用（余额耗尽/认证失败） */
    disabled: boolean;
}

/** acquire() 返回的句柄，调用方使用后需 release */
export interface PoolAcquireHandle {
    /** 选中的 API key */
    apiKey: string;
    /** 选中的 base URL（可能与 profile 默认不同） */
    baseUrl?: string;
    /** 内部索引，release 时使用 */
    _index: number;
}

// ─── 全局 Pool 注册表 ───
// 每个 profile 名共享同一个 LLMPool 实例，确保状态一致

const _poolRegistry = new Map<string, LLMPool>();

/**
 * 获取或创建一个 LLMPool 实例。
 * 使用 poolId + config 指纹做 key，确保同一 profile 共享调度状态。
 */
export function getOrCreatePool(poolId: string, poolConfig: PoolConfig): LLMPool {
    let pool = _poolRegistry.get(poolId);
    if (pool) return pool;
    pool = new LLMPool(poolId, poolConfig);
    _poolRegistry.set(poolId, pool);
    log.info("创建 LLM Pool", { poolId, strategy: poolConfig.strategy, members: poolConfig.members.length });
    return pool;
}

/** 清除所有 pool 实例（用于测试） */
export function clearAllPools(): void {
    _poolRegistry.clear();
}

// ─── Pool 实现 ───

/** 冷却基数 */
const COOLDOWN_BASE_MS = 5_000;
/** 冷却最大值 */
const COOLDOWN_MAX_MS = 120_000;

export class LLMPool {
    readonly id: string;
    readonly strategy: PoolStrategy;
    private members: PoolMemberState[];
    private rrIndex = 0; // round_robin 计数器

    constructor(id: string, config: PoolConfig) {
        this.id = id;
        this.strategy = config.strategy;
        this.members = config.members.map(m => ({
            config: m,
            pendingRequests: 0,
            consecutiveErrors: 0,
            cooldownUntil: 0,
            disabled: false,
        }));
    }

    /** 获取 pool 成员数 */
    get size(): number {
        return this.members.length;
    }

    /**
     * 选择下一个可用的 API key。
     * 如果所有 key 都在冷却中，返回 null。
     */
    acquire(): PoolAcquireHandle | null {
        const now = Date.now();
        const available = this.members
            .map((m, i) => ({ member: m, index: i }))
            .filter(({ member }) => !member.disabled && now >= member.cooldownUntil);

        if (available.length === 0) {
            const allDisabled = this.members.every(m => m.disabled);
            log.warn(allDisabled ? "Pool 所有 key 已永久禁用" : "Pool 所有 key 均在冷却中（或已禁用）", {
                poolId: this.id,
                members: this.members.map(m => ({
                    disabled: m.disabled,
                    cooldownRemaining: Math.max(0, m.cooldownUntil - now),
                    consecutiveErrors: m.consecutiveErrors,
                })),
            });
            return null;
        }

        let selected: { member: PoolMemberState; index: number };

        switch (this.strategy) {
            case "round_robin": {
                // 从 rrIndex 开始找下一个可用 key
                let found = false;
                for (let i = 0; i < this.members.length; i++) {
                    const idx = (this.rrIndex + i) % this.members.length;
                    const m = this.members[idx];
                    if (!m.disabled && now >= m.cooldownUntil) {
                        selected = { member: m, index: idx };
                        this.rrIndex = (idx + 1) % this.members.length;
                        found = true;
                        break;
                    }
                }
                if (!found) return null; // shouldn't happen since available.length > 0
                break;
            }

            case "least_pending": {
                selected = available.reduce((best, curr) =>
                    curr.member.pendingRequests < best.member.pendingRequests ? curr : best
                );
                break;
            }

            case "random": {
                selected = available[Math.floor(Math.random() * available.length)];
                break;
            }

            default:
                selected = available[0];
        }

        selected!.member.pendingRequests++;

        return {
            apiKey: selected!.member.config.apiKey,
            baseUrl: selected!.member.config.baseUrl,
            _index: selected!.index,
        };
    }

    /**
     * 请求完成后释放句柄。
     * @param handle - acquire 返回的句柄
     * @param success - 请求是否成功
     * @param isQuotaError - 是否为 429/quota 错误（触发冷却，连续失败后永久禁用）
     * @param isAuthError - 是否为 401/403 认证/权限错误（立即永久禁用）
     */
    release(handle: PoolAcquireHandle, success: boolean, isQuotaError = false, isAuthError = false): void {
        const member = this.members[handle._index];
        if (!member) return;

        member.pendingRequests = Math.max(0, member.pendingRequests - 1);

        if (success) {
            member.consecutiveErrors = 0;
            member.cooldownUntil = 0;
            // 注意：disabled 状态不会被 success 重置，因为一旦标记为永久禁用
            // 该 key 不会再被 acquire() 选中，也就不会有 success 调用
        } else if (isAuthError) {
            // 401/403 认证或权限错误 → 立即永久禁用（billing 被关、key 被吊销等）
            member.disabled = true;
            member.consecutiveErrors++;
            log.error("Pool member 认证/权限失败，已永久禁用", {
                poolId: this.id,
                memberIndex: handle._index,
                apiKeyPreview: handle.apiKey.slice(0, 10) + "...",
            });
        } else if (isQuotaError) {
            member.consecutiveErrors++;

            // 连续失败超过阈值 → 永久禁用（判定为余额耗尽）
            if (member.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                member.disabled = true;
                log.error(`Pool member 连续 ${member.consecutiveErrors} 次 quota 失败，已永久禁用`, {
                    poolId: this.id,
                    memberIndex: handle._index,
                    apiKeyPreview: handle.apiKey.slice(0, 10) + "...",
                });
                return;
            }

            const backoff = Math.min(
                COOLDOWN_BASE_MS * Math.pow(2, member.consecutiveErrors - 1),
                COOLDOWN_MAX_MS,
            );
            member.cooldownUntil = Date.now() + backoff;
            log.warn("Pool member 进入冷却", {
                poolId: this.id,
                memberIndex: handle._index,
                backoffMs: backoff,
                consecutiveErrors: member.consecutiveErrors,
                maxBeforeDisable: MAX_CONSECUTIVE_ERRORS,
                apiKeyPreview: handle.apiKey.slice(0, 10) + "...",
            });
        }
        // 非 quota/auth 错误不触发冷却（可能是网络抖动，由 callLLM 内部重试处理）
    }

    /** 获取 pool 状态快照（用于 Dashboard / 日志） */
    getStatus(): Array<{
        apiKeyPreview: string;
        baseUrl?: string;
        pendingRequests: number;
        consecutiveErrors: number;
        cooldownRemaining: number;
        disabled: boolean;
        weight?: number;
    }> {
        const now = Date.now();
        return this.members.map(m => ({
            apiKeyPreview: m.config.apiKey.slice(0, 10) + "...",
            baseUrl: m.config.baseUrl,
            pendingRequests: m.pendingRequests,
            consecutiveErrors: m.consecutiveErrors,
            cooldownRemaining: Math.max(0, m.cooldownUntil - now),
            disabled: m.disabled,
            weight: m.config.weight,
        }));
    }
}
