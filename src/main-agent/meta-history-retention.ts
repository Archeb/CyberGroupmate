import { loadConfig, type AppConfig, type MetaHistoryBudgetConfig } from "../core/config.js";

export const META_SESSION_HISTORY_SOFT_CHAR_LIMIT = 18_000;
export const META_SESSION_HISTORY_TRIM_TARGET_CHARS = 10_000;
export const META_SESSION_HISTORY_HARD_MESSAGE_LIMIT = 48;
export const META_SESSION_HISTORY_TRIM_TARGET_MESSAGES = 32;
export const META_SESSION_HISTORY_MIN_MESSAGES = 8;

export interface ResolvedMetaHistoryBudget {
    softCharLimit: number;
    trimTargetChars: number;
    minMessages: number;
    hardMessageLimit: number;
    trimTargetMessages: number;
}

export interface MetaHistoryWindowStatus extends ResolvedMetaHistoryBudget {
    currentChars: number;
    currentMessages: number;
    willTrimOnNextAppend: boolean;
}

export function trimMetaSessionHistoryWindow<T extends { content: string }>(history: T[]): void {
    const budget = resolveMetaHistoryBudget();
    let totalChars = history.reduce((sum, message) => sum + normalizedContentLength(message.content), 0);
    const shouldTrimByChars = totalChars > budget.softCharLimit;
    const shouldTrimByCount = history.length > budget.hardMessageLimit;

    if (!shouldTrimByChars && !shouldTrimByCount) {
        return;
    }

    const targetChars = shouldTrimByChars ? budget.trimTargetChars : Number.POSITIVE_INFINITY;
    const targetMessages = shouldTrimByCount ? budget.trimTargetMessages : Number.POSITIVE_INFINITY;

    while (
        history.length > budget.minMessages
        && (totalChars > targetChars || history.length > targetMessages)
    ) {
        const removed = history.shift();
        if (!removed) {
            break;
        }
        totalChars -= normalizedContentLength(removed.content);
    }
}

export function resolveMetaHistoryBudget(config: AppConfig = loadConfig()): ResolvedMetaHistoryBudget {
    const budget = config.subagent?.metaHistory;

    return {
        softCharLimit: positiveInt(budget?.softCharLimit, META_SESSION_HISTORY_SOFT_CHAR_LIMIT),
        trimTargetChars: positiveInt(budget?.trimTargetChars, META_SESSION_HISTORY_TRIM_TARGET_CHARS),
        minMessages: positiveInt(budget?.minMessages, META_SESSION_HISTORY_MIN_MESSAGES),
        hardMessageLimit: positiveInt(budget?.hardMessageLimit, META_SESSION_HISTORY_HARD_MESSAGE_LIMIT),
        trimTargetMessages: positiveInt(budget?.trimTargetMessages, META_SESSION_HISTORY_TRIM_TARGET_MESSAGES),
    };
}

export function getMetaHistoryWindowStatus<T extends { content: string }>(
    history: T[],
    config: AppConfig = loadConfig(),
): MetaHistoryWindowStatus {
    const budget = resolveMetaHistoryBudget(config);
    const currentChars = history.reduce((sum, message) => sum + normalizedContentLength(message.content), 0);

    return {
        ...budget,
        currentChars,
        currentMessages: history.length,
        willTrimOnNextAppend: currentChars > budget.softCharLimit || history.length > budget.hardMessageLimit,
    };
}

function normalizedContentLength(content: string): number {
    return String(content ?? "").trim().length;
}

function positiveInt(value: MetaHistoryBudgetConfig[keyof MetaHistoryBudgetConfig], fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}