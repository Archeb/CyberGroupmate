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

/**
 * Provider 返回的原生推理状态。
 *
 * 这些字段必须和对应的 assistant turn 一起原样回传，模型才能在下一轮
 * 继续先前的推理。不同协议的状态不可互换；fallback 到其他 provider 时会忽略。
 * 同一协议下的不同 profile 之间也不可互换，靠 originKey 区分。
 */
export type LLMReasoning = {
    /** 本轮内部推理 token 数；用于上下文预算，避免把密文长度误当 token 数。 */
    tokenCount?: number;
    /**
     * 产出这段状态的 profile 指纹（见 reasoning-origin.ts）。
     * 只有当前调用的 profile 指纹一致时才回传 opaque 状态；不一致或缺失
     * （历史持久化数据）时整段丢弃——少一轮推理续链，好过整个请求 400。
     */
    originKey?: string;
} & (
    | {
        provider: "openai_responses";
        /** Responses API 的 opaque `type: reasoning` output items（含 encrypted_content）。 */
        items: Array<Record<string, unknown>>;
        /** Responses WebSocket 返回的续链锚点。 */
        responseId?: string;
        /** 仅用于匹配当前进程内仍存活的 WebSocket 连接。 */
        websocketSessionId?: string;
    }
    | {
        provider: "anthropic";
        /** Anthropic thinking / redacted_thinking content blocks（含 signature/data）。 */
        blocks: Array<Record<string, unknown>>;
    }
    | {
        provider: "openai_chat";
        /** OpenAI-compatible Chat API 的 reasoning_content。 */
        content: string;
    }
);

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
    /** 与本条 assistant 消息绑定的原生推理状态。 */
    reasoning?: LLMReasoning;
}

/** LLM 调用结果 */
export interface LLMResponse {
    /** 生成的文本 */
    content: string;
    /** 必须附着到对应 assistant ChatMessage，供后续调用原样回传。 */
    reasoning?: LLMReasoning;
    /** 使用的 token 数量（如果 API 返回） */
    usage?: {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        /** 缓存命中的 token 数（OpenAI: prompt_tokens_details.cached_tokens, Anthropic: cache_read_input_tokens） */
        cachedTokens?: number;
        /** Anthropic 缓存创建 token 数（cache_creation_input_tokens） */
        cacheCreationTokens?: number;
        /** provider 报告的内部推理 / thinking token 数。 */
        reasoningTokens?: number;
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
