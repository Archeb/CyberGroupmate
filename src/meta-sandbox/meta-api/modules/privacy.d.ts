/**
 * privacy — Meta 隐私分级 API。
 *
 * 全局 visibility 兜底在代码层按 chat 分级（private / shared）防止跨会话隐私泄露：
 * 私密会话（私聊 / 配置或运行时标记的敏感群）的消息正文与私密 fact 不会出现在 Meta 的检索结果里。
 * 本模块让你可以主动把某个会话标记为敏感（只进不出，不可撤销），以及查询某会话的隐私状态。
 * 注意：Meta 没有"当前会话"概念，chatId 必填。
 */

interface PrivacyMarkResult {
    chatId: string;
    visibility: "private" | "shared";
    markedSensitive: boolean;
    reason?: string;
}

interface PrivacyStatusResult {
    chatId: string;
    visibility: "private" | "shared";
    isDirectMessage: boolean;
    markedSensitive: boolean;
    reason?: string;
    /** private 的来源：dm（私聊自动）| config（配置种子）| marked（运行时标记）| none（shared）。 */
    source: "dm" | "config" | "marked" | "none";
}

interface PrivacyApi {
    /**
     * 把某个会话标记为敏感/私密（append-only：只进不出，标记后不可撤销，重启后依然生效）。
     * @param chatId 目标 composite chatId（必填）。
     * @param reason 标记原因（便于审计）。
     */
    markSensitive(chatId: string, reason?: string): Promise<PrivacyMarkResult>;

    /**
     * 查询某会话当前的隐私状态。
     * @param chatId 目标 composite chatId（必填）。
     */
    status(chatId: string): Promise<PrivacyStatusResult>;
}

declare const privacy: PrivacyApi;
