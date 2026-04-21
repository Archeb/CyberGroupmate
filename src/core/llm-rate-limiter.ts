/**
 * llm-rate-limiter.ts — LLM 请求限速器
 *
 * 支持两种限制维度：
 * 1. 并发数（maxConcurrency）：同时进行的 LLM 请求数上限
 * 2. RPM（requestsPerMinute）：每分钟请求数上限（滑动窗口）
 *
 * 可以全局设置，也可以按 profile 设置（profile 级别覆盖全局）。
 * 超限请求会排队等待，不会被拒绝。
 */

import { createLogger } from "./logger.js";
import { EventEmitter } from "node:events";

const log = createLogger("rate-limiter");

/** 限速配置 */
export interface RateLimitConfig {
    /** 是否启用限速 */
    enabled: boolean;
    /** 全局最大并发 LLM 请求数。0 = 不限制 */
    maxConcurrency: number;
    /** 全局每分钟最大请求数。0 = 不限制 */
    requestsPerMinute: number;
    /** 按 profile 覆盖。key 为 profile 名称 */
    perProfile?: Record<string, {
        maxConcurrency?: number;
        requestsPerMinute?: number;
    }>;
}

/** 限速器状态（供 Dashboard 展示） */
export interface RateLimiterStats {
    activeConcurrency: number;
    queueLength: number;
    recentRPM: number;
    config: RateLimitConfig;
    perProfile: Record<string, {
        activeConcurrency: number;
        queueLength: number;
        recentRPM: number;
    }>;
}

interface QueueEntry {
    resolve: () => void;
    profileName?: string;
    enqueuedAt: number;
}

/** 限速事件（供 Dashboard 订阅） */
export const rateLimitEvents = new EventEmitter();
rateLimitEvents.setMaxListeners(20);

class LLMRateLimiter {
    private _config: RateLimitConfig = {
        enabled: false,
        maxConcurrency: 0,
        requestsPerMinute: 0,
    };

    // Global tracking
    private _activeConcurrency = 0;
    private _timestamps: number[] = []; // RPM sliding window
    private _queue: QueueEntry[] = [];

    // Per-profile tracking
    private _profileActive = new Map<string, number>();
    private _profileTimestamps = new Map<string, number[]>();
    private _profileQueues = new Map<string, QueueEntry[]>();

    private _drainTimer: ReturnType<typeof setInterval> | null = null;

    updateConfig(config: RateLimitConfig): void {
        this._config = { ...config };
        log.info("Rate limiter config updated", {
            enabled: config.enabled,
            maxConcurrency: config.maxConcurrency,
            rpm: config.requestsPerMinute,
            profiles: Object.keys(config.perProfile ?? {}),
        });
        this._drain();
    }

    getConfig(): RateLimitConfig {
        return { ...this._config };
    }

    getStats(): RateLimiterStats {
        this._pruneTimestamps();
        const perProfile: RateLimiterStats["perProfile"] = {};
        for (const name of new Set([
            ...this._profileActive.keys(),
            ...this._profileTimestamps.keys(),
            ...this._profileQueues.keys(),
        ])) {
            perProfile[name] = {
                activeConcurrency: this._profileActive.get(name) ?? 0,
                queueLength: (this._profileQueues.get(name) ?? []).length,
                recentRPM: (this._profileTimestamps.get(name) ?? []).length,
            };
        }
        return {
            activeConcurrency: this._activeConcurrency,
            queueLength: this._queue.length,
            recentRPM: this._timestamps.length,
            config: { ...this._config },
            perProfile,
        };
    }

    /**
     * Acquire a slot. Resolves when the request is allowed to proceed.
     * Returns a release function that MUST be called when the request completes.
     */
    async acquire(profileName?: string): Promise<() => void> {
        if (!this._config.enabled) {
            return () => {};
        }

        // Wait until we have a slot. The _drain mechanism or immediate check
        // will record the slot in counters before resolving.
        const reservedByDrain = await this._waitForSlot(profileName);

        if (!reservedByDrain) {
            // We got through immediately — record now
            this._recordSlot(profileName);
        }
        // If reservedByDrain === true, _drain already recorded the slot

        let released = false;
        return () => {
            if (released) return;
            released = true;
            this._activeConcurrency = Math.max(0, this._activeConcurrency - 1);
            if (profileName) {
                const cur = this._profileActive.get(profileName) ?? 1;
                this._profileActive.set(profileName, Math.max(0, cur - 1));
            }
            this._drain();
        };
    }

