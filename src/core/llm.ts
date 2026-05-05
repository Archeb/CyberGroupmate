/**
 * llm.ts — LLM API 调用封装
 *
 * 统一的 LLM 调用接口，支持 Anthropic Claude API、OpenAI 兼容 API 和 Google Gemini API。
 * 处理 rate limiting、重试和错误恢复。
 * 支持多 key 负载均衡池（通过 LLMConfig.pool）。
 *
 * 配置加载已迁移到 config.ts。
 * Provider 实现已拆分到 llm/ 目录。
 */

// 从 config.ts 重新导出，保持向后兼容
export { type LLMConfig } from "./config.js";

// 从 llm/types.ts 重新导出类型，保持向后兼容
export { type ImagePart, type ChatMessage, type LLMResponse } from "./llm/types.js";

import type { LLMConfig } from "./config.js";
import type { ChatMessage, LLMResponse } from "./llm/types.js";
import type { ContextManifest } from "../context-engine/types.js";
import { getOrCreatePool } from "./llm-pool.js";
import { rateLimiter } from "./llm-rate-limiter.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { EventEmitter } from "node:events";

// Provider 实现
import { callOpenAI } from "./llm/openai.js";
import { callOpenAIResponses } from "./llm/openai-responses.js";
import { callAnthropic } from "./llm/anthropic.js";
import { callGoogle } from "./llm/google.js";

const log = createLogger("llm");

// ─── LLM 事件总线（供 Dashboard 订阅） ───

export const llmEvents = new EventEmitter();
llmEvents.setMaxListeners(20);

/** LLM 调用事件数据 */
export interface LLMCallEvent {
    /** 唯一调用 ID */
    callId: string;
    /** 调用方模块标识 */
    caller: string;
    /** 模型名 */
    model: string;
    /** 温度 */
    temperature: number;
    /** 最大 token 数 */
    maxTokens: number;
    /** provider */
    provider: string;
    /** 消息摘要：每条消息的 role + content 前 200 字 + imageParts 信息 */
    messageSummaries: Array<{
        role: string;
        contentPreview: string;
        imageCount: number;
        /** 图片 URL 列表（base64 只保留前缀，URL 保留完整） */
        imageUrls?: string[];
    }>;
    /** 调用开始时间 */
    timestamp: string;
    /** 额外请求体字段（如有） */
    extraBody?: Record<string, unknown>;
    /** 自定义请求头（如有） */
    customHeaders?: Record<string, string>;
    /** 调用时对应的 ContextEngine manifest（如有） */
    contextManifest?: ContextManifest;
}

/** LLM 响应事件数据 */
export interface LLMResponseEvent {
    /** 对应的调用 ID */
    callId: string;
    /** 调用方模块标识 */
    caller: string;
    /** 响应内容前 500 字 */
    contentPreview: string;
    /** 完整内容长度 */
    contentLength: number;
    /** token 用量 */
    usage?: LLMResponse["usage"];
    /** 耗时 ms */
    durationMs: number;
    /** 是否出错 */
    error?: string;
    /** 时间戳 */
    timestamp: string;
}

/** LLM 重试事件数据 */
export interface LLMRetryEvent {
    /** 对应的调用 ID */
    callId: string;
    /** 调用方模块标识 */
    caller: string;
    /** 当前重试次数（1-based） */
    attempt: number;
    /** 最大重试次数 */
    maxRetries: number;
    /** 错误信息 */
    error: string;
    /** 错误原因分类 */
    reason: string;
    /** 重试延迟 ms（0 表示立即重试） */
    retryDelayMs: number;
    /** 时间戳 */
    timestamp: string;
}

/** LLM 调用选项（可覆盖默认配置） */
export interface LLMCallOptions {
    /** 覆盖默认温度 */
    temperature?: number;
    /** 覆盖默认 max tokens */
    maxTokens?: number;
    /** 覆盖默认 model */
    model?: string;
    /** Gemini thinking level: "none" | "low" | "medium" | "high" */
    thinkingLevel?: string;
    /** 调用方模块标识（用于 Dashboard 日志显示） */
    caller?: string;
    /**
     * Assistant prefill — 预填充 LLM 的回复开头。
     * 如果 LLMConfig.supportsPrefill !== false，会在消息列表末尾追加
     * 一条 role=assistant 消息作为生成起点。返回的 content 会自动拼接
     * prefill 前缀，调用方拿到的是完整文本。
     */
    prefill?: string;
    /** Stop sequences — LLM 遇到这些字符串时停止生成 */
    stop?: string[];
    /** 请求超时（毫秒）。来自 llmRouting.timeouts[component]，未设置则使用默认 60000 */
    timeoutMs?: number;
    /** Profile 名称（用于限速器按 profile 限速） */
    profileName?: string;
    /** 调用时对应的 ContextEngine manifest（供 Dashboard 可视化） */
    contextManifest?: ContextManifest;
}

