/**
 * llm/openai-responses.ts — OpenAI Responses API（官方 SDK）调用
 */

import OpenAI from "openai";
import type { LLMConfig } from "../config.js";
import type { ChatMessage, LLMResponse } from "./types.js";

type ResponsesUsage = {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: {
        cached_tokens?: number;
    };
};

type ResponsesResult = {
    output_text?: string;
    usage?: ResponsesUsage;
};

export async function callOpenAIResponses(
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
    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        defaultHeaders: config.customHeaders,
    });

    const systemMessages = messages
        .filter(m => m.role === "system")
        .map(m => m.content.trim())
        .filter(Boolean);

    const input: Array<Record<string, unknown>> = messages
        .filter(m => m.role !== "system")
        .map(m => {
        if (m.imageParts && m.imageParts.length > 0 && m.role === "user") {
            const content: Array<Record<string, unknown>> = [{ type: "input_text", text: m.content }];
            for (const img of m.imageParts) {
                content.push({
                    type: "input_image",
                    image_url: img.url,
                    ...(img.detail ? { detail: img.detail } : {}),
                });
            }
            return { role: m.role, content };
        }
        if (m.role === "assistant") {
            return {
                role: m.role,
                content: [{ type: "output_text", text: m.content }],
            };
        }
        return {
            role: m.role,
            content: [{ type: "input_text", text: m.content }],
        };
    });

    if (prefill) {
        input.push({
            role: "assistant",
            content: [{ type: "output_text", text: prefill }],
        });
    }

    const requestBody = {
        model,
        store: false,
        ...(systemMessages.length > 0 ? { instructions: systemMessages.join("\n\n") } : {}),
        input,
        temperature,
        max_output_tokens: maxTokens,
        ...(thinkingLevel && thinkingLevel !== "none" ? { reasoning: { effort: thinkingLevel } } : {}),
        ...(stop && stop.length > 0 ? { stop } : {}),
        ...(config.extraBody ?? {}),
    };

    const requestMode = config.responsesRequestMode ?? "non_stream";
    const response = requestMode === "stream"
        ? await collectResponseFromStream(
            await client.responses.create({ ...requestBody, stream: true }, { signal }),
        )
        : await client.responses.create(requestBody, { signal }) as ResponsesResult;

    const content = response.output_text ?? "";
    if (!content) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content,
        usage: response.usage
            ? {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
                cachedTokens: response.usage.input_tokens_details?.cached_tokens,
            }
            : undefined,
    };
}

async function collectResponseFromStream(stream: unknown): Promise<ResponsesResult> {
    const asyncIterator = (stream as AsyncIterable<unknown>)?.[Symbol.asyncIterator];
    if (!asyncIterator) {
        throw new Error("OpenAI Responses stream mode did not return an async iterable");
    }

    let outputText = "";
    let usage: ResponsesUsage | undefined;
    for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        if (event.type === "response.output_text.delta") {
            outputText += typeof event.delta === "string" ? event.delta : "";
        }
        if (event.type === "response.completed") {
            const completed = event.response as ResponsesResult | undefined;
            if (completed?.output_text) {
                outputText = completed.output_text;
            }
            usage = completed?.usage ?? usage;
        }
    }

    return { output_text: outputText, usage };
}
