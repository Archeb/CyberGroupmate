/**
 * token-stats.ts — 持久化 Token 用量与费用统计
 *
 * 按模型维度累计 token 用量 + 根据 pricing config 计算费用。
 * 使用 JSON 文件持久化（workspace/token-stats.json），不依赖 SQLite。
 *
 * 在 EventBridge 的 llm:response 回调中调用 record() 写入统计。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../core/logger.js";
import type { TokenPricingEntry, LLMConfig } from "../core/config.js";
import type { LLMResponse } from "../core/llm.js";

const log = createLogger("token-stats");

/** 单个模型的累计统计 */
export interface ModelStats {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    totalCost: number;
    callCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
}

/** 持久化数据结构 */
export interface TokenStatsData {
    byModel: Record<string, ModelStats>;
    updatedAt: string;
}

/** 计算单次调用费用（USD） */
export function calculateCallCost(
    usage: LLMResponse["usage"],
    pricing?: TokenPricingEntry,
): number {
    if (!usage || !pricing) return 0;

    const M = 1_000_000; // per-million

    const promptTokens = usage.promptTokens ?? 0;
    const completionTokens = usage.completionTokens ?? 0;
    const cachedTokens = usage.cachedTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;

    // 非缓存 prompt token = total prompt - cached（OpenAI cached 包含在 prompt_tokens 中）
    // Anthropic: input_tokens 已经排除了 cache_read 和 cache_creation
    const regularPrompt = Math.max(0, promptTokens - cachedTokens);

    let cost = 0;
    cost += (regularPrompt / M) * pricing.input;
    cost += (completionTokens / M) * pricing.output;
    cost += (cachedTokens / M) * (pricing.cachedInput ?? pricing.input);
    cost += (cacheCreationTokens / M) * (pricing.cacheCreation ?? pricing.input);

    return cost;
}

export class TokenStatsCollector {
    private data: TokenStatsData;
    private filePath: string;
    private dirty = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    /** model name → pricing (derived from profiles) */
    private modelPricing: Record<string, TokenPricingEntry> = {};
    /** model name → profile name (for frontend display) */
    private modelToProfile: Record<string, string> = {};

    constructor(filePath: string, llmProfiles?: Record<string, LLMConfig>) {
        this.filePath = filePath;
        this.data = this.load();
        if (llmProfiles) this.setProfiles(llmProfiles);
    }

    /** 从 LLM profiles 中提取 pricing 映射 */
    setProfiles(profiles: Record<string, LLMConfig>): void {
        this.modelPricing = {};
        this.modelToProfile = {};
        for (const [name, cfg] of Object.entries(profiles)) {
            this.modelToProfile[cfg.model] = name;
            if (cfg.pricing) {
                this.modelPricing[cfg.model] = cfg.pricing;
            }
        }
    }

    /** 记录一次 LLM 调用统计 */
    record(model: string, usage: LLMResponse["usage"]): void {
        if (!usage) return;

        const now = new Date().toISOString();
        if (!this.data.byModel[model]) {
            this.data.byModel[model] = {
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                cacheCreationTokens: 0,
                totalCost: 0,
                callCount: 0,
                firstSeenAt: now,
                lastSeenAt: now,
            };
        }

        const stats = this.data.byModel[model];
        stats.promptTokens += usage.promptTokens ?? 0;
        stats.completionTokens += usage.completionTokens ?? 0;
        stats.cachedTokens += usage.cachedTokens ?? 0;
        stats.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
        stats.callCount += 1;
        stats.lastSeenAt = now;

        // 计算费用
        const pricing = this.modelPricing[model];
        if (pricing) {
            stats.totalCost += calculateCallCost(usage, pricing);
        }

        this.data.updatedAt = now;
        this.markDirty();
    }

    /** 获取当前统计数据 */
    getStats(): TokenStatsData {
        return this.data;
    }

    /** 获取 pricing（从 profiles 构建，前端用） */
    getPricing(): Record<string, TokenPricingEntry> {
        const result: Record<string, TokenPricingEntry> = {};
        for (const [model, pricing] of Object.entries(this.modelPricing)) {
            const profileName = this.modelToProfile[model] ?? model;
            result[profileName] = pricing;
        }
        return result;
    }

    /** 清零统计 */
    reset(): void {
        this.data = { byModel: {}, updatedAt: new Date().toISOString() };
        this.save();
    }

    /** 关闭时保存 */
    shutdown(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        if (this.dirty) this.save();
    }

    // ─── 内部 ───

    private load(): TokenStatsData {
        if (!existsSync(this.filePath)) {
            return { byModel: {}, updatedAt: new Date().toISOString() };
        }
        try {
            const raw = readFileSync(this.filePath, "utf-8");
            const parsed = JSON.parse(raw) as TokenStatsData;
            if (parsed && typeof parsed.byModel === "object") {
                return parsed;
            }
        } catch (err) {
            log.warn("token-stats.json 解析错误，重置", { error: String(err) });
        }
        return { byModel: {}, updatedAt: new Date().toISOString() };
    }

    private save(): void {
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
            this.dirty = false;
        } catch (err) {
            log.warn("token-stats.json 保存失败", { error: String(err) });
        }
    }

    private markDirty(): void {
        this.dirty = true;
        if (!this.saveTimer) {
            this.saveTimer = setTimeout(() => {
                this.saveTimer = null;
                if (this.dirty) this.save();
            }, 30_000);
        }
    }
}
