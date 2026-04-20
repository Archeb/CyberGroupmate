/**
 * llm/types.ts — LLM Provider 共享类型
 */

import type { LLMConfig } from "../config.js";

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
    /**
     * 缓存断点标记：provider 会在此消息处设置缓存边界。
     * Anthropic -> cache_control: { type: "ephemeral" }
     * OpenAI/Google -> 忽略（依赖隐式前缀缓存）
     */
    cacheBreakpoint?: boolean;
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

/** Provider 调用函数签名 */
export type ProviderCallFn = (
    messages: ChatMessage[],
    config: LLMConfig,
    model: string,
    temperature: number,
    maxTokens: number,
    thinkingLevel?: string,
    prefill?: string,
    stop?: string[],
    signal?: AbortSignal,
) => Promise<LLMResponse>;
