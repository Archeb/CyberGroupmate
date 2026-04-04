/**
 * minicodeact-handlers/attention.ts — attention 命名空间处理器
 *
 * 提供 attention.boost / attention.scheduleRevisit /
 *         attention.adjustStickiness / attention.revokeFastPath
 */

import { registerHandlers, type MiniCodeActHandler, type MiniCodeActDeps } from "../minicodeact-executor.js";
import type { StickinessLevel } from "../../subagent/types.js";
import type { FastPathHandler } from "../../subagent/fast-path-handler.js";

function handler(
    fn: (args: Record<string, unknown>, chatId: string, deps: MiniCodeActDeps) => unknown,
    descFn: (args: Record<string, unknown>) => string,
): MiniCodeActHandler {
    const h = fn as MiniCodeActHandler;
    h.describe = descFn;
    return h;
}

/** 待重访的 setTimeout 句柄（供潜在清理） */
const pendingRevisits = new Map<string, ReturnType<typeof setTimeout>>();

/** StickinessLevel 顺序：索引越小级别越高 */
const STICKINESS_ORDER: StickinessLevel[] = ["CORE", "FAMILIAR", "ACQUAINTANCE", "STRANGER"];

registerHandlers("attention", {
    boost: handler(
        (args, _chatId, deps) => {
            const chatId = args.chatId as string;
            const rawAmount = args.amount as number;

            if (!chatId) {
                throw new Error("missing required arg: chatId");
            }

            // Clamp amount to 1-50
            const amount = Math.max(1, Math.min(50, rawAmount ?? 1));

            const existing = deps.attentionQueue.get(chatId);
            if (!existing) {
                // 自动入队再 boost，而不是直接失败
                deps.attentionQueue.enqueueOrUpdate({
                    chatId,
                    source: "MINICODEACT_BOOST",
                    priority: amount,
                    basePriority: amount,
                    enqueuedAt: Date.now(),
                    lastAttendedAt: null,
                    attendCount: 0,
                    blocked: false,
                    hasFastPathRequest: false,
                    newMessageCount: 0,
                    topicDigests: [],
                });
                const entry = deps.attentionQueue.get(chatId);
                return { newPriority: entry?.priority ?? amount, success: true, autoEnqueued: true };
            }

            deps.attentionQueue.boost(chatId, amount);

            // Re-fetch to get updated priority
            const updated = deps.attentionQueue.get(chatId);
            const newPriority = updated?.priority ?? amount;
            return { newPriority, success: true };
        },
        (args) => `已提升 ${args.chatId} 优先级 +${args.amount}${args.reason ? ` (${args.reason})` : ""}`,
    ),

    scheduleRevisit: handler(
        (args, _chatId, deps) => {
            const chatId = args.chatId as string;
            const delayMinutes = (args.delayMinutes as number) ?? 5;

            if (!chatId) {
                throw new Error("missing required arg: chatId");
            }

            const delayMs = delayMinutes * 60 * 1000;
            const scheduledAt = new Date(Date.now() + delayMs).toISOString();

            // Cancel any existing pending revisit for this chatId
            const existing = pendingRevisits.get(chatId);
            if (existing !== undefined) {
                clearTimeout(existing);
            }

            const timer = setTimeout(() => {
                pendingRevisits.delete(chatId);
                deps.attentionQueue.enqueueOrUpdate({
                    chatId,
                    source: "SCHEDULED_REVISIT",
                    priority: 30,
                    basePriority: 30,
                    enqueuedAt: Date.now(),
                    lastAttendedAt: null,
                    attendCount: 0,
                    blocked: false,
                    hasFastPathRequest: false,
                    newMessageCount: 0,
                    topicDigests: [],
                });
            }, delayMs);

            // Don't prevent process exit
            if (timer.unref) timer.unref();
            pendingRevisits.set(chatId, timer);

            return { scheduledAt };
        },
        (args) => `已安排 ${args.delayMinutes} 分钟后重访 ${args.chatId}${args.reason ? ` (${args.reason})` : ""}`,
    ),

    adjustStickiness: handler(
        (args, _chatId, deps) => {
            const chatId = args.chatId as string;
            const targetLevel = args.targetLevel as StickinessLevel;

            if (!chatId || !targetLevel) {
                throw new Error("missing required args: chatId, targetLevel");
            }

            if (!STICKINESS_ORDER.includes(targetLevel)) {
                throw new Error(`invalid targetLevel: ${targetLevel}`);
            }

            const entry = deps.attentionQueue.get(chatId);
            if (!entry) {
                return { success: false, currentLevel: "UNKNOWN" };
            }

            const currentLevel = (entry.stickinessLevel ?? "STRANGER") as StickinessLevel;
            const currentIdx = STICKINESS_ORDER.indexOf(currentLevel);
            const targetIdx = STICKINESS_ORDER.indexOf(targetLevel);

            // Only allow adjacent level changes (one step)
            if (Math.abs(currentIdx - targetIdx) > 1) {
                return { success: false, currentLevel };
            }

            // Already at target
            if (currentIdx === targetIdx) {
                return { success: true, currentLevel };
            }

            // Apply the change to Q3 entry
            entry.stickinessLevel = targetLevel;

            // 持久化到 SubagentManager（如果存在）
            const subagent = deps.subagentManager.get(chatId);
            if (subagent) {
                subagent.stickiness.level = targetLevel;
            }

            return { success: true, currentLevel: targetLevel };
        },
        (args) => `已将 ${args.chatId} 亲密度调整为 ${args.targetLevel}`,
    ),

    revokeFastPath: handler(
        (args, _chatId, deps) => {
            const chatId = args.chatId as string;

            if (!chatId) {
                throw new Error("missing required arg: chatId");
            }

            const subagent = deps.subagentManager.get(chatId);
            if (!subagent) {
                return { success: false };
            }

            const fastPathHandler = subagent.fastPathHandler as FastPathHandler | null;
            if (!fastPathHandler || typeof (fastPathHandler as any).revoke !== "function") {
                return { success: false };
            }

            if (!(fastPathHandler as any).isAuthorized()) {
                return { success: false };
            }

            (fastPathHandler as any).revoke();
            return { success: true };
        },
        (args) => `已撤销 ${args.chatId} 的 FastPath 授权${args.reason ? ` (${args.reason})` : ""}`,
    ),
});
