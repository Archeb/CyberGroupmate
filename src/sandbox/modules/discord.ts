/**
 * modules/discord.ts — Discord 客户端代理模块
 *
 * 包含 DiscordClient proxy 的完整实现：
 * - 重复消息拦截（per-session 去重）
 * - ACK 格式化 & agent_message_sent 事件发射
 * - 所有 discord.* 方法的 callHost 转发
 */

import type { CapabilityRegistryEnv } from "../capability-registry.js";

// ─── 工具函数 ───

export function formatDiscordAck(prefix: string, payload: unknown): string {
    if (!payload || typeof payload !== "object") return prefix;
    const raw = payload as Record<string, unknown>;
    const channelId = raw.channelId;
    const msgId = raw.id;
    const text = typeof raw.text === "string" ? raw.text : undefined;
    const parts = [prefix];
    if (channelId !== undefined) parts.push(`channel=${String(channelId)}`);
    if (msgId !== undefined) parts.push(`msg=${String(msgId)}`);
    if (text) parts.push(`text=${text}`);
    return parts.join(" ");
}

// ─── Discord 客户端代理 ───

export function createDiscordClientProxy(env: CapabilityRegistryEnv, sentHistory: Map<string, Set<string>>) {
    /**
     * 检查消息是否是重复发送。
     * 如果是新消息则记录并返回 false；如果已发送过则返回 true。
     */
    function isDuplicate(channelId: string, text: string): boolean {
        const key = String(channelId);
        const existing = sentHistory.get(key);
        if (existing && existing.has(text)) {
            return true;
        }
        if (!existing) {
            sentHistory.set(key, new Set([text]));
        } else {
            existing.add(text);
        }
        return false;
    }

    return {
        sendText: async (channelId: string, text: string, opts?: { replyTo?: string }) => {
            // ── 重复消息拦截 ──
            if (isDuplicate(channelId, text)) {
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 channel=${channelId} 的消息 "${text.length > 80 ? text.slice(0, 80) + '...' : text}" 与本次 session 中已发送的消息内容完全一致，已自动拦截，不会重复发送。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "discord",
                    chatId: channelId,
                    text,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            const sent = await env.callHost("discord.sendText", [channelId, text, opts]);
            env.emitOutput(formatDiscordAck("[Discord] sendText ok", sent));
            // 发射 agent_message_sent 通知，供 SentMessageCollector 捕获
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "discord",
                chatId: channelId,
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text,
                replyToMessageId: opts?.replyTo,
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendMedia: async (channelId: string, media: unknown, opts?: { replyTo?: string; caption?: string }) => {
            // ── 重复消息拦截（基于 caption + 媒体标识）──
            let mediaIdentifier = "[media]";
            if (media && typeof media === "object") {
                const m = media as Record<string, unknown>;
                if (typeof m.file === "string") mediaIdentifier = `[media:file=${m.file}]`;
                else if (typeof m.url === "string") mediaIdentifier = `[media:url=${m.url}]`;
                else if (typeof m.type === "string") mediaIdentifier = `[media:type=${m.type}]`;
            }
            const mediaText = opts?.caption ? `${opts.caption}|${mediaIdentifier}` : mediaIdentifier;
            if (isDuplicate(channelId, mediaText)) {
                const preview = mediaText.length > 80 ? mediaText.slice(0, 80) + '...' : mediaText;
                const warning = `[⚠ 运行时警告: 重复消息已拦截] 目标 channel=${channelId} 的媒体消息 "${preview}" 与本次 session 中已发送的消息内容完全一致，已自动拦截，不会重复发送。`;
                env.emitOutput(warning);
                env.notifyHost({
                    type: "system.duplicate_message_blocked",
                    scene: "discord",
                    chatId: channelId,
                    text: mediaText,
                    timestamp: new Date().toISOString(),
                });
                return null;
            }
            const sent = await env.callHost("discord.sendMedia", [channelId, media, opts]);
            env.emitOutput(formatDiscordAck("[Discord] sendMedia ok", sent));
            env.notifyHost({
                type: "system.agent_message_sent",
                scene: "discord",
                chatId: channelId,
                messageId: typeof sent === "object" && sent && "id" in sent ? (sent as { id?: unknown }).id : undefined,
                text: opts?.caption ?? "[media]",
                timestamp: new Date().toISOString(),
            });
            return sent;
        },
        sendTyping: async (channelId: string) => {
            await env.callHost("discord.sendTyping", [channelId]);
            env.emitOutput(`[Discord] sendTyping ok channel=${channelId}`);
        },
    };
}
