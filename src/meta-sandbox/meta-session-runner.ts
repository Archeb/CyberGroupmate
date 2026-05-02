import { ulid } from "ulid";
import { callLLMWithFallback, type ChatMessage, type LLMCallOptions, type LLMResponse } from "../core/llm.js";
import type { LLMConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import type { MetaSandbox } from "./meta-sandbox.js";
import type { ContextManifest } from "../context-engine/types.js";
import { codeActEvents, type CodeActProgressEvent } from "../sandbox/session-runner.js";

const log = createLogger("meta-session");

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_CODE_TIMEOUT_MS = 30_000;
const END_TURN_MARKER = "<end_turn>";
const CODE_FENCE_LANGS = "typescript|ts|javascript|js";
const CODE_BLOCK_IN_HISTORY_RE = /```(?:typescript|ts|javascript|js)\s*\n[\s\S]*?\n```/g;
export const META_CODEACT_CHAT_ID = "__meta__";

export interface MetaCodeActSessionMessage {
    role: ChatMessage["role"];
    content: string;
    timestamp: string;
}

export interface MetaCodeActState {
    chatId: typeof META_CODEACT_CHAT_ID;
    sessionId: string | null;
    session: MetaCodeActSessionMessage[];
    queueSize: number;
    sessionSize: number;
    executionCount: number;
    isProcessing: boolean;
    lastUpdatedAt: string | null;
}

let metaCodeActState: MetaCodeActState = createEmptyMetaCodeActState();
let metaCancelRequested = false;

export interface MetaSessionConfig {
    maxTurns?: number;
    codeTimeout?: number;
    llmCaller?: MetaLLMCaller;
    llmTimeoutMs?: number;
    contextManifest?: ContextManifest;
}

export interface MetaSessionTurn {
    turn: number;
    assistantMessage: string;
    thinking?: string;
    code?: string;
    observation?: string;
    usage?: LLMResponse["usage"];
}

export interface MetaSessionResult {
    sessionId: string;
    turns: MetaSessionTurn[];
    messages: ChatMessage[];
    endReason: "end_turn" | "max_turns" | "error" | "no_code" | "interrupted";
    error?: string;
    sessionDigest?: string;
}

export interface ParsedMetaResponse {
    thinking: string;
    code?: string;
}

export type MetaLLMCaller = (
    messages: ChatMessage[],
    configs: LLMConfig[],
    options?: LLMCallOptions,
) => Promise<LLMResponse>;

export function getMetaCodeActState(): MetaCodeActState {
    return {
        ...metaCodeActState,
        session: metaCodeActState.session.map((message) => ({ ...message })),
    };
}

export function resetMetaCodeActState(): void {
    metaCancelRequested = false;
    metaCodeActState = createEmptyMetaCodeActState();
}

export function requestCancelMetaCodeActSession(): boolean {
    if (!metaCodeActState.isProcessing) {
        return false;
    }
    metaCancelRequested = true;
    return true;
}

export function parseMetaResponse(response: string): ParsedMetaResponse {
    const codeBlockRegex = new RegExp("```(" + CODE_FENCE_LANGS + ")\\s*\\n([\\s\\S]*?)```", "g");
    const firstMatch = codeBlockRegex.exec(response);
    const code = firstMatch?.[2]?.trim();

    const thinking = response
        .replace(codeBlockRegex, "")
        .replace(new RegExp(END_TURN_MARKER, "g"), "")
        .trim();

    return {
        thinking,
        code,
    };
}

export function extractSessionDigest(thinking?: string, maxChars: number = 500): string | undefined {
    const trimmed = thinking?.trim();
    if (!trimmed) {
        return undefined;
    }

    const match = trimmed.match(/\[SESSION_DIGEST\]([\s\S]*?)(?:\[\/SESSION_DIGEST\]|$)/);
    if (match?.[1]?.trim()) {
        return match[1].trim();
    }

    return compactThinking(trimmed, maxChars);
}

export function compactThinking(thinking: string, maxChars: number = 500): string {
    const trimmed = thinking.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return trimmed.slice(-maxChars).trim();
}

export async function runMetaSession(
    initialMessages: ChatMessage[],
    sandbox: MetaSandbox,
    llmConfigs: LLMConfig[],
    config: MetaSessionConfig = {},
): Promise<MetaSessionResult> {
    const sessionId = ulid();
    const messages = initialMessages.map((message) => ({ ...message }));
    const turns: MetaSessionTurn[] = [];
    const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
    const codeTimeout = config.codeTimeout ?? DEFAULT_CODE_TIMEOUT_MS;
    const llmCaller = config.llmCaller ?? callLLMWithFallback;
    metaCancelRequested = false;
    sandbox.beginSession(sessionId);
    syncMetaCodeActState(sessionId, messages, turns, true);

    const finalize = (
        endReason: MetaSessionResult["endReason"],
        error?: string,
    ): MetaSessionResult => {
        const result: MetaSessionResult = {
            sessionId,
            turns,
            messages,
            endReason,
            error,
            sessionDigest: extractSessionDigest(turns.at(-1)?.thinking),
        };

        syncMetaCodeActState(sessionId, messages, turns, false);
        sandbox.endSession(sessionId);
        emitMetaProgress(sessionId, {
            turn: turns.at(-1)?.turn ?? 0,
            phase: "end",
            thinking: turns.at(-1)?.thinking,
            isProcessing: false,
            endReason,
        });
        return result;
    };

    const lastUserMsg = [...messages].reverse().find((message) => message.role === "user");
    if (lastUserMsg) {
        emitMetaProgress(sessionId, {
            turn: -1,
            phase: "task",
            userMessage: typeof lastUserMsg.content === "string"
                ? lastUserMsg.content
                : JSON.stringify(lastUserMsg.content),
            isProcessing: true,
        });
    }

    for (let turn = 1; turn <= maxTurns; turn++) {
        if (metaCancelRequested) {
            return finalize("interrupted", "Meta session cancelled by user");
        }

        try {
            const response = await llmCaller(messages, llmConfigs, {
                caller: "meta-session",
                timeoutMs: config.llmTimeoutMs,
                ...(config.contextManifest ? { contextManifest: config.contextManifest } : {}),
            });
            const assistantMessage = response.content.trim();
            const parsed = parseMetaResponse(assistantMessage);
            const hasEndTurn = assistantMessage.includes(END_TURN_MARKER);

            const turnRecord: MetaSessionTurn = {
                turn,
                assistantMessage,
                thinking: parsed.thinking || undefined,
                code: parsed.code,
                usage: response.usage,
            };

            turns.push(turnRecord);
            messages.push({ role: "assistant", content: stripCodeBlocksForHistory(assistantMessage) });
            syncMetaCodeActState(sessionId, messages, turns, true);
            emitMetaProgress(sessionId, {
                turn,
                phase: "thinking",
                thinking: parsed.thinking || undefined,
                codeBlocks: parsed.code ? [{ lang: "js", code: parsed.code }] : undefined,
                isProcessing: true,
            });

            if (!parsed.code) {
                return finalize(hasEndTurn ? "end_turn" : "no_code");
            }

            if (metaCancelRequested) {
                return finalize("interrupted", "Meta session cancelled by user");
            }

            emitMetaProgress(sessionId, {
                turn,
                phase: "executing",
                codeBlocks: [{ lang: "js", code: parsed.code }],
                isProcessing: true,
            });

            const execution = await sandbox.execute(parsed.code, { timeoutMs: codeTimeout });
            turnRecord.observation = execution.output;
            messages.push({ role: "user", content: formatObservation(execution.output) });
            syncMetaCodeActState(sessionId, messages, turns, true);
            emitMetaProgress(sessionId, {
                turn,
                phase: "observation",
                executionOutput: execution.output,
                isProcessing: true,
            });

            if (execution.error) {
                log.warn("Meta session code execution failed", {
                    sessionId,
                    turn,
                    error: execution.output,
                });
                continue;
            }

            if (metaCancelRequested) {
                return finalize("interrupted", "Meta session cancelled by user");
            }

            if (hasEndTurn) {
                return finalize("end_turn");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn("Meta session failed", { sessionId, turn, error: message });
            return finalize("error", message);
        }
    }

    return finalize("max_turns");
}

function formatObservation(output: string): string {
    return `[MetaSandbox observation]\n${output}`;
}

function stripCodeBlocksForHistory(content: string): string {
    return content
        .replace(CODE_BLOCK_IN_HISTORY_RE, "[执行代码已剥离]")
        .replace(new RegExp(END_TURN_MARKER, "g"), "")
        .trim();
}

function createEmptyMetaCodeActState(): MetaCodeActState {
    return {
        chatId: META_CODEACT_CHAT_ID,
        sessionId: null,
        session: [],
        queueSize: 0,
        sessionSize: 0,
        executionCount: 0,
        isProcessing: false,
        lastUpdatedAt: null,
    };
}

function syncMetaCodeActState(
    sessionId: string,
    messages: ChatMessage[],
    turns: MetaSessionTurn[],
    isProcessing: boolean,
): void {
    const timestamp = new Date().toISOString();
    metaCodeActState = {
        chatId: META_CODEACT_CHAT_ID,
        sessionId,
        session: messages.map((message) => ({
            role: message.role,
            content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
            timestamp,
        })),
        queueSize: 0,
        sessionSize: messages.length,
        executionCount: turns.filter((turn) => !!turn.code).length,
        isProcessing,
        lastUpdatedAt: timestamp,
    };
}

function emitMetaProgress(
    sessionId: string,
    event: Omit<CodeActProgressEvent, "chatId" | "sessionId" | "timestamp">,
): void {
    const payload: CodeActProgressEvent = {
        chatId: META_CODEACT_CHAT_ID,
        sessionId,
        timestamp: new Date().toISOString(),
        ...event,
    };
    codeActEvents.emit("codeact:progress", payload);
}
