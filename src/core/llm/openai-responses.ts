/**
 * llm/openai-responses.ts — OpenAI Responses API（官方 SDK）调用
 */

import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { ReasoningEffort } from "openai/resources/shared.js";
import type {
    Response,
    ResponseInput,
    ResponseInputItem,
    ResponseInputMessageContentList,
    ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import WebSocket, { type RawData } from "ws";
import type { LLMConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { reasoningOriginKey } from "./reasoning-origin.js";
import type { ChatMessage, LLMResponse } from "./types.js";

const log = createLogger("openai-responses");

type ResponsesUsage = NonNullable<Response["usage"]>;
type ResponsesResult = Pick<Response, "output_text" | "usage" | "output"> & { id?: string };

interface WebSocketPendingResponse {
    resolve: (result: ResponsesResult) => void;
    reject: (error: Error) => void;
    outputText: string;
    output: Response["output"];
    responseId?: string;
    abortCleanup?: () => void;
}

interface ResponsesWebSocketSession {
    id: string;
    profileKey: string;
    socket: WebSocket;
    pending?: WebSocketPendingResponse;
    idleTimer?: NodeJS.Timeout;
}

const websocketSessions = new Map<string, ResponsesWebSocketSession>();
const websocketIdleTimeoutMs = 4 * 60_000;

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

    const originKey = reasoningOriginKey(config, model);
    const input = buildResponsesInput(messages, originKey);

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
        // 官方当前会在 stateless response 中默认返回 encrypted_content，显式 include
        // 同时兼容尚未跟进该默认行为的 Responses 网关。
        include: ["reasoning.encrypted_content" as const],
        ...(systemMessages.length > 0 ? { instructions: systemMessages.join("\n\n") } : {}),
        input,
        ...(config.omit_temperature ? {} : { temperature }),
        ...(config.omit_max_output_tokens ? {} : { max_output_tokens: maxTokens }),
        ...(reasoningEffort ? { reasoning: { effort: reasoningEffort as ReasoningEffort } } : {}),
        ...(stop && stop.length > 0 ? { stop } : {}),
        ...(config.extraBody ?? {}),
    };

    const requestMode = config.responsesRequestMode ?? "non_stream";
    let websocketSessionId: string | undefined;
    let response: ResponsesResult;
    if (requestMode === "websocket") {
        try {
            const result = await callOpenAIResponsesWebSocket(messages, config, requestBody, originKey, prefill, signal);
            websocketSessionId = result.sessionId;
            response = result.response;
        } catch (error) {
            if (signal?.aborted || !isRetryableResponsesWebSocketError(error)) throw error;

            // Responses 的 encrypted reasoning 同样能通过普通 HTTP 往返；WS 只负责
            // 连接内 previous_response_id 续链。上游 WS 代理繁忙时直接用完整 input
            // 降级到 HTTP，既保留 reasoning，也避免反复撞同一个 WS 入口。
            log.warn("Responses WebSocket unavailable; falling back to HTTP", {
                error: error instanceof Error ? error.message : String(error),
            });
            response = await client.responses.create(requestBody, { signal }) as ResponsesResult;
        }
    } else if (requestMode === "stream") {
        response = await collectResponseFromStream(
            await client.responses.create({ ...requestBody, stream: true }, { signal }),
        );
    } else {
        response = await client.responses.create(requestBody, { signal }) as ResponsesResult;
    }

    const content = response.output_text ?? "";
    const reasoningItems = response.output
        ?.filter((item) => item.type === "reasoning")
        .map((item) => ({ ...item } as unknown as Record<string, unknown>));
    if (!content) {
        throw new Error(`LLM returned empty response (0 chars) from model ${model}`);
    }

    return {
        content,
        reasoning: reasoningItems?.length || (websocketSessionId && response.id)
            ? {
                provider: "openai_responses",
                items: reasoningItems ?? [],
                originKey,
                tokenCount: response.usage?.output_tokens_details?.reasoning_tokens,
                ...(websocketSessionId && response.id ? { responseId: response.id } : {}),
                ...(websocketSessionId ? { websocketSessionId } : {}),
            }
            : undefined,
        usage: response.usage
            ? {
                promptTokens: response.usage.input_tokens,
                completionTokens: response.usage.output_tokens,
                totalTokens: response.usage.total_tokens,
                cachedTokens: response.usage.input_tokens_details?.cached_tokens,
                reasoningTokens: response.usage.output_tokens_details?.reasoning_tokens,
            }
            : undefined,
    };
}

