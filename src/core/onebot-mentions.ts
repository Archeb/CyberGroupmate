import type { MessageMention } from "./message-provenance.js";

type Segment = { type: string; data?: Record<string, unknown> };

/** Outbound targets must be account IDs, never display names or group IDs. */
export function validateOneBotMentionTarget(target: string): void {
    if (target !== "all" && !/^[1-9]\d*$/.test(target)) {
        throw new Error("QQ @ 目标必须是已核实的 QQ 号，不能使用昵称。先查询原消息发送者 userId 或群成员，再调用 onebot.sendAt(chatId, userId, text)。");
    }
}

/** Inspect the actual prepared payload, respecting native auto_escape. */
export function outgoingOneBotMentions(message: unknown, autoEscape = false): MessageMention[] {
    const targets = Array.isArray(message)
        ? (message as Segment[]).filter(segment => segment.type === "at").map(segment => String(segment.data?.qq ?? ""))
        : typeof message === "string" && !autoEscape
            ? [...message.matchAll(/\[CQ:at((?:,[^\]]*)?)\]/g)].map(match => /(?:^|,)qq=([^,]*)/.exec(match[1])?.[1] ?? "")
            : [];
    return [...new Set(targets)].map(target => {
        validateOneBotMentionTarget(target);
        return { userId: `onebot:${target}`, ...(target === "all" ? { isAll: true } : {}) };
    });
}

/** Surface likely accidental plain-text @ before sending; do not guess an account. */
export function assertNoAccidentalTextMention(message: unknown, hasStructuredMention: boolean): void {
    if (typeof message !== "string" || hasStructuredMention) return;
    if (/^\s*[@＠]\S+/.test(message) || /(?:^|\s)[@＠]\S+\s+[/!！#]\S+/.test(message)) {
        throw new Error("这条消息只有文字 @，不会触发 QQ 提及或 bot 指令。请用 onebot.sendAt(chatId, 已核实的QQ号, 指令正文)，或 sendText 的 mentions 选项。若确实只想展示文字 @，请显式使用 sendMessage(chatId, [{type:'text',data:{text:正文}}])。");
    }
}
