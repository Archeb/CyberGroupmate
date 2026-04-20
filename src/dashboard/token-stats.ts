/**
 * token-stats.ts — 持久化 Token 用量与费用统计
 *
 * 按模型/调用方/时段维度累计 token 用量，费用在查询时根据当前 pricing 动态计算。
 * 使用 JSON 文件持久化（workspace/token-stats.json），不依赖 SQLite。
 *
 * 存储格式 v2：按小时桶（hourKey|model|caller）聚合，无预计算费用字段，
 * 确保修改 pricing 后历史数据费用自动重算。
 *
 * 在 EventBridge 的 llm:response 回调中调用 record() 写入统计。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../core/logger.js";
import type { TokenPricingEntry, LLMConfig } from "../core/config.js";
import type { LLMResponse } from "../core/llm.js";

const log = createLogger("token-stats");

// ─── Caller 归一化 ───

/** 将不同的 caller 变体归并到同一模块名 */
const CALLER_ALIASES: Record<string, string> = {
    "session-runner-pass2": "session-runner",
};

function normalizeCaller(caller: string): string {
    return CALLER_ALIASES[caller] ?? caller;
}

// ─── 时间键工具 ───

/** 截断到小时的 UTC ISO 前缀，如 "2024-01-15T14"（可直接字符串比较排序） */
function toHourKey(iso: string): string {
    return iso.slice(0, 13); // "YYYY-MM-DDTHH"
}

function makeBucketKey(hourKey: string, model: string, caller: string): string {
    return `${hourKey}|${model}|${caller}`;
}

function parseBucketKey(key: string): { hourKey: string; model: string; caller: string } {
    const idx1 = key.indexOf("|");
    const idx2 = key.indexOf("|", idx1 + 1);
    return {
        hourKey: key.slice(0, idx1),
        model: key.slice(idx1 + 1, idx2),
        caller: key.slice(idx2 + 1),
    };
}

// ─── 存储结构 v2 ───

/** 单个小时桶内的 token 计数（不含费用，费用在查询时动态计算） */
export interface TokenBucket {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    callCount: number;
    firstSeenAt: string;
    lastSeenAt: string;
}

/** v2 持久化数据结构 */
export interface TokenStatsDataV2 {
    version: 2;
    /** key = "hourKey|model|caller" */
    buckets: Record<string, TokenBucket>;
    updatedAt: string;
}

/** v1 旧格式（迁移用） */
interface TokenStatsDataV1 {
    byModel: Record<string, {
        promptTokens: number;
        completionTokens: number;
        cachedTokens: number;
        cacheCreationTokens: number;
        totalCost: number;
        callCount: number;
        firstSeenAt: string;
        lastSeenAt: string;
    }>;
    updatedAt: string;
}

// ─── 查询接口 ───

export type GroupBy = "model" | "caller" | "both";
export type Period = "hour" | "day" | "week" | "month" | "all";
export type SortBy = "cost" | "promptTokens" | "completionTokens" | "callCount";
export type SortDir = "asc" | "desc";

export interface TokenStatsQuery {
    groupBy?: GroupBy;
    period?: Period;
    /** 自定义起始时间（ISO），优先于 period */
    from?: string;
    /** 自定义结束时间（ISO），优先于 period */
    to?: string;
    sortBy?: SortBy;
    sortDir?: SortDir;
    /** 只显示指定模型的数据 */
    filterModel?: string;
    /** 只显示指定调用方（模块）的数据 */
    filterCaller?: string;
}

export interface TokenStatsRow {
    key: string;
    model?: string;
    caller?: string;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    callCount: number;
    totalCost: number;
    firstSeenAt: string;
    lastSeenAt: string;
}

export interface TokenStatsTotals {
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheCreationTokens: number;
    callCount: number;
    totalCost: number;
}

export interface TokenStatsResult {
    rows: TokenStatsRow[];
    totals: TokenStatsTotals;
    groupBy: GroupBy;
    period: Period | "custom";
    from: string;
    to: string;
    updatedAt: string;
}

// ─── 费用计算 ───

/** 计算单次调用费用（USD），根据当前 pricing 动态计算 */
export function calculateCallCost(
    usage: Pick<NonNullable<LLMResponse["usage"]>, "promptTokens" | "completionTokens" | "cachedTokens" | "cacheCreationTokens">,
    pricing?: TokenPricingEntry,
): number {
    if (!pricing) return 0;

    const M = 1_000_000;
    const promptTokens = usage.promptTokens ?? 0;
    const completionTokens = usage.completionTokens ?? 0;
    const cachedTokens = usage.cachedTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;

    // Anthropic: input_tokens 已排除 cache_read 和 cache_creation
    // OpenAI: cached_tokens 包含在 prompt_tokens 中，需减去
    const regularPrompt = Math.max(0, promptTokens - cachedTokens);

    let cost = 0;
    cost += (regularPrompt / M) * pricing.input;
    cost += (completionTokens / M) * pricing.output;
    cost += (cachedTokens / M) * (pricing.cachedInput ?? pricing.input);
    cost += (cacheCreationTokens / M) * (pricing.cacheCreation ?? pricing.input);
    return cost;
}

