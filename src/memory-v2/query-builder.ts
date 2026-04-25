/**
 * memory-v2/query-builder.ts — 类型安全 SQL 查询构建器
 *
 * 避免动态 SQL 字符串拼接，通过编译期类型 + 运行期白名单双校验
 * 确保所有列名合法，所有值通过参数化绑定。
 *
 * 与 better-sqlite3 同步 API 兼容。
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("query-builder");

// ─── Schema 列名白名单 ───

/**
 * 每张表允许在 UPDATE/WHERE 中使用的列名（不含 PRIMARY KEY 的 id）
 *
 * 这里 as const 保证编译期类型安全：
 * - SafeUpdateBuilder.set() 只接受白名单中的列名
 * - 运行期 validateColumn() 再做一次校验
 */
export const COLUMN_WHITELIST = {
    topics: [
        "pipeline_topic_id", "chat_id", "label", "summary", "key_points",
        "participants", "keywords", "message_ids",
        "message_count", "started_at", "ended_at", "sentiment",
        "related_topic_ids", "associated_memories", "callback_potential",
        "embedding", "created_at", "updated_at",
    ],
    core_facts: [
        "subject", "content", "category", "confidence", "source",
        "embedding", "created_at", "updated_at", "expires_at",
    ],
    person_identities: [
        "display_name", "username", "aliases", "total_message_count",
        "last_seen_at", "first_seen_at", "updated_at",
    ],
    person_group_profiles: [
        "dunbar_tier", "dunbar_reason", "affinity_score", "traits", "interests",
        "communication_style", "relation_to_agent", "recent_episodes",
        "merged_memory", "message_count", "last_seen_at", "active_hours",
        "first_seen_at", "updated_at",
    ],
    group_models: [
        "chat_title", "description", "dominant_language",
        "communication_norms", "active_members", "avg_messages_per_day",
        "peak_hours", "agent_role", "engagement_level", "recent_feedback",
        "hot_topics", "taboo_topics", "last_reflected_at", "is_direct_message", "updated_at",
    ],
    interactions: [
        "chat_id", "user_id", "topic_id", "type", "summary",
        "sentiment", "significance", "created_at",
    ],
    message_log: [
        "message_id", "chat_id", "user_id", "display_name",
        "text", "reply_to_message_id", "timestamp", "media_type", "media_info",
    ],
} as const;

export type TableName = keyof typeof COLUMN_WHITELIST;
export type ColumnOf<T extends TableName> = (typeof COLUMN_WHITELIST)[T][number];

/** 运行期列名校验 */
function validateColumn(table: TableName, column: string): void {
    const allowed = COLUMN_WHITELIST[table] as readonly string[];
    if (!allowed.includes(column)) {
        const msg = `非法列名 "${column}" (表 "${table}")。允许的列: ${allowed.join(", ")}`;
        log.warn("列名校验失败", { table, column });
        throw new Error(msg);
    }
}

// ─── SafeUpdateBuilder ───

/**
 * 类型安全的 UPDATE 语句构建器
 *
 * @example
 * ```ts
 * const { sql, params } = new SafeUpdateBuilder("topics")
 *   .set("label", "新标签")
 *   .set("summary", "新摘要")
 *   .where("id", topicId)
 *   .build();
 * // sql = "UPDATE topics SET label = ?, summary = ? WHERE id = ?"
 * // params = ["新标签", "新摘要", topicId]
 * ```
 */
export class SafeUpdateBuilder<T extends TableName> {
    private table: T;
    private sets: Array<{ column: string; value: unknown }> = [];
    private wheres: Array<{ column: string; value: unknown }> = [];

    constructor(table: T) {
        this.table = table;
    }

    /** 添加 SET 子句（列名经编译期 + 运行期双校验） */
    set(column: ColumnOf<T>, value: unknown): this {
        validateColumn(this.table, column as string);
        this.sets.push({ column: column as string, value });
        return this;
    }

    /** 添加 WHERE 子句 */
    where(column: string, value: unknown): this {
        // WHERE 允许 primary key 列（如 "id", "user_id"）不在白名单中
        this.wheres.push({ column, value });
        return this;
    }

    /** 是否有 SET 子句 */
    get hasSets(): boolean {
        return this.sets.length > 0;
    }

    /** 构建 SQL + 参数数组 */
    build(): { sql: string; params: unknown[] } {
        if (this.sets.length === 0) {
            throw new Error(`SafeUpdateBuilder: 无 SET 子句 (表 "${this.table}")`);
        }
        if (this.wheres.length === 0) {
            throw new Error(`SafeUpdateBuilder: 无 WHERE 子句 (表 "${this.table}")，不允许无条件更新`);
        }

        const setClauses = this.sets.map(s => `${s.column} = ?`).join(", ");
        const whereClauses = this.wheres.map(w => `${w.column} = ?`).join(" AND ");
        const sql = `UPDATE ${this.table} SET ${setClauses} WHERE ${whereClauses}`;
        const params = [
            ...this.sets.map(s => s.value),
            ...this.wheres.map(w => w.value),
        ];

        return { sql, params };
    }
}

// ─── SafeSelectBuilder ───

/**
 * 类型安全的 SELECT WHERE 条件构建器
 *
 * @example
 * ```ts
 * const { sql, params } = new SafeSelectBuilder("core_facts")
 *   .from("SELECT * FROM core_facts")
 *   .where("embedding IS NOT NULL")
 *   .whereEq("chat_id", chatId)
 *   .whereIn("category", ["preference", "biographical"])
 *   .build();
 * ```
 */
export class SafeSelectBuilder<T extends TableName> {
    private table: T;
    private baseSQL: string = "";
    private conditions: Array<{ clause: string; params: unknown[] }> = [];

    constructor(table: T) {
        this.table = table;
    }

    /** 设置基础 SELECT 语句 */
    from(baseSql: string): this {
        this.baseSQL = baseSql;
        return this;
    }

    /** 添加原始 WHERE 条件（无参数化，用于 IS NOT NULL 等固定条件） */
    where(rawCondition: string): this {
        this.conditions.push({ clause: rawCondition, params: [] });
        return this;
    }

    /** 添加 column = ? 条件（列名校验 + 参数化） */
    whereEq(column: ColumnOf<T> | "id" | "user_id" | "chat_id", value: unknown): this {
        // 允许 PK 列不经过白名单校验
        const col = column as string;
        if (col !== "id" && col !== "user_id" && col !== "chat_id") {
            validateColumn(this.table, col);
        }
        this.conditions.push({ clause: `${col} = ?`, params: [value] });
        return this;
    }

    /** 添加 column IN (?, ?, ...) 条件（列名校验 + 参数化） */
    whereIn(column: ColumnOf<T>, values: unknown[]): this {
        validateColumn(this.table, column as string);
        if (values.length === 0) return this;
        const placeholders = values.map(() => "?").join(", ");
        this.conditions.push({
            clause: `${column as string} IN (${placeholders})`,
            params: values,
        });
        return this;
    }

    /** 构建最终 SQL + 参数 */
    build(): { sql: string; params: unknown[] } {
        let sql = this.baseSQL;
        const allParams: unknown[] = [];

        if (this.conditions.length > 0) {
            const hasWhere = sql.toUpperCase().includes("WHERE");
            for (let i = 0; i < this.conditions.length; i++) {
                const cond = this.conditions[i];
                if (i === 0 && !hasWhere) {
                    sql += ` WHERE ${cond.clause}`;
                } else {
                    sql += ` AND ${cond.clause}`;
                }
                allParams.push(...cond.params);
            }
        }

        return { sql, params: allParams };
    }
}