/**
 * @param originKey 当前 profile 的推理来源指纹；只回传指纹一致的 reasoning item，
 *   别的 profile（哪怕同为 Responses 协议）的 item id 会被上游判为非法格式。
 */
function buildResponsesInput(
    messages: ChatMessage[],
    originKey: string,
    includeReasoning = true,
): ResponseInput {
    const input: ResponseInput = [];
    for (const m of messages.filter(m => m.role !== "system")) {
        if (
            includeReasoning && m.role === "assistant"
            && m.reasoning?.provider === "openai_responses"
            && m.reasoning.originKey === originKey
        ) {
            input.push(...m.reasoning.items as unknown as ResponseInputItem[]);
        }
        if (m.imageParts && m.imageParts.length > 0 && m.role === "user") {
            const content: ResponseInputMessageContentList = [{ type: "input_text", text: m.content }];
            for (const img of m.imageParts) {
                content.push({
                    type: "input_image",
                    image_url: img.url,
                    detail: img.detail ?? "auto",
                });
            }
            input.push({ role: m.role, content });
            continue;
        }
        if (m.role === "assistant") {
            input.push({ role: m.role, content: m.content });
            continue;
        }
        input.push({
            role: m.role,
            content: [{ type: "input_text", text: m.content }],
        });
    }
    return input;
}

function findWebSocketContinuation(
    messages: ChatMessage[],
    profileKey: string,
): { session: ResponsesWebSocketSession; responseId: string; input: ResponseInput } | undefined {
    for (let index = messages.length - 1; index >= 0; index--) {
        const reasoning = messages[index].reasoning;
        if (messages[index].role !== "assistant" || reasoning?.provider !== "openai_responses") continue;
        // 最近一轮由别的 profile 产出：它的 responseId 不在本 profile 的命名空间里，
        // 无法续链，只能退回完整 input（且那一轮的 reasoning item 会被丢弃）。
        if (reasoning.originKey !== profileKey) return undefined;
        if (!reasoning.responseId || !reasoning.websocketSessionId) return undefined;
        const session = websocketSessions.get(reasoning.websocketSessionId);
        if (!session || session.pending || session.profileKey !== profileKey || session.socket.readyState !== WebSocket.OPEN) {
            return undefined;
        }
        return {
            session,
            responseId: reasoning.responseId,
            input: buildResponsesInput(messages.slice(index + 1), profileKey),
        };
    }
    return undefined;
}

async function callOpenAIResponsesWebSocket(
    messages: ChatMessage[],
    config: LLMConfig,
    requestBody: Record<string, unknown>,
    profileKey: string,
    prefill?: string,
    signal?: AbortSignal,
): Promise<{ response: ResponsesResult; sessionId: string }> {
    const continuation = findWebSocketContinuation(messages, profileKey);
    const incrementalInput = continuation?.input ?? buildResponsesInput(messages, profileKey, false);
    if (prefill) incrementalInput.push({ role: "assistant", content: prefill });

    let session: ResponsesWebSocketSession | undefined;
    try {
        session = continuation?.session ?? await createResponsesWebSocketSession(config, profileKey, signal);
    } catch (error) {
        if (session) closeResponsesWebSocketSession(session, 1011, "connection failed");
        throw error;
    }
    const payload: Record<string, unknown> = {
        ...requestBody,
        type: "response.create",
        ...(continuation
            ? { previous_response_id: continuation.responseId, input: incrementalInput }
            : { input: incrementalInput }),
    };
    delete payload.stream;
    delete payload.background;

    try {
        const response = await sendResponsesWebSocketRequest(session, payload, signal);
        scheduleWebSocketSessionIdleClose(session);
        return { response, sessionId: session.id };
    } catch (error) {
        closeResponsesWebSocketSession(session, 1011, "request failed");
        throw error;
    }
}