    private _recordSlot(profileName?: string): void {
        this._activeConcurrency++;
        this._timestamps.push(Date.now());
        if (profileName) {
            this._profileActive.set(profileName, (this._profileActive.get(profileName) ?? 0) + 1);
            const pts = this._profileTimestamps.get(profileName) ?? [];
            pts.push(Date.now());
            this._profileTimestamps.set(profileName, pts);
        }
    }

    /**
     * Returns true if the slot was reserved by drain (queued then released),
     * false if it proceeded immediately.
     */
    private async _waitForSlot(profileName?: string): Promise<boolean> {
        if (this._canProceed(profileName)) return false;

        return new Promise<boolean>((resolve) => {
            const entry: QueueEntry = {
                resolve: () => resolve(true),
                profileName,
                enqueuedAt: Date.now(),
            };
            this._queue.push(entry);
            if (profileName) {
                const pq = this._profileQueues.get(profileName) ?? [];
                pq.push(entry);
                this._profileQueues.set(profileName, pq);
            }

            rateLimitEvents.emit("rate-limit:queued", {
                profileName,
                queueLength: this._queue.length,
                timestamp: new Date().toISOString(),
            });

            this._ensureDrainTimer();
        });
    }

    private _canProceed(profileName?: string): boolean {
        this._pruneTimestamps();

        const globalMaxC = this._config.maxConcurrency;
        if (globalMaxC > 0 && this._activeConcurrency >= globalMaxC) return false;

        const globalRPM = this._config.requestsPerMinute;
        if (globalRPM > 0 && this._timestamps.length >= globalRPM) return false;

        if (profileName && this._config.perProfile?.[profileName]) {
            const override = this._config.perProfile[profileName];
            if (override.maxConcurrency != null && override.maxConcurrency > 0) {
                if ((this._profileActive.get(profileName) ?? 0) >= override.maxConcurrency) return false;
            }
            if (override.requestsPerMinute != null && override.requestsPerMinute > 0) {
                if ((this._profileTimestamps.get(profileName) ?? []).length >= override.requestsPerMinute) return false;
            }
        }

        return true;
    }

    private _drain(): void {
        if (this._queue.length === 0) {
            this._stopDrainTimer();
            return;
        }

        let i = 0;
        while (i < this._queue.length) {
            const entry = this._queue[i];
            if (this._canProceed(entry.profileName)) {
                this._queue.splice(i, 1);
                if (entry.profileName) {
                    const pq = this._profileQueues.get(entry.profileName);
                    if (pq) {
                        const idx = pq.indexOf(entry);
                        if (idx >= 0) pq.splice(idx, 1);
                    }
                }
                // Reserve the slot before resolving
                this._recordSlot(entry.profileName);

                const waitMs = Date.now() - entry.enqueuedAt;
                if (waitMs > 100) {
                    log.debug("Request dequeued", { profile: entry.profileName, waitMs, remaining: this._queue.length });
                }

                entry.resolve();
            } else {
                i++;
            }
        }

        if (this._queue.length === 0) {
            this._stopDrainTimer();
        }
    }

    private _pruneTimestamps(): void {
        const cutoff = Date.now() - 60_000;
        this._timestamps = this._timestamps.filter(t => t > cutoff);
        for (const [name, ts] of this._profileTimestamps) {
            this._profileTimestamps.set(name, ts.filter(t => t > cutoff));
        }
    }

    private _ensureDrainTimer(): void {
        if (this._drainTimer) return;
        this._drainTimer = setInterval(() => this._drain(), 1000);
    }

    private _stopDrainTimer(): void {
        if (this._drainTimer) {
            clearInterval(this._drainTimer);
            this._drainTimer = null;
        }
    }
}

/** Singleton */
export const rateLimiter = new LLMRateLimiter();
