/**
 * llm/openai-responses.ts — OpenAI Responses API（官方 SDK）调用
 */

import OpenAI from "openai";
import type { ReasoningEffort } from "openai/resources/shared.js";
import type {
    Response,
    ResponseInput,
    ResponseInputItem,
    ResponseInputMessageContentList,
    ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import type { LLMConfig } from "../config.js";
import type { ChatMessage, LLMResponse } from "./types.js";

type ResponsesUsage = NonNullable<Response["usage"]>;
type ResponsesResult = Pick<Response, "output_text" | "usage">;

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

    const input: ResponseInput = messages
        .filter(m => m.role !== "system")
        .map((m): ResponseInputItem => {
        if (m.imageParts && m.imageParts.length > 0 && m.role === "user") {
            const content: ResponseInputMessageContentList = [{ type: "input_text", text: m.content }];
            for (const img of m.imageParts) {
                content.push({
                    type: "input_image",
                    image_url: img.url,
                    detail: img.detail ?? "auto",
                });
            }
            return { role: m.role, content };
        }
        if (m.role === "assistant") {
            return { role: m.role, content: m.content };
        }
        return {
            role: m.role,
            content: [{ type: "input_text", text: m.content }],
        };
    });

    if (prefill) {
        input.push({
            role: "assistant",
            content: prefill,
        });
    }

    const reasoningEffort = toReasoningEffort(thinkingLevel);
    const requestBody = {
        model,
        store: false,
        ...(systemMessages.length > 0 ? { instructions: systemMessages.join("\n\n") } : {}),
        input,
        temperature,
        max_output_tokens: maxTokens,
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
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

function toReasoningEffort(value?: string): ReasoningEffort | undefined {
    if (value === "low" || value === "medium" || value === "high") {
        return value;
    }
    return undefined;
}

async function collectResponseFromStream(stream: AsyncIterable<ResponseStreamEvent>): Promise<ResponsesResult> {
    const asyncIterator = stream[Symbol.asyncIterator];
    if (!asyncIterator) {
        throw new Error("OpenAI Responses stream mode did not return an async iterable");
    }

    let outputText = "";
    let usage: ResponsesUsage | undefined;
    for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
            outputText += event.delta;
        }
        if (event.type === "response.completed") {
            if (event.response.output_text) {
                outputText = event.response.output_text;
            }
            usage = event.response.usage ?? usage;
        }
    }

    return { output_text: outputText, usage };
}