async function createResponsesWebSocketSession(
    config: LLMConfig,
    profileKey: string,
    signal?: AbortSignal,
): Promise<ResponsesWebSocketSession> {
    if (signal?.aborted) throw abortError(signal);
    const url = new URL(config.baseUrl);
    url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
    url.pathname = `${url.pathname.replace(/\/$/, "")}/responses`;
    const socket = new WebSocket(url, {
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            ...(config.customHeaders ?? {}),
        },
        handshakeTimeout: 15_000,
    });
    const session: ResponsesWebSocketSession = { id: randomUUID(), profileKey, socket };
    websocketSessions.set(session.id, session);
    attachResponsesWebSocketHandlers(session);

    try {
        await new Promise<void>((resolve, reject) => {
            const onOpen = () => finish(resolve);
            const onError = (error: Error) => finish(() => reject(error));
            const onClose = (code: number, reason: Buffer) => finish(() => reject(websocketCloseError(code, reason)));
            const onAbort = () => finish(() => {
                closeResponsesWebSocketSession(session, 1000, "aborted");
                reject(abortError(signal));
            });
            const finish = (callback: () => void) => {
                socket.off("open", onOpen);
                socket.off("error", onError);
                socket.off("close", onClose);
                signal?.removeEventListener("abort", onAbort);
                callback();
            };
            socket.once("open", onOpen);
            socket.once("error", onError);
            socket.once("close", onClose);
            signal?.addEventListener("abort", onAbort, { once: true });
        });
    } catch (error) {
        closeResponsesWebSocketSession(session, 1011, "connection failed");
        throw error;
    }
    return session;
}

function attachResponsesWebSocketHandlers(session: ResponsesWebSocketSession): void {
    session.socket.on("message", (raw: RawData) => handleResponsesWebSocketEvent(session, raw));
    session.socket.on("close", (code, reason) => {
        websocketSessions.delete(session.id);
        if (session.idleTimer) clearTimeout(session.idleTimer);
        rejectWebSocketPending(session, websocketCloseError(code, reason));
    });
    session.socket.on("error", (error) => rejectWebSocketPending(session, error));
}

function sendResponsesWebSocketRequest(
    session: ResponsesWebSocketSession,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<ResponsesResult> {
    if (session.pending) return Promise.reject(new Error("Responses WebSocket session already has an active request"));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (session.idleTimer) clearTimeout(session.idleTimer);

    return new Promise<ResponsesResult>((resolve, reject) => {
        const pending: WebSocketPendingResponse = { resolve, reject, outputText: "", output: [] };
        session.pending = pending;
        if (signal) {
            const onAbort = () => {
                closeResponsesWebSocketSession(session, 1000, "aborted");
                rejectWebSocketPending(session, abortError(signal));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            pending.abortCleanup = () => signal.removeEventListener("abort", onAbort);
        }
        session.socket.send(JSON.stringify(payload), error => {
            if (error) rejectWebSocketPending(session, error);
        });
    });
}

function handleResponsesWebSocketEvent(session: ResponsesWebSocketSession, raw: RawData): void {
    const pending = session.pending;
    if (!pending) return;
    let event: Record<string, any>;
    try {
        event = JSON.parse(raw.toString()) as Record<string, any>;
    } catch {
        return;
    }

    if (event.type === "response.created") pending.responseId = event.response?.id ?? pending.responseId;
    if (event.type === "response.output_text.delta") pending.outputText += event.delta ?? "";
    if (event.type === "response.output_item.done" && event.item) pending.output.push(event.item);

    if (event.type === "error" || event.type === "response.failed") {
        const apiError = event.error ?? event.response?.error;
        rejectWebSocketPending(session, new Error(apiError?.message ?? `${event.type} from Responses WebSocket`));
        return;
    }
    if (event.type !== "response.completed" && event.type !== "response.incomplete") return;

    const response = event.response ?? {};
    const completedOutput = Array.isArray(response.output) ? response.output : [];
    const completedIds = new Set(completedOutput.flatMap((item: Record<string, unknown>) =>
        typeof item.id === "string" ? [item.id] : [],
    ));
    const output = [
        ...pending.output.filter(item => typeof item.id !== "string" || !completedIds.has(item.id)),
        ...completedOutput,
    ] as Response["output"];
    const outputText = pending.outputText || extractResponsesOutputText(output);
    pending.abortCleanup?.();
    session.pending = undefined;
    pending.resolve({
        id: response.id ?? pending.responseId,
        output_text: outputText,
        output,
        usage: response.usage,
    });
}

function extractResponsesOutputText(output: Response["output"]): string {
    let text = "";
    for (const item of output) {
        if (item.type !== "message") continue;
        for (const part of item.content) {
            if (part.type === "output_text") text += part.text;
        }
    }
    return text;
}

function rejectWebSocketPending(session: ResponsesWebSocketSession, error: Error): void {
    const pending = session.pending;
    if (!pending) return;
    pending.abortCleanup?.();
    session.pending = undefined;
    pending.reject(error);
}

function scheduleWebSocketSessionIdleClose(session: ResponsesWebSocketSession): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
        closeResponsesWebSocketSession(session, 1000, "idle timeout");
    }, websocketIdleTimeoutMs);
    session.idleTimer.unref();
}

