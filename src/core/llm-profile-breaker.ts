/**
 * llm-profile-breaker.ts — Profile 级熔断器
 *
 * 按 component + profileName 维度做熔断隔离：某个 profile 连续失败超过阈值时进入 open
 * 状态，在冷却期内跳过该 profile；冷却到期后放一个真实业务请求作为探针（half_open），
 * 探针成功则恢复（closed），探针失败则重新 open 并以更长冷却退避。
 *
 * 设计要点：
 * - 单例模式，与 llm-rate-limiter.ts / llm-pool.ts 保持一致的风格。
 * - 所有方法同步执行——JS 事件循环保证 check+set 在同一同步块内原子完成。
 * - 不依赖 config.ts（避免循环导入）：配置由 config.ts 在 loadConfig 后通过 setConfig 推入。
 * - 熔断只决定"是否跳过某个 profile"，不会让原本成功的调用失败，也不会让原本失败的调用
 *   静默成功。callLLMWithFallback 在所有 profile 均被熔断时会 reset 后强制重试一轮（兜底）。
 */

import { createLogger } from "./logger.js";

const log = createLogger("profile-breaker");

// ─── 类型定义 ───

export type BreakerState = "closed" | "open" | "half_open";

interface BreakerEntry {
    state: BreakerState;
    consecutiveErrors: number;
    /** 冷却到期时间戳（epoch ms）；0 表示未在冷却 */
    cooldownUntil: number;
    /** half_open 状态下是否有探针请求在途 */
    probing: boolean;
    lastStateChangeAt: number;
}

export interface CircuitBreakerConfig {
    /** 是否启用熔断 */
    enabled: boolean;
    /** 连续失败多少次后熔断（open） */
    failureThreshold: number;
    /** 冷却基数（ms） */
    cooldownBaseMs: number;
    /** 冷却退避因子（每次重新 open 都乘以此因子） */
    cooldownFactor: number;
    /** 冷却上限（ms） */
    cooldownMaxMs: number;
}

export interface BreakerStatusEntry {
    component: string;
    profileName: string;
    state: BreakerState;
    consecutiveErrors: number;
    /** 剩余冷却 ms；未在冷却时为 0 */
    cooldownRemainingMs: number;
    probing: boolean;
}

// ─── 默认配置 ───

const DEFAULT_CONFIG: CircuitBreakerConfig = {
    enabled: true,
    failureThreshold: 5,
    cooldownBaseMs: 60_000,
    cooldownFactor: 1.5,
    cooldownMaxMs: 300_000,
};

// ─── 熔断器实现 ───

class LLMProfileBreaker {
    private _entries = new Map<string, BreakerEntry>();
    private _config: CircuitBreakerConfig = { ...DEFAULT_CONFIG };

    /** 由 config.ts 在 loadConfig 后调用，覆盖默认配置（支持部分字段） */
    setConfig(cfg: Partial<CircuitBreakerConfig>): void {
        this._config = { ...DEFAULT_CONFIG, ...cfg };
        log.info("Profile breaker config updated", {
            enabled: this._config.enabled,
            failureThreshold: this._config.failureThreshold,
            cooldownBaseMs: this._config.cooldownBaseMs,
            cooldownFactor: this._config.cooldownFactor,
            cooldownMaxMs: this._config.cooldownMaxMs,
        });
    }

    getConfig(): CircuitBreakerConfig {
        return { ...this._config };
    }

    private _key(component: string, profileName: string): string {
        return `${component}::${profileName}`;
    }

    private _getOrCreate(component: string, profileName: string): BreakerEntry {
        const k = this._key(component, profileName);
        let entry = this._entries.get(k);
        if (!entry) {
            entry = {
                state: "closed",
                consecutiveErrors: 0,
                cooldownUntil: 0,
                probing: false,
                lastStateChangeAt: Date.now(),
            };
            this._entries.set(k, entry);
        }
        return entry;
    }

