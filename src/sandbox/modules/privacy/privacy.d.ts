/**
 * modules/privacy.d.ts — 隐私分级模块类型定义
 *
 * 全局 visibility 兜底：系统会按 chat 分级（private / shared）在代码层拦截跨会话的隐私泄露。
 * 你不需要手动检查权限——读取其它私密会话的数据会被自动过滤/遮蔽，从私密会话向外发送/派发会直接报错。
 * 本模块让你可以「主动收紧」：把某个会话标记为敏感（只进不出），以及查询某会话当前的隐私状态。
 */

interface PrivacyModule {
    /**
     * 把某个会话标记为敏感/私密（append-only：只进不出，标记后无法撤销，重启后依然生效）。
     *
     * 典型场景：群里有人表达出对「bot 把这里的对话带到别处 / 记住并外泄」的担忧时，
     * 你可以主动调用本方法把当前会话收紧为私密。之后：
     * - 在别的会话里再也无法读到本会话的消息/话题/私密 fact；
     * - 绑定在本会话时，向其它会话 sendText / dispatch 会被代码拦截。
     *
     * 注意：管理员可通过 privacy.allow_llm_mark_sensitive=false 禁用本方法；被禁用时调用会抛错。
     *
     * @param chatId 目标 composite chatId；省略则标记「当前会话」。标记是单调收紧方向，传任意 chatId 都安全。
     * @param reason 标记原因（便于日后审计），如 "群友明确表示不希望对话被带出本群"。
     *
     * @example
     * // 感知到隐私顾虑，收紧当前会话
     * await privacy.markSensitive(undefined, "群友表达了对隐私的担忧，主动收紧");
     */
    markSensitive(chatId?: string, reason?: string): Promise<{
        chatId: string;
        visibility: "private" | "shared";
        markedSensitive: boolean;
        reason?: string;
    }>;

    /**
     * 查询某会话当前的隐私状态（visibility 及其来源）。
     *
     * @param chatId 目标 composite chatId；省略则查询「当前会话」。
     *
     * @example
     * const s = await privacy.status();
     * if (s.visibility === "private") console.log("本会话内容不会外泄");
     */
    status(chatId?: string): Promise<{
        chatId: string;
        visibility: "private" | "shared";
        isDirectMessage: boolean;
        markedSensitive: boolean;
        reason?: string;
        /** private 的来源：dm（私聊自动）| config（配置种子）| marked（运行时标记）| none（shared）。 */
        source: "dm" | "config" | "marked" | "none";
    }>;
}

declare const privacy: PrivacyModule;