let _callIdCounter = 0;
function nextCallId(): string {
    return `llm_${Date.now()}_${++_callIdCounter}`;
}

// ─── 活跃 LLM 调用追踪（用于 Dashboard 取消/立即重试） ───

const _activeControllers = new Map<string, AbortController>();

/**
 * 取消指定 callId 的活跃 LLM 请求并立即重试。
 * 由 Dashboard 通过 WebSocket 命令调用。
 * 取消后 retry 循环会跳过退避延迟立即重试。
 */
export function cancelLLMCall(callId: string): boolean {
    const controller = _activeControllers.get(callId);
    if (controller) {
        log.info("LLM call cancelled by user for immediate retry", { callId });
        // 必须传入 DOMException 而非裸字符串，否则 Node.js undici 的 fetch
        // 会直接 reject(signal.reason)，导致 catch 收到的是字符串而非 Error，
        // 使得 err instanceof Error 判断失败，跳过重试逻辑。
        const abortError = new DOMException("user_retry", "AbortError");
        controller.abort(abortError);
        return true;
    }
    return false;
}

/** 获取当前活跃的 LLM 调用 ID 列表 */
export function getActiveLLMCalls(): string[] {
    return [..._activeControllers.keys()];
}

function summarizeMessages(messages: ChatMessage[]): LLMCallEvent["messageSummaries"] {
    return messages.map(m => {
        const imageUrls = (m.imageParts ?? []).map(img => img.url);
        return {
            role: m.role,
            contentPreview: m.content,
            imageCount: m.imageParts?.length ?? 0,
            imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
        };
    });
}

function detectErrorContentPattern(content: string, patterns?: string[]): string | null {
    if (!patterns || patterns.length === 0) return null;
    const lowerContent = content.toLowerCase();
    for (const rawPattern of patterns) {
        const pattern = rawPattern.trim();
        if (!pattern) continue;
        if (lowerContent.includes(pattern.toLowerCase())) {
            return pattern;
        }
    }
    return null;
}

// ─── LLM 调用 ───

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // 指数退避

/**
 * 检测错误是否为 quota/rate-limit 类型
 */
function isQuotaError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return msg.includes("429") || msg.includes("rate limit") ||
        msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("overloaded") || msg.includes("402") ||
        msg.includes("payment") || msg.includes("Payment Required") ||
        msg.includes("insufficient");
}

/**
 * 检测错误是否为认证/权限类型（key 无效、billing 被关）
 */
function isAuthError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return msg.includes("401") || msg.includes("403") ||
        msg.includes("PERMISSION_DENIED") || msg.includes("API key not valid") ||
        msg.includes("billing") || msg.includes("Unauthorized") ||
        msg.includes("Forbidden");
}

/**
 * 调用 LLM API
 *
 * 支持 Anthropic Claude API、OpenAI 兼容 API 和 Google Gemini API。
 * 自动处理 rate limiting 和重试。
 * 当 config 配置了 pool 时，自动在多个 API key 之间进行负载均衡。
 *
 * @param messages - OpenAI 格式消息数组
 * @param config - LLM 配置
 * @param options - 可选的调用参数覆盖
 * @returns LLM 响应（含生成文本和 token 用量）
 */
export async function callLLM(
    messages: ChatMessage[],
    config: LLMConfig,
    options?: LLMCallOptions
): Promise<LLMResponse> {
    // ── Pool 模式：委托给 callLLMWithPool ──
    if (config.pool && config.pool.members.length > 0) {
        return callLLMWithPool(messages, config, options);
    }

    // ── 单 key 模式（原有逻辑） ──
    return callLLMSingleKey(messages, config, options);
}

/**
 * Pool 模式调用：从池中获取 key，调用 API，释放 key。
 * 如果当前 key 遇到 429/quota 错误，会尝试从池中获取另一个 key 重试。
 */
