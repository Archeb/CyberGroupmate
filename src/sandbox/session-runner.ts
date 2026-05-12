/**
 * session-runner.ts — CodeAct Session Runner
 *
 * 运行一个完整的 CodeAct 交互 session：LLM 生成思考和代码 → 
 * sandbox 执行代码 → 结果作为 observation 反馈 → 重复直到完成。
 *
 * 支持 Two-pass Code Generation：
 * - Pass 1：LLM 基于轻量 API 概览生成初版代码
 * - 类型解析：提取代码中调用的 API 方法，按需注入完整 TypeDoc 文档
 * - Pass 2：LLM 基于完整文档重新生成代码（仅在需要时触发）
 *
 * 在整体架构中的位置：
 * - Orchestrator (main.ts) 在处理事件时调用 runCodeActSession
 */

import { Sandbox, ExecutionResult } from "./sandbox.js";
import type { NotificationCenter } from "../event/notification-center.js";
import { callLLMWithFallback, ChatMessage, LLMResponse } from "../core/llm.js";
import type { LLMConfig } from "../core/config.js";
import type { ContextManifest } from "../context-engine/types.js";
import { ulid } from "ulid";
import { createLogger } from "../core/logger.js";
import { EventEmitter } from "node:events";
import { extractApiCalls, getDocLookupMethods } from "./api-intent-extractor.js";

// ─── CodeAct Progress Events ───

/** 全局 CodeAct 进度事件发射器（与 llmEvents 同模式） */
export const codeActEvents = new EventEmitter();
codeActEvents.setMaxListeners(20);