    /**
     * 尝试获取一次调用许可。
     * - 熔断关闭（enabled=false）→ 永远放行 { try: true, probe: false }
     * - closed → 放行
     * - open 且未到冷却 → 拒绝 { try: false }
     * - open 且冷却到期 → 转为 half_open 并放行首个探针
     * - half_open 且探针在途 → 拒绝（仅允许一个探针）
     * - half_open 且无探针在途 → 放行并标记为探针
     */
    tryAcquire(component: string, profileName: string): { try: boolean; probe: boolean } {
        if (!this._config.enabled) {
            return { try: true, probe: false };
        }
        const entry = this._getOrCreate(component, profileName);
        const now = Date.now();

        switch (entry.state) {
            case "closed":
                return { try: true, probe: false };

            case "open":
                if (now < entry.cooldownUntil) {
                    // 仍在冷却期 → 跳过
                    return { try: false, probe: false };
                }
                // 冷却到期 → 转为 half_open，等待探针
                entry.state = "half_open";
                entry.probing = false;
                entry.lastStateChangeAt = now;
                // fall through 到 half_open 分支：本次调用作为首个探针
                entry.probing = true;
                return { try: true, probe: true };

            case "half_open":
                if (entry.probing) {
                    // 已有探针在途 → 跳过
                    return { try: false, probe: false };
                }
                // 无探针在途 → 本次作为探针
                entry.probing = true;
                return { try: true, probe: true };
        }
    }

    /** 调用成功：重置为 closed（已恢复） */
    recordSuccess(component: string, profileName: string): void {
        const k = this._key(component, profileName);
        const entry = this._entries.get(k);
        if (!entry) return;
        const wasOpen = entry.state !== "closed";
        entry.state = "closed";
        entry.consecutiveErrors = 0;
        entry.cooldownUntil = 0;
        entry.probing = false;
        entry.lastStateChangeAt = Date.now();
        if (wasOpen) {
            log.info("profile breaker closed (recovered)", { component, profileName });
        } else {
            log.debug("profile breaker closed (recovered)", { component, profileName });
        }
    }

    /** 调用失败：累计错误，达到阈值则熔断；half_open 失败则重新 open 并加长冷却 */
    recordFailure(component: string, profileName: string): void {
        const entry = this._getOrCreate(component, profileName);
        const now = Date.now();
        entry.consecutiveErrors += 1;
        entry.probing = false; // 无论成败，清除探针标记

        if (entry.consecutiveErrors >= this._config.failureThreshold) {
            // 计算退避冷却：base * factor^(errors - threshold)
            const exponent = entry.consecutiveErrors - this._config.failureThreshold;
            const cooldownMs = Math.min(
                this._config.cooldownBaseMs * Math.pow(this._config.cooldownFactor, exponent),
                this._config.cooldownMaxMs,
            );
            entry.state = "open";
            entry.cooldownUntil = now + cooldownMs;
            entry.lastStateChangeAt = now;
            log.warn("profile breaker OPEN", {
                component,
                profileName,
                errors: entry.consecutiveErrors,
                cooldownMs,
            });
        } else {
            // 仍在累计错误，未达阈值，保持 closed
            log.debug("profile breaker accumulating errors", {
                component,
                profileName,
                errors: entry.consecutiveErrors,
                threshold: this._config.failureThreshold,
            });
        }
    }

    /** 清除所有熔断状态（配置重载 / 全员熔断兜底时调用） */
    resetAll(): void {
        this._entries.clear();
        log.info("profile breaker: all states reset");
    }

    /** 获取全部熔断状态快照（供 Dashboard / API） */
    getStatus(): { enabled: boolean; config: CircuitBreakerConfig; entries: BreakerStatusEntry[] } {
        const now = Date.now();
        const entries: BreakerStatusEntry[] = [];
        for (const [k, entry] of this._entries) {
            const [component, profileName] = k.split("::");
            entries.push({
                component,
                profileName,
                state: entry.state,
                consecutiveErrors: entry.consecutiveErrors,
                cooldownRemainingMs: Math.max(0, entry.cooldownUntil - now),
                probing: entry.probing,
            });
        }
        return {
            enabled: this._config.enabled,
            config: { ...this._config },
            entries,
        };
    }
}

/** Singleton */
export const profileBreaker = new LLMProfileBreaker();
