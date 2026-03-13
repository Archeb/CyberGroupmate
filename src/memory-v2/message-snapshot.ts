/**
 * message-snapshot.ts — 时间一致的消息快照
 *
 * 主 Agent 在处理某个群组的 notification 时，需要读取截至
 * snapshotTimestamp 的最新消息视图（不包含处理过程中新到达的消息）。
 *
 * 依赖 S1.1 的实时落盘：消息在 NC push 时已同步写入 message_log。
 */

import type Database from "better-sqlite3";
import { createLogger } from "../core/logger.js";

const log = createLogger("message-snapshot");

/** 快照中的单条消息 */
export interface SnapshotMessage {
    messageId: string;
    chatId: string;
    userId: string;
    displayName: string;
    text: string;
    replyToMessageId: string | null;
    timestamp: string;
}

/** 消息快照结果 */
export interface MessageSnapshot {
    /** 所属群组 */
    chatId: string;
    /** 快照截止时间（不含此时间之后的消息） */
    snapshotTimestamp: string;
    /** 上次处理该群的时间（起始点） */
    lastAttendedAt: string | null;
    /** 新消息列表（lastAttendedAt < timestamp <= snapshotTimestamp） */
    messages: SnapshotMessage[];
    /** 新消息数量 */
    newMessageCount: number;
    /** 总消息数（该群截至 snapshotTimestamp 的所有消息） */
    totalMessageCount: number;
}

/** MessageSnapshot 构建器配置 */
export interface MessageSnapshotConfig {
    /** 无 lastAttendedAt 时的默认回溯时间（小时），默认 24 */
    defaultLookbackHours?: number;
    /** 单次快照最大消息数，默认 200 */
    maxMessages?: number;
}

const DEFAULT_CONFIG: Required<MessageSnapshotConfig> = {
    defaultLookbackHours: 24,
    maxMessages: 200,
};

/**
 * 构建时间一致的消息快照
 *
 * @param db - better-sqlite3 数据库实例（来自 MemoryStoreV2.db）
 * @param chatId - 目标群组 ID
 * @param snapshotTimestamp - 快照截止时间 (ISO 8601)
 * @param lastAttendedAt - 上次处理该群的时间 (ISO 8601，null 时使用 defaultLookbackHours)
 * @param config - 可选配置
 */
export function buildMessageSnapshot(
    db: Database.Database,
    chatId: string,
    snapshotTimestamp: string,
    lastAttendedAt: string | null,
    config?: MessageSnapshotConfig,
): MessageSnapshot {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // 计算起始时间
    const startTime = lastAttendedAt ?? new Date(
        new Date(snapshotTimestamp).getTime() - cfg.defaultLookbackHours * 3600 * 1000
    ).toISOString();

    // 查询新消息
    const messages = db.prepare(`
        SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp
        FROM message_log
        WHERE chat_id = ?
          AND timestamp > ?
          AND timestamp <= ?
        ORDER BY timestamp ASC
        LIMIT ?
    `).all(chatId, startTime, snapshotTimestamp, cfg.maxMessages) as Array<{
        message_id: string;
        chat_id: string;
        user_id: string;
        display_name: string;
        text: string;
        reply_to_message_id: string | null;
        timestamp: string;
    }>;

    // 查询总消息数
    const totalRow = db.prepare(`
        SELECT COUNT(*) as cnt
        FROM message_log
        WHERE chat_id = ?
          AND timestamp <= ?
    `).get(chatId, snapshotTimestamp) as { cnt: number };

    const snapshotMessages: SnapshotMessage[] = messages.map(row => ({
        messageId: row.message_id,
        chatId: row.chat_id,
        userId: row.user_id,
        displayName: row.display_name,
        text: row.text,
        replyToMessageId: row.reply_to_message_id,
        timestamp: row.timestamp,
    }));

    log.debug("buildMessageSnapshot", {
        chatId,
        snapshotTimestamp,
        lastAttendedAt,
        newMessages: snapshotMessages.length,
        totalMessages: totalRow.cnt,
    });

    return {
        chatId,
        snapshotTimestamp,
        lastAttendedAt,
        messages: snapshotMessages,
        newMessageCount: snapshotMessages.length,
        totalMessageCount: totalRow.cnt,
    };
}

/**
 * 获取指定群组截至某时间点的最近 N 条消息
 * 用于构建上下文窗口
 */
export function getRecentMessagesUntil(
    db: Database.Database,
    chatId: string,
    until: string,
    limit: number = 50,
): SnapshotMessage[] {
    const rows = db.prepare(`
        SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp
        FROM message_log
        WHERE chat_id = ?
          AND timestamp <= ?
        ORDER BY timestamp DESC
        LIMIT ?
    `).all(chatId, until, limit) as Array<{
        message_id: string;
        chat_id: string;
        user_id: string;
        display_name: string;
        text: string;
        reply_to_message_id: string | null;
        timestamp: string;
    }>;

    // 反转为时间正序
    return rows.reverse().map(row => ({
        messageId: row.message_id,
        chatId: row.chat_id,
        userId: row.user_id,
        displayName: row.display_name,
        text: row.text,
        replyToMessageId: row.reply_to_message_id,
        timestamp: row.timestamp,
    }));
}
