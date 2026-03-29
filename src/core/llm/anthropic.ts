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
    _thinkingLevel?: string,
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
        // Extra body（用户自定义额外字段）
        ...(config.extraBody ?? {}),
    };

    if (systemMsg) {
        body.system = systemMsg.content;
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
