/**
 * llm-events.ts — LLM 事件总线独立导出
 *
 * 将 llmEvents EventEmitter 和事件类型从 llm.ts 主模块中独立出来，
 * 避免 llm.ts 的 provider 依赖（@google/genai 等）影响轻量级订阅者（如 metrics-collector）。
 *
 * 重要：必须与 llm.ts 使用同一个 EventEmitter 实例，
 * 通过从 llm.ts 重新导出来保持单一实例。
 */

// Re-export from llm.ts — 必须是同一个 EventEmitter 实例
export {
    llmEvents,
    type LLMCallEvent,
    type LLMResponseEvent,
    type LLMRetryEvent,
} from "./llm.js";
