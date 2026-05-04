/**
 * stickiness.ts — 群组亲密度 (GroupStickiness) 管理
 *
 * 基于历史交互数据计算和管理群组亲密度级别：
 * - CORE: 核心群组，最高优先级
 * - FAMILIAR: 熟悉群组
 * - ACQUAINTANCE: 认识但不熟
 * - STRANGER: 陌生群组
 *
 * 每个级别有对应的：
 * - 优先级乘数 (priorityMultiplier)
 * - 上下文深度周期 (depthCyclePeriod)
 *
 * 参考设计：subagent.md §10, subtask.md S7
 */

import type {
    GroupStickiness,
    StickinessLevel,
    SubagentConfig,
} from "./types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./types.js";
import type { GroupModel } from "../memory-v2/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("stickiness");

/** Stickiness 配置 */
export interface StickinessConfig {
    /** 各级别默认值 */
    defaults: Record<StickinessLevel, {
        priorityMultiplier: number;
        depthCyclePeriod: number;
    }>;
    /** 基于近 7 天 agent 互动量排名的分层阈值 */
    rankingThresholds: {
        /** 前 15% */
        coreTopRatio: number;
        /** 前 50%（不含 CORE 部分） */
        familiarTopRatio: number;
    };
    /** 降级阈值：连续无交互天数 */
    downgradeThresholds: {
        /** CORE → FAMILIAR */
        coreToFamiliar: number;
        /** FAMILIAR → ACQUAINTANCE */
        familiarToAcquaintance: number;
        /** ACQUAINTANCE → STRANGER */
        acquaintanceToStranger: number;
    };
}

const DEFAULT_STICKINESS_CONFIG: StickinessConfig = {
    defaults: DEFAULT_SUBAGENT_CONFIG.stickiness.defaults,
    rankingThresholds: {
        coreTopRatio: 0.15,
        familiarTopRatio: 0.5,
    },
    downgradeThresholds: {
        coreToFamiliar: 14,
        familiarToAcquaintance: 30,
        acquaintanceToStranger: 60,
    },
};

export interface StickinessInteractionActivity {
    chatId: string;
    interactionCount: number;
}

/** 各级别预设值（不可改） */
const LEVEL_PRESETS: Record<StickinessLevel, {
    overactiveThreshold: number;
    replyFrequency: number;
    initiativeLevel: number;
    maxInterventionsPerHour: number;
    cooldownAfterIntervention: number;
}> = {
    CORE: { overactiveThreshold: 200, replyFrequency: 0.8, initiativeLevel: 0.7, maxInterventionsPerHour: 20, cooldownAfterIntervention: 30_000 },
    FAMILIAR: { overactiveThreshold: 150, replyFrequency: 0.5, initiativeLevel: 0.4, maxInterventionsPerHour: 10, cooldownAfterIntervention: 60_000 },
    ACQUAINTANCE: { overactiveThreshold: 100, replyFrequency: 0.3, initiativeLevel: 0.2, maxInterventionsPerHour: 5, cooldownAfterIntervention: 120_000 },
    STRANGER: { overactiveThreshold: 50, replyFrequency: 0.1, initiativeLevel: 0.05, maxInterventionsPerHour: 2, cooldownAfterIntervention: 300_000 },
};

/**
 * 创建指定级别的默认 GroupStickiness
 */
export function createStickiness(
    level: StickinessLevel,
    config?: Partial<StickinessConfig>,
): GroupStickiness {
    const cfg = { ...DEFAULT_STICKINESS_CONFIG, ...config };
    const defaults = cfg.defaults[level];
    const presets = LEVEL_PRESETS[level];

    return {
        level,
        priorityMultiplier: defaults.priorityMultiplier,
        depthCyclePeriod: defaults.depthCyclePeriod,
        overactiveThreshold: presets.overactiveThreshold,
        replyFrequency: presets.replyFrequency,
        initiativeLevel: presets.initiativeLevel,
        maxInterventionsPerHour: presets.maxInterventionsPerHour,
        cooldownAfterIntervention: presets.cooldownAfterIntervention,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * 基于近 7 天 agent 互动量在活跃群中的相对排名评估亲密度级别
 *
 * @param groupModel - 群组画像
 * @param daysSinceLastInteraction - 距上次交互的天数
 * @param currentLevel - 当前级别（用于升降级判断）
 * @param recentInteractionActivity - 有近 7 天 agent 互动记录的群及互动数
 */
export function evaluateStickiness(
    groupModel: GroupModel | null,
    daysSinceLastInteraction: number,
    currentLevel: StickinessLevel,
    recentInteractionActivity: StickinessInteractionActivity[] = [],
    config?: Partial<StickinessConfig>,
): StickinessLevel {
    const cfg = { ...DEFAULT_STICKINESS_CONFIG, ...config };

    if (!groupModel) return "STRANGER";

    const rankedLevel = rankByRecentInteraction(groupModel.chatId, recentInteractionActivity, cfg);
    if (rankedLevel) return rankedLevel;

    // 没有近期 agent 互动记录时，才保持当前等级或按无互动天数降级。
    const downgradeResult = checkDowngrade(currentLevel, daysSinceLastInteraction, cfg);
    if (downgradeResult) return downgradeResult;

    return currentLevel;
}

/**
 * 更新 Stickiness（结合评估结果）
 */
export function updateStickiness(
    current: GroupStickiness,
    newLevel: StickinessLevel,
    config?: Partial<StickinessConfig>,
): GroupStickiness {
    if (current.level === newLevel) return current;

    const updated = createStickiness(newLevel, config);
    log.info("updateStickiness", { from: current.level, to: newLevel });
    return updated;
}

// ─── 内部 ───

function checkDowngrade(
    level: StickinessLevel,
    daysSinceLastInteraction: number,
    config: StickinessConfig,
): StickinessLevel | null {
    switch (level) {
        case "CORE":
            if (daysSinceLastInteraction >= config.downgradeThresholds.coreToFamiliar) return "FAMILIAR";
            break;
        case "FAMILIAR":
            if (daysSinceLastInteraction >= config.downgradeThresholds.familiarToAcquaintance) return "ACQUAINTANCE";
            break;
        case "ACQUAINTANCE":
            if (daysSinceLastInteraction >= config.downgradeThresholds.acquaintanceToStranger) return "STRANGER";
            break;
    }
    return null;
}

function rankByRecentInteraction(
    chatId: string,
    activity: StickinessInteractionActivity[],
    config: StickinessConfig,
): StickinessLevel | null {
    const active = activity
        .filter(item => item.interactionCount > 0)
        .sort((a, b) => b.interactionCount - a.interactionCount || a.chatId.localeCompare(b.chatId));
    if (active.length === 0) return null;

    const target = active.find(item => item.chatId === chatId);
    if (!target) return null;

    const coreCutoffIndex = Math.max(0, Math.ceil(active.length * config.rankingThresholds.coreTopRatio) - 1);
    const familiarCutoffIndex = Math.max(0, Math.ceil(active.length * config.rankingThresholds.familiarTopRatio) - 1);
    const coreCutoff = active[coreCutoffIndex]?.interactionCount ?? Infinity;
    const familiarCutoff = active[familiarCutoffIndex]?.interactionCount ?? Infinity;

    if (target.interactionCount >= coreCutoff) return "CORE";
    if (target.interactionCount >= familiarCutoff) return "FAMILIAR";
    return "ACQUAINTANCE";
}