async function callLLMWithPool(
    messages: ChatMessage[],
    config: LLMConfig,
    options?: LLMCallOptions,
): Promise<LLMResponse> {
    const poolConfig = config.pool!;
    // poolId 包含 model + baseUrl + members 指纹，避免不同 profile 共享同一 pool
    const memberFingerprint = poolConfig.members
        .map(m => m.apiKey.slice(0, 8))
        .sort()
        .join(",");
    const pool = getOrCreatePool(`${config.model}:${config.baseUrl}:${memberFingerprint}`, poolConfig);

    // 最多尝试 pool.size 次不同的 key
    const maxPoolAttempts = pool.size;
    let lastError: Error | null = null;

    for (let i = 0; i < maxPoolAttempts; i++) {
        const handle = pool.acquire();
        if (!handle) {
            // 所有 key 冷却中或已禁用，跳出走 fallback（如果有）或抛错
            break;
        }

        // 构造使用选中 key 的临时 config
        const effectiveConfig: LLMConfig = {
            ...config,
            apiKey: handle.apiKey,
            baseUrl: handle.baseUrl ?? config.baseUrl,
            pool: undefined, // 避免递归
        };

        try {
            const result = await callLLMSingleKey(messages, effectiveConfig, options);
            pool.release(handle, true);
            return result;
        } catch (err) {
            const quota = isQuotaError(err);
            const auth = isAuthError(err);
            pool.release(handle, false, quota, auth);
            lastError = err instanceof Error ? err : new Error(String(err));

            // quota 或 auth 错误 → 尝试下一个 key
            if ((quota || auth) && i < maxPoolAttempts - 1) {
                log.warn(`Pool key ${auth ? "认证" : "quota"} 失败，尝试下一个 key`, {
                    poolId: pool.id,
                    attempt: i + 1,
                    total: maxPoolAttempts,
                    apiKeyPreview: handle.apiKey.slice(0, 10) + "...",
                });
                continue;
            }

            // 非 quota/auth 错误，或最后一个 key 也失败 → 抛出
            throw lastError;
        }
    }

    // 所有 key 都在冷却中或已禁用
    throw lastError ?? new Error(`LLM Pool "${pool.id}" 所有 key 均不可用（冷却中或已禁用）`);
}

/**
 * 单 key 模式调用（原有 callLLM 逻辑，含内部 3 次重试）
 */
async function callLLMSingleKey(
    messages: ChatMessage[],
    config: LLMConfig,
    options?: LLMCallOptions,
): Promise<LLMResponse> {
    // ── Rate Limiting ──
    // Auto-detect profile name by matching config object against loaded profiles
    let profileName = options?.profileName;
    if (!profileName) {
        try {
            const appConfig = loadConfig();
            for (const [name, p] of Object.entries(appConfig.llmProfiles)) {
                if (p === config || (p.model === config.model && p.baseUrl === config.baseUrl && p.apiKey === config.apiKey)) {
                    profileName = name;
                    break;
                }
            }
        } catch {}
    }
    const releaseSlot = await rateLimiter.acquire(profileName);
    try {
        return await _callLLMSingleKeyInner(messages, config, options);
    } finally {
        releaseSlot();
    }
}

