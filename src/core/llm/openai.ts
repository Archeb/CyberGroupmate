/**
 * llm/openai.ts — OpenAI 兼容 API 调用
 */

import type { LLMConfig } from "../config.js";
import type { ChatMessage, LLMResponse } from "./types.js";

/**
 * 调用 OpenAI 兼容 API
 */
export async function callOpenAI(
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
        signal,
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
