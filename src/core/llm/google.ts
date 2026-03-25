/**
 * llm/google.ts — Google Gemini API 调用（使用 @google/genai SDK）
 *
 * 支持两种鉴权模式：
 * 1. AI Studio — apiKey 直接鉴权
 * 2. Vertex AI — 通过 googleAuthOptions 传入 credentials（JSON 原文保存在 config.yaml）或 ADC
 */

import { GoogleGenAI, type Content, type Part } from "@google/genai";
import type { LLMConfig } from "../config.js";
import type { ChatMessage, LLMResponse } from "./types.js";

// ─── SDK 实例缓存（按配置指纹复用） ───

const _clientCache = new Map<string, GoogleGenAI>();

function getClient(config: LLMConfig): GoogleGenAI {
    const isVertexAI = !!config.vertexProject;
    const cacheKey = isVertexAI
        ? `vertex:${config.vertexProject}:${config.vertexRegion ?? "us-central1"}`
        : `studio:${config.apiKey}`;

    let client = _clientCache.get(cacheKey);
    if (client) return client;

    if (isVertexAI) {
        client = new GoogleGenAI({
            vertexai: true,
            project: config.vertexProject!,
            location: config.vertexRegion ?? "us-central1",
            ...(config.vertexCredentials
                ? { googleAuthOptions: { credentials: config.vertexCredentials as any } }
                : {}),
        });
    } else {
        client = new GoogleGenAI({
            apiKey: config.apiKey,
        });
    }

    _clientCache.set(cacheKey, client);
    return client;
}

/**
 * 将 ChatMessage[] 转换为 @google/genai 的 Content[]
 */
function convertMessages(messages: ChatMessage[]): {
    contents: Content[];
    systemInstruction?: string;
} {
    let systemInstruction: string | undefined;
    const contents: Content[] = [];

    for (const msg of messages) {
        if (msg.role === "system") {
            // 取最后一条 system 消息
            systemInstruction = msg.content;
            continue;
        }

        const parts: Part[] = [];

        // 文本 part
        if (msg.content) {
            parts.push({ text: msg.content });
        }

        // 图片 parts（支持 base64 和 URL）
        if (msg.imageParts && msg.imageParts.length > 0 && msg.role === "user") {
            for (const img of msg.imageParts) {
                const dataMatch = img.url.match(/^data:([^;]+);base64,(.+)$/);
                if (dataMatch) {
                    parts.push({
                        inlineData: {
                            mimeType: dataMatch[1],
                            data: dataMatch[2],
                        },
                    });
                } else {
                    // URL 格式
                    parts.push({
                        fileData: {
                            fileUri: img.url,
                            mimeType: "image/jpeg",
                        },
                    });
                }
            }
        }

        contents.push({
            role: msg.role === "assistant" ? "model" : "user",
            parts,
        });
    }

    return { contents, systemInstruction };
}

/**
 * 调用 Google Gemini API（通过 @google/genai SDK）
 *
 * 根据 config 自动选择 AI Studio 或 Vertex AI 模式。
 * 支持多模态图片输入。
 */
export async function callGoogle(
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
    const client = getClient(config);

    // ── 转换消息格式 ──
    const { contents, systemInstruction } = convertMessages(messages);

    // Prefill: 追加 model 消息作为生成起点
    if (prefill) {
        contents.push({
            role: "model",
            parts: [{ text: prefill }],
        });
    }

    // ── 调用 SDK ──
    const response = await client.models.generateContent({
        model,
        contents,
        config: {
            temperature,
            maxOutputTokens: maxTokens,
            ...(systemInstruction ? { systemInstruction } : {}),
            ...(stop && stop.length > 0 ? { stopSequences: stop } : {}),
            ...(signal ? { abortSignal: signal } : {}),
        },
    });

    const text = response.text ?? "";
    if (!text) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content: text,
        usage: response.usageMetadata
            ? {
                promptTokens: response.usageMetadata.promptTokenCount,
                completionTokens: response.usageMetadata.candidatesTokenCount,
                totalTokens: response.usageMetadata.totalTokenCount,
                cachedTokens: response.usageMetadata.cachedContentTokenCount,
            }
            : undefined,
    };
}
