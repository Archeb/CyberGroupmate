/**
 * session-runner.ts — CodeAct Session Runner
 *
 * 运行一个完整的 CodeAct 交互 session：LLM 生成思考和代码 → 
 * sandbox 执行代码 → 结果作为 observation 反馈 → 重复直到完成。
 *
 * 在整体架构中的位置：
 * - Orchestrator (main.ts) 在处理事件时调用 runCodeActSession
 * - 每个 session 的完整对话记录保存到 data/sessions/
 */

import { Sandbox, ExecutionResult } from "./sandbox.js";
import { NotificationCenter } from "../event/notification-center.js";
import { callLLM, ChatMessage, LLMResponse } from "../core/llm.js";
import type { LLMConfig } from "../core/config.js";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { ulid } from "ulid";
import { createLogger } from "../core/logger.js";

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

/** 最大交互轮次 */
const MAX_TURNS = 15;

/** 代码执行输出最大字符数 */
const MAX_OUTPUT_CHARS = 4000;

// ─── 类型 ───

/** Session 中的一个交互轮次记录 */
export interface SessionTurn {
    /** 轮次编号 */
    turn: number;
    /** LLM 原始 response */
    assistantMessage: string;
    /** 解析出的思考文本 */
    thinking: string;
    /** 解析出的代码块列表 */
    codeBlocks: string[];
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

/**
 * 从 LLM response 中提取思考文本和代码块
 *
 * 代码块匹配 ```typescript, ```ts, ```js, ```javascript 围栏。
 * 围栏外的文本作为「思考」返回。
 *
 * @param response - LLM 的原始响应文本
 * @returns 思考文本和代码块数组
 */
export function parseResponse(response: string): {
    thinking: string;
    codeBlocks: string[];
} {
    const codeBlocks: string[] = [];
    let thinking = response;

    // 匹配 ```typescript/ts/js/javascript ... ``` 代码块
    const codeBlockRegex =
        /```(?:typescript|ts|javascript|js)\s*\n([\s\S]*?)```/g;

    let match;
    while ((match = codeBlockRegex.exec(response)) !== null) {
        codeBlocks.push(match[1].trim());
    }

    // 思考 = 原文去掉所有代码块
    thinking = response.replace(codeBlockRegex, "").trim();

    return { thinking, codeBlocks };
}

export function shouldInterruptForEvent(event: Record<string, unknown>): boolean {
    const type = String(event.type ?? "");
    if (type === "system.reply_task") return true;
    if (type === "nc.message") return true;
    if (type === "telegram.message") return true;
    return !!event._urgent;
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
 * @param sessionsDir - Session transcript 保存目录
 * @returns Session 结果
 *
 * @example
 * ```ts
 * const result = await runCodeActSession(
 *   [{ role: "system", content: systemPrompt }, { role: "user", content: eventContext }],
 *   sandbox, nc, llmConfig, "workspace/sessions"
 * );
 * ```
 */
export async function runCodeActSession(
    messages: ChatMessage[],
    sandbox: Sandbox,
    nc: NotificationCenter,
    llmConfig: LLMConfig,
    sessionsDir: string = "workspace/sessions",
    /** 每段代码的执行超时（毫秒），默认 30s */
    executeTimeout: number = 30000,
    /** 禁用 NC drain 中断检查（Subagent 架构时使用，避免与 Observer 冲突） */
    disableNcInterrupt: boolean = false,
    /** 已发消息收集器，用于将 notify 事件中确认的消息反馈到 observation */
    sentMessageCollector?: SentMessageCollector,
): Promise<SessionResult> {
    const sessionId = ulid();
    const turns: SessionTurn[] = [];

    // 确保 session 目录存在
    if (!existsSync(sessionsDir)) {
        mkdirSync(sessionsDir, { recursive: true });
    }
    const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);

    for (let turnNum = 0; turnNum < MAX_TURNS; turnNum++) {
        // ─── 调用 LLM ───
        let llmResponse: LLMResponse;
        try {
            llmResponse = await callLLM(messages, llmConfig);
        } catch (err: unknown) {
            const errorMsg =
                err instanceof Error ? err.message : String(err);

            // 重要：如果在请求 LLM 时就失败（如 400 Bad Request），我们不能将当前这轮（破损的）遗留下来，
            // 不然外层拿到断裂的 sessionMessages 可能会出问题。
            // 直接带着出错原因返回即可保护 session 不被完全销毁，或者至少日志能体现。
            return {
                sessionId,
                turns,
                messages,
                endReason: "error",
                error: `LLM call failed: ${errorMsg}`,
            };
        }

        const assistantText = llmResponse.content;
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

        // ─── 无代码块 → session 结束 ───
        if (codeBlocks.length === 0) {
            log.debug(`Turn ${turnNum}: 无代码块，session 结束`);
            turns.push(turn);
            appendTranscript(transcriptPath, turn);
            return {
                sessionId,
                turns,
                messages,
                endReason: "no_code",
            };
        }

        // ─── 执行代码块 ───
        const outputParts: string[] = [];

        for (const code of codeBlocks) {
            const codeIndex = codeBlocks.indexOf(code);
            log.debug(`Turn ${turnNum}: code[${codeIndex}]`, { code });

            let errorOccurred = false;

            try {
                const result = await sandbox.execute(code, executeTimeout);
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
                    appendTranscript(transcriptPath, turn);
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
        appendTranscript(transcriptPath, turn);

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

        // 将 observation 作为 user 消息追加
        if (observation.trim()) {
            messages.push({ role: "user", content: observation });
        }

        if (!disableNcInterrupt && nc.pendingCount > 0) {
            const newEvents = await nc.drain(0, 5);
            if (newEvents.length > 0) {
                const shouldInterrupt = newEvents.some(event =>
                    shouldInterruptForEvent(event as Record<string, unknown>)
                );

                if (shouldInterrupt) {
                    for (let i = newEvents.length - 1; i >= 0; i--) {
                        nc.push(newEvents[i]);
                    }
                    messages.push({
                        role: "user",
                        content: `[系统] 发现新的外部消息或回复任务，当前 session 已中断并把控制权交还主循环。`,
                    });
                    return {
                        sessionId,
                        turns,
                        messages,
                        endReason: "interrupted",
                    };
                }

                const eventSummary = newEvents
                    .map((e) => {
                        const preview = JSON.stringify(e).slice(0, 300);
                        return `- ${e.type}: ${preview}`;
                    })
                    .join("\n");
                messages.push({
                    role: "user",
                    content: `[📬 新通知到达 (${newEvents.length} 条)]\n${eventSummary}`,
                });
            }
        }
    }

    // 达到最大轮次
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

/**
 * 追加一个 turn 记录到 session transcript
 */
function appendTranscript(path: string, turn: SessionTurn): void {
    try {
        const record = {
            turn: turn.turn,
            thinking: turn.thinking.slice(0, 500),
            codeBlocks: turn.codeBlocks.length,
            results: turn.executionResults.map((r) => ({
                error: r.error,
                outputLength: r.output.length,
            })),
            usage: turn.usage,
            timestamp: new Date().toISOString(),
        };
        appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
    } catch {
        // 写入失败不影响主流程
    }
}
