/**
 * llm.ts — LLM API 调用封装
 *
 * 统一的 LLM 调用接口，支持 Anthropic Claude API 和 OpenAI 兼容 API。
 * 处理 rate limiting、重试和错误恢复。
 * 支持多 key 负载均衡池（通过 LLMConfig.pool）。
 *
 * 配置加载已迁移到 config.ts。
 */

// 从 config.ts 重新导出，保持向后兼容
export { type LLMConfig } from "./config.js";

import type { LLMConfig } from "./config.js";
import { getOrCreatePool } from "./llm-pool.js";
import { createLogger } from "./logger.js";
import { EventEmitter } from "node:events";

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

let _callIdCounter = 0;
function nextCallId(): string {
    return `llm_${Date.now()}_${++_callIdCounter}`;
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

// ─── 类型定义 ───

/** 多模态图片附件 */
export interface ImagePart {
    /** data:image/jpeg;base64,... 或 URL */
    url: string;
    detail?: "auto" | "low" | "high";
}

/** OpenAI 格式消息 */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
    /** 可选作用域：用于在多场景设计下过滤消息 */
    scope?: string;
    /** 多模态图片附件（仅 role=user 生效） */
    imageParts?: ImagePart[];
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
}

/** LLM 调用结果 */
export interface LLMResponse {
    /** 生成的文本 */
    content: string;
    /** 使用的 token 数量（如果 API 返回） */
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        /** 缓存命中的 token 数（OpenAI: prompt_tokens_details.cached_tokens, Anthropic: cache_read_input_tokens） */
        cachedTokens?: number;
        /** Anthropic 缓存创建 token 数（cache_creation_input_tokens） */
        cacheCreationTokens?: number;
    };
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
        msg.includes("overloaded");
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
 * 支持 Anthropic Claude API 和 OpenAI 兼容 API。
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
            const result = await callLLMSingleKey(messages, effectiveConfig, options, true);
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
    skipRetryOnQuota = false,
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
        };
        llmEvents.emit("llm:call", callEvent);
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            // ── 解析 prefill（仅当 config 支持时应用） ──
            const prefill = (options?.prefill && config.supportsPrefill !== false)
                ? options.prefill
                : undefined;
            const stop = options?.stop;

            let result: LLMResponse;
            if (config.provider === "anthropic") {
                result = await callAnthropic(messages, config, model, temperature, maxTokens, prefill, stop);
            } else {
                result = await callOpenAI(messages, config, model, temperature, maxTokens, thinkingLevel, prefill, stop);
            }

            // ── 自动拼接 prefill 前缀到返回内容 ──
            if (prefill) {
                result = { ...result, content: prefill + result.content };
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

            const isNetworkError =
                err instanceof Error &&
                (err.message.includes("fetch failed") ||
                    err.message.includes("ECONNRESET") ||
                    err.message.includes("ECONNREFUSED") ||
                    err.message.includes("ETIMEDOUT") ||
                    err.message.includes("socket hang up") ||
                    err.message.includes("UND_ERR") ||
                    err.message.includes("network"));

            const isEmptyResponse =
                err instanceof Error &&
                err.message.includes("empty response");

            const isRetryable = isRateLimit || isServerError || isNetworkError || isEmptyResponse;

            // Pool 模式下，429/quota 不在此层重试（由 pool 层切换 key 处理）
            if (isRetryable && attempt < MAX_RETRIES && !(skipRetryOnQuota && isRateLimit)) {
                const delay = RETRY_DELAYS[attempt] ?? 4000;
                log.warn(`LLM call failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms`, {
                    caller,
                    error: err instanceof Error ? err.message : String(err),
                    reason: isRateLimit ? "rate_limit" : isServerError ? "server_error" : isNetworkError ? "network_error" : "empty_response",
                });
                await new Promise((r) => setTimeout(r, delay));
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
            const msg = lastError.message;
            const isQuota = msg.includes("429") ||
                msg.includes("quota") ||
                msg.includes("RESOURCE_EXHAUSTED") ||
                msg.includes("rate limit") ||
                msg.includes("overloaded");

            const isTransient = msg.includes("fetch failed") ||
                msg.includes("ECONNRESET") ||
                msg.includes("ECONNREFUSED") ||
                msg.includes("ETIMEDOUT") ||
                msg.includes("socket hang up") ||
                msg.includes("UND_ERR") ||
                msg.includes("network") ||
                msg.includes("empty response") ||
                msg.includes("500") ||
                msg.includes("502") ||
                msg.includes("503");

            const shouldFallback = isQuota || isTransient;

            if (!shouldFallback || i === configs.length - 1) {
                // 非可恢复错误或最后一个 config → 直接抛出
                throw lastError;
            }

            log.warn("callLLMWithFallback: 错误，尝试下一个 profile", {
                failedModel: configs[i].model,
                nextModel: configs[i + 1]?.model,
                attempt: i + 1,
                total: configs.length,
                reason: isQuota ? "quota" : "transient",
                error: msg.slice(0, 150),
            });
        }
    }
    throw lastError ?? new Error("callLLMWithFallback: unexpected state");
}