function closeResponsesWebSocketSession(session: ResponsesWebSocketSession, code: number, reason: string): void {
    websocketSessions.delete(session.id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    if (session.socket.readyState === WebSocket.OPEN || session.socket.readyState === WebSocket.CONNECTING) {
        session.socket.close(code, reason);
    }
}

function websocketCloseError(code: number, reason: Buffer): Error {
    const suffix = reason.length > 0 ? `: ${reason.toString()}` : "";
    return new Error(`Responses WebSocket closed (${code})${suffix}`);
}

/** WS 代理或上游暂时不可用时，允许用同一份完整 input 改走 HTTP。 */
export function isRetryableResponsesWebSocketError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return /Responses WebSocket closed \((?:1011|1012|1013)\)/.test(error.message)
        || /Unexpected server response: (?:429|5\d\d)/i.test(error.message)
        || /(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up)/i.test(error.message);
}

function abortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError");
}

export function closeOpenAIResponsesWebSockets(): void {
    for (const session of [...websocketSessions.values()]) {
        closeResponsesWebSocketSession(session, 1000, "shutdown");
    }
}

// "xhigh" 未在 SDK 的 ReasoningEffort 联合类型里，但部分模型/网关支持，透传出去
type ReasoningEffortExtended = ReasoningEffort | "xhigh" | "max";

function toReasoningEffort(value?: string): ReasoningEffortExtended | undefined {
    if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") {
        return value;
    }
    return undefined;
}

export async function collectResponseFromStream(stream: AsyncIterable<ResponseStreamEvent>): Promise<ResponsesResult> {
    const asyncIterator = stream[Symbol.asyncIterator];
    if (!asyncIterator) {
        throw new Error("OpenAI Responses stream mode did not return an async iterable");
    }

    let outputText = "";
    let usage: ResponsesUsage | undefined;
    let output: Response["output"] = [];
    let completed = false;
    try {
        for await (const event of stream) {
            if (event.type === "response.output_text.delta") {
                outputText += event.delta;
            }
            if (event.type === "response.output_item.done" && event.item.type === "reasoning") {
                output.push(event.item);
            }
            if (event.type === "response.completed") {
                completed = true;
                if (event.response.output_text) {
                    outputText = event.response.output_text;
                }
                usage = event.response.usage ?? usage;
                const completedOutput = event.response.output ?? [];
                const completedHasReasoning = completedOutput.some(item => item.type === "reasoning");
                output = completedHasReasoning
                    ? completedOutput
                    : [...output, ...completedOutput];
            }
        }
    } catch (err) {
        if (completed && isPrematureCloseError(err)) {
            return { output_text: outputText, usage, output };
        }
        throw err;
    }

    return { output_text: outputText, usage, output };
}

function isPrematureCloseError(err: unknown): boolean {
    return err instanceof Error && err.message.includes("Premature close");
}
