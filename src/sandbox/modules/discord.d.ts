/**
 * discord.d.ts — Discord 平台 API
 *
 * 系统注入的 Discord host proxy 接口。
 * 提供给 Agent 在 sandbox 执行时作为 TypeScript 强类型上下文参考。
 * 平台连接与消息监听由宿主侧 DiscordAdapter 管理。
 */

declare const discord: {
    // ─── 发送与交互 ───

    /**
     * 发送文本消息到指定频道。
     * @param channelId 目标频道 ID（由 sandbox 上下文自动填入当前频道）
     * @param text 消息内容
     * @param opts 可选参数
     * @example sendText(channelId, "你好！")
     * @example sendText(channelId, "回复你的问题", { replyTo: "1234567890" })
     */
    sendText(channelId: string, text: string, opts?: { replyTo?: string }): Promise<{ id: string; text: string; channelId: string; guildId?: string; timestamp: string; }>;

    /**
     * 发送媒体消息（附件）到指定频道。支持 URL 和本地文件路径（支持绝对路径或基于 cwd 工作区的相对路径）。
     * @param channelId 目标频道 ID
     * @param media 媒体对象，支持 URL 或文件内容
     * @param opts 可选参数
     * @example sendMedia(channelId, { url: "https://example.com/image.png", caption: "看看这张图" })
     * @example sendMedia(channelId, { file: "screenshot.png", caption: "本地截图" }) // 自动基于 process.cwd() 解析
     */
    sendMedia(channelId: string, media: { url?: string; file?: string; caption?: string; fileName?: string }, opts?: { replyTo?: string }): Promise<{ id: string; text: string; channelId: string; guildId?: string; timestamp: string; }>;

    // ─── 状态操作 ───

    /**
     * 在频道中显示 "正在输入..." 状态。
     * @param channelId 目标频道 ID
     */
    sendTyping(channelId: string): Promise<void>;
};