// ─── 主类 ───

export class TokenStatsCollector {
    private data: TokenStatsDataV2;
    private filePath: string;
    private dirty = false;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;

    /** model name → pricing */
    private modelPricing: Record<string, TokenPricingEntry> = {};
    /** model name → profile name（前端显示用） */
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

    /**
     * 记录一次 LLM 调用统计
     * @param model  - 模型名
     * @param caller - 调用方标识（自动归一化别名）
     * @param usage  - token 用量
     */
    record(model: string, caller: string, usage: LLMResponse["usage"]): void {
        if (!usage) return;

        const now = new Date().toISOString();
        const normalizedCaller = normalizeCaller(caller);
        const bucketKey = makeBucketKey(toHourKey(now), model, normalizedCaller);

        if (!this.data.buckets[bucketKey]) {
            this.data.buckets[bucketKey] = {
                promptTokens: 0,
                completionTokens: 0,
                cachedTokens: 0,
                cacheCreationTokens: 0,
                callCount: 0,
                firstSeenAt: now,
                lastSeenAt: now,
            };
        }

        const bucket = this.data.buckets[bucketKey];
        bucket.promptTokens += usage.promptTokens ?? 0;
        bucket.completionTokens += usage.completionTokens ?? 0;
        bucket.cachedTokens += usage.cachedTokens ?? 0;
        bucket.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
        bucket.callCount += 1;
        bucket.lastSeenAt = now;

        this.data.updatedAt = now;
        this.markDirty();
    }

    /**
     * 查询统计数据，费用根据当前 pricing 动态计算
     */
    query(opts: TokenStatsQuery = {}): TokenStatsResult {
        const {
            groupBy = "model",
            period = "all",
            from,
            to,
            sortBy = "cost",
            sortDir = "desc",
            filterModel,
            filterCaller,
        } = opts;

        const { fromDate, toDate } = resolveRange(period, from, to);
        const fromKey = toHourKey(fromDate.toISOString());
        const toKey = toHourKey(toDate.toISOString());

        const aggregated = new Map<string, TokenStatsRow>();

        for (const [bucketKey, bucket] of Object.entries(this.data.buckets)) {
            const { hourKey, model, caller } = parseBucketKey(bucketKey);

            // 时间过滤（字符串比较，UTC hour key 是可排序的）
            if (hourKey < fromKey || hourKey > toKey) continue;
            // 模型/模块过滤
            if (filterModel && model !== filterModel) continue;
            if (filterCaller && caller !== filterCaller) continue;

            // 聚合 key
            let aggKey: string;
            if (groupBy === "model") aggKey = model;
            else if (groupBy === "caller") aggKey = caller;
            else aggKey = `${model}|${caller}`;

            if (!aggregated.has(aggKey)) {
                aggregated.set(aggKey, {
                    key: aggKey,
                    model: groupBy !== "caller" ? model : undefined,
                    caller: groupBy !== "model" ? caller : undefined,
                    promptTokens: 0,
                    completionTokens: 0,
                    cachedTokens: 0,
                    cacheCreationTokens: 0,
                    callCount: 0,
                    totalCost: 0,
                    firstSeenAt: bucket.firstSeenAt,
                    lastSeenAt: bucket.lastSeenAt,
                });
            }

            const row = aggregated.get(aggKey)!;
            row.promptTokens += bucket.promptTokens;
            row.completionTokens += bucket.completionTokens;
            row.cachedTokens += bucket.cachedTokens;
            row.cacheCreationTokens += bucket.cacheCreationTokens;
            row.callCount += bucket.callCount;
            if (bucket.firstSeenAt < row.firstSeenAt) row.firstSeenAt = bucket.firstSeenAt;
            if (bucket.lastSeenAt > row.lastSeenAt) row.lastSeenAt = bucket.lastSeenAt;

            // 费用按桶内 model 动态计算（groupBy=caller 时跨模型累加各自定价）
            row.totalCost += calculateCallCost(bucket, this.modelPricing[model]);
        }

        // 排序
        const rows = [...aggregated.values()];
        rows.sort((a, b) => {
            let diff: number;
            switch (sortBy) {
                case "cost": diff = a.totalCost - b.totalCost; break;
                case "promptTokens": diff = a.promptTokens - b.promptTokens; break;
                case "completionTokens": diff = a.completionTokens - b.completionTokens; break;
                case "callCount": diff = a.callCount - b.callCount; break;
                default: diff = a.totalCost - b.totalCost;
            }
            return sortDir === "asc" ? diff : -diff;
        });

        // 合计
        const totals: TokenStatsTotals = rows.reduce(
            (acc, r) => ({
                promptTokens: acc.promptTokens + r.promptTokens,
                completionTokens: acc.completionTokens + r.completionTokens,
                cachedTokens: acc.cachedTokens + r.cachedTokens,
                cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
                callCount: acc.callCount + r.callCount,
                totalCost: acc.totalCost + r.totalCost,
            }),
            { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, callCount: 0, totalCost: 0 },
        );

        return {
            rows,
            totals,
            groupBy,
            period: from || to ? "custom" : period,
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
            updatedAt: this.data.updatedAt,
        };
    }