/**
 * 调用 OpenAI 兼容 API
 */
async function callOpenAI(
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number,
    thinkingLevel?: string,
    prefill?: string,
    stop?: string[],
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    // 组装 API 消息列表（含可选 prefill）
    const apiMessages = messages.map(m => {
        // 有 imageParts 时组装为多模态 content parts
        if (m.imageParts && m.imageParts.length > 0 && m.role === "user") {
            const parts: Array<Record<string, unknown>> = [
                { type: "text", text: m.content },
            ];
            for (const img of m.imageParts) {
                parts.push({
                    type: "image_url",
                    image_url: {
                        url: img.url,
                        ...(img.detail ? { detail: img.detail } : {}),
                    },
                });
            }
            return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
    });

    // Prefill: 追加 assistant 消息作为生成起点
    if (prefill) {
        apiMessages.push({ role: "assistant", content: prefill });
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model,
            messages: apiMessages,
            temperature,
            max_tokens: maxTokens,
            // Gemini thinking 参数（OpenAI 兼容格式：reasoning_effort）
            ...(thinkingLevel && thinkingLevel !== "none" ? {
                reasoning_effort: thinkingLevel,
            } : {}),
            // Stop sequences
            ...(stop && stop.length > 0 ? { stop } : {}),
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `OpenAI API error ${response.status}: ${response.statusText} — ${body}`
        );
    }

    const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_tokens_details?: {
                cached_tokens?: number;
            };
        };
    };

    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content,
        usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
                cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
            }
            : undefined,
    };
}

/**
 * 调用 Anthropic Claude API
 */
async function callAnthropic(
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number,
    prefill?: string,
    stop?: string[],
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;

    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
    };

    // 组装 API 消息列表
    const apiMessages = nonSystemMsgs.map((m) => {
        // 有 imageParts 时组装为 Anthropic 多模态格式
        if (m.imageParts && m.imageParts.length > 0 && m.role === "user") {
            const parts: Array<Record<string, unknown>> = [
                { type: "text", text: m.content },
            ];
            for (const img of m.imageParts) {
                // Anthropic 需要 base64 source 格式
                const dataMatch = img.url.match(/^data:([^;]+);base64,(.+)$/);
                if (dataMatch) {
                    parts.push({
                        type: "image",
                        source: {
                            type: "base64",
                            media_type: dataMatch[1],
                            data: dataMatch[2],
                        },
                    });
                } else {
                    // URL 格式（Anthropic 也支持）
                    parts.push({
                        type: "image",
                        source: {
                            type: "url",
                            url: img.url,
                        },
                    });
                }
            }
            return { role: m.role, content: parts };
        }
        return { role: m.role, content: m.content };
    });

    // Prefill: 追加 assistant 消息作为生成起点
    if (prefill) {
        apiMessages.push({ role: "assistant", content: prefill });
    }

    const body: Record<string, unknown> = {
        model,
        messages: apiMessages,
        temperature,
        max_tokens: maxTokens,
        // Stop sequences（Anthropic 使用 stop_sequences 字段）
        ...(stop && stop.length > 0 ? { stop_sequences: stop } : {}),
    };

    if (systemMsg) {
        body.system = systemMsg.content;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        throw new Error(
            `Anthropic API error ${response.status}: ${response.statusText} — ${responseBody}`
        );
    }

    const data = (await response.json()) as {
        content: Array<{ type: string; text: string }>;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
        };
    };

    const text = data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

    if (!text) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content: text,
        usage: data.usage
            ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens:
                    (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
                cachedTokens: data.usage.cache_read_input_tokens,
                cacheCreationTokens: data.usage.cache_creation_input_tokens,
            }
            : undefined,
    };
}
