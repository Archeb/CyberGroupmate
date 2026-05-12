import { ulid } from "ulid";
import { callLLMWithFallback, type ChatMessage, type LLMCallOptions, type LLMResponse } from "../core/llm.js";
import type { LLMConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import type { MetaSandbox } from "./meta-sandbox.js";
import type { ContextManifest } from "../context-engine/types.js";
import { codeActEvents, type CodeActProgressEvent } from "../sandbox/session-runner.js";
import { extractApiCalls, getDocLookupMethods } from "../sandbox/api-intent-extractor.js";

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
    twoPassConfig?: MetaTwoPassConfig;
}

export interface MetaTwoPassConfig {
    getPrefixMap: () => Record<string, string>;
    lookupDocs: (calledMethods: string[]) => string;
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

    const explicitDigest = extractExplicitSessionDigest(trimmed);
    if (explicitDigest) {
        return explicitDigest;
    }

    return compactThinking(trimmed, maxChars);
}

function extractExplicitSessionDigest(thinking?: string): string | undefined {
    const trimmed = thinking?.trim();
    if (!trimmed) {
        return undefined;
    }
    const match = trimmed.match(/\[SESSION_DIGEST\]([\s\S]*?)(?:\[\/SESSION_DIGEST\]|$)/);
    return match?.[1]?.trim() || undefined;
}

function extractLatestSessionDigest(turns: MetaSessionTurn[]): string | undefined {
    for (let index = turns.length - 1; index >= 0; index--) {
        const digest = extractExplicitSessionDigest(turns[index]?.thinking);
        if (digest) {
            return digest;
        }
    }

    for (let index = turns.length - 1; index >= 0; index--) {
        const digest = extractSessionDigest(turns[index]?.thinking);
        if (digest) {
            return digest;
        }
    }

    return undefined;
}

function hasSessionDigest(thinking?: string): boolean {
    return Boolean(extractExplicitSessionDigest(thinking));
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

function buildFirstNoCodeConfirmationObservation(): string {
    return [
        "[Meta runner notice]",
        `你本次未写代码分配任务，如果这是你的本意，请再次只输出${END_TURN_MARKER}即可。`,
        "如果仍需行动，请输出一个 JS 代码块。",
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
    let firstNoCodeConfirmationPending = false;
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
            sessionDigest: extractLatestSessionDigest(turns),
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
            let assistantMessage = response.content.trim();
            let parsed = parseMetaResponse(assistantMessage);
            const hasCode = Boolean(parsed.code);
            let hasEndTurn = assistantMessage.includes(END_TURN_MARKER);
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

            if (parsed.code && config.twoPassConfig) {
                const calledMethods = extractApiCalls(parsed.code, config.twoPassConfig.getPrefixMap());
                const docLookupMethods = getDocLookupMethods(calledMethods);
                const missingMethods = docLookupMethods.filter((method) => !hasInjectedMethodDoc(messages, method));

                if (missingMethods.length > 0) {
                    const fullDocs = config.twoPassConfig.lookupDocs(missingMethods);
                    if (fullDocs) {
                        log.info("Meta session Two-pass triggered", {
                            sessionId,
                            turn,
                            calledMethods,
                            missingMethods,
                            docsLength: fullDocs.length,
                        });

                        emitMetaProgress(sessionId, {
                            turn,
                            phase: "type_resolving",
                            thinking: `正在查阅 Meta API 文档: ${missingMethods.join(", ")}`,
                            isProcessing: true,
                        });

                        const pass1AssistantHistoryContent = assistantHistoryContent;
                        if (pass1AssistantHistoryContent) {
                            messages.pop();
                        }
                        messages.push({
                            role: "user",
                            content: buildMetaApiDocsMessage(missingMethods, fullDocs),
                        });
                        syncMetaCodeActState(sessionId, messages, turns, true);

                        try {
                            const pass2Response = await llmCaller(messages, llmConfigs, {
                                caller: "meta-session-pass2",
                                stop: [META_SANDBOX_OBSERVATION_MARKER],
                                timeoutMs: config.llmTimeoutMs,
                                ...(config.contextManifest ? { contextManifest: config.contextManifest } : {}),
                            });

                            assistantMessage = pass2Response.content.trim();
                            parsed = parseMetaResponse(assistantMessage);
                            hasEndTurn = assistantMessage.includes(END_TURN_MARKER);

                            if (parsed.code && hasEndTurn) {
                                log.info("Meta session pass2 response included code and end_turn; end_turn is ignored until a later pure-text turn", {
                                    sessionId,
                                    turn,
                                });
                            }

                            turnRecord.assistantMessage = assistantMessage;
                            turnRecord.thinking = parsed.thinking || undefined;
                            turnRecord.code = parsed.code;
                            turnRecord.usage = pass2Response.usage;

                            const pass2AssistantHistoryContent = buildAssistantHistoryContent(assistantMessage);
                            if (pass2AssistantHistoryContent) {
                                messages.push({ role: "assistant", content: pass2AssistantHistoryContent });
                            }
                            syncMetaCodeActState(sessionId, messages, turns, true);
                            emitMetaProgress(sessionId, {
                                turn,
                                phase: "thinking",
                                thinking: parsed.thinking || undefined,
                                codeBlocks: parsed.code ? [{ lang: "js", code: parsed.code }] : undefined,
                                isProcessing: true,
                            });
                        } catch (error) {
                            log.warn("Meta session pass2 LLM failed; falling back to pass1 code", {
                                sessionId,
                                turn,
                                error: String(error),
                            });
                            messages.pop();
                            if (pass1AssistantHistoryContent) {
                                messages.push({ role: "assistant", content: pass1AssistantHistoryContent });
                            }
                            syncMetaCodeActState(sessionId, messages, turns, true);
                        }
                    }
                } else if (docLookupMethods.length > 0) {
                    log.debug("Meta session API docs already in context; skipping Two-pass", {
                        sessionId,
                        turn,
                        calledMethods,
                    });
                }
            }

            if (!parsed.code) {
                if (turn === 1) {
                    const observation = buildFirstNoCodeConfirmationObservation();
                    firstNoCodeConfirmationPending = true;
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

                if (hasEndTurn) {
                    if (firstNoCodeConfirmationPending) {
                        firstNoCodeConfirmationPending = false;
                        return finalize("end_turn");
                    }
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

            firstNoCodeConfirmationPending = false;
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

function hasInjectedMethodDoc(messages: ChatMessage[], method: string): boolean {
    const marker = `### ${method}`;
    return messages.some((message) =>
        typeof message.content === "string" && message.content.includes(marker)
    );
}

function buildMetaApiDocsMessage(missingMethods: string[], fullDocs: string): string {
    return `[📚 Meta API 文档加载完成]

你打算使用以下 Meta API: ${missingMethods.join(", ")}。
以下是这些方法的完整类型定义和用法文档，请仔细阅读后重新输出一个 JS/TS 代码块。

${fullDocs}

注意：获取完信息 console.log 出来看看再决定下一步行动。不要在代码块后伪造 observation，也不要和 ${END_TURN_MARKER} 同轮输出。`;
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
