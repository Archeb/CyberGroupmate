/**
 * memory-v2/memory-v2.ts — Memory V2 真实 SQLite 实现
 *
 * 基于 better-sqlite3 的 MemoryStoreV2 实现。
 * 参考设计文档 memory.md v3.0。
 *
 * 在整体架构中的位置：
 * - 被 main.ts、compaction.ts、cli.ts 导入使用
 * - Recording Pipeline Step 4 调用写入方法（upsertTopic, storeMessageBatch）
 * - 在 sandbox-worker.ts 中以精简版注入到 Agent 运行环境
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../core/logger.js";
import { createRequire } from "node:module";
import type { LLMConfig, ReflectionExternalConfig, EmbeddingConfig } from "../core/config.js";
import {
    cosineSimilarity,
    bufferToEmbedding,
    embeddingToBuffer,
    embed,
    getSimilarityFn,
} from "./embedding.js";
import { callLLM, type ChatMessage, type LLMConfig as LlmCallConfig } from "../core/llm.js";
import { SafeUpdateBuilder, SafeSelectBuilder } from "./query-builder.js";
import type {
    IMemoryStoreV2,
    TopicNode,
    PersonIdentity,
    PersonGroupProfile,
    InteractionEpisode,
    MergedMemory,
    GroupModel,
    CoreFact,
    FactCategory,
    MessageLogEntry,
    RecentMessageEntry,
    RecallOptions,
    RecallResult,
    HistoryBrowseRequest,
    HistoryBrowseResult,
    ReflectionResult,
} from "./types.js";

const log = createLogger("memory-v2");

// ─── JSON 工具函数 ───

function toJSON(value: unknown): string {
    return JSON.stringify(value ?? []);
}

function fromJSON<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function now(): string {
    return new Date().toISOString();
}

// ─── System Prompt 加载（外部模版 + 内联 fallback）───

const PROMPTS_DIR = join(process.cwd(), "system-prompts");

let _recallDeepSummaryPrompt: string | null = null;
function getRecallDeepSummaryPrompt(): string {
    if (!_recallDeepSummaryPrompt) {
        try {
            _recallDeepSummaryPrompt = readFileSync(
                join(PROMPTS_DIR, "recall-deep-summary.md"), "utf-8",
            ).trim();
        } catch {
            _recallDeepSummaryPrompt = "你是一组群聊记忆系统中的深度总结助手。请根据以下记忆片段（话题摘要和事实），针对用户查询生成简洁的中文总结（2-3 句话）。只输出总结，不要其他内容。";
            log.warn("recall-deep-summary.md 未找到，使用内联 fallback");
        }
    }
    return _recallDeepSummaryPrompt;
}

let _browseIntentParsePrompt: string | null = null;
function getBrowseIntentParsePrompt(): string {
    if (!_browseIntentParsePrompt) {
        try {
            _browseIntentParsePrompt = readFileSync(
                join(PROMPTS_DIR, "browse-intent-parse.md"), "utf-8",
            ).trim();
        } catch {
            _browseIntentParsePrompt = `你是一个意图解析助手。请分析用户的搜索意图，提取关键词和时间范围。
输出严格 JSON 格式：{"keywords": ["关键词1", "关键词2"], "daysBack": 数字或null, "userId": "用户ID或null"}
- keywords：搜索关键词（中文分词后的重要词汇，至少1个）
- daysBack：如果用户提到了时间范围（如"上周"=7，"昨天"=1，"上个月"=30），否则 null
- userId：如果用户提到了具体的人名或ID，否则 null
只输出 JSON。`;
            log.warn("browse-intent-parse.md 未找到，使用内联 fallback");
        }
    }
    return _browseIntentParsePrompt;
}

let _browseDeepReadPrompt: string | null = null;
function getBrowseDeepReadPrompt(): string {
    if (!_browseDeepReadPrompt) {
        try {
            _browseDeepReadPrompt = readFileSync(
                join(PROMPTS_DIR, "browse-deep-read.md"), "utf-8",
            ).trim();
        } catch {
            _browseDeepReadPrompt = "你是一个消息历史阅读助手。请根据以下对话记录，回答用户的问题。用中文简洁回答（2-4 句话）。只输出回答，不要其他内容。";
            log.warn("browse-deep-read.md 未找到，使用内联 fallback");
        }
    }
    return _browseDeepReadPrompt;
}

// ─── MemoryStoreV2 实现 ───

/**
 * MemoryStoreV2 — SQLite 实现
 *
 * 使用 better-sqlite3 同步 API。所有 JSON 数组字段以 TEXT 存储。
 * FTS5 虚拟表用于中文全文搜索（Phase M1 基础版）。
 *
 * @example
 * ```ts
 * const mem = new MemoryStoreV2("workspace/memory.db");
 * mem.upsertTopic("t_001", { label: "京都旅行", summary: "讨论京都岚山" });
 * const result = await mem.recall("京都");
 * ```
 */
export class MemoryStoreV2 implements IMemoryStoreV2 {
    private db: Database.Database;
    private embeddingConfig?: EmbeddingConfig;
    private cheapLlmConfig?: LlmCallConfig;
    /** sqlite-vec 扩展是否可用 */
    public sqliteVecAvailable = false;

