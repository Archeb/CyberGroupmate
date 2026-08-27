/**
 * llm/reasoning-origin.ts — 推理状态的来源指纹
 */

import { createHash } from "node:crypto";
import type { LLMConfig } from "../config.js";

/**
 * 产出某段推理状态的 profile 指纹。
 *
 * 同一个 provider 协议下的不同网关/模型，返回的 opaque 推理状态并不通用：
 * Responses 的 reasoning item id 是各网关自己的命名空间（opencode zen 是
 * `rs_<upstream>:rs_<uuid>` 并严格校验必须是 `rs_` 形态，别家可能是 `item_…`），
 * Anthropic 的 thinking signature 也只在签发它的上游有效。跨 profile 回传会被
 * 直接 400（"Invalid reasoning item id format"），而 fallback 链一旦写入一条别家
 * 的推理状态，后面每一轮都会重新撞上，profile 就永久废掉。
 *
 * 因此推理状态必须带上来源指纹，只有指纹一致时才回传。用哈希而非原文，
 * 避免 apiKey 跟着 session history 持久化落盘。
 */
export function reasoningOriginKey(config: LLMConfig, model: string): string {
    return createHash("sha256")
        .update(`${config.baseUrl}\n${model}\n${config.apiKey}`)
        .digest("hex")
        .slice(0, 16);
}
