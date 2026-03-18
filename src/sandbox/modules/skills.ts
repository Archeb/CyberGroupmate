/**
 * modules/skills.ts — Skills 模块
 *
 * 高层代码型 skills 能力：
 * - skills.memory: recallAndSummarize, browseForAnswer
 * - skills.social: replyInTelegram（依赖 Telegram 代理）
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";
import { createTelegramClientProxy } from "./telegram.js";

export function installSkills(env: CapabilityRegistryEnv, sentHistory: Map<string, Set<string>>) {
    const tg = createTelegramClientProxy(env, sentHistory);
    return {
        memory: {
            recallAndSummarize: async (query: string, options?: Record<string, unknown>) =>
                env.callHost("memory.recall", [query, options]),
            browseForAnswer: async (request: Record<string, unknown>) =>
                env.callHost("memory.browseHistory", [request]),
        },
        social: {
            replyInTelegram: async (
                chatId: number | string,
                text: string,
                opts?: { replyTo?: number }
            ) => {
                // tg.sendText 内部已经发射 system.agent_message_sent 通知 + 去重检查
                const sent = await tg.sendText(chatId, text, opts);
                return sent;
            },
        },
    };
}