    /** 列出所有出现过的模型和调用方（用于前端筛选下拉框） */
    listMeta(): { models: string[]; callers: string[] } {
        const models = new Set<string>();
        const callers = new Set<string>();
        for (const key of Object.keys(this.data.buckets)) {
            const { model, caller } = parseBucketKey(key);
            models.add(model);
            callers.add(caller);
        }
        return {
            models: [...models].sort(),
            callers: [...callers].sort(),
        };
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
        this.data = { version: 2, buckets: {}, updatedAt: new Date().toISOString() };
        this.save();
    }

    /** 关闭时保存 */
    shutdown(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        if (this.dirty) this.save();
    }

    // ─── 内部 ───

    private load(): TokenStatsDataV2 {
        if (!existsSync(this.filePath)) {
            return { version: 2, buckets: {}, updatedAt: new Date().toISOString() };
        }
        try {
            const raw = readFileSync(this.filePath, "utf-8");
            const parsed = JSON.parse(raw) as TokenStatsDataV2 | TokenStatsDataV1;

            // v2 格式
            if ("version" in parsed && parsed.version === 2 && typeof parsed.buckets === "object") {
                return parsed;
            }

            // v1 格式迁移
            if ("byModel" in parsed && typeof parsed.byModel === "object") {
                log.info("token-stats: 检测到 v1 格式，自动迁移到 v2");
                return this.migrateV1(parsed as TokenStatsDataV1);
            }
        } catch (err) {
            log.warn("token-stats.json 解析错误，重置", { error: String(err) });
        }
        return { version: 2, buckets: {}, updatedAt: new Date().toISOString() };
    }

    /** 将 v1 的 byModel 结构迁移为 v2 hourly buckets */
    private migrateV1(v1: TokenStatsDataV1): TokenStatsDataV2 {
        const data: TokenStatsDataV2 = {
            version: 2,
            buckets: {},
            updatedAt: v1.updatedAt,
        };
        for (const [model, stats] of Object.entries(v1.byModel)) {
            // 使用 lastSeenAt 的小时作为桶 key；caller 标记为 legacy
            const hourKey = toHourKey(stats.lastSeenAt || new Date().toISOString());
            const bucketKey = makeBucketKey(hourKey, model, "legacy");
            data.buckets[bucketKey] = {
                promptTokens: stats.promptTokens,
                completionTokens: stats.completionTokens,
                cachedTokens: stats.cachedTokens,
                cacheCreationTokens: stats.cacheCreationTokens,
                callCount: stats.callCount,
                firstSeenAt: stats.firstSeenAt,
                lastSeenAt: stats.lastSeenAt,
            };
        }
        return data;
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

// ─── 工具函数 ───

function resolveRange(
    period: Period,
    from?: string,
    to?: string,
): { fromDate: Date; toDate: Date } {
    const now = new Date();
    const parsedFrom = from ? new Date(from) : null;
    const parsedTo = to ? new Date(to) : null;
    const fromValid = !!parsedFrom && !Number.isNaN(parsedFrom.getTime());
    const toValid = !!parsedTo && !Number.isNaN(parsedTo.getTime());

    if (fromValid || toValid) {
        return {
            fromDate: fromValid ? parsedFrom! : new Date(0),
            toDate: toValid ? parsedTo! : now,
        };
    }

    switch (period) {
        case "hour":  return { fromDate: new Date(now.getTime() - 3_600_000), toDate: now };
        case "day":   return { fromDate: new Date(now.getTime() - 86_400_000), toDate: now };
        case "week":  return { fromDate: new Date(now.getTime() - 7 * 86_400_000), toDate: now };
        case "month": return { fromDate: new Date(now.getTime() - 30 * 86_400_000), toDate: now };
        default:      return { fromDate: new Date(0), toDate: now };
    }
}
