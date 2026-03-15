/**
 * cosine-decay.ts — 上下文深度 Cosine Decay 调度器
 *
 * 根据 attend 次数使用 cosine 曲线周期性切换上下文深度：
 * - L0 (浅): 仅话题摘要 + engagement 分数
 * - L1 (标准): + GroupModel + 历史 callback
 * - L2 (深): + 消息原文
 * - L3 (全): + 深度摘要（LLM 生成）
 *
 * 公式：depth = floor(2 * (1 + cos(2π × attendCount / cyclePeriod)))
 *
 * 参考设计：subagent.md §4.4
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("cosine-decay");

/** Cosine Decay 配置 */
export interface CosineDecayConfig {
    /** 衰减周期（attend 次数）。默认 20 */
    cyclePeriod: number;
    /** 各深度的权重调整 */
    depthWeights?: [number, number, number, number]; // L0, L1, L2, L3
}

/** calculateDepth 可选参数 */
export interface DepthOptions {
    /** 强制最小深度（用于 alert / urgentSignals 场景） */
    forceMinDepth?: ContextDepth;
}

const DEFAULT_CONFIG: CosineDecayConfig = {
    cyclePeriod: 20,
    depthWeights: [1, 1, 1, 1],
};

export type ContextDepth = 0 | 1 | 2 | 3;

/**
 * 计算给定 attend 次数下的上下文深度
 *
 * 使用 cosine 曲线进行周期性调度：
 * - 大部分时间在 L0/L1（浅层，高效）
 * - 周期性深入到 L2/L3（深层，全面）
 *
 * @param attendCount - 已 attend 的次数
 * @param cyclePeriod - 一个完整周期需要的 attend 次数
 * @returns 上下文深度 (0-3)
 */
export function calculateDepth(
    attendCount: number,
    cyclePeriod: number = DEFAULT_CONFIG.cyclePeriod,
    options?: DepthOptions,
): ContextDepth {
    if (cyclePeriod <= 0) return (options?.forceMinDepth ?? 0) as ContextDepth;

    // cos(2π × count / period) 在 [−1, 1] 之间振荡
    // (1 + cos) / 2 映射到 [0, 1]
    // × 3 映射到 [0, 3]
    const t = (2 * Math.PI * attendCount) / cyclePeriod;
    const raw = (1 + Math.cos(t)) / 2; // [0, 1]
    let depth = Math.round(raw * 3) as ContextDepth; // [0, 3]
    depth = Math.min(3, Math.max(0, depth)) as ContextDepth;

    // Alert / urgentSignals 场景强制最小深度
    if (options?.forceMinDepth !== undefined && depth < options.forceMinDepth) {
        depth = options.forceMinDepth;
    }

    return depth;
}

/**
 * 批量预览未来 N 次 attend 的深度调度
 * 用于调试和可视化
 */
export function previewSchedule(startCount: number, steps: number, cyclePeriod: number = 20): ContextDepth[] {
    const schedule: ContextDepth[] = [];
    for (let i = 0; i < steps; i++) {
        schedule.push(calculateDepth(startCount + i, cyclePeriod));
    }
    return schedule;
}

/**
 * 判断当前 attend 是否应该进行深度更新
 * （L2 或 L3）
 */
export function isDeepUpdate(attendCount: number, cyclePeriod: number = 20): boolean {
    return calculateDepth(attendCount, cyclePeriod) >= 2;
}
