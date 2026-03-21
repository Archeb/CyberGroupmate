/**
 * session-runner.ts — CodeAct Session Runner
 *
 * 运行一个完整的 CodeAct 交互 session：LLM 生成思考和代码 → 
 * sandbox 执行代码 → 结果作为 observation 反馈 → 重复直到完成。
 *
 * 在整体架构中的位置：
 * - Orchestrator (main.ts) 在处理事件时调用 runCodeActSession
 */

import { Sandbox, ExecutionResult } from "./sandbox.js";
import type { NotificationCenter } from "../event/notification-center.js";
import { callLLMWithFallback, ChatMessage, LLMResponse } from "../core/llm.js";
import type { LLMConfig } from "../core/config.js";
import { ulid } from "ulid";
import { createLogger } from "../core/logger.js";
import { EventEmitter } from "node:events";

// ─── CodeAct Progress Events ───

/** 全局 CodeAct 进度事件发射器（与 llmEvents 同模式） */
export const codeActEvents = new EventEmitter();
codeActEvents.setMaxListeners(20);

/** CodeAct 进度事件 payload */
export interface CodeActProgressEvent {
    chatId: string;
    sessionId: string;
    turn: number;
    phase: "thinking" | "executing" | "observation" | "end";
    thinking?: string;
    codeBlocks?: CodeBlock[];
    executionOutput?: string;
    isProcessing: boolean;
    endReason?: string;
    timestamp: string;
}

const log = createLogger("session");

// ─── Sent Message Collector ───

/** 收集 sandbox 执行期间发出的消息 */
export interface SentMessageRecord {
    chatId: string;
    text: string;
    messageId?: string;
    timestamp: string;
}

/**
 * SentMessageCollector — 在 session 执行期间收集已发送消息和重复消息拦截警告
 *
 * 用法：调用方在 runCodeActSession 前创建，注册 sandbox notify
 * 监听器，每轮代码执行后调用 drainTurn() 取得本轮新发消息。
 */
export class SentMessageCollector {
    private buffer: SentMessageRecord[] = [];
    /** 整个 session 的累计记录 */
    readonly allSent: SentMessageRecord[] = [];

    /** 本轮被拦截的重复消息警告 */
    private duplicateWarningBuffer: string[] = [];
    /** 整个 session 累计的重复拦截次数 */
    duplicateBlockedCount = 0;

    /** 由 sandbox notify 事件回调调用 */
    collect(event: Record<string, unknown>): void {
        const type = String(event.type ?? "");

        // 处理重复消息拦截事件
        if (type === "system.duplicate_message_blocked") {
            this.duplicateBlockedCount++;
            const chatId = String(event.chatId ?? "");
            const text = String(event.text ?? "");
            const preview = text.length > 80 ? text.slice(0, 80) + "..." : text;
            this.duplicateWarningBuffer.push(
                `- chat=${chatId}: "${preview}" 已在本次 session 中发送过，重复发送已被拦截`
            );
            return;
        }

        if (type !== "system.agent_message_sent") return;
        const record: SentMessageRecord = {
            chatId: String(event.chatId ?? ""),
            text: String(event.text ?? ""),
            messageId: event.messageId != null ? String(event.messageId) : undefined,
            timestamp: String(event.timestamp ?? new Date().toISOString()),
        };
        this.buffer.push(record);
        this.allSent.push(record);
    }

    /** 取出本轮新收集的消息并清空 buffer */
    drainTurn(): SentMessageRecord[] {
        const drained = this.buffer.splice(0);
        return drained;
    }

    /** 取出本轮重复拦截警告并清空 buffer */
    drainDuplicateWarnings(): string[] {
        const drained = this.duplicateWarningBuffer.splice(0);
        return drained;
    }

    /** 格式化为 observation 文本（含已发消息确认 + 重复拦截警告） */
    static formatAsObservation(records: SentMessageRecord[], duplicateWarnings?: string[]): string {
        const parts: string[] = [];

        if (records.length > 0) {
            const lines = records.map(r =>
                `- 发送到 chat=${r.chatId}: "${r.text.length > 100 ? r.text.slice(0, 100) + '...' : r.text}"`
            );
            parts.push(`[📤 已发送消息确认]\n${lines.join("\n")}`);
        }

        if (duplicateWarnings && duplicateWarnings.length > 0) {
            parts.push(`[⚠ 运行时警告: 重复消息已拦截]\n${duplicateWarnings.join("\n")}\n请勿重复发送相同内容的消息。`);
        }

        return parts.join("\n\n");
    }
}


// ─── 常量 ───