async function _callLLMSingleKeyInner(
    messages: ChatMessage[],
    config: LLMConfig,
    options?: LLMCallOptions,
): Promise<LLMResponse> {
    // ── 擦屁股：清洗空 assistant 消息 ──
    for (const msg of messages) {
        if (msg.role === "assistant" && (!msg.content || !msg.content.trim())) {
            log.warn("Empty assistant message detected, filling with placeholder", {
                original: msg.content ?? "(undefined)",
            });
            msg.content = "(no response)";
        }
    }

    const model = options?.model ?? config.model;
    const temperature = options?.temperature ?? config.temperature;
    const maxTokens = options?.maxTokens ?? config.maxTokens;
    const thinkingLevel = options?.thinkingLevel ?? config.thinkingLevel;
    const caller = options?.caller ?? "unknown";

    // ── 发射 llm:call 事件 ──
    const callId = nextCallId();
    const startTime = Date.now();
    if (llmEvents.listenerCount("llm:call") > 0) {
        const callEvent: LLMCallEvent = {
            callId,
            caller,
            model,
            temperature,
            maxTokens,
            provider: config.provider ?? "openai",
            messageSummaries: summarizeMessages(messages),
            timestamp: new Date().toISOString(),
            extraBody: config.extraBody,
            customHeaders: config.customHeaders,
            contextManifest: options?.contextManifest,
        };
        llmEvents.emit("llm:call", callEvent);
    }

    const timeoutMs = options?.timeoutMs ?? 60_000;

    // 创建主 AbortController 用于 Dashboard 取消
    let currentController = new AbortController();
    _activeControllers.set(callId, currentController);

    try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // 检查是否已被用户取消（上一次循环中可能被 abort）
        // 如果被取消，重置 controller 以便下一次 fetch 正常使用
        let wasUserRetry = false;

        try {
            // ── 解析 prefill（仅当 config 支持时应用） ──
            const prefill = (options?.prefill && config.supportsPrefill !== false)
                ? options.prefill
                : undefined;
            const stop = options?.stop;

            // 创建本次 fetch 的 AbortSignal：合并超时 + 用户取消
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const combinedSignal = AbortSignal.any([timeoutSignal, currentController.signal]);

            // ── Provider dispatch ──
            let result: LLMResponse;
            if (config.provider === "anthropic") {
                result = await callAnthropic(messages, config, model, temperature, maxTokens, thinkingLevel, prefill, stop, combinedSignal);
            } else if (config.provider === "google") {
                result = await callGoogle(messages, config, model, temperature, maxTokens, thinkingLevel, prefill, stop, combinedSignal);
            } else if (config.provider === "openai_responses") {
                result = await callOpenAIResponses(messages, config, model, temperature, maxTokens, thinkingLevel, prefill, stop, combinedSignal);
            } else {
                result = await callOpenAI(messages, config, model, temperature, maxTokens, thinkingLevel, prefill, stop, combinedSignal);
            }

            // ── 自动拼接 prefill 前缀到返回内容 ──
            if (prefill) {
                result = { ...result, content: prefill + result.content };
            }

            // 某些 API 会返回 200 但把错误写进文本内容，这里按配置将其视为失败。
            const matchedErrorPattern = detectErrorContentPattern(result.content, config.errorContentPatterns);
            if (matchedErrorPattern) {
                throw new Error(`response content matched error pattern: ${matchedErrorPattern}`);
            }

            // ── 发射 llm:response 事件 ──
            if (llmEvents.listenerCount("llm:response") > 0) {
                const responseEvent: LLMResponseEvent = {
                    callId,
                    caller,
                    contentPreview: result.content,
                    contentLength: result.content.length,
                    usage: result.usage,
                    durationMs: Date.now() - startTime,
                    timestamp: new Date().toISOString(),
                };
                llmEvents.emit("llm:response", responseEvent);
            }

            return result;
        } catch (err: unknown) {
            // 检测是否是用户通过 Dashboard 触发的取消（立即重试）
            // err 可能是 DOMException（abort 传入 Error 时）或裸字符串（兼容旧行为）
            const abortReason = currentController.signal.reason;
            const isUserAbort = currentController.signal.aborted && (
                // Case 1: abort(DOMException) → fetch reject DOMException, reason 是 DOMException
                (err instanceof Error && err.name === "AbortError" &&
                    abortReason instanceof DOMException && abortReason.message === "user_retry") ||
                // Case 2: abort(string) 兼容 → fetch reject 裸字符串
                err === "user_retry" ||
                // Case 3: reason 是字符串 "user_retry"（旧版兼容）
                abortReason === "user_retry"
            );

            if (isUserAbort) {
                wasUserRetry = true;
                // 重建 controller 以便下次 fetch 可用
                currentController = new AbortController();
                _activeControllers.set(callId, currentController);
            }

            const isRateLimit =
                err instanceof Error &&
                (err.message.includes("429") ||
                    err.message.includes("rate limit") ||
                    err.message.includes("overloaded"));

            const isServerError =
                err instanceof Error &&
                (err.message.includes("500") ||
                    err.message.includes("502") ||
                    err.message.includes("503"));

            const isTimeoutAbort =
                err instanceof Error && (
                    err.name === "TimeoutError" ||
                    err.message.includes("operation was aborted due to timeout")
                );

            const isNetworkError =
                err instanceof Error &&
                (isTimeoutAbort ||
                    err.message.includes("fetch failed") ||
                    err.message.includes("ECONNRESET") ||
                    err.message.includes("ECONNREFUSED") ||
                    err.message.includes("ETIMEDOUT") ||
                    err.message.includes("socket hang up") ||
                    err.message.includes("UND_ERR") ||
                    err.message.includes("network"));

            const isEmptyResponse =
                err instanceof Error &&
                err.message.includes("empty response");

            // quota/billing 类错误不在此层重试，直接抛出让 callLLMWithFallback 层 fallback 到下一个 profile
            const isRetryable = isUserAbort || isServerError || isNetworkError || isEmptyResponse;

            const reason = isUserAbort ? "user_retry" : isRateLimit ? "rate_limit" : isServerError ? "server_error" : isNetworkError ? "network_error" : isEmptyResponse ? "empty_response" : "quota_or_billing";

            if (isRetryable && attempt < MAX_RETRIES) {
                const delay = wasUserRetry ? 0 : (RETRY_DELAYS[attempt] ?? 4000);
                log.warn(`LLM call failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms`, {
                    caller,
                    error: err instanceof Error ? err.message : String(err),
                    reason,
                });

                // ── 发射 llm:retry 事件 ──
                if (llmEvents.listenerCount("llm:retry") > 0) {
                    const retryEvent: LLMRetryEvent = {
                        callId,
                        caller,
                        attempt: attempt + 1,
                        maxRetries: MAX_RETRIES,
                        error: err instanceof Error ? err.message : String(err),
                        reason,
                        retryDelayMs: delay,
                        timestamp: new Date().toISOString(),
                    };
                    llmEvents.emit("llm:retry", retryEvent);
                }

                if (delay > 0) {
                    await new Promise((r) => setTimeout(r, delay));
                }
                continue;
            }

            // ── 发射错误事件 ──
            if (llmEvents.listenerCount("llm:response") > 0) {
                const responseEvent: LLMResponseEvent = {
                    callId,
                    caller,
                    contentPreview: "",
                    contentLength: 0,
                    durationMs: Date.now() - startTime,
                    error: err instanceof Error ? err.message : String(err),
                    timestamp: new Date().toISOString(),
                };
                llmEvents.emit("llm:response", responseEvent);
            }

            throw err;
        }
    }

    throw new Error("LLM call failed after all retries");
    } finally {
        _activeControllers.delete(callId);
    }
}

