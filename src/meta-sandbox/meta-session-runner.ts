import { ulid } from "ulid";
import { callLLMWithFallback, type ChatMessage, type LLMCallOptions, type LLMResponse } from "../core/llm.js";
import type { LLMConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import type { MetaSandbox } from "./meta-sandbox.js";

const log = createLogger("meta-session");

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_CODE_TIMEOUT_MS = 30_000;
const END_TURN_MARKER = "<end_turn>";
const CODE_FENCE_LANGS = "typescript|ts|javascript|js";

export interface MetaSessionConfig {
    maxTurns?: number;
    codeTimeout?: number;
    llmCaller?: MetaLLMCaller;
    llmTimeoutMs?: number;
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
    endReason: "end_turn" | "max_turns" | "error" | "no_code";
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

    const finalize = (
        endReason: MetaSessionResult["endReason"],
        error?: string,
    ): MetaSessionResult => ({
        sessionId,
        turns,
        messages,
        endReason,
        error,
        sessionDigest: extractSessionDigest(turns.at(-1)?.thinking),
    });

    for (let turn = 1; turn <= maxTurns; turn++) {
        try {
            const response = await llmCaller(messages, llmConfigs, {
                caller: "meta-session",
                timeoutMs: config.llmTimeoutMs,
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
            messages.push({ role: "assistant", content: assistantMessage });

            if (!parsed.code) {
                return finalize(hasEndTurn ? "end_turn" : "no_code");
            }

            const execution = await sandbox.execute(parsed.code, { timeoutMs: codeTimeout });
            turnRecord.observation = execution.output;
            messages.push({ role: "user", content: formatObservation(execution.output) });

            if (execution.error) {
                return finalize("error", execution.output);
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