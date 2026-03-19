/**
 * attend-handler.ts — 主 Agent Attend Handler (Phase 4-5)
 *
 * 从 main.ts 提取的 LLM 决策逻辑：
 * - Phase 4: 构建 GroupContextPackage (Cosine Decay → 上下文深度 → 消息原文/FastPath 历史)
 * - Phase 5: 主 Agent LLM 决策 (系统 prompt + 上下文注入 + JSON 解析 + 算法 fallback)
 *
 * 参考设计：subagent.md §12.2 ➋➌➍
 */

import type { AttentionQueueEntry, AttendResult } from "../subagent/types.js";
import type { SubagentManager } from "../subagent/subagent-manager.js";
import type { FastPathHandler } from "../subagent/fast-path-handler.js";
import type { MemoryStoreV2 } from "../memory-v2/index.js";
import type { LLMConfig } from "../core/config.js";
import type { ChatMessage } from "../core/llm.js";
import type { GlobalState } from "./global-state.js";
import type { MainAgentLoop } from "./main-agent-loop.js";
import { calculateDepth } from "./cosine-decay.js";
import { buildGroupContext } from "./context-builder.js";
import { estimateReplyMode, buildReplyDecisions, buildObserveDecision } from "./decision-maker.js";
import { renderPrompt, buildAttentionVariables, buildMainSystemVariables } from "./prompt-renderer.js";
import { callLLM } from "../core/llm.js";
import { createLogger } from "../core/logger.js";
import { formatTsForDisplay } from "../core/timezone.js";
import { formatMessageLine, type RawMessage } from "../core/message-enricher.js";

const log = createLogger("attend-handler");

/** Attend handler 依赖 */
export interface AttendHandlerDeps {
    memory: MemoryStoreV2;
    globalState: GlobalState;
    subagentManager: SubagentManager;
    mainLoop: MainAgentLoop;
    sotaConfig: LLMConfig;
    persona: { name: string; description: string };
}

/**
 * 创建 attend handler 工厂函数
 *
 * 返回可直接传给 MainAgentLoop.setAttendHandler() 的函数。
 */
