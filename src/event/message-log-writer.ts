/**
 * message-log-writer.ts — 消息实时落盘
 *
 * 在 NC push() 时同步将 telegram.message 事件写入 MemoryV2 的 message_log 表，
 * 使得主 Agent 可以按 snapshotTimestamp 读取时间一致的消息视图。
 *
 * 设计要点：
 * - 幂等写入：使用 INSERT OR IGNORE（message_log PK = chat_id + message_id）
 * - 只处理 telegram.message 类型事件，其他事件类型直接跳过
 * - 线程安全：SQLite WAL 模式下单进程串行写入
 */

import type { NotificationEvent } from "./notification-center.js";
import type { IMemoryStoreV2, MessageLogEntry } from "../memory-v2/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("message-log-writer");

/** 配置选项 */
export interface MessageLogWriterConfig {
    /** 要处理的事件类型前缀列表。默认 ["telegram.message"] */
    eventTypes?: string[];
}

const DEFAULT_CONFIG: Required<MessageLogWriterConfig> = {
    eventTypes: ["telegram.message"],
};

/**
 * MessageLogWriter — 将 NC 事件实时写入 message_log 表
 *
 * 使用方式：
 * ```ts
 * const writer = new MessageLogWriter(memoryStore);
 * nc.onPush(event => writer.write(event));
 * ```
 */
export class MessageLogWriter {
    private memoryStore: IMemoryStoreV2;
    private config: Required<MessageLogWriterConfig>;
    private writtenCount = 0;

    constructor(memoryStore: IMemoryStoreV2, config?: MessageLogWriterConfig) {
        this.memoryStore = memoryStore;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 将单个 NC 事件写入 message_log。
     * 只处理匹配 eventTypes 的事件，其他类型静默跳过。
     * 
     * @returns true 如果写入成功，false 如果跳过
     */
    write(event: NotificationEvent): boolean {
        // 检查事件类型是否匹配
        if (!this.shouldProcess(event)) {
            return false;
        }

        // 提取消息字段
        const entry = this.extractMessageLogEntry(event);
        if (!entry) {
            log.warn("write: 无法从事件中提取消息字段", { eventId: event._id, type: event.type });
            return false;
        }

        // 幂等写入（storeMessageBatch 内部使用 INSERT OR IGNORE）
        try {
            this.memoryStore.storeMessageBatch([entry]);
            this.writtenCount++;
            log.debug("write: 成功", { messageId: entry.messageId, chatId: entry.chatId });
            return true;
        } catch (err) {
            log.error("write: 写入失败", { messageId: entry.messageId, error: String(err) });
            return false;
        }
    }

    /**
     * 批量写入多个事件。用于初始化时补写。
     * @returns 成功写入的数量
     */
    writeBatch(events: NotificationEvent[]): number {
        const entries: MessageLogEntry[] = [];
        for (const event of events) {
            if (!this.shouldProcess(event)) continue;
            const entry = this.extractMessageLogEntry(event);
            if (entry) entries.push(entry);
        }

        if (entries.length === 0) return 0;

        try {
            this.memoryStore.storeMessageBatch(entries);
            this.writtenCount += entries.length;
            log.debug("writeBatch: 成功", { count: entries.length });
            return entries.length;
        } catch (err) {
            log.error("writeBatch: 写入失败", { count: entries.length, error: String(err) });
            return 0;
        }
    }

    /** 获取已成功写入的消息计数 */
    getWrittenCount(): number {
        return this.writtenCount;
    }

    /** 重置写入计数器 */
    resetWrittenCount(): void {
        this.writtenCount = 0;
    }

    // ─── 内部方法 ───

    private shouldProcess(event: NotificationEvent): boolean {
        return this.config.eventTypes.some(prefix => event.type.startsWith(prefix));
    }

    /**
     * 从 NC 事件中提取 MessageLogEntry。
     * 
     * NC 事件中 telegram.message 的典型字段：
     * - chatId / chat_id: 群组 ID
     * - userId / user_id / senderId / sender_id: 发送者 ID
     * - displayName / display_name / senderName / sender_name: 显示名称
     * - text / message: 消息文本
     * - messageId / message_id: 消息 ID
     * - replyToMessageId / reply_to_message_id: 回复消息 ID
     * - timestamp / _ts: 时间戳
     */
    private extractMessageLogEntry(event: NotificationEvent): MessageLogEntry | null {
        const chatId = String(event.chatId ?? event.chat_id ?? "");
        const userId = String(event.userId ?? event.user_id ?? event.senderId ?? event.sender_id ?? "");
        const messageId = String(event.messageId ?? event.message_id ?? "");
        const text = String(event.text ?? event.message ?? "");
        const displayName = String(event.displayName ?? event.display_name ?? event.senderName ?? event.sender_name ?? "");
        const replyToMessageId = event.replyToMessageId ?? event.reply_to_message_id;
        const timestamp = String(event.timestamp ?? event._ts ?? new Date().toISOString());

        // 必要字段校验
        if (!chatId || !messageId) {
            return null;
        }

        return {
            messageId,
            chatId,
            userId,
            displayName,
            text,
            replyToMessageId: replyToMessageId ? String(replyToMessageId) : undefined,
            timestamp,
        };
    }
}