/** CodeAct 进度事件 payload */
export interface CodeActProgressEvent {
    chatId: string;
    sessionId: string;
    turn: number;
    phase: "thinking" | "executing" | "observation" | "new_messages" | "task" | "end" | "type_resolving";
    thinking?: string;
    codeBlocks?: CodeBlock[];
    executionOutput?: string;
    isProcessing: boolean;
    endReason?: string;
    /** 注入的用户消息文本（phase=new_messages 时） */
    userMessage?: string;
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
const MAX_OUTPUT_CHARS = 32768;

/** 模型显式终止标记 */
const END_TURN_MARKER = "<end_task>";

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
    endReason: "end_turn" | "max_turns" | "error" | "interrupted";
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
 * （如果截断前有 <end_task> 但被截断了，则补回 <end_task>）
 */
export function trimAfterFirstCodeBlock(response: string, hasEndTurn: boolean = false): string {
    // 非贪婪匹配第一个完整代码块（含闭合 ```）
    const firstBlockRe = new RegExp(
        "```(?:" + CODE_FENCE_LANGS + ")\\s*\\n[\\s\\S]*?```"
    );
    const m = firstBlockRe.exec(response);
    
    let trimmed = response;
    if (m) {
        // 保留：从开头到第一个代码块闭合围栏的末尾
        trimmed = response.slice(0, m.index + m[0].length);
    }
    
    if (hasEndTurn && !trimmed.includes(END_TURN_MARKER)) {
        trimmed += "\n" + END_TURN_MARKER;
    }
    
    return trimmed;
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

function hasSessionDigest(thinking?: string): boolean {
    const trimmed = thinking?.trim();
    if (!trimmed) return false;

    const match = trimmed.match(/\[SESSION_DIGEST\]([\s\S]*?)(?:\[\/SESSION_DIGEST\]|$)/);
    return Boolean(match?.[1]?.trim());
}

function buildMissingDigestObservation(): string {
    return [
        "[⚠ 结束前缺少 SESSION_DIGEST]",
        "你已经输出 <end_task>，但没有输出 [SESSION_DIGEST]...[/SESSION_DIGEST]。",
        "请用纯文本补充本次任务摘要，格式必须包含 [SESSION_DIGEST]做了什么、结果如何、是否还有遗留[/SESSION_DIGEST]，然后再输出 <end_task>。",
    ].join("\n");
}

// ─── Session Runner ───

/**
 * 运行一个完整的 CodeAct 交互 session
 *
 * 流程：
 * 1. 调用 LLM 获取 response
 * 2. 解析 response：分离思考和代码块，检测 <end_task> 标记
 * 3. 有 <end_task> → session 结束（若有代码块则先执行）
 * 4. 无代码块且无 <end_task> → 纯文本思考轮次，继续下一轮
 * 5. 有代码块 → 在 sandbox 中依次执行，收集输出
 * 6. 输出作为 [Execution Output] 追加到消息历史
 * 7. 每轮检查是否有新通知；若有新的外部消息/回复任务，则中断当前 session 交还主循环
 * 8. 重复直到 <end_task> 或达到最大轮次
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
    /**
     * Two-pass 配置。
     * - getPrefixMap: 每个 turn 动态获取最新模块前缀映射（支持 MCP 热插拔）
     * - lookupDocs: 接收方法调用列表，返回完整 TypeDoc 文档
     */
    twoPassConfig?: {
        getPrefixMap: () => Record<string, string>;
        lookupDocs: (calledMethods: string[]) => string;
    },
    /** 当前任务 prompt 的 ContextEngine manifest（供 Dashboard 关联到 LLM log） */
    contextManifest?: ContextManifest,
): Promise<SessionResult> {
    const sessionId = ulid();
    const turns: SessionTurn[] = [];
    let effectiveMaxTurns = maxTurns;
    let effectiveExecuteTimeout = executeTimeout;

    // 清理可能残留的控制指令（避免上一个 session 泄漏）
    sandbox.consumeExecutionControl();

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

    // ─── 发射初始任务 prompt 进度事件 ───
    // 取 messages 中最后一条 user 消息作为任务 prompt 展示
    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
    if (lastUserMsg) {
        emitProgress({
            turn: -1,
            phase: "task",
            userMessage: typeof lastUserMsg.content === "string"
                ? lastUserMsg.content
                : JSON.stringify(lastUserMsg.content),
            isProcessing: true,
        });
    }

    for (let turnNum = 0; turnNum < effectiveMaxTurns; turnNum++) {
        // ─── 层 2: turn 间消息注入 ───
        if (pendingMessagesDrain) {
            const newMessages = pendingMessagesDrain();
            if (newMessages) {
                log.info(`Turn ${turnNum}: 注入前送消息`, { length: newMessages.length });
                messages.push({ role: "user", content: newMessages });

                // 发射进度事件：新消息到达
                emitProgress({
                    turn: turnNum,
                    phase: "new_messages",
                    userMessage: newMessages,
                    isProcessing: true,
                });
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
                ...(contextManifest ? { contextManifest } : {}),
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

        let rawAssistantText = llmResponse.content;

        // ─── 检测 <end_task> 显式终止标记 ───
        let hasEndTurn = rawAssistantText.includes(END_TURN_MARKER);

        // ─── 防御：代码块 + <end_task> 共存时，剥离 <end_task> ───
        // 模型有时会急于在代码块后附加 <end_task>，但它还没看到执行结果。
        // 此处强制忽略，让代码执行后照常回送 observation，模型在下一轮再决定是否结束。
        const { codeBlocks: probeBlocks } = parseResponse(rawAssistantText);
        if (hasEndTurn && probeBlocks.length > 0) {
            log.info(`Turn ${turnNum}: 代码块与 <end_task> 共存，剥离 <end_task>（强制继续）`);
            hasEndTurn = false;
            // 从原文中移除 <end_task> 标记，避免存入 history 成为坏 few-shot 信号
            rawAssistantText = rawAssistantText.replace(END_TURN_MARKER, "").trimEnd();
        }

        // ─── 截断：只保留第一个完整代码块及其前面的文本 ───
        // 剥离 <end_task> 后，trimAfterFirstCodeBlock 不再补回 <end_task>
        const assistantText = trimAfterFirstCodeBlock(rawAssistantText, hasEndTurn);
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
        log.debug(`Turn ${turnNum}: thinking`, { text: thinking, hasEndTurn });

        // 发射 thinking 进度事件
        emitProgress({
            turn: turnNum,
            phase: "thinking",
            thinking,
            codeBlocks: codeBlocks.length > 0 ? codeBlocks : undefined,
            isProcessing: true,
        });

        // ─── <end_task> 且无代码块 → 直接结束 session ───
        if (hasEndTurn && codeBlocks.length === 0) {
            if (!hasSessionDigest(thinking)) {
                log.info(`Turn ${turnNum}: <end_task> 缺少 SESSION_DIGEST，要求补充摘要`);
                turns.push(turn);
                const observation = buildMissingDigestObservation();
                emitProgress({
                    turn: turnNum,
                    phase: "observation",
                    executionOutput: observation,
                    isProcessing: true,
                });
                messages.push({ role: "user", content: observation });
                continue;
            }
            log.debug(`Turn ${turnNum}: 检测到 <end_task>，session 结束`);
            turns.push(turn);
            emitProgress({ turn: turnNum, phase: "end", thinking, isProcessing: false, endReason: "end_turn" });
            return {
                sessionId,
                turns,
                messages,
                endReason: "end_turn",
            };
        }

        // ─── 无代码块且无 <end_task> → 纯文本思考轮次，继续下一轮 ───
        if (codeBlocks.length === 0) {
            log.debug(`Turn ${turnNum}: 纯文本轮次（无代码块、无 <end_task>），继续`);
            turns.push(turn);

            let textOnlyObs = "[📝 纯文本轮次，未执行代码。如需结束请输出 <end_task>]";

            if (sentMessageCollector) {
                const turnSent = sentMessageCollector.drainTurn();
                const turnDupWarnings = sentMessageCollector.drainDuplicateWarnings();
                const sentConfirmation = SentMessageCollector.formatAsObservation(turnSent, turnDupWarnings);
                if (sentConfirmation) {
                    textOnlyObs += `\n\n${sentConfirmation}`;
                }
            }

            const currentTurn = turnNum + 1;
            const remaining = effectiveMaxTurns - currentTurn;
            let turnStatus = `[📊 轮次状态: 第 ${currentTurn}/${effectiveMaxTurns} 轮，剩余 ${remaining} 轮]`;
            if (turnNum === 0) {
                turnStatus += `\n[💡 每轮代码在独立作用域执行，局部变量不跨轮次保留。需要跨轮次传递的状态请存入 ctx 对象]`;
            }
            if (remaining === 0) {
                turnStatus += `\n[⚠ 这是最后一轮，请确保在本轮内完成所有必要操作并发送最终回复]`;
            } else if (remaining === 1) {
                turnStatus += `\n[⚠ 仅剩 1 轮，请尽快完成操作]`;
            }
            textOnlyObs += `\n\n${turnStatus}`;

            emitProgress({
                turn: turnNum,
                phase: "observation",
                executionOutput: textOnlyObs,
                isProcessing: true,
            });

            messages.push({ role: "user", content: textOnlyObs });
            continue;
        }

        // ─── Two-pass: 类型解析与文档注入（无状态去重） ───
        // 每一轮都检测代码中的 API 调用，但只注入上下文中尚未存在的方法文档。
        // 如果文档因 compact 被清理，下次调用时会自动重新注入。
        if (twoPassConfig && codeBlocks.length > 0) {
            // 合并所有代码块的 API 调用
            const allCode = codeBlocks.map(b => b.code).join("\n");
            const calledMethods = extractApiCalls(allCode, twoPassConfig.getPrefixMap());
            const docLookupMethods = getDocLookupMethods(calledMethods);

            if (docLookupMethods.length > 0) {
                // ─── 无状态去重：检查 messages 中哪些方法文档已经存在 ───
                const missingMethods = docLookupMethods.filter(method => {
                    // 文档注入时使用 "### module.method" 作为标记
                    const marker = `### ${method}`;
                    return !messages.some(m =>
                        typeof m.content === "string" && m.content.includes(marker)
                    );
                });

                if (missingMethods.length > 0) {
                    const fullDocs = twoPassConfig.lookupDocs(missingMethods);
                    if (fullDocs) {
                        log.info(`Turn ${turnNum}: Two-pass 触发`, {
                            calledMethods,
                            missingMethods,
                            alreadyInContext: calledMethods.length - missingMethods.length,
                            docsLength: fullDocs.length,
                        });

                        // 发射 type_resolving 进度事件
                        emitProgress({
                            turn: turnNum,
                            phase: "type_resolving",
                            thinking: `正在查阅 API 文档: ${missingMethods.join(", ")}`,
                            isProcessing: true,
                        });

                        // 将 Pass 1 的 assistant 输出替换为第一人称提示
                        messages.pop();
                        // 注入文档到 history 中（作为系统提示的补充）
                        messages.push({
                            role: "user",
                            content: `[📚 API 文档加载完成]

你打算使用以下 API: ${missingMethods.join(", ")}。
以下是这些方法的完整类型定义和用法文档，请仔细阅读后编写代码：
${fullDocs}

注意：获取完信息 console.log 出来看看再决定下一步行动。
`,


                        });

                        // Pass 2: 重新调用 LLM，让其基于完整文档重新生成代码
                        try {
                            const pass2Response = await callLLMWithFallback(messages, configs, {
                                caller: "session-runner-pass2",
                                ...(prefill ? { prefill } : {}),
                                ...(stopSequences ? { stop: stopSequences } : {}),
                                ...(contextManifest ? { contextManifest } : {}),
                            });

                            // ─── Pass 2: 检测 <end_task> ───
                            const pass2Raw = pass2Response.content;
                            let pass2HasEndTurn = pass2Raw.includes(END_TURN_MARKER);

                            // Pass 2 同样防御：代码块 + <end_task> 共存时剥离
                            const { codeBlocks: pass2ProbeBlocks } = parseResponse(pass2Raw);
                            if (pass2HasEndTurn && pass2ProbeBlocks.length > 0) {
                                log.info(`Turn ${turnNum}: Pass 2 代码块与 <end_task> 共存，剥离 <end_task>`);
                                pass2HasEndTurn = false;
                            }

                            const pass2Text = trimAfterFirstCodeBlock(pass2Raw, pass2HasEndTurn);
                            hasEndTurn = pass2HasEndTurn; // Pass 2 覆盖 Pass 1 的终止信号

                            messages.push({ role: "assistant", content: pass2Text });

                            // 重新解析 Pass 2 的输出
                            const pass2Parsed = parseResponse(pass2Text);
                            turn.assistantMessage = pass2Text;
                            turn.thinking = pass2Parsed.thinking;
                            turn.codeBlocks = pass2Parsed.codeBlocks;
                            turn.usage = pass2Response.usage;

                            // 如果 Pass 2 有 <end_task> 且无代码块，结束 session
                            if (pass2HasEndTurn && pass2Parsed.codeBlocks.length === 0) {
                                if (!hasSessionDigest(pass2Parsed.thinking)) {
                                    log.info(`Turn ${turnNum}: Pass 2 <end_task> 缺少 SESSION_DIGEST，要求补充摘要`);
                                    turns.push(turn);
                                    const observation = buildMissingDigestObservation();
                                    emitProgress({
                                        turn: turnNum,
                                        phase: "observation",
                                        executionOutput: observation,
                                        isProcessing: true,
                                    });
                                    messages.push({ role: "user", content: observation });
                                    continue;
                                }
                                log.debug(`Turn ${turnNum}: Pass 2 检测到 <end_task>，session 结束`);
                                turns.push(turn);
                                emitProgress({ turn: turnNum, phase: "end", thinking: pass2Parsed.thinking, isProcessing: false, endReason: "end_turn" });
                                return { sessionId, turns, messages, endReason: "end_turn" };
                            }

                            log.info(`Turn ${turnNum}: Pass 2 完成`, {
                                codeBlocks: pass2Parsed.codeBlocks.length,
                            });

                            // 发射 Pass 2 thinking 进度事件（覆盖 Pass 1 的代码块）
                            emitProgress({
                                turn: turnNum,
                                phase: "thinking",
                                thinking: pass2Parsed.thinking,
                                codeBlocks: pass2Parsed.codeBlocks.length > 0 ? pass2Parsed.codeBlocks : undefined,
                                isProcessing: true,
                            });
                        } catch (err: unknown) {
                            // Pass 2 LLM 失败 → 回退到 Pass 1 的代码继续执行
                            log.warn(`Turn ${turnNum}: Pass 2 LLM 失败，回退到 Pass 1 代码`, {
                                error: String(err),
                            });
                            // 移除文档注入消息，恢复 Pass 1 assistant 消息
                            messages.pop(); // 移除文档 user message
                            messages.push({ role: "assistant", content: assistantText }); // 恢复 Pass 1
                        }
                    }
                } else {
                    log.debug(`Turn ${turnNum}: 所有方法文档已在上下文中，跳过 Two-pass`, {
                        calledMethods,
                    });
                }
            }
        }

        // ─── 执行代码块（可能是 Pass 1 原始代码或 Pass 2 重写后的代码） ───
        const { codeBlocks: finalCodeBlocks } = turn; // 使用可能被 Pass 2 更新的 codeBlocks
        const outputParts: string[] = [];

        for (let codeIndex = 0; codeIndex < finalCodeBlocks.length; codeIndex++) {
            const block = finalCodeBlocks[codeIndex];
            log.debug(`Turn ${turnNum}: code[${codeIndex}] (${block.lang})`, { code: block.code });

            let errorOccurred = false;

            try {
                const result = block.lang === "bash"
                    ? await sandbox.executeShell(block.code, effectiveExecuteTimeout)
                    : await sandbox.execute(block.code, effectiveExecuteTimeout);
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

                // 如果 sandbox 进程已死或本轮执行超时，立即终止 session（不再用卡住的 worker 重试）。
                if (!sandbox.isAlive() || isCodeExecutionTimeoutError(errorMsg)) {
                    log.error("Sandbox execution aborted, ending session", { sessionId, turn: turnNum, error: errorMsg });
                    turns.push(turn);

                    emitProgress({ turn: turnNum, phase: "end", isProcessing: false, endReason: "error" });
                    return {
                        sessionId,
                        turns,
                        messages,
                        endReason: "error",
                        error: `Sandbox execution aborted: ${errorMsg}`,
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
        const remaining = effectiveMaxTurns - currentTurn;
        let turnStatus = `[📊 轮次状态: 第 ${currentTurn}/${effectiveMaxTurns} 轮，剩余 ${remaining} 轮]`;
        if (turnNum === 0) {
            turnStatus += `\n[💡 每轮代码在独立作用域执行，局部变量不跨轮次保留。需要跨轮次传递的状态请存入 ctx 对象]`;
        }
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

        // 消费本轮 runtime.extendSteps / runtime.modifyTimeout 控制指令
        const control = sandbox.consumeExecutionControl();
        if (control.extendSteps > 0) {
            const oldMaxTurns = effectiveMaxTurns;
            effectiveMaxTurns += control.extendSteps;
            log.info(`Turn ${turnNum}: runtime.extendSteps 生效`, {
                extendedBy: control.extendSteps,
                from: oldMaxTurns,
                to: effectiveMaxTurns,
            });
        }
        if (control.timeoutMs != null) {
            const oldTimeout = effectiveExecuteTimeout;
            effectiveExecuteTimeout = control.timeoutMs;
            log.info(`Turn ${turnNum}: runtime.modifyTimeout 生效`, {
                from: oldTimeout,
                to: effectiveExecuteTimeout,
            });
        }

        // ─── <end_task> 检查：代码已执行完毕，终止 session ───
        // 注意：正常情况下 hasEndTurn 在有代码块时已被强制设为 false，
        // 此处仅作为最终防线保留。
        if (hasEndTurn) {
            if (!hasSessionDigest(turn.thinking)) {
                log.info(`Turn ${turnNum}: 代码执行后 <end_task> 缺少 SESSION_DIGEST，要求补充摘要`);
                const observation = buildMissingDigestObservation();
                emitProgress({
                    turn: turnNum,
                    phase: "observation",
                    executionOutput: observation,
                    isProcessing: true,
                });
                messages.push({ role: "user", content: observation });
                continue;
            }
            log.debug(`Turn ${turnNum}: 代码已执行，检测到 <end_task>，session 结束`);
            emitProgress({ turn: turnNum, phase: "end", isProcessing: false, endReason: "end_turn" });
            return {
                sessionId,
                turns,
                messages,
                endReason: "end_turn",
            };
        }

    }

    // 达到最大轮次
    emitProgress({ turn: effectiveMaxTurns, phase: "end", isProcessing: false, endReason: "max_turns" });

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

function isCodeExecutionTimeoutError(message: string): boolean {
    return message.includes("Code execution timed out after");
}
