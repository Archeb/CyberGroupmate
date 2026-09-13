/**
 * llm/openai.ts — OpenAI 兼容 API 调用
 */

import { Stream } from "openai/streaming";
import type { LLMConfig } from "../config.js";
import { reasoningOriginKey } from "./reasoning-origin.js";
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
    const originKey = reasoningOriginKey(config, model);

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(config.customHeaders ?? {}),
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
        // reasoning_content 虽然是明文、不像 Responses item id 那样会被判非法格式，
        // 但部分上游（如 DeepSeek）明确拒绝 input 里带该字段，同样按 profile 隔离。
        if (m.role === "assistant" && m.reasoning?.provider === "openai_chat" && m.reasoning.originKey === originKey) {
            return {
                role: m.role,
                content: m.content,
                reasoning_content: m.reasoning.content,
            };
        }
        return { role: m.role, content: m.content };
    });

    // Prefill: 追加 assistant 消息作为生成起点
    if (prefill) {
        apiMessages.push({ role: "assistant", content: prefill });
    }

    const streaming = config.chatRequestMode === "stream";
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
            model,
            messages: apiMessages,
            ...(config.omit_temperature ? {} : { temperature }),
            max_tokens: maxTokens,
            ...(thinkingLevel && thinkingLevel !== "none" ? { reasoning_effort: thinkingLevel } : {}),
            ...(stop && stop.length > 0 ? { stop } : {}),
            ...(config.extraBody ?? {}),
            // 请求模式决定解析方式，不能被 extra_body.stream 覆盖。
            stream: streaming,
            ...(streaming ? {
                stream_options: { include_usage: true, ...(config.extraBody?.stream_options as Record<string, unknown> ?? {}) },
            } : {}),
        }),
        signal: requestSignal,
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
            `OpenAI API error ${response.status}: ${response.statusText} — ${body}`
        );
    }

    const data: ChatCompletionResult = streaming
        ? await collectChatCompletionFromStream(response, controller, requestSignal, model)
        : await response.json() as ChatCompletionResult;

    const responseMessage = data.choices?.[0]?.message;
    const content = responseMessage?.content ?? "";
    const reasoningContent = responseMessage?.reasoning_content ?? responseMessage?.reasoning;
    if (!content) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content,
        reasoning: reasoningContent
            ? {
                provider: "openai_chat",
                content: reasoningContent,
                originKey,
                tokenCount: data.usage?.completion_tokens_details?.reasoning_tokens,
            }
            : undefined,
        usage: data.usage
            ? {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
                cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
                reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
            }
            : undefined,
    };
}

type ChatCompletionResult = {
    choices: Array<{
        message: {
            content: string;
            reasoning_content?: string;
            reasoning?: string;
        };
    }>;
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: {
            cached_tokens?: number;
        };
        completion_tokens_details?: {
            reasoning_tokens?: number;
        };
    };
};

type ChatCompletionChunk = {
    choices?: Array<{
        index: number;
        delta?: { content?: string | null; reasoning_content?: string; reasoning?: string };
        finish_reason?: string | null;
    }>;
    usage?: ChatCompletionResult["usage"];
};

/** SSE 解码由 SDK 处理，包括跨网络分块的 UTF-8、事件和上游 error 事件。 */
async function collectChatCompletionFromStream(
    response: Response,
    controller: AbortController,
    signal: AbortSignal,
    model: string,
): Promise<ChatCompletionResult> {
    const content: string[] = [];
    const reasoningContent: string[] = [];
    const reasoning: string[] = [];
    let usage: ChatCompletionResult["usage"];
    let finished = false;
    const stream = Stream.fromSSEResponse<ChatCompletionChunk>(response, controller);
    for await (const chunk of stream) {
        // include_usage 的最后一帧可以只有 usage，没有 choices。
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.find(choice => choice.index === 0);
        if (!choice) continue;
        if (choice.finish_reason === "error") {
            throw new Error(`OpenAI stream failed from model ${model}`);
        }
        if (choice.delta?.content) content.push(choice.delta.content);
        if (choice.delta?.reasoning_content) reasoningContent.push(choice.delta.reasoning_content);
        if (choice.delta?.reasoning) reasoning.push(choice.delta.reasoning);
        if (choice.finish_reason) finished = true;
    }
    // SDK 会吞掉 AbortError；不能把取消前累积的半截输出作为成功响应返回。
    signal.throwIfAborted();
    if (!finished) throw new Error(`OpenAI stream ended before completion from model ${model}`);
    return {
        choices: [{ message: {
            content: content.join(""),
            ...(reasoningContent.length ? { reasoning_content: reasoningContent.join("") } : {}),
            ...(reasoning.length ? { reasoning: reasoning.join("") } : {}),
        } }],
        usage,
    };
}
