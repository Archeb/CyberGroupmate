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
const META_SANDBOX_OBSERVATION_MARKER = "[MetaSandbox observation]";
const CODE_FENCE_LANGS = "typescript|ts|javascript|js";
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

interface FirstCodeBlockMatch {
    code: string;
    start: number;
    end: number;
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
    const firstCodeBlock = findFirstCodeBlock(response);
    if (firstCodeBlock) {
        return {
            thinking: stripEndTurnMarker(response.slice(0, firstCodeBlock.start)).trim(),
            code: firstCodeBlock.code.trim(),
        };
    }

    return {
        thinking: stripEndTurnMarker(response).trim(),
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

function hasSessionDigest(thinking?: string): boolean {
    const trimmed = thinking?.trim();
    if (!trimmed) {
        return false;
    }
    const match = trimmed.match(/\[SESSION_DIGEST\]([\s\S]*?)(?:\[\/SESSION_DIGEST\]|$)/);
    return Boolean(match?.[1]?.trim());
}

export function compactThinking(thinking: string, maxChars: number = 500): string {
    const trimmed = thinking.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return trimmed.slice(-maxChars).trim();
}

function buildMissingDigestObservation(): string {
    return [
        "[Meta runner notice]",
        "你已经输出 <end_turn>，但没有输出 [SESSION_DIGEST]...[/SESSION_DIGEST]。",
        "请用纯文本补充本轮摘要，格式必须包含 [SESSION_DIGEST]做了什么、为什么、还在等什么[/SESSION_DIGEST]，然后再输出 <end_turn>。",
        "不要输出历史占位符或伪造执行结果。",
    ].join("\n");
}

function buildMissingEndTurnObservation(): string {
    return [
        "[Meta runner notice]",
        `你这轮没有输出代码块，也没有输出 ${END_TURN_MARKER}。`,
        `如果本轮已经结束，请用纯文本补充 ${END_TURN_MARKER}；如果还需要行动，请输出一个 JS 代码块。`,
        "不要输出历史占位符或伪造执行结果。",
    ].join("\n");
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
                stop: [META_SANDBOX_OBSERVATION_MARKER],
                timeoutMs: config.llmTimeoutMs,
                ...(config.contextManifest ? { contextManifest: config.contextManifest } : {}),
            });
            const assistantMessage = response.content.trim();
            const parsed = parseMetaResponse(assistantMessage);
            const hasCode = Boolean(parsed.code);
            const hasEndTurn = assistantMessage.includes(END_TURN_MARKER);
            if (hasCode && hasEndTurn) {
                log.info("Meta session response included code and end_turn; end_turn is ignored until a later pure-text turn", {
                    sessionId,
                    turn,
                });
            }

            const turnRecord: MetaSessionTurn = {
                turn,
                assistantMessage,
                thinking: parsed.thinking || undefined,
                code: parsed.code,
                usage: response.usage,
            };

            turns.push(turnRecord);
            const assistantHistoryContent = buildAssistantHistoryContent(assistantMessage);
            if (assistantHistoryContent) {
                messages.push({ role: "assistant", content: assistantHistoryContent });
            }
            syncMetaCodeActState(sessionId, messages, turns, true);
            emitMetaProgress(sessionId, {
                turn,
                phase: "thinking",
                thinking: parsed.thinking || undefined,
                codeBlocks: parsed.code ? [{ lang: "js", code: parsed.code }] : undefined,
                isProcessing: true,
            });

            if (!parsed.code) {
                if (hasEndTurn) {
                    if (!hasSessionDigest(parsed.thinking)) {
                        const observation = buildMissingDigestObservation();
                        turnRecord.observation = observation;
                        messages.push({ role: "user", content: observation });
                        syncMetaCodeActState(sessionId, messages, turns, true);
                        emitMetaProgress(sessionId, {
                            turn,
                            phase: "observation",
                            executionOutput: observation,
                            isProcessing: true,
                        });
                        continue;
                    }
                    return finalize("end_turn");
                }

                const observation = buildMissingEndTurnObservation();
                turnRecord.observation = observation;
                messages.push({ role: "user", content: observation });
                syncMetaCodeActState(sessionId, messages, turns, true);
                emitMetaProgress(sessionId, {
                    turn,
                    phase: "observation",
                    executionOutput: observation,
                    isProcessing: true,
                });
                continue;
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

function buildAssistantHistoryContent(content: string): string {
    return content.trim();
}

function findFirstCodeBlock(content: string): FirstCodeBlockMatch | null {
    const codeBlockRegex = new RegExp("```(" + CODE_FENCE_LANGS + ")\\s*\\n([\\s\\S]*?)```");
    const match = codeBlockRegex.exec(content);
    if (!match) {
        return null;
    }
    return {
        code: match[2] ?? "",
        start: match.index,
        end: match.index + match[0].length,
    };
}

function stripEndTurnMarker(content: string): string {
    return content.replace(new RegExp(END_TURN_MARKER, "g"), "");
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