/**
 * 带 Profile Fallback 的 LLM 调用。
 *
 * 按 configs 顺序依次尝试调用 LLM：
 * - 配额/rate-limit 错误（429、quota、RESOURCE_EXHAUSTED）→ 自动 fallback 到下一个 config
 * - 其他错误（如网络异常、JSON 格式错误）→ 直接抛出，不 fallback
 * - 最后一个 config 失败 → 抛出原始错误
 *
 * 每个 config 内部仍走 callLLM 的 3 次指数退避重试。
 */
export async function callLLMWithFallback(
    messages: ChatMessage[],
    configs: LLMConfig[],
    options?: LLMCallOptions,
): Promise<LLMResponse> {
    if (configs.length === 0) {
        throw new Error("callLLMWithFallback: no LLM configs provided");
    }
    if (configs.length === 1) {
        return callLLM(messages, configs[0], options);
    }

    let lastError: Error | null = null;
    for (let i = 0; i < configs.length; i++) {
        try {
            return await callLLM(messages, configs[i], options);
        } catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));

            // 最后一个 config 也失败 → 抛出
            if (i === configs.length - 1) {
                throw lastError;
            }

            // 分类仅用于日志
            const msg = lastError.message;
            const reason = (msg.includes("429") || msg.includes("quota") || msg.includes("RESOURCE_EXHAUSTED") ||
                msg.includes("rate limit") || msg.includes("overloaded") || msg.includes("402") ||
                msg.includes("payment") || msg.includes("insufficient"))
                ? "quota"
                : (msg.includes("401") || msg.includes("403") || msg.includes("PERMISSION_DENIED") ||
                    msg.includes("billing") || msg.includes("Unauthorized") || msg.includes("Forbidden"))
                    ? "auth"
                    : "other";

            log.warn("callLLMWithFallback: 错误，尝试下一个 profile", {
                failedModel: configs[i].model,
                nextModel: configs[i + 1]?.model,
                attempt: i + 1,
                total: configs.length,
                reason,
                error: msg.slice(0, 150),
            });
        }
    }
    throw lastError ?? new Error("callLLMWithFallback: unexpected state");
}
