/**
 * llm/anthropic.ts — Anthropic Claude API 调用
 */

import type { LLMConfig } from "../config.js";
import type { ChatMessage, LLMResponse } from "./types.js";

/**
 * 调用 Anthropic Claude API
 */
export async function callAnthropic(
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number,
    thinkingLevel?: string,
    prefill?: string,
    stop?: string[],
    signal?: AbortSignal,
): Promise<LLMResponse> {
    const url = `${config.baseUrl.replace(/\/$/, "")}/messages`;

    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
        ...(config.customHeaders ?? {}),
    };

    const thinkingEnabled = Boolean(thinkingLevel && thinkingLevel !== "none");

    // 组装 API 消息列表
    const apiMessages = nonSystemMsgs.map((m) => {
        const hasCacheBreakpoint = !!m.cacheBreakpoint;

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
            if (hasCacheBreakpoint && parts.length > 0) {
                const lastPart = parts[parts.length - 1] as Record<string, unknown>;
                lastPart.cache_control = { type: "ephemeral" };
            }
            return { role: m.role, content: parts };
        }

        if (m.role === "assistant" && m.reasoning?.provider === "anthropic") {
            const parts: Array<Record<string, unknown>> = [
                ...m.reasoning.blocks.map((block) => ({ ...block })),
                { type: "text", text: m.content },
            ];
            if (hasCacheBreakpoint) {
                parts[parts.length - 1].cache_control = { type: "ephemeral" };
            }
            return { role: m.role, content: parts };
        }

        if (hasCacheBreakpoint) {
            return {
                role: m.role,
                content: [{
                    type: "text",
                    text: m.content,
                    cache_control: { type: "ephemeral" },
                }],
            };
        }

        return { role: m.role, content: m.content };
    });

    // Prefill: 追加 assistant 消息作为生成起点
    // Anthropic 不允许 assistant prefill 与 extended/adaptive thinking 同时使用。
    // callLLM 外层仍会把 prefill 拼回最终 content，保持调用方返回值语义不变。
    if (prefill && !thinkingEnabled) {
        apiMessages.push({ role: "assistant", content: prefill });
    }

    const body: Record<string, unknown> = {
        model,
        messages: apiMessages,
        ...(config.omit_temperature ? {} : { temperature }),
        max_tokens: maxTokens,
        ...(thinkingEnabled ? {
            thinking: { type: "adaptive" },
            output_config: { effort: toAnthropicEffort(thinkingLevel) },
        } : {}),
        // Stop sequences（Anthropic 使用 stop_sequences 字段）
        ...(stop && stop.length > 0 ? { stop_sequences: stop } : {}),
        // Extra body（用户自定义额外字段）
        ...(config.extraBody ?? {}),
    };

    if (systemMsg) {
        body.system = [{
            type: "text",
            text: systemMsg.content,
            cache_control: { type: "ephemeral" },
        }];
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const responseBody = await response.text().catch(() => "");
        throw new Error(
            `Anthropic API error ${response.status}: ${response.statusText} — ${responseBody}`
        );
    }

    const data = (await response.json()) as {
        content: Array<Record<string, unknown> & { type: string; text?: string }>;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens_details?: {
                thinking_tokens?: number;
            };
        };
    };

    const text = data.content
        ?.filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");

    const thinkingBlocks = data.content
        ?.filter((c) => c.type === "thinking" || c.type === "redacted_thinking")
        .map((c) => ({ ...c }));

    if (!text) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content: text,
        reasoning: thinkingBlocks?.length
            ? {
                provider: "anthropic",
                blocks: thinkingBlocks,
                tokenCount: data.usage?.output_tokens_details?.thinking_tokens,
            }
            : undefined,
        usage: data.usage
            ? {
                promptTokens: data.usage.input_tokens,
                completionTokens: data.usage.output_tokens,
                totalTokens:
                    (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
                cachedTokens: data.usage.cache_read_input_tokens,
                cacheCreationTokens: data.usage.cache_creation_input_tokens,
                reasoningTokens: data.usage.output_tokens_details?.thinking_tokens,
            }
            : undefined,
    };
}

function toAnthropicEffort(value?: string): "low" | "medium" | "high" | "max" {
    if (value === "low" || value === "high" || value === "max") return value;
    if (value === "xhigh") return "max";
    return "medium";
}