/** 默认最大交互轮次 */
const DEFAULT_MAX_TURNS = 30;

/** 代码执行输出最大字符数 */
const MAX_OUTPUT_CHARS = 4000;

// ─── 类型 ───

/** 解析出的代码块（携带语言标记） */
export interface CodeBlock {
    /** 代码块语言类型 */
    lang: "js" | "bash";
    /** 代码内容 */
    code: string;
}

/** Session 中的一个交互轮次记录 */
export interface SessionTurn {
    /** 轮次编号 */
    turn: number;
    /** LLM 原始 response */
    assistantMessage: string;
    /** 解析出的思考文本 */
    thinking: string;
    /** 解析出的代码块列表 */
    codeBlocks: CodeBlock[];
    /** 各代码块执行结果 */
    executionResults: ExecutionResult[];
    /** LLM token 用量 */
    usage?: LLMResponse["usage"];
}

/** Session 最终结果 */
export interface SessionResult {
    /** Session ID */
    sessionId: string;
    /** 所有轮次的记录 */
    turns: SessionTurn[];
    /** 完整的消息历史 */
    messages: ChatMessage[];
    /** 结束原因 */
    endReason: "no_code" | "max_turns" | "error" | "interrupted";
    /** 如果因为 error 结束，错误信息 */
    error?: string;
}

// ─── 代码块解析 ───

/** 支持的代码围栏语言标记（用于构建正则） */
const CODE_FENCE_LANGS = "typescript|ts|javascript|js|bash|shell|sh";

/** 判断语言标记是否为 JS/TS 类 */
function isJsLang(lang: string): boolean {
    return ["typescript", "ts", "javascript", "js"].includes(lang);
}

/** 判断语言标记是否为 bash/shell 类 */
function isBashLang(lang: string): boolean {
    return ["bash", "shell", "sh"].includes(lang);
}

/**
 * 截断 LLM 输出：只保留第一个完整代码块及其前面的自然语言，
 * 丢弃第一个代码块结束围栏之后的所有内容。
 * 如果没有完整的代码块，则原样返回。
 */
export function trimAfterFirstCodeBlock(response: string): string {
    // 非贪婪匹配第一个完整代码块（含闭合 ```）
    const firstBlockRe = new RegExp(
        "```(?:" + CODE_FENCE_LANGS + ")\\s*\\n[\\s\\S]*?```"
    );
    const m = firstBlockRe.exec(response);
    if (!m) return response; // 没有完整代码块，原样返回

    // 保留：从开头到第一个代码块闭合围栏的末尾
    return response.slice(0, m.index + m[0].length);
}

/**
 * 从 LLM response 中提取思考文本和代码块
 *
 * 代码块匹配 ```typescript, ```ts, ```js, ```javascript,
 * ```bash, ```shell, ```sh 围栏。
 * 围栏外的文本作为「思考」返回。
 *
 * @param response - LLM 的原始响应文本
 * @returns 思考文本和代码块数组（含语言标记）
 */
export function parseResponse(response: string): {
    thinking: string;
    codeBlocks: CodeBlock[];
} {
    const codeBlocks: CodeBlock[] = [];
    let thinking = response;

    // 匹配 ```typescript/ts/js/javascript/bash/shell/sh ... ``` 代码块
    const codeBlockRegex =
        new RegExp("```(" + CODE_FENCE_LANGS + ")\\s*\\n([\\s\\S]*?)```", "g");

    let match;
    while ((match = codeBlockRegex.exec(response)) !== null) {
        const langTag = match[1].toLowerCase();
        const lang: "js" | "bash" = isBashLang(langTag) ? "bash" : "js";
        codeBlocks.push({ lang, code: match[2].trim() });
    }

    // 思考 = 原文去掉所有代码块
    thinking = response.replace(codeBlockRegex, "").trim();

    return { thinking, codeBlocks };
}

// ─── Session Runner ───

/**
 * 运行一个完整的 CodeAct 交互 session
 *
 * 流程：
 * 1. 调用 LLM 获取 response
 * 2. 解析 response：分离思考和代码块
 * 3. 没有代码块 → session 结束
 * 4. 有代码块 → 在 sandbox 中依次执行，收集输出
 * 5. 输出作为 [Execution Output] 追加到消息历史
 * 6. 每轮检查是否有新通知；若有新的外部消息/回复任务，则中断当前 session 交还主循环
 * 7. 重复直到无代码块或达到最大轮次
 *
 * @param initialMessages - 初始消息（含 system prompt、context 等）
 * @param sandbox - Sandbox 实例
 * @param nc - NotificationCenter 实例（用于检查新通知）
 * @param llmConfig - LLM 配置
 * @returns Session 结果
 *
 * @example
 * ```ts
 * const result = await runCodeActSession(
 *   [{ role: "system", content: systemPrompt }, { role: "user", content: eventContext }],
 *   sandbox, nc, llmConfig
 * );
 * ```
 */