export function createAttendHandler(
    deps: AttendHandlerDeps,
): (entry: AttentionQueueEntry) => Promise<AttendResult | null> {
    const { memory, globalState, subagentManager, mainLoop, sotaConfig, persona } = deps;

    return async (entry: AttentionQueueEntry): Promise<AttendResult | null> => {
        const subagent = subagentManager.get(entry.chatId);
        if (!subagent) return buildObserveDecision(entry.chatId);

        // ─── Phase 4: 构建上下文 ───

        let depth = calculateDepth(
            entry.attendCount,
            subagent.stickiness.depthCyclePeriod,
            entry.alert ? { forceMinDepth: 2 } : undefined,
        );

        // 获取群组画像和最近 callbacks（L1+ 深度可见）
        const groupModel = memory.getGroupModel(entry.chatId) ?? undefined;

        // 自动深度提升：当 topicDigests 和 groupModel 都为空时，
        // L0/L1 深度下 LLM 几乎没有可用信息来做决策，自动升级到 L2 以获取消息原文
        if (depth < 2 && entry.topicDigests.length === 0 && !groupModel) {
            log.info("深度自动提升: topicDigests 和 groupModel 均为空", { chatId: entry.chatId, from: `L${depth}`, to: "L2" });
            depth = 2 as import("./cosine-decay.js").ContextDepth;
        }

        // L1: 少量最近消息（3-5条）提供基本上下文感知
        // L2+: 完整消息列表（20条）提供详细上下文
        const messageLimit = depth >= 2 ? 20 : depth >= 1 ? 5 : 0;
        const recentMessages = messageLimit > 0
            ? memory.getRecentMessages(entry.chatId, messageLimit).map(m => ({
                ...m,
                replyToMessageId: m.replyToMessageId ?? null,
            }))
            : undefined;

        const contextPkg = buildGroupContext({
            chatId: entry.chatId,
            depth,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: entry.topicDigests,
            engagementScore: entry.priority,
            groupModel,
            lastCallbacks: subagent.lastCallbacks,
            messages: recentMessages,
            chatTitle: groupModel?.chatTitle,
            isDirectMessage: groupModel?.isDirectMessage,
            stickiness: subagent.stickiness,
            fastPathEnabled: !!(subagent.fastPathHandler as any)?.isAuthorized?.(),
            pendingCodeActTasks: (subagent.codeActExecutor as any)?.getQueueSize?.() ?? 0,
        });

        // 算法预估 replyMode（作为 LLM 参考信号 + fallback）
        const suggestedReplyMode = estimateReplyMode(
            contextPkg,
            entry.newMessageCount,
            entry.hasFastPathRequest,
            entry.stickinessLevel,
            entry.topicDigests.filter(d => d.state === "ACTIVE").length,
            entry.lastAttendedAt ? Date.now() - new Date(entry.lastAttendedAt).getTime() : Infinity,
            0,
        );

        // 算法 fallback 结果（LLM 失败时使用）
        const algorithmicResult = suggestedReplyMode === "NONE"
            ? buildObserveDecision(entry.chatId)
            : buildReplyDecisions(
                entry.chatId,
                suggestedReplyMode,
                entry.topicDigests.map(d => ({ topicId: d.topicId, label: d.label })),
                `${suggestedReplyMode} (engagement=${Math.round(entry.priority)}, depth=L${depth})`,
            );

        // ═══ Phase 5: LLM 决策路径 (subagent.md §12.2 ➋➌➍) ═══
        try {
            // 构建消息原文（L2+ 深度）
            let messagesText = "";
            if (depth >= 2) {
                const recentMsgs = memory.getRecentMessages(entry.chatId, 20);
                recentMsgs.reverse(); // DESC→ASC: LLM 需要时间正序
                if (recentMsgs.length > 0) {
                    // 构建 messageId → displayName 映射，用于解析 replyTo 关系
                    const msgIdToName = new Map<string, string>();
                    for (const m of recentMsgs) {
                        msgIdToName.set(m.messageId, m.displayName || `(uid:${m.userId})`);
                    }
                    messagesText = recentMsgs.map(
                        (m: any) => {
                            // 转换为 RawMessage 格式，复用 formatMessageLine
                            const raw: RawMessage = {
                                id: m.messageId,
                                sender: m.displayName ?? `(uid:${m.userId})`,
                                text: m.text ?? "",
                                timestamp: m.timestamp,
                                replyTo: m.replyToMessageId
                                    ? (msgIdToName.get(m.replyToMessageId) ?? `msg#${m.replyToMessageId}`)
                                    : undefined,
                                mediaType: m.mediaType,
                                mediaInfo: m.mediaInfo,
                            };
                            return formatMessageLine(raw, { includeMediaTags: true });
                        }
                    ).join("\n");
                }
            }

            // 构建 FastPath 历史
            const fpHandler = subagent.fastPathHandler as FastPathHandler | null;
            const fpHistory = fpHandler?.getSentMessages()
                .map(m => `- [${formatTsForDisplay(m.timestamp)}] ${m.text}`)
                .join("\n") ?? "";

            // 计算时间差
            const timeSinceLastAttend = entry.lastAttendedAt
                ? `${Math.round((Date.now() - new Date(entry.lastAttendedAt).getTime()) / 60_000)}分钟`
                : "从未关注";

            // ➌ Attend 上下文注入 + ➍ Decision 输出格式
            const promptVars = buildAttentionVariables(contextPkg, entry.newMessageCount, {
                persona: `你是「${persona.name}」。${persona.description}`,
                lastAttendedAt: entry.lastAttendedAt,
                timeSinceLastAttend,
                stickinessLevel: entry.stickinessLevel,
                priorityMultiplier: subagent.stickiness.priorityMultiplier,
                tonePreset: subagent.stickiness.level === "CORE" ? "随意友好" :
                    subagent.stickiness.level === "FAMILIAR" ? "轻松" : "礼貌得体",
                callbacks: subagent.lastCallbacks.length > 0
                    ? subagent.lastCallbacks.slice(-3)
                    : undefined,
                fastPathHistory: fpHistory,
                alertReason: entry.alert?.reason,
                messages: messagesText || undefined,
                suggestedReplyMode,
                dispatchedTopicIds: [...subagent.getDispatchedTopicIds()],
            });

            const attentionPrompt = renderPrompt("ATTENTION", promptVars);
            const decisionPrompt = renderPrompt("DECISION", promptVars);

            // ➋ 主 Agent 系统 Prompt — 使用模板渲染 (subagent.md §12.2 ➋)
            const mainSystemVars = buildMainSystemVariables(persona, globalState, decisionPrompt);
            const mainSystemPrompt = renderPrompt("MAIN_SYSTEM", mainSystemVars);

            // ➝ 构建 messages: [system, ...历史对话, 当前轮 attend prompt]
            const currentTurnPrompt = `${attentionPrompt}`;
            const messages: ChatMessage[] = [
                { role: "system", content: mainSystemPrompt },
                ...(mainLoop.getConversationHistory() as ChatMessage[]),
                { role: "user", content: currentTurnPrompt },
            ];

            const llmResponse = await callLLM(
                messages,
                sotaConfig,
                { caller: "attend-handler" },
            );

            // 解析 LLM 返回的 JSON
            const jsonContent = llmResponse.content.trim();
            // 尝试提取 JSON（处理 markdown 围栏情况）
            const jsonMatch = jsonContent.match(/```(?:json)?\s*\n?([\s\S]*?)```/) ?? [null, jsonContent];
            const parsed = JSON.parse(jsonMatch[1] ?? jsonContent);

            const llmResult: AttendResult = {
                chatId: entry.chatId,
                replyMode: parsed.replyMode ?? suggestedReplyMode,
                decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map((d: any) => ({
                    action: d.action ?? "REPLY",
                    topicId: d.topicId,
                    contentDirection: d.contentDirection,
                    confidence: d.confidence ?? 0.5,
                    reason: d.reason ?? "",
                })) : algorithmicResult.decisions,
                reasoning: parsed.reasoning ?? "",
            };

            // ═══ 追加本轮对话到历史（下轮 LLM 可见） ═══
            await mainLoop.appendToHistory({ role: "user", content: currentTurnPrompt });
            await mainLoop.appendToHistory({ role: "assistant", content: jsonContent });

            globalState.recordDecision(entry.chatId,
                `LLM_DECISION: ${llmResult.replyMode} (${llmResult.decisions.length} decisions, engagement=${Math.round(entry.priority)}, depth=L${depth})`);
            log.info("LLM 决策完成", {
                chatId: entry.chatId,
                replyMode: llmResult.replyMode,
                decisions: llmResult.decisions.length,
                reasoning: llmResult.reasoning,
                decisionDetails: llmResult.decisions.map(d =>
                    `[${d.action}] ${d.contentDirection ?? d.reason ?? "(无方向)"} (topic=${d.topicId ?? "N/A"}, conf=${d.confidence})`
                ),
            });
            return llmResult;

        } catch (err) {
            // LLM 决策失败 → fallback 到算法结果
            log.warn("LLM 决策失败，fallback 到算法", {
                chatId: entry.chatId,
                error: String(err),
            });
            globalState.recordDecision(entry.chatId,
                `ALGO_FALLBACK: ${suggestedReplyMode} (engagement=${Math.round(entry.priority)}, depth=L${depth}, llm_error=${String(err).slice(0, 100)})`);
            return algorithmicResult;
        }
    };
}
