import { getRawId, safeGroupModelKey } from "../../core/chat-id.js";
import { getChatVisibility, type VisibilityDeps } from "../../core/visibility-policy.js";
import type { MemoryStoreV2 } from "../../memory-v2/index.js";

type PrivacyMemoryReader = Pick<MemoryStoreV2, "getGroupModel" | "markChatSensitive">;

export interface MetaPrivacyStatus {
    chatId: string;
    visibility: "private" | "shared";
    isDirectMessage: boolean;
    markedSensitive: boolean;
    reason?: string;
    source: "dm" | "config" | "marked" | "none";
}

/**
 * Meta 侧隐私分级 API。与 subagent 的 privacy 模块同义，但 Meta 无"当前会话"，故 chatId 必填。
 * @param getDeps 每次调用时返回最新的 VisibilityDeps（读配置 + GroupModel）。
 * @param getAllowMark 每次调用时返回是否允许 LLM 自行 markSensitive（config.privacy.allowLlmMarkSensitive）。
 */
export function createPrivacyApi(
    memory: PrivacyMemoryReader,
    getDeps: () => VisibilityDeps,
    getAllowMark?: () => boolean,
) {
    return {
        markSensitive: async (chatId: string, reason?: string): Promise<{
            chatId: string;
            visibility: "private" | "shared";
            markedSensitive: boolean;
            reason?: string;
        }> => {
            if (getAllowMark && !getAllowMark()) {
                throw new Error("privacy.markSensitive 已被管理员禁用（privacy.allow_llm_mark_sensitive=false）；私密名单仅可由管理员在配置中设置。");
            }
            const target = String(chatId ?? "").trim();
            if (!target) throw new Error("privacy.markSensitive(chatId) 需要 composite chatId");
            const gm = memory.markChatSensitive(target, reason);
            return {
                chatId: target,
                visibility: getChatVisibility(target, getDeps()),
                markedSensitive: !!gm?.markedSensitive,
                reason: gm?.sensitiveReason,
            };
        },

        status: async (chatId: string): Promise<MetaPrivacyStatus> => {
            const target = String(chatId ?? "").trim();
            if (!target) throw new Error("privacy.status(chatId) 需要 composite chatId");
            const deps = getDeps();
            const key = safeGroupModelKey(target);
            const gm = memory.getGroupModel(key);
            // visibility 以 getChatVisibility 为唯一事实来源（含裸 rawId / GroupModel 兜底），
            // status 只额外推导一个人类可读的 source 标签——避免二次实现导致与守卫判定漂移。
            const visibility = getChatVisibility(target, deps);
            // 种子命中与 getChatVisibility 对齐：composite 与裸 rawId 形态都算。
            const inSeed = deps.sensitiveSeed.has(target) || deps.sensitiveSeed.has(key)
                || deps.sensitiveSeed.has(getRawId(target)) || deps.sensitiveSeed.has(getRawId(key));
            const source: MetaPrivacyStatus["source"] =
                visibility === "shared" ? "none"
                : inSeed ? "config"
                : gm?.markedSensitive ? "marked"
                : "dm";
            return {
                chatId: target,
                visibility,
                isDirectMessage: !!gm?.isDirectMessage,
                markedSensitive: !!gm?.markedSensitive,
                reason: gm?.sensitiveReason,
                source,
            };
        },
    };
}