    constructor(dbPath: string, options?: {
        embeddingConfig?: EmbeddingConfig;
        cheapLlmConfig?: LlmCallConfig;
    }) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.embeddingConfig = options?.embeddingConfig;
        this.cheapLlmConfig = options?.cheapLlmConfig;
        this.initTables();
        this.sqliteVecAvailable = this.tryLoadSqliteVec();
        if (this.sqliteVecAvailable) {
            this.initVecTables();
        }
        log.info("Memory V2 SQLite 初始化完成", {
            dbPath,
            hasEmbedding: !!this.embeddingConfig,
            hasCheapLlm: !!this.cheapLlmConfig,
            sqliteVec: this.sqliteVecAvailable,
        });
    }

    /** 获取当前 embedding 配置（供 reflection 等外部模块使用） */
    getEmbeddingConfig(): EmbeddingConfig | undefined {
        return this.embeddingConfig;
    }

    /**
     * 动态加载 sqlite-vec 扩展
     * 如果不可用（未安装 / 编译失败），透明 fallback 到纯 JS。
     */
    private tryLoadSqliteVec(): boolean {
        try {
            const esmRequire = createRequire(import.meta.url);
            const sqliteVec = esmRequire("sqlite-vec");
            sqliteVec.load(this.db);
            const version = this.db.prepare("SELECT vec_version()").pluck().get() as string;
            log.info("sqlite-vec 加载成功", { version });
            return true;
        } catch (err) {
            log.warn("sqlite-vec 不可用，使用纯 JS 向量搜索 fallback", { error: String(err) });
            return false;
        }
    }

    /**
     * 创建 vec0 虚拟表（仅在 sqlite-vec 可用时调用）
     * 如果表已存在但维度不匹配，会 DROP + 重建。
     */
    private initVecTables(): void {
        const dims = this.embeddingConfig?.dimensions ?? 128;
        log.debug("initVecTables", { dims, provider: this.embeddingConfig?.provider ?? "local" });
        try {
            // 检测已有 topics_vec 的维度是否匹配
            let needRecreate = false;
            try {
                // 尝试插入一个零向量来检查维度
                const testVec = Buffer.alloc(dims * 4); // float32 = 4 bytes each
                this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS topics_vec USING vec0(
                    topic_id TEXT PRIMARY KEY, chat_id TEXT partition key, embedding float[${dims}]
                )`);
                // 如果上面成功了（表不存在或维度匹配），直接继续
            } catch {
                // 如果失败（维度不匹配），需要重建
                needRecreate = true;
            }

            if (needRecreate) {
                log.info("vec0 表维度不匹配，重建中...", { targetDims: dims });
                this.db.exec(`DROP TABLE IF EXISTS topics_vec`);
                this.db.exec(`DROP TABLE IF EXISTS facts_vec`);
                this.db.exec(`
                    CREATE VIRTUAL TABLE topics_vec USING vec0(
                        topic_id TEXT PRIMARY KEY,
                        chat_id TEXT partition key,
                        embedding float[${dims}]
                    );
                `);
            }

            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS facts_vec USING vec0(
                    fact_id TEXT PRIMARY KEY,
                    embedding float[${dims}]
                );
            `);
            log.debug("vec0 虚拟表就绪", { dims });
        } catch (err) {
            log.warn("vec0 虚拟表创建失败", { error: String(err) });
            this.sqliteVecAvailable = false;
        }
    }

    // ─── 建表 ───

    private initTables(): void {
        this.db.exec(`
            -- 话题节点
            CREATE TABLE IF NOT EXISTS topics (
                id TEXT PRIMARY KEY,
                pipeline_topic_id TEXT,
                chat_id TEXT NOT NULL,
                label TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                key_points TEXT NOT NULL DEFAULT '[]',
                participants TEXT NOT NULL DEFAULT '[]',
                keywords TEXT NOT NULL DEFAULT '[]',
                message_ids TEXT NOT NULL DEFAULT '[]',
                message_count INTEGER DEFAULT 0,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                sentiment TEXT DEFAULT 'neutral',
                related_topic_ids TEXT DEFAULT '[]',
                was_engaged BOOLEAN DEFAULT 0,
                intervention_count INTEGER DEFAULT 0,
                embedding BLOB,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_topics_chat_date ON topics(chat_id, started_at);
            CREATE INDEX IF NOT EXISTS idx_topics_pipeline_id ON topics(pipeline_topic_id);

            -- 个体身份（全局，跨群）
            CREATE TABLE IF NOT EXISTS person_identities (
                user_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                aliases TEXT NOT NULL DEFAULT '[]',
                total_message_count INTEGER DEFAULT 0,
                last_seen_at TEXT,
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            -- 个体群内画像（每群独立）
            CREATE TABLE IF NOT EXISTS person_group_profiles (
                user_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                dunbar_tier INTEGER NOT NULL DEFAULT 4,
                dunbar_reason TEXT DEFAULT '',
                traits TEXT NOT NULL DEFAULT '[]',
                interests TEXT NOT NULL DEFAULT '[]',
                communication_style TEXT DEFAULT '',
                relation_to_agent TEXT DEFAULT '',
                recent_episodes TEXT DEFAULT '[]',
                merged_memory TEXT DEFAULT '[]',
                message_count INTEGER DEFAULT 0,
                last_seen_at TEXT,
                active_hours TEXT DEFAULT '[]',
                first_seen_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, chat_id)
            );
            CREATE INDEX IF NOT EXISTS idx_pgp_chat ON person_group_profiles(chat_id);

            -- 群组画像
            CREATE TABLE IF NOT EXISTS group_models (
                chat_id TEXT PRIMARY KEY,
                chat_title TEXT NOT NULL DEFAULT '',
                description TEXT DEFAULT '',
                dominant_language TEXT DEFAULT 'zh',
                communication_norms TEXT DEFAULT '[]',
                active_members INTEGER DEFAULT 0,
                avg_messages_per_day REAL DEFAULT 0,
                peak_hours TEXT DEFAULT '[]',
                agent_role TEXT DEFAULT '',
                engagement_level TEXT DEFAULT 'medium',
                recent_feedback TEXT DEFAULT '',
                hot_topics TEXT DEFAULT '[]',
                taboo_topics TEXT DEFAULT '[]',
                last_reflected_at TEXT,
                updated_at TEXT NOT NULL
            );

            -- 交互日志
            CREATE TABLE IF NOT EXISTS interactions (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                topic_id TEXT,
                type TEXT NOT NULL,
                summary TEXT NOT NULL,
                sentiment TEXT DEFAULT 'neutral',
                significance REAL DEFAULT 0.5,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_interactions_user_chat ON interactions(user_id, chat_id, created_at);

            -- 核心事实
            CREATE TABLE IF NOT EXISTS core_facts (
                id TEXT PRIMARY KEY,
                subject TEXT NOT NULL,
                content TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'general',
                confidence REAL DEFAULT 1.0,
                source TEXT,
                embedding BLOB,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                expires_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_facts_subject ON core_facts(subject);
            CREATE INDEX IF NOT EXISTS idx_facts_category ON core_facts(category);

            -- 消息日志
            CREATE TABLE IF NOT EXISTS message_log (
                message_id TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                text TEXT NOT NULL DEFAULT '',
                reply_to_message_id TEXT,
                timestamp TEXT NOT NULL,
                PRIMARY KEY (chat_id, message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_msglog_chat_time ON message_log(chat_id, timestamp);
            CREATE INDEX IF NOT EXISTS idx_msglog_user ON message_log(user_id, timestamp);
        `);

        // FTS5 虚拟表（独立模式，手动同步内容）
        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS topics_fts USING fts5(
                    label, summary, keywords
                );
            `);
        } catch {
            // FTS5 表已存在时忽略
        }

        try {
            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS core_facts_fts USING fts5(
                    content, subject
                );
            `);
        } catch {
            // FTS5 表已存在时忽略
        }
    }

    // ─── 写入方法 ───

    upsertTopic(pipelineTopicId: string, data: Partial<TopicNode>): string {
        const existing = this.db
            .prepare("SELECT id FROM topics WHERE pipeline_topic_id = ?")
            .get(pipelineTopicId) as { id: string } | undefined;

        const ts = now();

        if (existing) {
            // UPDATE — 只更新非 undefined 的字段（SafeUpdateBuilder 校验列名）
            const builder = new SafeUpdateBuilder("topics");

            if (data.chatId !== undefined) builder.set("chat_id", data.chatId);
            if (data.label !== undefined) builder.set("label", data.label);
            if (data.summary !== undefined) builder.set("summary", data.summary);
            if (data.keyPoints !== undefined) builder.set("key_points", toJSON(data.keyPoints));
            if (data.participants !== undefined) builder.set("participants", toJSON(data.participants));
            if (data.keywords !== undefined) builder.set("keywords", toJSON(data.keywords));
            if (data.messageRange !== undefined) {
                builder.set("message_ids", toJSON(data.messageRange.messageIds));
                builder.set("message_count", data.messageRange.count);
            }
            if (data.startedAt !== undefined) builder.set("started_at", data.startedAt);
            if (data.endedAt !== undefined) builder.set("ended_at", data.endedAt);
            if (data.sentiment !== undefined) builder.set("sentiment", data.sentiment);
            if (data.relatedTopicIds !== undefined) builder.set("related_topic_ids", toJSON(data.relatedTopicIds));
            if (data.wasEngaged !== undefined) builder.set("was_engaged", data.wasEngaged ? 1 : 0);
            if (data.interventionCount !== undefined) builder.set("intervention_count", data.interventionCount);
            if (data.embedding !== undefined) builder.set("embedding", Buffer.from(data.embedding.buffer));
            builder.set("updated_at", ts);
            builder.where("id", existing.id);

            if (builder.hasSets) {
                const { sql, params } = builder.build();
                this.db.prepare(sql).run(...params);

                // 同步更新 FTS5
                this.syncTopicFTS(existing.id);

                // 同步 vec0 索引
                if (data.embedding !== undefined) {
                    // chatId 可能不在 update data 中，从主表获取
                    const chatIdForVec = data.chatId ?? (this.db.prepare(
                        "SELECT chat_id FROM topics WHERE id = ?"
                    ).pluck().get(existing.id) as string) ?? "";
                    this.syncTopicVec(existing.id, chatIdForVec, data.embedding);
                }
            }

            log.debug("upsertTopic: UPDATE", { id: existing.id, pipelineTopicId });
            return existing.id;
        } else {
            // INSERT
            const id = randomUUID();
            this.db.prepare(`
                INSERT INTO topics (
                    id, pipeline_topic_id, chat_id, label, summary, key_points, participants,
                    keywords, message_ids, message_count,
                    started_at, ended_at, sentiment, related_topic_ids,
                    was_engaged, intervention_count, embedding,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                id,
                pipelineTopicId,
                data.chatId ?? "",
                data.label ?? "",
                data.summary ?? "",
                toJSON(data.keyPoints),
                toJSON(data.participants),
                toJSON(data.keywords),
                toJSON(data.messageRange?.messageIds),
                data.messageRange?.count ?? 0,
                data.startedAt ?? ts,
                data.endedAt ?? null,
                data.sentiment ?? "neutral",
                toJSON(data.relatedTopicIds),
                data.wasEngaged ? 1 : 0,
                data.interventionCount ?? 0,
                data.embedding ? Buffer.from(data.embedding.buffer) : null,
                ts,
                ts,
            );

            // 插入 FTS5
            this.syncTopicFTS(id);

            // 同步 vec0 索引
            if (data.embedding) {
                this.syncTopicVec(id, data.chatId ?? "", data.embedding);
            }

            log.debug("upsertTopic: INSERT", { id, pipelineTopicId });
            return id;
        }
    }

    /**
     * 按 SQLite id 更新话题节点（Reflection 等内部调用者使用）。
     * 与 upsertTopic 的 UPDATE 分支逻辑一致，但按 id 查找而非 pipeline_topic_id。
     */
    updateTopicById(id: string, data: Partial<TopicNode>): void {
        const ts = now();
        const builder = new SafeUpdateBuilder("topics");

        if (data.chatId !== undefined) builder.set("chat_id", data.chatId);
        if (data.label !== undefined) builder.set("label", data.label);
        if (data.summary !== undefined) builder.set("summary", data.summary);
        if (data.keyPoints !== undefined) builder.set("key_points", toJSON(data.keyPoints));
        if (data.participants !== undefined) builder.set("participants", toJSON(data.participants));
        if (data.keywords !== undefined) builder.set("keywords", toJSON(data.keywords));
        if (data.messageRange !== undefined) {
            builder.set("message_ids", toJSON(data.messageRange.messageIds));
            builder.set("message_count", data.messageRange.count);
        }
        if (data.startedAt !== undefined) builder.set("started_at", data.startedAt);
        if (data.endedAt !== undefined) builder.set("ended_at", data.endedAt);
        if (data.sentiment !== undefined) builder.set("sentiment", data.sentiment);
        if (data.relatedTopicIds !== undefined) builder.set("related_topic_ids", toJSON(data.relatedTopicIds));
        if (data.wasEngaged !== undefined) builder.set("was_engaged", data.wasEngaged ? 1 : 0);
        if (data.interventionCount !== undefined) builder.set("intervention_count", data.interventionCount);
        if (data.embedding !== undefined) builder.set("embedding", Buffer.from(data.embedding.buffer));
        builder.set("updated_at", ts);
        builder.where("id", id);

        if (builder.hasSets) {
            const { sql, params } = builder.build();
            this.db.prepare(sql).run(...params);

            this.syncTopicFTS(id);

            if (data.embedding !== undefined) {
                const chatIdForVec = data.chatId ?? (this.db.prepare(
                    "SELECT chat_id FROM topics WHERE id = ?"
                ).pluck().get(id) as string) ?? "";
                this.syncTopicVec(id, chatIdForVec, data.embedding);
            }
        }

        log.debug("updateTopicById", { id });
    }

    /** 同步 topics_fts 与 topics 表中某行的数据（独立 FTS5 模式） */
    private syncTopicFTS(topicId: string): void {
        try {
            const row = this.db.prepare(
                "SELECT rowid, label, summary, keywords FROM topics WHERE id = ?"
            ).get(topicId) as { rowid: number; label: string; summary: string; keywords: string } | undefined;
            if (!row) return;

            // 独立 FTS5：先删后插，使用 rowid 关联
            this.db.prepare("DELETE FROM topics_fts WHERE rowid = ?").run(row.rowid);
            this.db.prepare(
                "INSERT INTO topics_fts(rowid, label, summary, keywords) VALUES (?, ?, ?, ?)"
            ).run(row.rowid, row.label, row.summary, row.keywords);
        } catch (err) {
            log.warn("syncTopicFTS 失败", { topicId, error: String(err) });
        }
    }

    /** 同步 topic embedding 到 vec0 虚拟表 */
    private syncTopicVec(topicId: string, chatId: string, embedding: Float32Array): void {
        if (!this.sqliteVecAvailable) return;
        try {
            // vec0 不支持 INSERT OR REPLACE，需先删后插
            this.db.prepare("DELETE FROM topics_vec WHERE topic_id = ?").run(topicId);
            this.db.prepare(
                "INSERT INTO topics_vec(topic_id, chat_id, embedding) VALUES (?, ?, ?)"
            ).run(topicId, chatId, Buffer.from(embedding.buffer));
            log.debug("syncTopicVec", { topicId, chatId });
        } catch (err) {
            log.warn("syncTopicVec 失败", { topicId, error: String(err) });
        }
    }

    /** 同步 fact embedding 到 vec0 虚拟表 */
    private syncFactVec(factId: string, embedding: Float32Array): void {
        if (!this.sqliteVecAvailable) return;
        try {
            this.db.prepare("DELETE FROM facts_vec WHERE fact_id = ?").run(factId);
            this.db.prepare(
                "INSERT INTO facts_vec(fact_id, embedding) VALUES (?, ?)"
            ).run(factId, Buffer.from(embedding.buffer));
            log.debug("syncFactVec", { factId });
        } catch (err) {
            log.warn("syncFactVec 失败", { factId, error: String(err) });
        }
    }

    /**
     * 从主表 embedding BLOB 批量重建 vec0 虚拟表索引
     * 用于：首次启用 sqlite-vec / vec0 表损坏后重建
     */
    rebuildVecIndex(): { topics: number; facts: number } {
        if (!this.sqliteVecAvailable) {
            log.warn("rebuildVecIndex: sqlite-vec 不可用，跳过");
            return { topics: 0, facts: 0 };
        }

        // 清空 vec0 表
        this.db.exec("DELETE FROM topics_vec");
        this.db.exec("DELETE FROM facts_vec");

        // 批量填充 topics
        const topicRows = this.db.prepare(
            "SELECT id, chat_id, embedding FROM topics WHERE embedding IS NOT NULL"
        ).all() as Array<{ id: string; chat_id: string; embedding: Buffer }>;

        const insertTopic = this.db.prepare(
            "INSERT INTO topics_vec(topic_id, chat_id, embedding) VALUES (?, ?, ?)"
        );
        const topicBatch = this.db.transaction((rows: typeof topicRows) => {
            for (const row of rows) {
                insertTopic.run(row.id, row.chat_id, row.embedding);
            }
        });
        topicBatch(topicRows);

        // 批量填充 facts
        const factRows = this.db.prepare(
            "SELECT id, embedding FROM core_facts WHERE embedding IS NOT NULL AND (expires_at IS NULL OR expires_at > datetime('now'))"
        ).all() as Array<{ id: string; embedding: Buffer }>;

        const insertFact = this.db.prepare(
            "INSERT INTO facts_vec(fact_id, embedding) VALUES (?, ?)"
        );
        const factBatch = this.db.transaction((rows: typeof factRows) => {
            for (const row of rows) {
                insertFact.run(row.id, row.embedding);
            }
        });
        factBatch(factRows);

        log.info("rebuildVecIndex 完成", { topics: topicRows.length, facts: factRows.length });
        return { topics: topicRows.length, facts: factRows.length };
    }

    finalizeTopic(pipelineTopicId: string): void {
        const ts = now();
        this.db.prepare(
            "UPDATE topics SET ended_at = ?, updated_at = ? WHERE pipeline_topic_id = ? AND ended_at IS NULL"
        ).run(ts, ts, pipelineTopicId);
        log.debug("finalizeTopic", { pipelineTopicId });
    }

    storeMessageBatch(messages: MessageLogEntry[]): void {
        if (messages.length === 0) return;

        const insert = this.db.prepare(`
            INSERT OR IGNORE INTO message_log
                (message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        const batch = this.db.transaction((msgs: MessageLogEntry[]) => {
            for (const m of msgs) {
                insert.run(
                    m.messageId, m.chatId, m.userId, m.displayName,
                    m.text, m.replyToMessageId ?? null, m.timestamp,
                );
            }
        });

        batch(messages);
        log.debug("storeMessageBatch", { count: messages.length });
    }

    /** 写入核心事实到 core_facts 表 */
    storeFact(subject: string, content: string, category: FactCategory, source?: string, expiresAt?: string, embedding?: Float32Array): string {
        const id = randomUUID();
        const ts = now();
        this.db.prepare(`
            INSERT INTO core_facts (id, subject, content, category, confidence, source, embedding, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?, ?)
        `).run(id, subject, content, category, source ?? null, embedding ? embeddingToBuffer(embedding) : null, ts, ts, expiresAt ?? null);

        // 同步 FTS5
        try {
            const row = this.db.prepare("SELECT rowid FROM core_facts WHERE id = ?").get(id) as { rowid: number } | undefined;
            if (row) {
                this.db.prepare(
                    "INSERT INTO core_facts_fts(rowid, content, subject) VALUES (?, ?, ?)"
                ).run(row.rowid, content, subject);
            }
        } catch (err) {
            log.warn("storeFact FTS sync 失败", { id, error: String(err) });
        }

        // 同步 vec0 索引
        if (embedding) {
            this.syncFactVec(id, embedding);
        }

        log.debug("storeFact", { id, subject, category, hasEmbedding: !!embedding });
        return id;
    }

    upsertPersonIdentity(userId: string, data: Partial<PersonIdentity>): void {
        const ts = now();
        const existing = this.db.prepare("SELECT user_id FROM person_identities WHERE user_id = ?").get(userId);

        if (existing) {
            const builder = new SafeUpdateBuilder("person_identities");

            if (data.displayName !== undefined) builder.set("display_name", data.displayName);
            if (data.aliases !== undefined) builder.set("aliases", toJSON(data.aliases));
            if (data.totalMessageCount !== undefined) builder.set("total_message_count", data.totalMessageCount);
            if (data.lastSeenAt !== undefined) builder.set("last_seen_at", data.lastSeenAt);
            builder.set("updated_at", ts);
            builder.where("user_id", userId);

            const { sql, params } = builder.build();
            this.db.prepare(sql).run(...params);
            log.debug("upsertPersonIdentity: UPDATE", { userId });
        } else {
            this.db.prepare(`
                INSERT INTO person_identities (user_id, display_name, aliases, total_message_count, last_seen_at, first_seen_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId,
                data.displayName ?? "",
                toJSON(data.aliases),
                data.totalMessageCount ?? 0,
                data.lastSeenAt ?? ts,
                data.firstSeenAt ?? ts,
                ts,
            );
            log.debug("upsertPersonIdentity: INSERT", { userId, displayName: data.displayName ?? "" });
        }
    }

    upsertPersonGroupProfile(userId: string, chatId: string, data: Partial<PersonGroupProfile>): void {
        const ts = now();
        const existing = this.db.prepare(
            "SELECT user_id FROM person_group_profiles WHERE user_id = ? AND chat_id = ?"
        ).get(userId, chatId);

        if (existing) {
            const builder = new SafeUpdateBuilder("person_group_profiles");

            if (data.dunbarTier !== undefined) builder.set("dunbar_tier", data.dunbarTier);
            if (data.dunbarReason !== undefined) builder.set("dunbar_reason", data.dunbarReason);
            if (data.traits !== undefined) builder.set("traits", toJSON(data.traits));
            if (data.interests !== undefined) builder.set("interests", toJSON(data.interests));
            if (data.communicationStyle !== undefined) builder.set("communication_style", data.communicationStyle);
            if (data.relationToAgent !== undefined) builder.set("relation_to_agent", data.relationToAgent);
            if (data.recentEpisodes !== undefined) builder.set("recent_episodes", toJSON(data.recentEpisodes));
            if (data.mergedMemory !== undefined) builder.set("merged_memory", toJSON(data.mergedMemory));
            if (data.messageCount !== undefined) builder.set("message_count", data.messageCount);
            if (data.lastSeenAt !== undefined) builder.set("last_seen_at", data.lastSeenAt);
            if (data.activeHours !== undefined) builder.set("active_hours", toJSON(data.activeHours));
            builder.set("updated_at", ts);
            builder.where("user_id", userId);
            builder.where("chat_id", chatId);

            const { sql, params } = builder.build();
            this.db.prepare(sql).run(...params);
            log.debug("upsertPersonGroupProfile: UPDATE", { userId, chatId });
        } else {
            this.db.prepare(`
                INSERT INTO person_group_profiles (
                    user_id, chat_id, dunbar_tier, dunbar_reason, traits, interests,
                    communication_style, relation_to_agent, recent_episodes, merged_memory,
                    message_count, last_seen_at, active_hours, first_seen_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId, chatId,
                data.dunbarTier ?? 4,
                data.dunbarReason ?? "",
                toJSON(data.traits),
                toJSON(data.interests),
                data.communicationStyle ?? "",
                data.relationToAgent ?? "",
                toJSON(data.recentEpisodes),
                toJSON(data.mergedMemory),
                data.messageCount ?? 0,
                data.lastSeenAt ?? ts,
                toJSON(data.activeHours),
                data.firstSeenAt ?? ts,
                ts,
            );
            log.debug("upsertPersonGroupProfile: INSERT", { userId, chatId, tier: data.dunbarTier ?? 4 });
        }
    }

    incrementProfileStats(userId: string, chatId: string, stats: {
        messageCountDelta: number;
        activeHoursDelta: number[];
        lastSeenAt: string;
    }): void {
        const ts = now();
        const existing = this.db.prepare(
            "SELECT active_hours FROM person_group_profiles WHERE user_id = ? AND chat_id = ?"
        ).get(userId, chatId) as { active_hours: string } | undefined;

        if (existing) {
            // 读现有 activeHours → 逐 slot 累加
            const current = fromJSON<number[]>(existing.active_hours, new Array(24).fill(0));
            for (let h = 0; h < 24; h++) {
                current[h] = (current[h] || 0) + (stats.activeHoursDelta[h] || 0);
            }
            this.db.prepare(`
                UPDATE person_group_profiles
                SET message_count = message_count + ?,
                    active_hours = ?,
                    last_seen_at = CASE WHEN last_seen_at < ? THEN ? ELSE last_seen_at END,
                    updated_at = ?
                WHERE user_id = ? AND chat_id = ?
            `).run(
                stats.messageCountDelta,
                toJSON(current),
                stats.lastSeenAt, stats.lastSeenAt,
                ts,
                userId, chatId,
            );
            log.debug("incrementProfileStats: UPDATE", { userId, chatId, delta: stats.messageCountDelta });
        } else {
            // 首次创建 profile（仅统计字段）
            const hours = new Array(24).fill(0);
            for (let h = 0; h < 24; h++) {
                hours[h] = stats.activeHoursDelta[h] || 0;
            }
            this.db.prepare(`
                INSERT INTO person_group_profiles (
                    user_id, chat_id, dunbar_tier, dunbar_reason, traits, interests,
                    communication_style, relation_to_agent, recent_episodes, merged_memory,
                    message_count, last_seen_at, active_hours, first_seen_at, updated_at
                ) VALUES (?, ?, 4, '', '[]', '[]', '', '', '[]', '[]', ?, ?, ?, ?, ?)
            `).run(
                userId, chatId,
                stats.messageCountDelta,
                stats.lastSeenAt,
                toJSON(hours),
                stats.lastSeenAt,
                ts,
            );
            log.debug("incrementProfileStats: INSERT", { userId, chatId, count: stats.messageCountDelta });
        }
    }

    upsertGroupModel(chatId: string, data: Partial<GroupModel>): void {
        const ts = now();
        const existing = this.db.prepare("SELECT chat_id FROM group_models WHERE chat_id = ?").get(chatId);

        if (existing) {
            const builder = new SafeUpdateBuilder("group_models");

            if (data.chatTitle !== undefined) builder.set("chat_title", data.chatTitle);
            if (data.description !== undefined) builder.set("description", data.description);
            if (data.dominantLanguage !== undefined) builder.set("dominant_language", data.dominantLanguage);
            if (data.communicationNorms !== undefined) builder.set("communication_norms", toJSON(data.communicationNorms));
            if (data.activeMembers !== undefined) builder.set("active_members", data.activeMembers);
            if (data.avgMessagesPerDay !== undefined) builder.set("avg_messages_per_day", data.avgMessagesPerDay);
            if (data.peakHours !== undefined) builder.set("peak_hours", toJSON(data.peakHours));
            if (data.agentRole !== undefined) builder.set("agent_role", data.agentRole);
            if (data.engagementLevel !== undefined) builder.set("engagement_level", data.engagementLevel);
            if (data.recentFeedback !== undefined) builder.set("recent_feedback", data.recentFeedback);
            if (data.hotTopics !== undefined) builder.set("hot_topics", toJSON(data.hotTopics));
            if (data.tabooTopics !== undefined) builder.set("taboo_topics", toJSON(data.tabooTopics));
            if (data.lastReflectedAt !== undefined) builder.set("last_reflected_at", data.lastReflectedAt);
            builder.set("updated_at", ts);
            builder.where("chat_id", chatId);

            const { sql, params } = builder.build();
            this.db.prepare(sql).run(...params);
            log.debug("upsertGroupModel: UPDATE", { chatId });
        } else {
            this.db.prepare(`
                INSERT INTO group_models (
                    chat_id, chat_title, description, dominant_language, communication_norms,
                    active_members, avg_messages_per_day, peak_hours, agent_role,
                    engagement_level, recent_feedback, hot_topics, taboo_topics,
                    last_reflected_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                chatId,
                data.chatTitle ?? "",
                data.description ?? "",
                data.dominantLanguage ?? "zh",
                toJSON(data.communicationNorms),
                data.activeMembers ?? 0,
                data.avgMessagesPerDay ?? 0,
                toJSON(data.peakHours),
                data.agentRole ?? "",
                data.engagementLevel ?? "medium",
                data.recentFeedback ?? "",
                toJSON(data.hotTopics),
                toJSON(data.tabooTopics),
                data.lastReflectedAt ?? null,
                ts,
            );
            log.debug("upsertGroupModel: INSERT", { chatId, title: data.chatTitle ?? "" });
        }
    }

    getGroupModel(chatId: string): GroupModel | null {
        const row = this.db.prepare("SELECT * FROM group_models WHERE chat_id = ?").get(chatId) as Record<string, unknown> | undefined;
        if (!row) {
            log.debug("getGroupModel: 未找到", { chatId });
            return null;
        }

        return {
            chatId: row.chat_id as string,
            chatTitle: row.chat_title as string,
            description: row.description as string,
            dominantLanguage: row.dominant_language as string,
            communicationNorms: fromJSON(row.communication_norms as string, []),
            activeMembers: row.active_members as number,
            avgMessagesPerDay: row.avg_messages_per_day as number,
            peakHours: fromJSON(row.peak_hours as string, []),
            agentRole: row.agent_role as string,
            engagementLevel: (row.engagement_level as string) as GroupModel["engagementLevel"],
            recentFeedback: row.recent_feedback as string,
            hotTopics: fromJSON(row.hot_topics as string, []),
            tabooTopics: fromJSON(row.taboo_topics as string, []),
            lastReflectedAt: (row.last_reflected_at as string) ?? null,
            updatedAt: row.updated_at as string,
        };
    }

    getPersonIdentity(userId: string): PersonIdentity | null {
        const row = this.db.prepare("SELECT * FROM person_identities WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined;
        if (!row) {
            log.debug("getPersonIdentity: 未找到", { userId });
            return null;
        }

        return {
            userId: row.user_id as string,
            displayName: row.display_name as string,
            aliases: fromJSON(row.aliases as string, []),
            totalMessageCount: row.total_message_count as number,
            lastSeenAt: row.last_seen_at as string,
            firstSeenAt: row.first_seen_at as string,
            updatedAt: row.updated_at as string,
        };
    }

    storeInteraction(episode: Omit<InteractionEpisode, "id">): string {
        const id = randomUUID();
        const ts = now();
        this.db.prepare(`
            INSERT INTO interactions (id, chat_id, user_id, topic_id, type, summary, sentiment, significance, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id,
            (episode as unknown as { chatId: string }).chatId ?? "",
            (episode as unknown as { userId: string }).userId ?? "",
            episode.topicId ?? null,
            episode.type,
            episode.summary,
            episode.sentiment ?? "neutral",
            episode.significance ?? 0.5,
            episode.date ?? ts,
        );
        log.debug("storeInteraction", { id, type: episode.type });
        return id;
    }

    /**
     * 向量搜索 topics（双模式：sqlite-vec KNN 快路径 + 纯 JS fallback）
     *
     * - sqlite-vec 可用时：使用 vec0 虚拟表 KNN 查询（O(N) 线性扫描 + 内部排序）
     * - 不可用时：从主表读取所有 embedding 做 JS 暴力搜索
     */
    vectorSearchTopics(
        queryEmbedding: Float32Array,
        limit: number = 10,
        chatId?: string,
    ): Array<TopicNode & { similarity: number }> {
        // ── vec0 快路径 ──
        if (this.sqliteVecAvailable) {
            try {
                let sql: string;
                const params: unknown[] = [Buffer.from(queryEmbedding.buffer), limit];

                if (chatId) {
                    sql = `SELECT topic_id, distance FROM topics_vec WHERE embedding MATCH ? AND k = ? AND chat_id = ? ORDER BY distance`;
                    params.push(chatId);
                } else {
                    sql = `SELECT topic_id, distance FROM topics_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`;
                }

                const vecRows = this.db.prepare(sql).all(...params) as Array<{ topic_id: string; distance: number }>;
                log.debug("vectorSearchTopics[vec0]: KNN 查询", { count: vecRows.length, chatId, limit });

                if (vecRows.length === 0) return [];

                // 用 topic_id 查主表获取完整数据
                const result: Array<TopicNode & { similarity: number }> = [];
                for (const vr of vecRows) {
                    const row = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(vr.topic_id) as Record<string, unknown> | undefined;
                    if (row) {
                        result.push({
                            ...this.rowToTopicNode(row),
                            // vec0 默认 L2 距离：1/(1+d) 映射到 (0, 1]
                            similarity: 1 / (1 + vr.distance),
                        });
                    }
                }

                log.debug("vectorSearchTopics[vec0]: 返回", {
                    returned: result.length,
                    topScore: result[0]?.similarity.toFixed(3) ?? 0,
                });
                return result;
            } catch (err) {
                log.warn("vectorSearchTopics[vec0] 查询失败，fallback 纯 JS", { error: String(err) });
                // fallthrough to JS path
            }
        }

        // ── 纯 JS fallback ──
        const selectBuilder = new SafeSelectBuilder("topics")
            .from("SELECT * FROM topics")
            .where("embedding IS NOT NULL");
        if (chatId) selectBuilder.whereEq("chat_id", chatId);
        const { sql, params } = selectBuilder.build();

        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
        log.debug("vectorSearchTopics[JS]: 候选数", { count: rows.length, chatId });

        if (rows.length === 0) return [];

        const simFn = getSimilarityFn(this.embeddingConfig?.similarityMetric ?? "cosine");
        const scored = rows.map(row => {
            const emb = bufferToEmbedding(row.embedding as Buffer);
            return {
                ...this.rowToTopicNode(row),
                similarity: simFn(queryEmbedding, emb),
            };
        });

        scored.sort((a, b) => b.similarity - a.similarity);
        const result = scored.slice(0, limit);
        log.debug("vectorSearchTopics[JS]: top-K", {
            limit,
            returned: result.length,
            metric: this.embeddingConfig?.similarityMetric ?? "cosine",
            topScore: result[0]?.similarity.toFixed(3) ?? 0,
        });
        return result;
    }

    /**
     * 向量搜索 core_facts（双模式：sqlite-vec KNN 快路径 + 纯 JS fallback）
     */
    vectorSearchFacts(
        queryEmbedding: Float32Array,
        limit: number = 10,
        categories?: FactCategory[],
    ): Array<{ id: string; content: string; category: FactCategory; subject: string; confidence: number; similarity: number }> {
        // ── vec0 快路径 ──
        if (this.sqliteVecAvailable && !categories?.length) {
            // vec0 不支持 category 过滤（非 partition key），仅在无 category 过滤时使用
            try {
                const sql = `SELECT fact_id, distance FROM facts_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance`;
                const vecRows = this.db.prepare(sql).all(
                    Buffer.from(queryEmbedding.buffer), limit
                ) as Array<{ fact_id: string; distance: number }>;

                log.debug("vectorSearchFacts[vec0]: KNN 查询", { count: vecRows.length, limit });

                if (vecRows.length === 0) return [];

                const result: Array<{ id: string; content: string; category: FactCategory; subject: string; confidence: number; similarity: number }> = [];
                for (const vr of vecRows) {
                    const row = this.db.prepare(
                        "SELECT * FROM core_facts WHERE id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))"
                    ).get(vr.fact_id) as Record<string, unknown> | undefined;
                    if (row) {
                        result.push({
                            id: row.id as string,
                            content: row.content as string,
                            category: row.category as FactCategory,
                            subject: row.subject as string,
                            confidence: row.confidence as number,
                            // vec0 默认 L2 距离
                            similarity: 1 / (1 + vr.distance),
                        });
                    }
                }

                log.debug("vectorSearchFacts[vec0]: 返回", {
                    returned: result.length,
                    topScore: result[0]?.similarity.toFixed(3) ?? 0,
                });
                return result;
            } catch (err) {
                log.warn("vectorSearchFacts[vec0] 查询失败，fallback 纯 JS", { error: String(err) });
            }
        }

        // ── 纯 JS fallback ──
        const selectBuilder = new SafeSelectBuilder("core_facts")
            .from("SELECT * FROM core_facts")
            .where("embedding IS NOT NULL")
            .where("(expires_at IS NULL OR expires_at > datetime('now'))");
        if (categories?.length) {
            selectBuilder.whereIn("category", categories);
        }
        const { sql, params } = selectBuilder.build();

        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
        log.debug("vectorSearchFacts[JS]: 候选数", { count: rows.length });

        if (rows.length === 0) return [];

        const simFn = getSimilarityFn(this.embeddingConfig?.similarityMetric ?? "cosine");
        const scored = rows.map(row => {
            const emb = bufferToEmbedding(row.embedding as Buffer);
            return {
                id: row.id as string,
                content: row.content as string,
                category: row.category as FactCategory,
                subject: row.subject as string,
                confidence: row.confidence as number,
                similarity: simFn(queryEmbedding, emb),
            };
        });

        scored.sort((a, b) => b.similarity - a.similarity);
        const result = scored.slice(0, limit);
        log.debug("vectorSearchFacts[JS]: top-K", {
            limit,
            returned: result.length,
            metric: this.embeddingConfig?.similarityMetric ?? "cosine",
            topScore: result[0]?.similarity.toFixed(3) ?? 0,
        });
        return result;
    }

    // ─── 检索方法 ───

    async recall(query: string, options?: RecallOptions): Promise<RecallResult> {
        const topicMap = new Map<string, TopicNode>();
        const factMap = new Map<string, { content: string; category: FactCategory; subject: string; confidence: number }>();

        const maxResults = options?.maxResults ?? 10;
        const chatIdFilter = options?.chatId;
        const daysBack = options?.daysBack;

        // ─── 路径 1：向量搜索（主路径，如有 embeddingConfig） ───
        if (this.embeddingConfig) {
            try {
                const [queryVec] = await embed([query], this.embeddingConfig);
                if (queryVec) {
                    // 向量搜索 topics
                    const vecTopics = this.vectorSearchTopics(queryVec, maxResults, chatIdFilter);
                    for (const t of vecTopics) {
                        if (!topicMap.has(t.id)) topicMap.set(t.id, t);
                    }

                    // 向量搜索 facts
                    const vecFacts = this.vectorSearchFacts(queryVec, maxResults, options?.categories);
                    for (const f of vecFacts) {
                        if (!factMap.has(f.id)) factMap.set(f.id, {
                            content: f.content, category: f.category,
                            subject: f.subject, confidence: f.confidence,
                        });
                    }
                    log.debug("recall: 向量搜索完成", { topics: vecTopics.length, facts: vecFacts.length });
                }
            } catch (err) {
                log.warn("recall: 向量搜索失败，回退 FTS5", { error: String(err) });
            }
        }

        // ─── 路径 2：FTS5 补充搜索 ───
        // FTS5 topics
        try {
            let topicQuery = `
                SELECT t.* FROM topics t
                INNER JOIN topics_fts fts ON t.rowid = fts.rowid
                WHERE topics_fts MATCH ?
            `;
            const params: unknown[] = [query];
            if (chatIdFilter) { topicQuery += " AND t.chat_id = ?"; params.push(chatIdFilter); }
            if (daysBack) {
                topicQuery += " AND t.started_at >= ?";
                params.push(new Date(Date.now() - daysBack * 86400000).toISOString());
            }
            topicQuery += ` LIMIT ?`;
            params.push(maxResults);

            const rows = this.db.prepare(topicQuery).all(...params) as Record<string, unknown>[];
            for (const row of rows) {
                const t = this.rowToTopicNode(row);
                if (!topicMap.has(t.id)) topicMap.set(t.id, t);
            }
        } catch (err) {
            log.debug("recall: FTS5 topics 失败", { error: String(err) });
        }

        // LIKE fallback topics
        if (topicMap.size === 0) {
            try {
                let likeQuery = "SELECT * FROM topics WHERE (label LIKE ? OR summary LIKE ? OR keywords LIKE ?)";
                const likePattern = `%${query}%`;
                const params: unknown[] = [likePattern, likePattern, likePattern];
                if (chatIdFilter) { likeQuery += " AND chat_id = ?"; params.push(chatIdFilter); }
                if (daysBack) {
                    likeQuery += " AND started_at >= ?";
                    params.push(new Date(Date.now() - daysBack * 86400000).toISOString());
                }
                likeQuery += " LIMIT ?";
                params.push(maxResults);

                const rows = this.db.prepare(likeQuery).all(...params) as Record<string, unknown>[];
                for (const row of rows) {
                    const t = this.rowToTopicNode(row);
                    if (!topicMap.has(t.id)) topicMap.set(t.id, t);
                }
            } catch { /* LIKE fallback */ }
        }

        // FTS5 facts
        try {
            let factQuery = `
                SELECT cf.* FROM core_facts cf
                INNER JOIN core_facts_fts fts ON cf.rowid = fts.rowid
                WHERE core_facts_fts MATCH ?
                AND (cf.expires_at IS NULL OR cf.expires_at > datetime('now'))
            `;
            const params: unknown[] = [query];
            if (options?.categories?.length) {
                factQuery += ` AND cf.category IN (${options.categories.map(() => "?").join(", ")})`;
                params.push(...options.categories);
            }
            factQuery += ` LIMIT ?`;
            params.push(maxResults);

            const rows = this.db.prepare(factQuery).all(...params) as Record<string, unknown>[];
            for (const row of rows) {
                const id = row.id as string;
                if (!factMap.has(id)) factMap.set(id, {
                    content: row.content as string,
                    category: row.category as FactCategory,
                    subject: row.subject as string,
                    confidence: row.confidence as number,
                });
            }
        } catch (err) {
            log.debug("recall: FTS5 facts 失败", { error: String(err) });
        }

        // LIKE fallback facts
        if (factMap.size === 0) {
            try {
                const likePattern = `%${query}%`;
                let likeQuery = "SELECT * FROM core_facts WHERE (content LIKE ? OR subject LIKE ?) AND (expires_at IS NULL OR expires_at > datetime('now'))";
                const params: unknown[] = [likePattern, likePattern];
                if (options?.categories?.length) {
                    likeQuery += ` AND category IN (${options.categories.map(() => "?").join(", ")})`;
                    params.push(...options.categories);
                }
                likeQuery += " LIMIT ?";
                params.push(maxResults);

                const rows = this.db.prepare(likeQuery).all(...params) as Record<string, unknown>[];
                for (const row of rows) {
                    const id = row.id as string;
                    if (!factMap.has(id)) factMap.set(id, {
                        content: row.content as string,
                        category: row.category as FactCategory,
                        subject: row.subject as string,
                        confidence: row.confidence as number,
                    });
                }
            } catch { /* LIKE fallback */ }
        }

        const topics = [...topicMap.values()];
        const facts = [...factMap.values()];

        // ─── 关联 persons（通过 topic.participants 匹配） ───
        const persons = this.resolvePersonsFromTopics(topics);

        // ─── deep summary（如结果超阈值且有 cheapLlmConfig） ───
        let deepSummary: string | undefined;
        const threshold = options?.deepRecallThreshold ?? 2000;
        const totalTokens = this.estimateRecallTokens(topics, facts);
        if (totalTokens > threshold && this.cheapLlmConfig) {
            try {
                deepSummary = await this.generateDeepSummary(query, topics, facts);
                log.debug("recall: deepSummary 生成", { tokens: totalTokens, threshold });
            } catch (err) {
                log.warn("recall: deepSummary 失败", { error: String(err) });
            }
        }

        log.debug("recall", {
            query,
            topicsFound: topics.length,
            factsFound: facts.length,
            personsFound: persons.length,
            hasDeepSummary: !!deepSummary,
        });
        return { topics, facts, persons, deepSummary };
    }

    /** 从 topic 参与者解析关联的 person_group_profiles */
    private resolvePersonsFromTopics(topics: TopicNode[]): PersonGroupProfile[] {
        const userIds = new Set<string>();
        for (const t of topics) {
            for (const p of t.participants) userIds.add(p);
        }
        if (userIds.size === 0) return [];

        const result: PersonGroupProfile[] = [];
        for (const uid of userIds) {
            try {
                const rows = this.db.prepare(
                    "SELECT * FROM person_group_profiles WHERE user_id = ? LIMIT 1"
                ).all(uid) as Record<string, unknown>[];
                for (const r of rows) {
                    result.push({
                        userId: r.user_id as string,
                        chatId: r.chat_id as string,
                        dunbarTier: (r.dunbar_tier as PersonGroupProfile["dunbarTier"]) ?? 4,
                        dunbarReason: (r.dunbar_reason as string) ?? "",
                        traits: fromJSON<string[]>(r.traits as string, []),
                        interests: fromJSON<string[]>(r.interests as string, []),
                        communicationStyle: (r.communication_style as string) ?? "",
                        relationToAgent: (r.relation_to_agent as string) ?? "",
                        recentEpisodes: fromJSON<InteractionEpisode[]>(r.recent_episodes as string, []),
                        mergedMemory: fromJSON<MergedMemory[]>(r.merged_memory as string, []),
                        messageCount: (r.message_count as number) ?? 0,
                        lastSeenAt: (r.last_seen_at as string) ?? "",
                        activeHours: fromJSON<number[]>(r.active_hours as string, []),
                        firstSeenAt: (r.first_seen_at as string) ?? "",
                        updatedAt: (r.updated_at as string) ?? "",
                    });
                }
            } catch { /* skip */ }
        }
        return result;
    }

    /** 估算 recall 结果的总 token 数（使用精确 tiktoken 计算） */
    private estimateRecallTokens(topics: TopicNode[], facts: Array<{ content: string }>): number {
        // 导入 estimateTokens 在运行时使用
        let total = 0;
        for (const t of topics) total += Math.ceil((t.summary?.length ?? 0) / 2);
        for (const f of facts) total += Math.ceil((f.content?.length ?? 0) / 2);
        return total;
    }

    /** 调用 cheap model 生成深度总结 */
    private async generateDeepSummary(
        query: string,
        topics: TopicNode[],
        facts: Array<{ content: string; subject: string }>,
    ): Promise<string> {
        if (!this.cheapLlmConfig) throw new Error("No cheap LLM config");

        const topicSummaries = topics.slice(0, 5).map(t =>
            `- [话题] ${t.label}: ${t.summary}`
        ).join("\n");
        const factSummaries = facts.slice(0, 10).map(f =>
            `- [事实] (${f.subject}) ${f.content}`
        ).join("\n");

        const messages: ChatMessage[] = [
            { role: "system", content: getRecallDeepSummaryPrompt() },
            { role: "user", content: `查询：${query}\n\n相关记忆：\n${topicSummaries}\n${factSummaries}` },
        ];

        const response = await callLLM(messages, this.cheapLlmConfig);
        return response.content.trim();
    }

    async browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult> {
        const segments: HistoryBrowseResult["segments"] = [];
        const contextWindow = request.contextWindow ?? 10;
        const maxSegments = request.maxSegments ?? 3;

        // ─── Step 1: 意图解析（LLM 或 fallback） ───
        let keywords: string[];
        let parsedHints = { ...request.hints };

        if (this.cheapLlmConfig && !request.hints?.topicId) {
            try {
                const parsed = await this.parseIntentWithLLM(request.intent);
                keywords = parsed.keywords;
                if (parsed.daysBack && !parsedHints.daysBack) parsedHints.daysBack = parsed.daysBack;
                if (parsed.userId && !parsedHints.userId) parsedHints.userId = parsed.userId;
                log.debug("browseHistory: LLM 意图解析", { keywords, parsedHints });
            } catch (err) {
                log.warn("browseHistory: LLM 意图解析失败，fallback 分词", { error: String(err) });
                keywords = request.intent.split(/\s+/).filter(w => w.length > 0);
            }
        } else {
            keywords = request.intent.split(/\s+/).filter(w => w.length > 0);
        }

        if (keywords.length === 0) {
            return { answer: "", segments: [], messagesRead: 0 };
        }

        // ─── Step 2: 定位 topics（向量搜索 + LIKE fallback） ───
        let topicRows: Record<string, unknown>[] = [];

        // 机会 1：向量搜索
        if (this.embeddingConfig) {
            try {
                const intentText = keywords.join(" ");
                const [queryVec] = await embed([intentText], this.embeddingConfig);
                if (queryVec) {
                    const vecTopics = this.vectorSearchTopics(queryVec, maxSegments, parsedHints.chatId);
                    // 转为原始 row 兼容后续逻辑
                    if (vecTopics.length > 0) {
                        topicRows = vecTopics.map(t => ({
                            ...t,
                            message_ids: toJSON(t.messageRange?.messageIds),
                            chat_id: t.chatId,
                            label: t.label,
                            started_at: t.startedAt,
                            ended_at: t.endedAt,
                        })) as unknown as Record<string, unknown>[];
                        log.debug("browseHistory: 向量搜索命中", { count: vecTopics.length });
                    }
                }
            } catch (err) {
                log.warn("browseHistory: 向量搜索失败", { error: String(err) });
            }
        }

        // 机会 2：LIKE fallback
        if (topicRows.length === 0) {
            const conditions = keywords.map(() => "(label LIKE ? OR keywords LIKE ? OR summary LIKE ?)").join(" OR ");
            const params: unknown[] = [];
            for (const kw of keywords) {
                const p = `%${kw}%`;
                params.push(p, p, p);
            }

            let whereClause = `WHERE (${conditions})`;
            if (parsedHints.chatId) { whereClause += " AND chat_id = ?"; params.push(parsedHints.chatId); }
            if (parsedHints.daysBack) {
                whereClause += " AND started_at >= ?";
                params.push(new Date(Date.now() - parsedHints.daysBack * 86400000).toISOString());
            }
            if (parsedHints.topicId) { whereClause += " AND id = ?"; params.push(parsedHints.topicId); }

            params.push(maxSegments);

            try {
                topicRows = this.db.prepare(
                    `SELECT * FROM topics ${whereClause} ORDER BY started_at DESC LIMIT ?`
                ).all(...params) as Record<string, unknown>[];
            } catch (err) {
                log.debug("browseHistory: LIKE 搜索失败", { error: String(err) });
            }
        }

        // ─── Step 3: 拉取 message_log ───
        let totalMessagesRead = 0;

        for (const topicRow of topicRows) {
            const messageIdsRaw = (topicRow.message_ids ?? topicRow.messageIds) as string | string[] | null;
            const chatId = (topicRow.chat_id ?? topicRow.chatId) as string;

            // 解析 message_ids
            let messageIds: string[];
            if (Array.isArray(messageIdsRaw)) {
                messageIds = messageIdsRaw.map(String);
            } else {
                messageIds = fromJSON<string[]>(messageIdsRaw as string, []);
            }
            if (messageIds.length === 0) continue;

            // 用精确 message_ids 查询归属消息
            const placeholders = messageIds.map(() => "?").join(", ");
            const msgRows = this.db.prepare(`
                SELECT * FROM message_log
                WHERE chat_id = ? AND message_id IN (${placeholders})
                ORDER BY timestamp ASC, message_id ASC
            `).all(
                chatId,
                ...messageIds,
            ) as Record<string, unknown>[];

            const messages = msgRows.map(r => ({
                messageId: String(r.message_id),
                userId: r.user_id as string,
                displayName: r.display_name as string,
                text: r.text as string,
                timestamp: r.timestamp as string,
            }));

            totalMessagesRead += messages.length;

            segments.push({
                topicLabel: (topicRow.label as string) ?? "",
                timeRange: {
                    from: (topicRow.started_at ?? topicRow.startedAt) as string,
                    to: ((topicRow.ended_at ?? topicRow.endedAt) as string) ?? now(),
                },
                messages,
                relevanceScore: (topicRow as { similarity?: number }).similarity ?? 1.0,
            });
        }

        // ─── Step 4: 生成 answer（LLM 深度阅读 或 fallback） ───
        let answer: string;
        if (this.cheapLlmConfig && segments.length > 0 && totalMessagesRead > 0) {
            try {
                answer = await this.deepReadWithLLM(request.intent, segments);
                log.debug("browseHistory: LLM 深度阅读完成", { answerLen: answer.length });
            } catch (err) {
                log.warn("browseHistory: LLM 深度阅读失败", { error: String(err) });
                answer = segments.length > 0
                    ? `找到 ${segments.length} 个相关话题：${segments.map(s => s.topicLabel).join("、")}`
                    : "";
            }
        } else {
            answer = segments.length > 0
                ? `找到 ${segments.length} 个相关话题：${segments.map(s => s.topicLabel).join("、")}`
                : "";
        }

        log.debug("browseHistory", { intent: request.intent, segmentsFound: segments.length, totalMessagesRead });
        return { answer, segments, messagesRead: totalMessagesRead };
    }

    /** LLM 意图解析 */
    private async parseIntentWithLLM(intent: string): Promise<{ keywords: string[]; daysBack?: number; userId?: string }> {
        if (!this.cheapLlmConfig) throw new Error("No cheap LLM config");

        const messages: ChatMessage[] = [
            { role: "system", content: getBrowseIntentParsePrompt() },
            { role: "user", content: intent },
        ];

        const response = await callLLM(messages, this.cheapLlmConfig);
        try {
            const parsed = JSON.parse(response.content.replace(/```json?\s*/g, "").replace(/```/g, "").trim());
            return {
                keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [intent],
                daysBack: typeof parsed.daysBack === "number" ? parsed.daysBack : undefined,
                userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
            };
        } catch {
            log.warn("browseHistory: 意图 JSON 解析失败", { raw: response.content.slice(0, 100) });
            return { keywords: intent.split(/\s+/).filter(w => w.length > 0) };
        }
    }

    /** LLM 深度阅读 */
    private async deepReadWithLLM(
        intent: string,
        segments: HistoryBrowseResult["segments"],
    ): Promise<string> {
        if (!this.cheapLlmConfig) throw new Error("No cheap LLM config");

        // 拼接消息上下文（限制长度）
        const contextParts: string[] = [];
        for (const seg of segments.slice(0, 3)) {
            const header = `【话题：${seg.topicLabel}】(${seg.timeRange.from} ~ ${seg.timeRange.to})`;
            const msgTexts = seg.messages.slice(0, 20).map(m =>
                `${m.displayName}: ${m.text}`
            ).join("\n");
            contextParts.push(`${header}\n${msgTexts}`);
        }

        const messages: ChatMessage[] = [
            { role: "system", content: getBrowseDeepReadPrompt() },
            { role: "user", content: `问题：${intent}\n\n对话记录：\n${contextParts.join("\n\n---\n\n")}` },
        ];

        const response = await callLLM(messages, this.cheapLlmConfig);
        return response.content.trim();
    }

    // ─── Reflection 查询方法 ───

    getTopicsSince(chatId: string, since: string): TopicNode[] {
        const rows = this.db.prepare(
            "SELECT * FROM topics WHERE chat_id = ? AND started_at >= ? ORDER BY started_at ASC"
        ).all(chatId, since) as Record<string, unknown>[];
        log.debug("getTopicsSince", { chatId, since, count: rows.length });
        return rows.map(r => this.rowToTopicNode(r));
    }

    getInteractionsSince(chatId: string, since: string): InteractionEpisode[] {
        const rows = this.db.prepare(
            "SELECT * FROM interactions WHERE chat_id = ? AND created_at >= ? ORDER BY created_at ASC"
        ).all(chatId, since) as Record<string, unknown>[];
        log.debug("getInteractionsSince", { chatId, since, count: rows.length });
        return rows.map(r => ({
            id: r.id as string,
            date: r.created_at as string,
            chatId: r.chat_id as string,
            userId: r.user_id as string,
            topicId: (r.topic_id as string) ?? null,
            type: r.type as InteractionEpisode["type"],
            summary: r.summary as string,
            sentiment: (r.sentiment as InteractionEpisode["sentiment"]) ?? "neutral",
            significance: (r.significance as number) ?? 0.5,
        }));
    }

    getProfilesForChat(chatId: string): PersonGroupProfile[] {
        const rows = this.db.prepare(
            "SELECT * FROM person_group_profiles WHERE chat_id = ? ORDER BY message_count DESC"
        ).all(chatId) as Record<string, unknown>[];
        const profiles = rows.map(r => ({
            userId: r.user_id as string,
            chatId: r.chat_id as string,
            dunbarTier: (r.dunbar_tier as PersonGroupProfile["dunbarTier"]) ?? 4,
            dunbarReason: (r.dunbar_reason as string) ?? "",
            traits: fromJSON<string[]>(r.traits as string, []),
            interests: fromJSON<string[]>(r.interests as string, []),
            communicationStyle: (r.communication_style as string) ?? "",
            relationToAgent: (r.relation_to_agent as string) ?? "",
            recentEpisodes: fromJSON<InteractionEpisode[]>(r.recent_episodes as string, []),
            mergedMemory: fromJSON<MergedMemory[]>(r.merged_memory as string, []),
            messageCount: (r.message_count as number) ?? 0,
            lastSeenAt: (r.last_seen_at as string) ?? "",
            activeHours: fromJSON<number[]>(r.active_hours as string, []),
            firstSeenAt: (r.first_seen_at as string) ?? "",
            updatedAt: (r.updated_at as string) ?? "",
        }));
        log.debug("getProfilesForChat", { chatId, count: profiles.length });
        return profiles;
    }

    getRecentMessages(chatId: string, limit: number = 5): RecentMessageEntry[] {
        const rows = this.db.prepare(
            `SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp
             FROM message_log
             WHERE chat_id = ?
             ORDER BY timestamp DESC
             LIMIT ?`
        ).all(chatId, limit) as Record<string, unknown>[];

        return rows.map((row) => ({
            messageId: row.message_id as string,
            chatId: row.chat_id as string,
            userId: row.user_id as string,
            displayName: (row.display_name as string) ?? "",
            text: (row.text as string) ?? "",
            replyToMessageId: (row.reply_to_message_id as string) ?? undefined,
            timestamp: row.timestamp as string,
        }));
    }

    // ─── Reflection (M2.4: 调用 reflection.ts) ───

    async reflect(
        chatId: string,
        llmConfig: LLMConfig,
        reflectionConfig?: ReflectionExternalConfig,
    ): Promise<ReflectionResult> {
        const { runReflection } = await import("./reflection.js");
        return runReflection(chatId, this, llmConfig, reflectionConfig);
    }

    // ─── 生命周期 ───

    close(): void {
        this.db.close();
        log.info("Memory V2 SQLite 已关闭");
    }

    // ─── 内部工具方法 ───

    /** 将 SQLite 行映射为 TopicNode */
    private rowToTopicNode(row: Record<string, unknown>): TopicNode {
        return {
            id: row.id as string,
            pipelineTopicId: (row.pipeline_topic_id as string) ?? undefined,
            chatId: row.chat_id as string,
            label: row.label as string,
            summary: row.summary as string,
            keyPoints: fromJSON(row.key_points as string, []),
            participants: fromJSON(row.participants as string, []),
            messageRange: {
                messageIds: fromJSON<string[]>(row.message_ids as string, []),
                count: (row.message_count as number) ?? 0,
            },
            startedAt: row.started_at as string,
            endedAt: (row.ended_at as string) ?? null,
            sentiment: (row.sentiment as TopicNode["sentiment"]) ?? "neutral",
            relatedTopicIds: fromJSON(row.related_topic_ids as string, []),
            keywords: fromJSON(row.keywords as string, []),
            wasEngaged: !!(row.was_engaged as number),
            interventionCount: (row.intervention_count as number) ?? 0,
            embedding: row.embedding ? new Float32Array((row.embedding as Buffer).buffer) : undefined,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
        };
    }
}