export async function runCodeActSession(
    messages: ChatMessage[],
    sandbox: Sandbox,
    nc: NotificationCenter,
    llmConfig: LLMConfig | LLMConfig[],
    /** 每段代码的执行超时（毫秒），默认 30s */
    executeTimeout: number = 30000,
    /** 已发消息收集器，用于将 notify 事件中确认的消息反馈到 observation */
    sentMessageCollector?: SentMessageCollector,
    /** 层 2 消息前送：每轮 LLM 调用前检查是否有新消息到达 */
    pendingMessagesDrain?: () => string | null,
    /** LLM prefill（预填充回复开头） */
    prefill?: string,
    /** LLM stop sequences */
    stopSequences?: string[],
    /** 关联的 chatId，用于进度事件 */
    chatId?: string,
    /** 最大交互轮次，默认 15 */
    maxTurns: number = DEFAULT_MAX_TURNS,
): Promise<SessionResult> {
    const sessionId = ulid();
    const turns: SessionTurn[] = [];

    /** 发射进度事件的辅助函数 */
    const emitProgress = (event: Omit<CodeActProgressEvent, "chatId" | "sessionId" | "timestamp">) => {
        if (!chatId) return;
        const payload: CodeActProgressEvent = {
            chatId,
            sessionId,
            timestamp: new Date().toISOString(),
            ...event,
        };
        codeActEvents.emit("codeact:progress", payload);
    };



    for (let turnNum = 0; turnNum < maxTurns; turnNum++) {
        // ─── 层 2: turn 间消息注入 ───
        if (pendingMessagesDrain) {
            const newMessages = pendingMessagesDrain();
            if (newMessages) {
                log.info(`Turn ${turnNum}: 注入前送消息`, { length: newMessages.length });
                messages.push({ role: "user", content: newMessages });
            }
        }

        // ─── 调用 LLM ───
        let llmResponse: LLMResponse;
        const configs = Array.isArray(llmConfig) ? llmConfig : [llmConfig];
        try {
            llmResponse = await callLLMWithFallback(messages, configs, {
                caller: "session-runner",
                ...(prefill ? { prefill } : {}),
                ...(stopSequences ? { stop: stopSequences } : {}),
            });
        } catch (err: unknown) {
            const errorMsg =
                err instanceof Error ? err.message : String(err);

            // 重要：如果在请求 LLM 时就失败（如 400 Bad Request），我们不能将当前这轮（破损的）遗留下来，
            // 不然外层拿到断裂的 sessionMessages 可能会出问题。
            // 直接带着出错原因返回即可保护 session 不被完全销毁，或者至少日志能体现。
            emitProgress({ turn: turnNum, phase: "end", isProcessing: false, endReason: "error" });
            return {
                sessionId,
                turns,
                messages,
                endReason: "error",
                error: `LLM call failed: ${errorMsg}`,
            };
        }

        const rawAssistantText = llmResponse.content;
        // ─── 截断：只保留第一个完整代码块及其前面的文本 ───
        const assistantText = trimAfterFirstCodeBlock(rawAssistantText);
        if (assistantText.length < rawAssistantText.length) {
            log.info(`Turn ${turnNum}: 截断模型输出`, {
                before: rawAssistantText.length,
                after: assistantText.length,
                discarded: rawAssistantText.length - assistantText.length,
            });
        }
        messages.push({ role: "assistant", content: assistantText });

        // ─── 解析 response ───
        const { thinking, codeBlocks } = parseResponse(assistantText);

        const turn: SessionTurn = {
            turn: turnNum,
            assistantMessage: assistantText,
            thinking,
            codeBlocks,
            executionResults: [],
            usage: llmResponse.usage,
        };

        // ─── Debug: 输出本轮的思考和代码 ───
        log.debug(`Turn ${turnNum}: thinking`, { text: thinking });

        // 发射 thinking 进度事件
        emitProgress({
            turn: turnNum,
            phase: "thinking",
            thinking,
            codeBlocks: codeBlocks.length > 0 ? codeBlocks : undefined,
            isProcessing: true,
        });

        // ─── 无代码块 → session 结束 ───
        if (codeBlocks.length === 0) {
            log.debug(`Turn ${turnNum}: 无代码块，session 结束`);
            turns.push(turn);

            // 发射结束事件
            emitProgress({ turn: turnNum, phase: "end", thinking, isProcessing: false, endReason: "no_code" });

            return {
                sessionId,
                turns,
                messages,
                endReason: "no_code",
            };
        }

        // ─── 执行代码块 ───
        const outputParts: string[] = [];

        for (let codeIndex = 0; codeIndex < codeBlocks.length; codeIndex++) {
            const block = codeBlocks[codeIndex];
            log.debug(`Turn ${turnNum}: code[${codeIndex}] (${block.lang})`, { code: block.code });

            let errorOccurred = false;

            try {
                const result = block.lang === "bash"
                    ? await sandbox.executeShell(block.code, executeTimeout)
                    : await sandbox.execute(block.code, executeTimeout);
                turn.executionResults.push(result);

                // Debug: 输出执行结果
                log.debug(`Turn ${turnNum}: exec[${codeIndex}]`, {
                    error: result.error,
                    output: result.output,
                });

                if (result.output) {
                    const truncated = truncateOutput(result.output);
                    const prefix = result.error
                        ? "[⚠ Execution Error]"
                        : "[Execution Output]";
                    outputParts.push(`${prefix}\n${truncated}`);
                } else if (result.error) {
                    outputParts.push("[⚠ Execution completed with error, no output]");
                } else {
                    outputParts.push("[Execution completed without output]");
                }

                if (result.error) {
                    errorOccurred = true;
                }
            } catch (err: unknown) {
                const errorMsg =
                    err instanceof Error ? err.message : String(err);
                turn.executionResults.push({
                    output: errorMsg,
                    error: true,
                });
                outputParts.push(`[⚠ Sandbox Error]\n${errorMsg}`);
                errorOccurred = true;

                // 如果 sandbox 进程已死，立即终止 session（不再重试）
                if (!sandbox.isAlive()) {
                    log.error("Sandbox worker died, aborting session", { sessionId, turn: turnNum, error: errorMsg });
                    turns.push(turn);

                    emitProgress({ turn: turnNum, phase: "end", isProcessing: false, endReason: "error" });
                    return {
                        sessionId,
                        turns,
                        messages,
                        endReason: "error",
                        error: `Sandbox worker died: ${errorMsg}`,
                    };
                }
            }

            if (errorOccurred) {
                break; // 如果沙箱捕捉到了运行时错误或者宿主层面抛出异常，停止执行后续代码块
            }
        }

        turns.push(turn);

        // ─── 组装 observation ───
        let observation = outputParts.join("\n\n");

        // Fix 1: 追加本轮已发送消息确认 + 重复拦截警告到 observation
        if (sentMessageCollector) {
            const turnSent = sentMessageCollector.drainTurn();
            const turnDupWarnings = sentMessageCollector.drainDuplicateWarnings();
            const sentConfirmation = SentMessageCollector.formatAsObservation(turnSent, turnDupWarnings);
            if (sentConfirmation) {
                observation = observation ? `${observation}\n\n${sentConfirmation}` : sentConfirmation;
            }
        }

        // ─── 轮次状态注入 ───
        const currentTurn = turnNum + 1; // 1-indexed for display
        const remaining = maxTurns - currentTurn;
        let turnStatus = `[📊 轮次状态: 第 ${currentTurn}/${maxTurns} 轮，剩余 ${remaining} 轮]`;
        if (remaining === 0) {
            turnStatus += `\n[⚠ 这是最后一轮，请确保在本轮内完成所有必要操作并发送最终回复]`;
        } else if (remaining === 1) {
            turnStatus += `\n[⚠ 仅剩 1 轮，请尽快完成操作]`;
        }
        observation = observation ? `${observation}\n\n${turnStatus}` : turnStatus;

        // 发射 observation 进度事件
        emitProgress({
            turn: turnNum,
            phase: "observation",
            executionOutput: observation || undefined,
            isProcessing: true,
        });

        // 将 observation 作为 user 消息追加
        if (observation.trim()) {
            messages.push({ role: "user", content: observation });
        }


    }

    // 达到最大轮次
    emitProgress({ turn: maxTurns, phase: "end", isProcessing: false, endReason: "max_turns" });

    return {
        sessionId,
        turns,
        messages,
        endReason: "max_turns",
    };
}

/**
 * 截断执行输出到最大字符数
 */
function truncateOutput(output: string): string {
    if (output.length <= MAX_OUTPUT_CHARS) return output;
    return (
        output.slice(0, MAX_OUTPUT_CHARS) +
        `\n...[truncated, ${output.length - MAX_OUTPUT_CHARS} chars omitted]`
    );
}


