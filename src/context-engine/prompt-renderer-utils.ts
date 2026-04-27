/**
 * context-engine/prompt-renderer-utils.ts — 从 prompt-renderer 提取的渲染工具函数
 *
 * 这些函数是纯视图层逻辑（结构化数据 → 文本），被 providers 和旧代码共用。
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("prompt-renderer-utils");

/** 话题渲染输入（统一接口） */
export interface FormattableTopic {
    id?: string;
    state?: string;
    label: string;
    summary?: string;
    recentContext?: string;
    createdAt?: number | string;
    participants?: string[];
    messageCount?: number;
    callbackPotential?: number;
    triageReason?: string;
}

/**
 * 将时间戳格式化为相对时间描述（如 "3小时前"、"2天前"）
 */
export function formatRelativeTime(timestamp: string | number | null | undefined): string {
    if (timestamp == null) return "";
    const ms = typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime();
    if (isNaN(ms)) return "";
    const diffMs = Date.now() - ms;
    if (diffMs < 0) return "刚刚";
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    return `${days}天前`;
}

/**
 * 格式化话题列表为可读字符串（统一渲染逻辑）
 */
export function formatTopicList(topics: FormattableTopic[], emptyText = "(无活跃话题)"): string {
    if (topics.length === 0) return emptyText;

    return topics.map(t => {
        const time = t.createdAt ? `(${formatRelativeTime(t.createdAt)})` : "";
        const id = t.id ? ` {${t.id}}` : "";
        const people = t.participants?.length ? ` [${t.participants.join(", ")}]` : "";
        const detail = t.summary
            ? ` — ${t.summary}`
            : (t.recentContext
                ? `: ${t.recentContext.split("\n").slice(-2).join("; ")}`
                : "");
        const reason = t.triageReason ? ` │ ✅ 建议介入，原因及方向: ${t.triageReason}` : "";
        return `${time} ${t.label}${people}${detail}${reason}${id}`.trim();
    }).join("\n");
}

/**
 * 根据 isDirectMessage 推断聊天类型（平台无关）
 */
export function deriveChatType(isDirectMessage?: boolean): string {
    if (isDirectMessage === true) return "私聊";
    return "群聊";
}
