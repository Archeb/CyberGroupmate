/**
 * llm.ts — LLM API 调用封装
 *
 * 统一的 LLM 调用接口，支持 Anthropic Claude API 和 OpenAI 兼容 API。
 * 处理 rate limiting、重试和错误恢复。
 *
 * 配置加载已迁移到 config.ts。
 */

// 从 config.ts 重新导出，保持向后兼容
export { type LLMConfig } from "./config.js";

import type { LLMConfig } from "./config.js";
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
    };
}

// ─── LLM 调用 ───

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 2000, 4000]; // 指数退避

/**
 * 调用 LLM API
 *
 * 支持 Anthropic Claude API 和 OpenAI 兼容 API。
 * 自动处理 rate limiting 和重试。
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
            let result: LLMResponse;
            if (config.provider === "anthropic") {
                result = await callAnthropic(messages, config, model, temperature, maxTokens);
            } else {
                result = await callOpenAI(messages, config, model, temperature, maxTokens, thinkingLevel);
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

            if ((isRateLimit || isServerError) && attempt < MAX_RETRIES) {
                const delay = RETRY_DELAYS[attempt] ?? 4000;
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
 * 调用 OpenAI 兼容 API
 */
async function callOpenAI(
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number,
    thinkingLevel?: string,
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
    };
    if (config.apiKey) {
        headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model,
            messages: messages.map(m => {
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
            }),
            temperature,
            max_tokens: maxTokens,
            // Gemini thinking 参数（OpenAI 兼容格式：reasoning_effort）
            ...(thinkingLevel && thinkingLevel !== "none" ? {
                reasoning_effort: thinkingLevel,
            } : {}),
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
        };
    };

    return {
        content: data.choices?.[0]?.message?.content ?? "",
        usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
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
    maxTokens: number
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;

    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
    };

    const body: Record<string, unknown> = {
        model,
        messages: nonSystemMsgs.map((m) => {
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
        }),
        temperature,
        max_tokens: maxTokens,
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
        };
    };

    const text = data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");

    return {
        content: text ?? "",
        usage: data.usage
            ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens:
                    (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
            }
            : undefined,
    };
}
