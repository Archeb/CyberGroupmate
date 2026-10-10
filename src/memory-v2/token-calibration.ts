/**
 * token-calibration.ts — 本地估算 → 实际 token 的每模型校准
 *
 * cl100k (tiktoken) 与实际服务模型（Qwen/GLM/DS 等）的 tokenizer 不一致，
 * 超长文本还走启发式估算，系统性偏低会让预算守卫放行实际超窗的请求
 * （实测 23 万字符的 compact 摘要估出 ~156K、实际 ~260K tokens）。
 *
 * 每次成功的 LLM 调用后，用 API 返回的真实 promptTokens 与本地估算的比值
 * 维护按模型的 EWMA 校准系数（只收紧不放松），供 shouldCompact / forceTrim
 * 在预算判断时放大估算值。
 *
 * 依赖方向：本模块不 import llm.ts / context-manager.ts（避免循环依赖），
 * estimator 由 context-manager 在模块加载时注入。
 */

import type { ChatMessage } from "../core/llm/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("token-calib");

/** 校准系数下限：估算偏高时不放大预算 */
const MIN_FACTOR = 1.0;
/** 校准系数上限：单次异常采样不至于把预算压到零 */
const MAX_FACTOR = 4.0;
/** EWMA 平滑系数 */
const EWMA_ALPHA = 0.3;
/** 实际 prompt 低于该值时不采样：请求模板/开销噪音占比太高 */
const MIN_SAMPLE_PROMPT_TOKENS = 4000;

const _factors = new Map<string, number>();

let _estimator: ((messages: ChatMessage[]) => number) | null = null;

/** 由 context-manager 注入消息级 token 估算器（模块加载时调用一次） */
export function setMessagesTokenEstimator(fn: (messages: ChatMessage[]) => number): void {
    _estimator = fn;
}

/** 记录一次「实际 / 估算」采样，更新该模型的 EWMA 校准系数 */
export function recordTokenCalibration(model: string, actualPromptTokens: number, estimatedTokens: number): void {
    if (!model || actualPromptTokens < MIN_SAMPLE_PROMPT_TOKENS || estimatedTokens <= 0) return;
    const sample = Math.min(Math.max(actualPromptTokens / estimatedTokens, MIN_FACTOR), MAX_FACTOR);
    const prev = _factors.get(model);
    const next = prev == null ? sample : prev + EWMA_ALPHA * (sample - prev);
    _factors.set(model, next);
    if (prev == null) {
        log.info("token 校准初始化", {
            model,
            factor: Number(next.toFixed(3)),
            actualPromptTokens,
            estimatedTokens,
        });
    } else {
        log.debug("token 校准更新", {
            model,
            factor: Number(next.toFixed(3)),
            sample: Number(sample.toFixed(3)),
        });
    }
}

/** 用响应携带的真实 usage 采样（estimator 未注入或估算失败时静默跳过） */
export function recordTokenCalibrationFromUsage(
    model: string,
    promptTokens: number | undefined,
    messages: ChatMessage[],
): void {
    if (promptTokens == null || !_estimator) return;
    try {
        recordTokenCalibration(model, promptTokens, _estimator(messages));
    } catch (err) {
        log.debug("token 校准采样失败", { model, error: String(err) });
    }
}

/** 获取模型的当前校准系数（未知模型为 1） */
export function tokenCalibrationFactor(model?: string): number {
    if (!model) return 1;
    return _factors.get(model) ?? 1;
}

/** 测试用：清空全部校准状态 */
export function resetTokenCalibration(): void {
    _factors.clear();
}
