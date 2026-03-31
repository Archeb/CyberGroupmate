/**
 * llm-collector.ts — LLM SLA 指标收集器
 *
 * 订阅 llmEvents EventEmitter 中的 llm:call / llm:response / llm:retry 事件，
 * 实时更新 LLM SLA 相关 metrics。
 *
 * 不修改 LLM 调用核心路径，完全为 pull-based 观察者模式。
 */

import { llmEvents, type LLMCallEvent, type LLMResponseEvent, type LLMRetryEvent } from "../../core/llm.js";
import {
    llmTokensPrompt,
    llmTokensCompletion,
    llmTokensCached,
    llmTokensCacheCreation,
    llmRequestDurationMs,
    llmRequests,
    llmRetries,
    llmTps,
} from "../registry.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("metrics:llm-collector");

/** 进行中的 LLM 调用追踪（callId → 开始信息） */
interface PendingCall {
    startMs: number;
    model: string;
    caller: string;
    provider: string;
}

export class LLMCollector {
    private pendingCalls = new Map<string, PendingCall>();

    private onCall: (data: LLMCallEvent) => void;
    private onResponse: (data: LLMResponseEvent) => void;
    private onRetry: (data: LLMRetryEvent) => void;

    constructor() {
        this.onCall = (data: LLMCallEvent) => {
            this.pendingCalls.set(data.callId, {
                startMs: Date.now(),
                model: data.model,
                caller: data.caller ?? "unknown",
                provider: data.provider ?? "unknown",
            });
        };

        this.onResponse = (data: LLMResponseEvent) => {
            const pending = this.pendingCalls.get(data.callId);
            this.pendingCalls.delete(data.callId);

            const model = pending?.model ?? "unknown";
            const caller = pending?.caller ?? (data.caller ?? "unknown");
            const provider = pending?.provider ?? "unknown";
            const durationMs = data.durationMs ?? (pending ? Date.now() - pending.startMs : 0);
            const status = data.error ? "error" : "success";

            const labels = { model, caller, provider };
            const statusLabels = { ...labels, status };

            // Request count
            llmRequests.inc(statusLabels);

            // Latency histogram
            llmRequestDurationMs.observe(statusLabels, durationMs);

            if (!data.error && data.usage) {
                const { promptTokens = 0, completionTokens = 0, cachedTokens = 0, cacheCreationTokens = 0 } = data.usage;

                // Token counters
                if (promptTokens > 0) llmTokensPrompt.inc(labels, promptTokens);
                if (completionTokens > 0) llmTokensCompletion.inc(labels, completionTokens);
                if (cachedTokens > 0) llmTokensCached.inc(labels, cachedTokens);
                if (cacheCreationTokens > 0) llmTokensCacheCreation.inc(labels, cacheCreationTokens);

                // TPS (tokens/second) — non-streaming approximation
                // TODO: Replace with streaming hook when providers switch to streaming API.
                //       Currently: TPS = completion_tokens / duration_s (average over full response).
                //       Accurate TTFT/ITL requires per-chunk timestamps from streaming providers.
                if (completionTokens > 0 && durationMs > 0) {
                    const tps = (completionTokens / durationMs) * 1000;
                    llmTps.observe(labels, tps);
                }
            }
        };

        this.onRetry = (data: LLMRetryEvent) => {
            const pending = this.pendingCalls.get(data.callId);
            const model = pending?.model ?? "unknown";
            const caller = pending?.caller ?? (data.caller ?? "unknown");
            const provider = pending?.provider ?? "unknown";
            const reason = data.reason ?? "unknown";

            llmRetries.inc({ model, caller, provider, reason });
        };

        // Subscribe to LLM events
        llmEvents.on("llm:call", this.onCall);
        llmEvents.on("llm:response", this.onResponse);
        llmEvents.on("llm:retry", this.onRetry);

        log.info("LLMCollector 已启动，订阅 llmEvents");
    }

    /** 取消事件订阅，释放资源 */
    dispose(): void {
        llmEvents.off("llm:call", this.onCall);
        llmEvents.off("llm:response", this.onResponse);
        llmEvents.off("llm:retry", this.onRetry);
        this.pendingCalls.clear();
        log.info("LLMCollector 已释放");
    }
}
