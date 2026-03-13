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
 * - FastPath 资格
 *
 * 参考设计：subagent.md §10, subtask.md S7
 */

import type {
    GroupStickiness,
    StickinessLevel,
    SubagentConfig,
} from "./types.js";
import { DEFAULT_SUBAGENT_CONFIG } from "./types.js";
import type { IMemoryStoreV2, GroupModel } from "../memory-v2/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("stickiness");

/** Stickiness 配置 */
export interface StickinessConfig {
    /** 各级别默认值 */
    defaults: Record<StickinessLevel, {
        priorityMultiplier: number;
        depthCyclePeriod: number;
    }>;
    /** 升级阈值：日均消息数 */
    upgradeThresholds: {
        /** STRANGER → ACQUAINTANCE */
        strangerToAcquaintance: number;
        /** ACQUAINTANCE → FAMILIAR */
        acquaintanceToFamiliar: number;
        /** FAMILIAR → CORE */
        familiarToCore: number;
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
    upgradeThresholds: {
        strangerToAcquaintance: 5,
        acquaintanceToFamiliar: 20,
        familiarToCore: 50,
    },
    downgradeThresholds: {
        coreToFamiliar: 14,
        familiarToAcquaintance: 30,
        acquaintanceToStranger: 60,
    },
};

/** 各级别预设值（不可改） */
const LEVEL_PRESETS: Record<StickinessLevel, {
    fastPathEligible: boolean;
    overactiveThreshold: number;
}> = {
    CORE: { fastPathEligible: true, overactiveThreshold: 200 },
    FAMILIAR: { fastPathEligible: true, overactiveThreshold: 150 },
    ACQUAINTANCE: { fastPathEligible: false, overactiveThreshold: 100 },
    STRANGER: { fastPathEligible: false, overactiveThreshold: 50 },
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
        fastPathEligible: presets.fastPathEligible,
        overactiveThreshold: presets.overactiveThreshold,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * 基于 GroupModel 数据评估亲密度级别
 *
 * @param groupModel - 群组画像
 * @param daysSinceLastInteraction - 距上次交互的天数
 * @param currentLevel - 当前级别（用于升降级判断）
 */
export function evaluateStickiness(
    groupModel: GroupModel | null,
    daysSinceLastInteraction: number,
    currentLevel: StickinessLevel,
    config?: Partial<StickinessConfig>,
): StickinessLevel {
    const cfg = { ...DEFAULT_STICKINESS_CONFIG, ...config };

    // 无数据 → STRANGER
    if (!groupModel) return "STRANGER";

    const avgMsgs = groupModel.avgMessagesPerDay ?? 0;

    // 检查降级
    const downgradeResult = checkDowngrade(currentLevel, daysSinceLastInteraction, cfg);
    if (downgradeResult) return downgradeResult;

    // 检查升级
    const upgradeResult = checkUpgrade(currentLevel, avgMsgs, cfg);
    if (upgradeResult) return upgradeResult;

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

function checkUpgrade(
    level: StickinessLevel,
    avgMsgsPerDay: number,
    config: StickinessConfig,
): StickinessLevel | null {
    switch (level) {
        case "STRANGER":
            if (avgMsgsPerDay >= config.upgradeThresholds.strangerToAcquaintance) return "ACQUAINTANCE";
            break;
        case "ACQUAINTANCE":
            if (avgMsgsPerDay >= config.upgradeThresholds.acquaintanceToFamiliar) return "FAMILIAR";
            break;
        case "FAMILIAR":
            if (avgMsgsPerDay >= config.upgradeThresholds.familiarToCore) return "CORE";
            break;
    }
    return null;
}
