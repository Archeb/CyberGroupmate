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
import { getGroupModelKey, safeGroupModelKey } from "../core/chat-id.js";
import { buildVisibilityDeps, isPrivateChat, type VisibilityDeps } from "../core/visibility-policy.js";
import { createRequire } from "node:module";
import { resolveComponentTimeout, resolveComponentProfiles, type LLMConfig, type ReflectionExternalConfig, type EmbeddingConfig } from "../core/config.js";
import {
    cosineSimilarity,
    bufferToEmbedding,
    embeddingToBuffer,
    embed,
    getSimilarityFn,
} from "./embedding.js";
import { callLLMWithFallback, type ChatMessage, type LLMConfig as LlmCallConfig } from "../core/llm.js";
import { loadPromptFile, registerCacheClear } from "../core/prompt-loader.js";
import { SafeUpdateBuilder, SafeSelectBuilder } from "./query-builder.js";
import type {
    IMemoryStoreV2,
    AssociatedMemory,
    TopicNode,
    PersonIdentity,
    PersonProfile,
    PersonGroupProfile,
    InteractionEpisode,
    MergedMemory,
    GroupModel,
    CoreFact,
    FactCategory,
    FactSearchResult,
    TopicSearchResult,
    MessageSearchResult,
    InteractionSearchResult,
    UserProfileSearchResult,
    CoreFactProvenance,
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

function normalizeEmojiCandidates(value: unknown): string[] {
    const candidates: string[] = [];
    const add = (item: unknown) => {
        if (typeof item !== "string") return;
        const trimmed = item.trim();
        if (!trimmed || candidates.includes(trimmed)) return;
        candidates.push(trimmed);
    };

    if (Array.isArray(value)) {
        for (const item of value) add(item);
    } else {
        add(value);
    }

    return candidates;
}

function normalizeStoredEmojis(rawEmojis: string | null | undefined, legacyEmoji?: string | null): string[] {
    return normalizeEmojiCandidates([
        ...fromJSON<unknown[]>(rawEmojis, []),
        ...(legacyEmoji ? [legacyEmoji] : []),
    ]);
}

function now(): string {
    return new Date().toISOString();
}

function buildFtsOrQuery(query: string): string {
    const terms = query
        .split(/\s+/)
        .map(term => term.replace(/"/g, "").trim())
        .filter(Boolean);
    if (terms.length === 0) return "";
    return terms.map(term => `"${term}"`).join(" OR ");
}

function identityAliasScore(identity: PersonIdentity, normalizedQuery: string): number {
    const candidates = [
        identity.userId,
        identity.displayName,
        identity.username ?? "",
        ...identity.aliases,
    ].map(value => value.trim().toLocaleLowerCase()).filter(Boolean);

    if (candidates.some(value => value === normalizedQuery)) return 100;
    if (candidates.some(value => value.startsWith(normalizedQuery))) return 80;
    if (candidates.some(value => value.includes(normalizedQuery))) return 60;
    return 0;
}

// ─── System Prompt 加载（统一使用 prompt-loader 支持 override）───

let _recallDeepSummaryPrompt: string | null = null;
function getRecallDeepSummaryPrompt(): string {
    if (!_recallDeepSummaryPrompt) {
        const content = loadPromptFile("memory/recall-deep-summary.md");
        if (content) {
            _recallDeepSummaryPrompt = content.trim();
        } else {
            _recallDeepSummaryPrompt = "你是一组聊天记忆系统中的深度总结助手。请根据以下记忆片段（话题摘要和事实），针对用户查询生成简洁的中文总结（2-3 句话）。只输出总结，不要其他内容。";
            log.warn("recall-deep-summary.md 未找到，使用内联 fallback");
        }
    }
    return _recallDeepSummaryPrompt;
}

let _browseIntentParsePrompt: string | null = null;
function getBrowseIntentParsePrompt(): string {
    if (!_browseIntentParsePrompt) {
        const content = loadPromptFile("memory/browse-intent-parse.md");
        if (content) {
            _browseIntentParsePrompt = content.trim();
        } else {
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
        const content = loadPromptFile("memory/browse-deep-read.md");
        if (content) {
            _browseDeepReadPrompt = content.trim();
        } else {
            _browseDeepReadPrompt = "你是一个消息历史阅读助手。请根据以下对话记录，回答用户的问题。用中文简洁回答（2-4 句话）。只输出回答，不要其他内容。";
            log.warn("browse-deep-read.md 未找到，使用内联 fallback");
        }
    }
    return _browseDeepReadPrompt;
}

// 注册缓存清除回调
registerCacheClear(() => {
    _recallDeepSummaryPrompt = null;
    _browseIntentParsePrompt = null;
    _browseDeepReadPrompt = null;
});

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
    /** sqlite-vec 扩展是否可用 */
    public sqliteVecAvailable = false;

    constructor(dbPath: string, options?: {
        embeddingConfig?: EmbeddingConfig;
    }) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.embeddingConfig = options?.embeddingConfig;
        this.initTables();
        this.sqliteVecAvailable = this.tryLoadSqliteVec();
        if (this.sqliteVecAvailable) {
            this.initVecTables();
        }
        log.info("Memory V2 SQLite 初始化完成", {
            dbPath,
            hasEmbedding: !!this.embeddingConfig,
            sqliteVec: this.sqliteVecAvailable,
        });
    }

    /** 获取当前 embedding 配置（供 reflection 等外部模块使用） */
    getEmbeddingConfig(): EmbeddingConfig | undefined {
        return this.embeddingConfig;
    }

    /**
     * 全局 visibility 分级所需的依赖（种子 + DM 自动判定 + GroupModel 读取）。
     * 由 memory-factory 通过 setPrivacyClassification 注入 config.privacy；默认 DM 自动私密、空种子。
     * 用统一的 getChatVisibility 定义，使 recall 守卫与 chokepoint 完全一致。
     */
    private privacyDeps: VisibilityDeps = buildVisibilityDeps({
        getGroupModel: (key: string) => this.getGroupModel(key),
    });
    /** enforce=off 时关闭 memory 层隐私兜底（总开关）；warn/block 都按私密处理（内部上下文恒 fail-closed）。 */
    private privacyEnforced = true;

    /** 注入全局隐私分级（config.privacy.sensitiveChats / dmAutoPrivate / enforce）。 */
    setPrivacyClassification(opts: { sensitiveChats?: string[]; dmAutoPrivate?: boolean; enforce?: "block" | "warn" | "off" }): void {
        this.privacyDeps = buildVisibilityDeps({
            getGroupModel: (key: string) => this.getGroupModel(key),
            sensitiveChats: opts.sensitiveChats,
            dmAutoPrivate: opts.dmAutoPrivate,
        });
        this.privacyEnforced = opts.enforce !== "off";
    }

    /**
     * 会话是否私密（DM / 配置种子 sensitiveChats / 运行时 markedSensitive），与 chokepoint 同一定义。
     * 供 recall / 可见性守卫（scrubFactsByVisibility）共用。enforce=off → 一律非私密。
     */
    isChatPrivate(chatId: string | null | undefined): boolean {
        if (!chatId || !this.privacyEnforced) return false;
        return isPrivateChat(chatId, this.privacyDeps);
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
            // 维度变更检测：从 sqlite_master 解析已有 vec0 表的 float[N]，与目标 dims 比对。
            // ⚠️ 不能靠「CREATE ... IF NOT EXISTS 是否报错」判断——表已存在时它直接 no-op、不校验维度，
            //    旧维度表会被静默保留，后续按新维度插入才失败。必须显式解析维度。
            const existingDims = (name: string): number | null => {
                const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql?: string } | undefined;
                const m = row?.sql?.match(/float\[(\d+)\]/);
                return m ? Number(m[1]) : null;
            };
            const tDims = existingDims("topics_vec");
            const fDims = existingDims("facts_vec");
            const oldDims = tDims ?? fDims;
            // 仅在 embedding 启用时才因维度不符重建——关闭时不写向量，旧维度表闲置无害，不动它（避免 toggle off 误删向量）。
            const mismatch = !!this.embeddingConfig
                && ((tDims != null && tDims !== dims) || (fDims != null && fDims !== dims));

            if (mismatch) {
                // 维度变了：旧 vec 表 + 旧主表向量都按旧维度存的，对新维度不可用。
                // → DROP 旧 vec 表、清空主表 embedding 列（避免 JS 回退路径用到错维向量报错/出垃圾），按新维度重建。
                log.warn(
                    `⚠️ embedding 维度变化：现有 vec0 表为 ${oldDims} 维，配置为 ${dims} 维。` +
                    `已 DROP 旧 vec 表并清空存量向量，按新维度重建——请运行一次 \`cli memory backfill-embeddings\` 重新生成向量（在此之前向量召回回退为关键词）。`,
                    { existingTopicDims: tDims, existingFactDims: fDims, targetDims: dims },
                );
                this.db.exec(`DROP TABLE IF EXISTS topics_vec`);
                this.db.exec(`DROP TABLE IF EXISTS facts_vec`);
                try { this.db.exec(`UPDATE core_facts SET embedding = NULL WHERE embedding IS NOT NULL`); } catch { /* 列可能不存在 */ }
                try { this.db.exec(`UPDATE topics SET embedding = NULL WHERE embedding IS NOT NULL`); } catch { /* 列可能不存在 */ }
            }

            this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS topics_vec USING vec0(
                topic_id TEXT PRIMARY KEY, chat_id TEXT partition key, embedding float[${dims}]
            )`);
            this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS facts_vec USING vec0(
                fact_id TEXT PRIMARY KEY, embedding float[${dims}]
            )`);
            log.debug("vec0 虚拟表就绪", { dims, recreatedForDimChange: mismatch });
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
                associated_memories TEXT DEFAULT '[]',
                callback_potential INTEGER DEFAULT 0,
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

            -- 个体全局画像（跨群共享的长期认知）
            CREATE TABLE IF NOT EXISTS person_profiles (
                user_id TEXT PRIMARY KEY,
                traits TEXT NOT NULL DEFAULT '[]',
                interests TEXT NOT NULL DEFAULT '[]',
                communication_style TEXT DEFAULT '',
                relation_to_agent TEXT DEFAULT '',
                stable_patterns TEXT NOT NULL DEFAULT '[]',
                agent_policy_hints TEXT NOT NULL DEFAULT '[]',
                followup_candidates TEXT NOT NULL DEFAULT '[]',
                source_chat_ids TEXT NOT NULL DEFAULT '[]',
                confidence REAL DEFAULT 0,
                last_reflected_at TEXT,
                created_at TEXT NOT NULL,
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
                is_direct_message INTEGER DEFAULT 0,
                marked_sensitive INTEGER DEFAULT 0,
                sensitive_reason TEXT,
                sensitive_at TEXT,
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
                source_chat_id TEXT,
                source_chat_title TEXT,
                source_topic_id TEXT,
                source_topic_label TEXT,
                source_message_ids TEXT DEFAULT '[]',
                source_interaction_ids TEXT DEFAULT '[]',
                observed_at TEXT,
                visibility TEXT DEFAULT 'contextual',
                sensitivity TEXT DEFAULT 'low',
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

        // ── 媒体相关表 ──

        // message_log 新增 media 列（兼容旧数据库）
        try { this.db.exec(`ALTER TABLE message_log ADD COLUMN media_type TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE message_log ADD COLUMN media_info TEXT`); } catch { /* 列已存在 */ }

        // Sticker 描述缓存表
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sticker_descriptions (
                unique_file_id TEXT PRIMARY KEY,
                description TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        `);
        // 新增 emoji 列（兼容旧数据库）
        try { this.db.exec(`ALTER TABLE sticker_descriptions ADD COLUMN emoji TEXT`); } catch { /* 列已存在 */ }
        // 新增 emojis 列：JSON 数组，保留 emoji 列作为旧结构主 emoji
        try { this.db.exec(`ALTER TABLE sticker_descriptions ADD COLUMN emojis TEXT`); } catch { /* 列已存在 */ }
        // 新增 enabled 列（默认启用，兼容旧数据库）
        try { this.db.exec(`ALTER TABLE sticker_descriptions ADD COLUMN enabled INTEGER DEFAULT 1`); } catch { /* 列已存在 */ }
        // 新增 content_hash 列：内部内容身份，避免 Telegram uniqueFileId 变化导致重复描述
        try { this.db.exec(`ALTER TABLE sticker_descriptions ADD COLUMN content_hash TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sticker_descriptions_content_hash ON sticker_descriptions(content_hash) WHERE content_hash IS NOT NULL`); } catch { /* index */ }
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sticker_file_aliases (
                unique_file_id TEXT PRIMARY KEY,
                content_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
        `);
        try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sticker_file_aliases_content_hash ON sticker_file_aliases(content_hash)`); } catch { /* index */ }

        // person_group_profiles 新增 affinity_score 列（兼容旧数据库）
        try { this.db.exec(`ALTER TABLE person_group_profiles ADD COLUMN affinity_score REAL DEFAULT 0`); } catch { /* 列已存在 */ }

        // group_models 新增 is_direct_message 列（兼容旧数据库）
        try { this.db.exec(`ALTER TABLE group_models ADD COLUMN is_direct_message INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }

        // group_models 新增 marked_sensitive / sensitive_reason / sensitive_at 列（全局 visibility 兜底，兼容旧数据库）
        try { this.db.exec(`ALTER TABLE group_models ADD COLUMN marked_sensitive INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE group_models ADD COLUMN sensitive_reason TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE group_models ADD COLUMN sensitive_at TEXT`); } catch { /* 列已存在 */ }

        // person_identities 新增 username 列（兼容旧数据库）
        try { this.db.exec(`ALTER TABLE person_identities ADD COLUMN username TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN source_chat_id TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN source_chat_title TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN source_topic_id TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN source_topic_label TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN source_message_ids TEXT DEFAULT '[]'`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN source_interaction_ids TEXT DEFAULT '[]'`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN observed_at TEXT`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN visibility TEXT DEFAULT 'contextual'`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE core_facts ADD COLUMN sensitivity TEXT DEFAULT 'low'`); } catch { /* 列已存在 */ }
        try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_facts_source_chat ON core_facts(source_chat_id)`); } catch { /* index */ }
        try { this.db.exec(`ALTER TABLE topics ADD COLUMN associated_memories TEXT DEFAULT '[]'`); } catch { /* 列已存在 */ }
        try { this.db.exec(`ALTER TABLE topics ADD COLUMN callback_potential INTEGER DEFAULT 0`); } catch { /* 列已存在 */ }

        // ── KV Store 表 ──
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS kv_store (
                chat_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                expires_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (chat_id, key)
            );
            CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv_store(expires_at);

            -- per-chat todo
            CREATE TABLE IF NOT EXISTS todo_items (
                chat_id TEXT NOT NULL,
                key TEXT NOT NULL,
                content TEXT NOT NULL,
                due_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (chat_id, key)
            );
            CREATE INDEX IF NOT EXISTS idx_todo_chat_due ON todo_items(chat_id, due_at);
        `);

        // 回填 person_identities.total_message_count（历史数据从 person_group_profiles 汇总）
        this.db.exec(`
            UPDATE person_identities
            SET total_message_count = COALESCE((
                SELECT SUM(message_count)
                FROM person_group_profiles
                WHERE person_group_profiles.user_id = person_identities.user_id
            ), 0)
            WHERE total_message_count = 0
              AND EXISTS (
                SELECT 1 FROM person_group_profiles
                WHERE person_group_profiles.user_id = person_identities.user_id
                  AND person_group_profiles.message_count > 0
              )
        `);
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
            if (data.associatedMemories !== undefined) builder.set("associated_memories", toJSON(data.associatedMemories));
            if (data.callbackPotential !== undefined) builder.set("callback_potential", data.callbackPotential);
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
                    associated_memories, callback_potential,
                    embedding,
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
                toJSON(data.associatedMemories),
                data.callbackPotential ?? 0,
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
        if (data.associatedMemories !== undefined) builder.set("associated_memories", toJSON(data.associatedMemories));
        if (data.callbackPotential !== undefined) builder.set("callback_potential", data.callbackPotential);
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
     * 为已存在的 fact 补写 embedding（更新 core_facts.embedding 列 + 同步 vec0）。
     * 供「异步写入」（reflection 存完事实后台补向量）与 backfill 使用——存储与算向量解耦，不阻塞写入路径。
     */
    setFactEmbedding(factId: string, embedding: Float32Array): void {
        try {
            this.db.prepare("UPDATE core_facts SET embedding = ? WHERE id = ?").run(embeddingToBuffer(embedding), factId);
            this.syncFactVec(factId, embedding);
        } catch (err) {
            log.warn("setFactEmbedding 失败", { factId, error: String(err) });
        }
    }

    /** 为已存在的 topic 补写 embedding（更新 topics.embedding 列 + 同步 vec0）。 */
    setTopicEmbedding(topicId: string, chatId: string, embedding: Float32Array): void {
        try {
            this.db.prepare("UPDATE topics SET embedding = ? WHERE id = ?").run(embeddingToBuffer(embedding), topicId);
            this.syncTopicVec(topicId, chatId, embedding);
        } catch (err) {
            log.warn("setTopicEmbedding 失败", { topicId, error: String(err) });
        }
    }

    /**
     * 运维：为所有缺向量的 fact / topic 批量补 embedding。
     * 开启 embedding（embedding.enabled=true）后，对存量数据跑一次（cli memory backfill-embeddings）。
     * 未启用 embedding（无 embeddingConfig）时返回 0。分批；单批失败不致命。
     */
    async backfillEmbeddings(opts?: { batchSize?: number }): Promise<{ facts: number; topics: number }> {
        const cfg = this.embeddingConfig;
        if (!cfg) {
            log.warn("backfillEmbeddings: 未启用 embedding（无 embeddingConfig），跳过");
            return { facts: 0, topics: 0 };
        }
        const BATCH = opts?.batchSize ?? 64;

        const factRows = this.db.prepare(
            "SELECT id, subject, content FROM core_facts WHERE embedding IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))"
        ).all() as Array<{ id: string; subject: string; content: string }>;
        let factDone = 0;
        for (let i = 0; i < factRows.length; i += BATCH) {
            const chunk = factRows.slice(i, i + BATCH);
            try {
                const embs = await embed(chunk.map(r => `${r.subject}: ${r.content}`), cfg);
                chunk.forEach((r, j) => { if (embs[j]) { this.setFactEmbedding(r.id, embs[j]); factDone++; } });
            } catch (err) {
                log.warn("backfillEmbeddings facts 批失败", { error: String(err) });
            }
        }

        const topicRows = this.db.prepare(
            "SELECT id, chat_id, label, summary FROM topics WHERE embedding IS NULL AND (label != '' OR summary != '')"
        ).all() as Array<{ id: string; chat_id: string; label: string; summary: string }>;
        let topicDone = 0;
        for (let i = 0; i < topicRows.length; i += BATCH) {
            const chunk = topicRows.slice(i, i + BATCH);
            try {
                const embs = await embed(chunk.map(r => `${r.label} ${r.summary}`.trim()), cfg);
                chunk.forEach((r, j) => { if (embs[j]) { this.setTopicEmbedding(r.id, r.chat_id, embs[j]); topicDone++; } });
            } catch (err) {
                log.warn("backfillEmbeddings topics 批失败", { error: String(err) });
            }
        }

        log.info("backfillEmbeddings 完成", { facts: factDone, topics: topicDone });
        return { facts: factDone, topics: topicDone };
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

    /** 统计指定群组近 N 天的消息总数（用于 stickiness 升级评估） */
    countRecentMessages(chatId: string, days: number): number {
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const row = this.db.prepare(
            "SELECT COUNT(*) as cnt FROM message_log WHERE chat_id = ? AND timestamp >= ?"
        ).get(chatId, since) as { cnt: number } | undefined;
        return row?.cnt ?? 0;
    }

    storeMessageBatch(messages: MessageLogEntry[]): void {
        if (messages.length === 0) return;

        const insert = this.db.prepare(`
            INSERT OR IGNORE INTO message_log
                (message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp, media_type, media_info)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const batch = this.db.transaction((msgs: MessageLogEntry[]) => {
            for (const m of msgs) {
                insert.run(
                    m.messageId, m.chatId, m.userId, m.displayName,
                    m.text, m.replyToMessageId ?? null, m.timestamp,
                    m.mediaType ?? null, m.mediaInfo ?? null,
                );
            }
        });

        batch(messages);
        log.debug("storeMessageBatch", { count: messages.length });
    }

    /** 写入核心事实到 core_facts 表 */
    storeFact(
        subject: string,
        content: string,
        category: FactCategory,
        source?: string,
        expiresAt?: string,
        embedding?: Float32Array,
        confidence?: number,
        provenance?: CoreFactProvenance,
    ): string {
        const id = randomUUID();
        const ts = now();
        const conf = confidence ?? 1.0;
        this.db.prepare(`
            INSERT INTO core_facts (
                id, subject, content, category, confidence, source,
                source_chat_id, source_chat_title, source_topic_id, source_topic_label,
                source_message_ids, source_interaction_ids, observed_at, visibility, sensitivity,
                embedding, created_at, updated_at, expires_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            id, subject, content, category, conf, source ?? null,
            provenance?.sourceChatId ?? null,
            provenance?.sourceChatTitle ?? null,
            provenance?.sourceTopicId ?? null,
            provenance?.sourceTopicLabel ?? null,
            toJSON(provenance?.sourceMessageIds ?? []),
            toJSON(provenance?.sourceInteractionIds ?? []),
            provenance?.observedAt ?? ts,
            provenance?.visibility ?? "contextual",
            provenance?.sensitivity ?? "low",
            embedding ? embeddingToBuffer(embedding) : null,
            ts, ts, expiresAt ?? null,
        );

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
            if (data.username !== undefined) builder.set("username", data.username);
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

    upsertPersonProfile(userId: string, data: Partial<PersonProfile>): void {
        const ts = now();
        const existing = this.db.prepare("SELECT user_id FROM person_profiles WHERE user_id = ?").get(userId);

        if (existing) {
            const builder = new SafeUpdateBuilder("person_profiles");
            if (data.traits !== undefined) builder.set("traits", toJSON(data.traits));
            if (data.interests !== undefined) builder.set("interests", toJSON(data.interests));
            if (data.communicationStyle !== undefined) builder.set("communication_style", data.communicationStyle);
            if (data.relationToAgent !== undefined) builder.set("relation_to_agent", data.relationToAgent);
            if (data.stablePatterns !== undefined) builder.set("stable_patterns", toJSON(data.stablePatterns));
            if (data.agentPolicyHints !== undefined) builder.set("agent_policy_hints", toJSON(data.agentPolicyHints));
            if (data.followupCandidates !== undefined) builder.set("followup_candidates", toJSON(data.followupCandidates));
            if (data.sourceChatIds !== undefined) builder.set("source_chat_ids", toJSON(data.sourceChatIds));
            if (data.confidence !== undefined) builder.set("confidence", data.confidence);
            if (data.lastReflectedAt !== undefined) builder.set("last_reflected_at", data.lastReflectedAt);
            builder.set("updated_at", ts);
            builder.where("user_id", userId);

            const { sql, params } = builder.build();
            this.db.prepare(sql).run(...params);
            log.debug("upsertPersonProfile: UPDATE", { userId });
        } else {
            this.db.prepare(`
                INSERT INTO person_profiles (
                    user_id, traits, interests, communication_style, relation_to_agent,
                    stable_patterns, agent_policy_hints, followup_candidates,
                    source_chat_ids, confidence, last_reflected_at, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                userId,
                toJSON(data.traits),
                toJSON(data.interests),
                data.communicationStyle ?? "",
                data.relationToAgent ?? "",
                toJSON(data.stablePatterns),
                toJSON(data.agentPolicyHints),
                toJSON(data.followupCandidates),
                toJSON(data.sourceChatIds),
                data.confidence ?? 0,
                data.lastReflectedAt ?? null,
                data.createdAt ?? ts,
                ts,
            );
            log.debug("upsertPersonProfile: INSERT", { userId });
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
            if (data.affinityScore !== undefined) builder.set("affinity_score", data.affinityScore);
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

        // 同步更新 person_identities.total_message_count
        if (stats.messageCountDelta > 0) {
            this.db.prepare(`
                UPDATE person_identities
                SET total_message_count = total_message_count + ?,
                    updated_at = ?
                WHERE user_id = ?
            `).run(stats.messageCountDelta, ts, userId);
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
            if (data.isDirectMessage !== undefined) builder.set("is_direct_message", data.isDirectMessage ? 1 : 0);
            if (data.markedSensitive !== undefined) builder.set("marked_sensitive", data.markedSensitive ? 1 : 0);
            if (data.sensitiveReason !== undefined) builder.set("sensitive_reason", data.sensitiveReason);
            if (data.sensitiveAt !== undefined) builder.set("sensitive_at", data.sensitiveAt);
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
                    last_reflected_at, is_direct_message, marked_sensitive, sensitive_reason, sensitive_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                data.isDirectMessage ? 1 : 0,
                data.markedSensitive ? 1 : 0,
                data.sensitiveReason ?? null,
                data.sensitiveAt ?? null,
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
            isDirectMessage: !!(row.is_direct_message as number),
            markedSensitive: !!(row.marked_sensitive as number),
            sensitiveReason: (row.sensitive_reason as string) ?? undefined,
            sensitiveAt: (row.sensitive_at as string) ?? null,
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

    /**
     * 将某会话标记为敏感/私密（append-only：只置 true、幂等、无取消路径）。
     * 写到规范化的 GroupModel key（Discord channel→guild），使全体 GroupModel 读者（reflection /
     * recording / getChatVisibility）都能看到，且对同 guild 的所有频道一致生效。
     * 已标记则直接幂等返回；不会覆盖已有原因/时间。
     */
    markChatSensitive(chatId: string, reason?: string): GroupModel | null {
        const key = safeGroupModelKey(chatId);
        const existing = this.getGroupModel(key);
        if (existing?.markedSensitive) {
            return existing; // 幂等：已敏感则不重复写
        }
        this.upsertGroupModel(key, {
            markedSensitive: true,
            sensitiveReason: reason?.trim() || existing?.sensitiveReason || "runtime marked sensitive",
            sensitiveAt: now(),
        });
        log.info("markChatSensitive", { chatId, key, reason: reason?.slice(0, 120) });
        return this.getGroupModel(key);
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
            username: (row.username as string) ?? undefined,
            aliases: fromJSON(row.aliases as string, []),
            totalMessageCount: row.total_message_count as number,
            lastSeenAt: row.last_seen_at as string,
            firstSeenAt: row.first_seen_at as string,
            updatedAt: row.updated_at as string,
        };
    }

    getPersonProfile(userId: string): PersonProfile | null {
        const row = this.db.prepare("SELECT * FROM person_profiles WHERE user_id = ?").get(userId) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
            userId: row.user_id as string,
            traits: fromJSON<string[]>(row.traits as string, []),
            interests: fromJSON<string[]>(row.interests as string, []),
            communicationStyle: (row.communication_style as string) ?? "",
            relationToAgent: (row.relation_to_agent as string) ?? "",
            stablePatterns: fromJSON<string[]>(row.stable_patterns as string, []),
            agentPolicyHints: fromJSON<string[]>(row.agent_policy_hints as string, []),
            followupCandidates: fromJSON<string[]>(row.followup_candidates as string, []),
            sourceChatIds: fromJSON<string[]>(row.source_chat_ids as string, []),
            confidence: (row.confidence as number) ?? 0,
            lastReflectedAt: (row.last_reflected_at as string) ?? null,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
        };
    }

    searchByAlias(query: string, limit: number = 10): PersonIdentity[] {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (!normalizedQuery) return [];
        const candidateLimit = Math.min(Math.max(limit * 5, limit), 200);
        const rows = this.db.prepare(
            `SELECT * FROM person_identities
             WHERE user_id = ?
                OR display_name LIKE '%' || ? || '%'
                OR username LIKE '%' || ? || '%'
                OR aliases LIKE '%' || ? || '%'
             LIMIT ?`
        ).all(query, query, query, query, candidateLimit) as Record<string, unknown>[];
        return rows
            .map(row => ({
                userId: row.user_id as string,
                displayName: row.display_name as string,
                username: (row.username as string) ?? undefined,
                aliases: fromJSON(row.aliases as string, []),
                totalMessageCount: row.total_message_count as number,
                lastSeenAt: row.last_seen_at as string,
                firstSeenAt: row.first_seen_at as string,
                updatedAt: row.updated_at as string,
            }))
            .sort((left, right) =>
                identityAliasScore(right, normalizedQuery) - identityAliasScore(left, normalizedQuery)
                || right.totalMessageCount - left.totalMessageCount
                || right.lastSeenAt.localeCompare(left.lastSeenAt)
            )
            .slice(0, limit);
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
    ): Array<{ id: string; content: string; category: FactCategory; subject: string; confidence: number; similarity: number; visibility?: "private" | "contextual" | "public"; sourceChatId?: string | null }> {
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

                const result: Array<{ id: string; content: string; category: FactCategory; subject: string; confidence: number; similarity: number; visibility?: "private" | "contextual" | "public"; sourceChatId?: string | null }> = [];
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
                            visibility: (row.visibility as "private" | "contextual" | "public") ?? undefined,
                            sourceChatId: (row.source_chat_id as string | null) ?? null,
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
                visibility: (row.visibility as "private" | "contextual" | "public") ?? undefined,
                sourceChatId: (row.source_chat_id as string | null) ?? null,
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

    /** 本地 SQLite 语义检索（向量 + FTS5 + LIKE 三级回退）。 */
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
        let persons = this.resolvePersonsFromTopics(topics);

        // 直接按 userId 查询（memory.md §4.4 Step 4）
        if (options?.userId) {
            const hasUser = persons.some(p => p.userId === options.userId);
            if (!hasUser) {
                if (options.chatId) {
                    const directProfile = this.getProfilesForChat(options.chatId)
                        .find(p => p.userId === options.userId);
                    if (directProfile) persons = [directProfile, ...persons];
                } else {
                    // 无 chatId 限定时查全部群的 profile
                    try {
                        const chatIds = this.db.prepare(
                            "SELECT DISTINCT chat_id FROM person_group_profiles WHERE user_id = ? LIMIT 5"
                        ).all(options.userId) as { chat_id: string }[];
                        for (const { chat_id } of chatIds) {
                            const profile = this.getProfilesForChat(chat_id)
                                .find(p => p.userId === options!.userId);
                            if (profile && !persons.some(e => e.userId === profile.userId && e.chatId === profile.chatId)) {
                                persons.push(profile);
                            }
                        }
                    } catch (err) {
                        log.debug("recall: userId 全局查询失败", { userId: options.userId, error: String(err) });
                    }
                }
            }
        }

        // ─── deep summary（如结果超阈值且有 cheapLlmConfig） ───
        let deepSummary: string | undefined;
        const threshold = options?.deepRecallThreshold ?? 2000;
        const totalTokens = this.estimateRecallTokens(topics, facts);
        if (totalTokens > threshold && resolveComponentProfiles("memory").length > 0) {
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
                        affinityScore: (r.affinity_score as number) ?? 0,
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
        const memoryConfigs = resolveComponentProfiles("memory");
        if (!memoryConfigs.length) throw new Error("No memory LLM config");

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

        const response = await callLLMWithFallback(messages, memoryConfigs, { caller: "memory", timeoutMs: resolveComponentTimeout("memory") });
        return response.content.trim();
    }

    async browseHistory(request: HistoryBrowseRequest): Promise<HistoryBrowseResult> {
        const segments: HistoryBrowseResult["segments"] = [];
        const contextWindow = request.contextWindow ?? 10;
        const maxSegments = request.maxSegments ?? 3;

        // ─── Step 1: 意图解析（LLM 或 fallback） ───
        let keywords: string[];
        let parsedHints = { ...request.hints };

        if (resolveComponentProfiles("memory").length > 0 && !request.hints?.topicId) {
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
        if (resolveComponentProfiles("memory").length > 0 && segments.length > 0 && totalMessagesRead > 0) {
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
        const memoryConfigs = resolveComponentProfiles("memory");
        if (!memoryConfigs.length) throw new Error("No memory LLM config");

        const messages: ChatMessage[] = [
            { role: "system", content: getBrowseIntentParsePrompt() },
            { role: "user", content: intent },
        ];

        const response = await callLLMWithFallback(messages, memoryConfigs, { caller: "memory", timeoutMs: resolveComponentTimeout("memory") });
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
        const memoryConfigs = resolveComponentProfiles("memory");
        if (!memoryConfigs.length) throw new Error("No memory LLM config");

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

        const response = await callLLMWithFallback(messages, memoryConfigs, { caller: "memory", timeoutMs: resolveComponentTimeout("memory") });
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

    getRecentTopics(chatId: string, limit: number = 20): TopicNode[] {
        const rows = this.db.prepare(
            "SELECT * FROM topics WHERE chat_id = ? ORDER BY started_at DESC LIMIT ?"
        ).all(chatId, limit) as Record<string, unknown>[];
        log.debug("getRecentTopics", { chatId, limit, count: rows.length });
        // 返回按时间正序（旧→新），与 getTopicsSince 行为一致
        return rows.map(r => this.rowToTopicNode(r)).reverse();
    }

    getTopicById(topicId: string): TopicNode | null {
        const row = this.db.prepare("SELECT * FROM topics WHERE id = ? LIMIT 1").get(topicId) as Record<string, unknown> | undefined;
        return row ? this.rowToTopicNode(row) : null;
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

    /**
     * 统计指定 chatId 中每个用户在最近 N 天内的互动次数（DIRECT_ADDRESS 逻辑）
     * 互动类型: direct_message, agent_mentioned, agent_replied
     * 同时统计每个用户的活跃天数
     */
    countInteractionsPerUser(chatId: string, days: number = 30): Map<string, { interactionCount: number; activeDays: number; lastInteractionAt: string | null }> {
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const rows = this.db.prepare(`
            SELECT user_id, COUNT(*) as cnt, COUNT(DISTINCT DATE(created_at)) as active_days, MAX(created_at) as last_at
            FROM interactions
            WHERE chat_id = ?
              AND created_at >= ?
              AND type IN ('direct_message', 'agent_mentioned', 'agent_replied')
            GROUP BY user_id
        `).all(chatId, since) as { user_id: string; cnt: number; active_days: number; last_at: string }[];

        const result = new Map<string, { interactionCount: number; activeDays: number; lastInteractionAt: string | null }>();
        for (const r of rows) {
            result.set(r.user_id, {
                interactionCount: r.cnt,
                activeDays: r.active_days,
                lastInteractionAt: r.last_at ?? null,
            });
        }
        return result;
    }

    /**
     * 统计最近 N 天每个 chat 与 agent 的互动次数（DIRECT_ADDRESS 逻辑）
     * 互动类型: direct_message, agent_mentioned, agent_replied
     */
    countInteractionsPerChat(days: number = 7): Map<string, { interactionCount: number; activeDays: number; lastInteractionAt: string | null }> {
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const rows = this.db.prepare(`
            SELECT chat_id, COUNT(*) as cnt, COUNT(DISTINCT DATE(created_at)) as active_days, MAX(created_at) as last_at
            FROM interactions
            WHERE created_at >= ?
              AND chat_id <> ''
              AND type IN ('direct_message', 'agent_mentioned', 'agent_replied')
            GROUP BY chat_id
        `).all(since) as { chat_id: string; cnt: number; active_days: number; last_at: string }[];

        const result = new Map<string, { interactionCount: number; activeDays: number; lastInteractionAt: string | null }>();
        for (const r of rows) {
            result.set(r.chat_id, {
                interactionCount: r.cnt,
                activeDays: r.active_days,
                lastInteractionAt: r.last_at ?? null,
            });
        }
        return result;
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
            affinityScore: (r.affinity_score as number) ?? 0,
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
            `SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp, media_type, media_info
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
            mediaType: (row.media_type as string) ?? undefined,
            mediaInfo: (row.media_info as string) ?? undefined,
        }));
    }

    searchFacts(query: string, options: {
        subject?: string;
        categories?: FactCategory[];
        limit?: number;
    } = {}): FactSearchResult[] {
        const ftsQuery = buildFtsOrQuery(query);
        if (!ftsQuery) return [];

        const limit = Math.min(Math.max(options.limit ?? 10, 1), 50);
        const sql = [
            `SELECT cf.id, cf.subject, cf.category, cf.content, cf.confidence,
                    cf.source_chat_id, cf.source_chat_title, cf.source_topic_id, cf.source_topic_label,
                    cf.source_message_ids, cf.source_interaction_ids, cf.observed_at,
                    cf.visibility, cf.sensitivity, cf.updated_at`,
            "FROM core_facts cf",
            "INNER JOIN core_facts_fts fts ON cf.rowid = fts.rowid",
            "WHERE core_facts_fts MATCH ?",
            "AND (cf.expires_at IS NULL OR cf.expires_at > datetime('now'))",
        ];
        const params: unknown[] = [ftsQuery];

        if (options.subject) {
            sql.push("AND cf.subject = ?");
            params.push(options.subject);
        }
        if (options.categories?.length) {
            sql.push(`AND cf.category IN (${options.categories.map(() => "?").join(", ")})`);
            params.push(...options.categories);
        }

        sql.push("ORDER BY bm25(core_facts_fts)");
        sql.push("LIMIT ?");
        params.push(limit);

        const rows = this.db.prepare(sql.join(" ")).all(...params) as Array<Record<string, unknown>>;
        return rows.map((row) => ({
            factId: row.id as string,
            subject: row.subject as string,
            category: row.category as FactCategory,
            content: row.content as string,
            confidence: row.confidence as number,
            sourceChatId: (row.source_chat_id as string) ?? null,
            sourceChatTitle: (row.source_chat_title as string) ?? null,
            sourceTopicId: (row.source_topic_id as string) ?? null,
            sourceTopicLabel: (row.source_topic_label as string) ?? null,
            sourceMessageIds: fromJSON<string[]>(row.source_message_ids as string, []),
            sourceInteractionIds: fromJSON<string[]>(row.source_interaction_ids as string, []),
            observedAt: (row.observed_at as string) ?? null,
            visibility: ((row.visibility as string) ?? "contextual") as FactSearchResult["visibility"],
            sensitivity: ((row.sensitivity as string) ?? "low") as FactSearchResult["sensitivity"],
            updatedAt: row.updated_at as string,
        }));
    }

    searchTopics(query: string, options: {
        chatId?: string;
        after?: string;
        before?: string;
        excludeTopicIds?: string[];
        limit?: number;
    } = {}): TopicSearchResult[] {
        const ftsQuery = buildFtsOrQuery(query);
        const limit = Math.min(Math.max(options.limit ?? 5, 1), 30);

        // ── 查询时解析人名 → userId，用于按参与者搜索 ──
        const terms = query.split(/\s+/).map(t => t.replace(/"/g, "").trim()).filter(Boolean);
        const participantUserIds: string[] = [];
        for (const term of terms) {
            if (term.length < 2) continue;
            const matches = this.searchByAlias(term, 3);
            for (const m of matches) {
                if (!participantUserIds.includes(m.userId)) {
                    participantUserIds.push(m.userId);
                }
            }
        }

        // ── 构建条件子句 ──
        const whereClauses: string[] = [];
        const params: unknown[] = [];

        // 条件组合: FTS 匹配 OR 参与者匹配
        const orConditions: string[] = [];

        if (ftsQuery) {
            orConditions.push("t.rowid IN (SELECT rowid FROM topics_fts WHERE topics_fts MATCH ?)");
            params.push(ftsQuery);
        }

        if (participantUserIds.length > 0) {
            const likeClauses = participantUserIds.map(() => "t.participants LIKE ?");
            orConditions.push(`(${likeClauses.join(" OR ")})`);
            params.push(...participantUserIds.map(uid => `%${uid}%`));
        }

        // 如果 FTS 和参与者都没有匹配条件，返回空
        if (orConditions.length === 0) return [];

        whereClauses.push(`(${orConditions.join(" OR ")})`);

        if (options.chatId) {
            whereClauses.push("t.chat_id = ?");
            params.push(options.chatId);
        }
        if (options.after) {
            whereClauses.push("t.started_at >= ?");
            params.push(options.after);
        }
        if (options.before) {
            whereClauses.push("t.started_at <= ?");
            params.push(options.before);
        }
        if (options.excludeTopicIds?.length) {
            whereClauses.push(`t.id NOT IN (${options.excludeTopicIds.map(() => "?").join(", ")})`);
            params.push(...options.excludeTopicIds);
        }

        const sql = [
            "SELECT t.*",
            "FROM topics t",
            `WHERE ${whereClauses.join(" AND ")}`,
            "ORDER BY t.started_at DESC",
            "LIMIT ?",
        ];
        params.push(limit);

        const rows = this.db.prepare(sql.join(" ")).all(...params) as Array<Record<string, unknown>>;
        return rows.map((row) => {
            const topic = this.rowToTopicNode(row);
            return {
                topicId: topic.id,
                chatId: topic.chatId,
                label: topic.label,
                summary: topic.summary,
                keywords: topic.keywords,
                participants: topic.participants,
                startedAt: topic.startedAt,
                endedAt: topic.endedAt,
                sentiment: topic.sentiment,
                callbackPotential: topic.callbackPotential ?? 0,
                associatedMemories: topic.associatedMemories ?? [],
            };
        });
    }

    searchMessages(query: string, options: {
        chatId?: string;
        userId?: string;
        after?: string;
        before?: string;
        limit?: number;
    } = {}): MessageSearchResult[] {
        const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
        const conditions = ["text LIKE ?"];
        const params: unknown[] = [`%${query}%`];

        if (options.chatId) {
            conditions.push("chat_id = ?");
            params.push(options.chatId);
        }
        if (options.userId) {
            conditions.push("user_id = ?");
            params.push(options.userId);
        }
        if (options.after) {
            conditions.push("timestamp >= ?");
            params.push(options.after);
        }
        if (options.before) {
            conditions.push("timestamp <= ?");
            params.push(options.before);
        }

        params.push(limit);
        const rows = this.db.prepare(`
            SELECT message_id, chat_id, user_id, display_name, text, timestamp
            FROM message_log
            WHERE ${conditions.join(" AND ")}
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(...params) as Array<Record<string, unknown>>;

        return rows.map((row) => ({
            messageId: row.message_id as string,
            chatId: row.chat_id as string,
            userId: row.user_id as string,
            displayName: (row.display_name as string) ?? "",
            content: (row.text as string) ?? "",
            timestamp: row.timestamp as string,
        }));
    }

    queryMessages(options: {
        chatIds?: string[];
        userIds?: string[];
        displayNameLike?: string;
        textLike?: string;
        after?: string;
        before?: string;
        limit?: number;
    } = {}): MessageSearchResult[] {
        const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
        const conditions: string[] = [];
        const params: unknown[] = [];

        const chatIds = [...new Set((options.chatIds ?? []).map(String).filter(Boolean))];
        if (chatIds.length > 0) {
            conditions.push(`chat_id IN (${chatIds.map(() => "?").join(", ")})`);
            params.push(...chatIds);
        }

        const userIds = [...new Set((options.userIds ?? []).map(String).filter(Boolean))];
        if (userIds.length > 0) {
            conditions.push(`user_id IN (${userIds.map(() => "?").join(", ")})`);
            params.push(...userIds);
        }

        const displayNameLike = options.displayNameLike?.trim();
        if (displayNameLike) {
            conditions.push("display_name LIKE ?");
            params.push(`%${displayNameLike}%`);
        }

        const textLike = options.textLike?.trim();
        if (textLike) {
            conditions.push("text LIKE ?");
            params.push(`%${textLike}%`);
        }

        if (options.after) {
            conditions.push("timestamp >= ?");
            params.push(options.after);
        }
        if (options.before) {
            conditions.push("timestamp <= ?");
            params.push(options.before);
        }

        params.push(limit);
        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const rows = this.db.prepare(`
            SELECT message_id, chat_id, user_id, display_name, text, timestamp, media_type, media_info
            FROM message_log
            ${where}
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(...params) as Array<Record<string, unknown>>;

        return rows.map((row) => ({
            messageId: row.message_id as string,
            chatId: row.chat_id as string,
            userId: row.user_id as string,
            displayName: (row.display_name as string) ?? "",
            content: (row.text as string) ?? "",
            timestamp: row.timestamp as string,
            mediaType: (row.media_type as string) ?? undefined,
            mediaInfo: (row.media_info as string) ?? undefined,
        }));
    }

    getUserProfile(userId: string, chatId?: string): UserProfileSearchResult {
        const identity = this.getPersonIdentity(userId);
        const globalProfile = this.getPersonProfile(userId);
        const groupProfile = chatId
            ? this.getProfilesForChat(chatId).find((profile) => profile.userId === userId) ?? null
            : null;
        const recentFacts = this.db.prepare(`
            SELECT id, subject, category, content, confidence,
                   source_chat_id, source_chat_title, source_topic_id, source_topic_label,
                   source_message_ids, source_interaction_ids, observed_at,
                   visibility, sensitivity, updated_at
            FROM core_facts
            WHERE subject = ?
              AND (expires_at IS NULL OR expires_at > datetime('now'))
            ORDER BY updated_at DESC
            LIMIT 5
        `).all(userId) as Array<Record<string, unknown>>;

        return {
            identity,
            globalProfile,
            groupProfile,
            recentFacts: recentFacts.map((row) => ({
                factId: row.id as string,
                subject: row.subject as string,
                category: row.category as FactCategory,
                content: row.content as string,
                confidence: row.confidence as number,
                sourceChatId: (row.source_chat_id as string) ?? null,
                sourceChatTitle: (row.source_chat_title as string) ?? null,
                sourceTopicId: (row.source_topic_id as string) ?? null,
                sourceTopicLabel: (row.source_topic_label as string) ?? null,
                sourceMessageIds: fromJSON<string[]>(row.source_message_ids as string, []),
                sourceInteractionIds: fromJSON<string[]>(row.source_interaction_ids as string, []),
                observedAt: (row.observed_at as string) ?? null,
                visibility: ((row.visibility as string) ?? "contextual") as FactSearchResult["visibility"],
                sensitivity: ((row.sensitivity as string) ?? "low") as FactSearchResult["sensitivity"],
                updatedAt: row.updated_at as string,
            })),
        };
    }

    getRecentInteractions(chatId?: string | null, userId?: string, limit: number = 10): InteractionSearchResult[] {
        const boundedLimit = Math.min(Math.max(limit ?? 10, 1), 50);
        const conditions: string[] = [];
        const params: unknown[] = [];

        if (chatId) {
            conditions.push("chat_id = ?");
            params.push(chatId);
        }
        if (userId) {
            conditions.push("user_id = ?");
            params.push(userId);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        params.push(boundedLimit);
        const rows = this.db.prepare(`
            SELECT chat_id, user_id, type, summary, sentiment, significance, created_at
            FROM interactions
            ${where}
            ORDER BY created_at DESC
            LIMIT ?
        `).all(...params);

        return (rows as Array<Record<string, unknown>>).map((row) => ({
            timestamp: row.created_at as string,
            chatId: row.chat_id as string,
            userId: row.user_id as string,
            type: row.type as string,
            summary: row.summary as string,
            sentiment: ((row.sentiment as string) ?? "neutral") as InteractionSearchResult["sentiment"],
            significance: (row.significance as number) ?? 0.5,
        }));
    }

    // ── 单条消息查询 ──

    getMessageById(chatId: string, messageId: string): RecentMessageEntry | null {
        const row = this.db.prepare(
            `SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp, media_type, media_info
             FROM message_log
             WHERE chat_id = ? AND message_id = ?
             LIMIT 1`
        ).get(chatId, messageId) as Record<string, unknown> | undefined;

        if (!row) return null;

        return {
            messageId: row.message_id as string,
            chatId: row.chat_id as string,
            userId: row.user_id as string,
            displayName: (row.display_name as string) ?? "",
            text: (row.text as string) ?? "",
            replyToMessageId: (row.reply_to_message_id as string) ?? undefined,
            timestamp: row.timestamp as string,
            mediaType: (row.media_type as string) ?? undefined,
            mediaInfo: (row.media_info as string) ?? undefined,
        };
    }

    /**
     * 获取指定消息的回复链，并带上每个节点的上下文（如同发信人前后的连续发言）
     * @param maxDepth 最大追溯层数
     * @param limitPerNode 每侧提取的最大前后连续消息数量
     */
    getReplyChainWithContext(chatId: string, messageId: string, maxDepth: number = 10, limitPerNode: number = 2): RecentMessageEntry[] {
        const results = new Map<string, RecentMessageEntry>();
        let currentMsgId: string | undefined = messageId;
        let depth = 0;

        while (currentMsgId && depth < maxDepth) {
            const parent = this.getMessageById(chatId, currentMsgId);
            if (!parent) break;

            if (!results.has(parent.messageId)) {
                results.set(parent.messageId, parent);

                try {
                    // 查询该发件人在 parent 消息之前的 N 条发言
                    const beforeCtx = this.db.prepare(`
                        SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp, media_type, media_info
                        FROM message_log 
                        WHERE chat_id = ? AND user_id = ? AND timestamp <= ?
                        ORDER BY timestamp DESC
                        LIMIT ?
                    `).all(chatId, parent.userId, parent.timestamp, limitPerNode + 1) as Record<string, unknown>[];

                    // 查询该发件人在 parent 消息之后的 N 条发言
                    const afterCtx = this.db.prepare(`
                        SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp, media_type, media_info
                        FROM message_log 
                        WHERE chat_id = ? AND user_id = ? AND timestamp > ?
                        ORDER BY timestamp ASC
                        LIMIT ?
                    `).all(chatId, parent.userId, parent.timestamp, limitPerNode) as Record<string, unknown>[];

                    for (const row of [...beforeCtx, ...afterCtx]) {
                        const mid = row.message_id as string;
                        if (!results.has(mid)) {
                            results.set(mid, {
                                messageId: mid,
                                chatId: row.chat_id as string,
                                userId: row.user_id as string,
                                displayName: (row.display_name as string) ?? "",
                                text: (row.text as string) ?? "",
                                replyToMessageId: (row.reply_to_message_id as string) ?? undefined,
                                timestamp: row.timestamp as string,
                                mediaType: (row.media_type as string) ?? undefined,
                                mediaInfo: (row.media_info as string) ?? undefined,
                            });
                        }
                    }
                } catch {
                    // 发生解析异常时不中断主流程
                }
            }

            currentMsgId = parent.replyToMessageId;
            depth++;
        }

        return Array.from(results.values());
    }

    /** 批量按 messageId 获取消息（保持 messageIds 顺序） */
    getMessagesByIds(chatId: string, messageIds: string[]): RecentMessageEntry[] {
        if (messageIds.length === 0) return [];

        const result: RecentMessageEntry[] = [];
        // 分批避免 SQLite IN 参数过多
        const CHUNK = 200;
        const byId = new Map<string, RecentMessageEntry>();

        for (let i = 0; i < messageIds.length; i += CHUNK) {
            const chunk = messageIds.slice(i, i + CHUNK);
            const placeholders = chunk.map(() => "?").join(", ");
            const rows = this.db.prepare(
                `SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp, media_type, media_info
                 FROM message_log
                 WHERE chat_id = ? AND message_id IN (${placeholders})`
            ).all(chatId, ...chunk) as Record<string, unknown>[];

            for (const row of rows) {
                const entry: RecentMessageEntry = {
                    messageId: row.message_id as string,
                    chatId: row.chat_id as string,
                    userId: row.user_id as string,
                    displayName: (row.display_name as string) ?? "",
                    text: (row.text as string) ?? "",
                    replyToMessageId: (row.reply_to_message_id as string) ?? undefined,
                    timestamp: row.timestamp as string,
                    mediaType: (row.media_type as string) ?? undefined,
                    mediaInfo: (row.media_info as string) ?? undefined,
                };
                byId.set(entry.messageId, entry);
            }
        }

        // 按原始顺序返回
        for (const id of messageIds) {
            const entry = byId.get(id);
            if (entry) result.push(entry);
        }

        log.debug("getMessagesByIds", { chatId, requested: messageIds.length, found: result.length });
        return result;
    }

    /** 按起止 messageId 重建一段时间连续的消息窗口（包含 agent 自己落盘的消息）。 */
    getMessagesBetweenIds(chatId: string, startMessageId: string, endMessageId: string): RecentMessageEntry[] {
        const start = this.getMessageById(chatId, startMessageId);
        const end = this.getMessageById(chatId, endMessageId);
        if (!start || !end) {
            log.debug("getMessagesBetweenIds: boundary not found", {
                chatId,
                startMessageId,
                endMessageId,
                hasStart: !!start,
                hasEnd: !!end,
            });
            return [];
        }

        const from = start.timestamp <= end.timestamp ? start.timestamp : end.timestamp;
        const to = start.timestamp <= end.timestamp ? end.timestamp : start.timestamp;
        const rows = this.db.prepare(
            `SELECT message_id, chat_id, user_id, display_name, text, reply_to_message_id, timestamp, media_type, media_info
             FROM message_log
             WHERE chat_id = ?
               AND timestamp >= ?
               AND timestamp <= ?
             ORDER BY timestamp ASC, rowid ASC`
        ).all(chatId, from, to) as Record<string, unknown>[];

        const result = rows.map((row): RecentMessageEntry => ({
            messageId: row.message_id as string,
            chatId: row.chat_id as string,
            userId: row.user_id as string,
            displayName: (row.display_name as string) ?? "",
            text: (row.text as string) ?? "",
            replyToMessageId: (row.reply_to_message_id as string) ?? undefined,
            timestamp: row.timestamp as string,
            mediaType: (row.media_type as string) ?? undefined,
            mediaInfo: (row.media_info as string) ?? undefined,
        }));

        log.debug("getMessagesBetweenIds", {
            chatId,
            startMessageId,
            endMessageId,
            count: result.length,
        });
        return result;
    }

    // ── Sticker 描述缓存 ──

    private getStickerDescriptionRow(uniqueFileId: string, contentHash?: string): { unique_file_id: string; description: string; emoji?: string | null; emojis?: string | null; content_hash?: string | null } | null {
        if (contentHash) {
            const byHash = this.db.prepare(
                "SELECT unique_file_id, description, emoji, emojis, content_hash FROM sticker_descriptions WHERE content_hash = ? LIMIT 1"
            ).get(contentHash) as { unique_file_id: string; description: string; emoji?: string | null; emojis?: string | null; content_hash?: string | null } | undefined;
            if (byHash) return byHash;
        }

        const direct = this.db.prepare(
            "SELECT unique_file_id, description, emoji, emojis, content_hash FROM sticker_descriptions WHERE unique_file_id = ?"
        ).get(uniqueFileId) as { unique_file_id: string; description: string; emoji?: string | null; emojis?: string | null; content_hash?: string | null } | undefined;
        if (direct) return direct;

        const alias = this.db.prepare(`
            SELECT sd.unique_file_id, sd.description, sd.emoji, sd.emojis, sd.content_hash
            FROM sticker_file_aliases a
            JOIN sticker_descriptions sd ON sd.content_hash = a.content_hash
            WHERE a.unique_file_id = ?
            LIMIT 1
        `).get(uniqueFileId) as { unique_file_id: string; description: string; emoji?: string | null; emojis?: string | null; content_hash?: string | null } | undefined;
        return alias ?? null;
    }

    private resolveStickerDescriptionKey(uniqueFileId: string): string {
        return this.getStickerDescriptionRow(uniqueFileId)?.unique_file_id ?? uniqueFileId;
    }

    linkStickerContent(uniqueFileId: string, contentHash: string): void {
        const ts = now();
        this.db.prepare(`
            INSERT OR REPLACE INTO sticker_file_aliases (unique_file_id, content_hash, created_at)
            VALUES (?, ?, ?)
        `).run(uniqueFileId, contentHash, ts);

        const direct = this.db.prepare(
            "SELECT unique_file_id, content_hash FROM sticker_descriptions WHERE unique_file_id = ?"
        ).get(uniqueFileId) as { unique_file_id: string; content_hash?: string | null } | undefined;
        if (!direct || direct.content_hash) return;

        const existingCanonical = this.db.prepare(
            "SELECT unique_file_id FROM sticker_descriptions WHERE content_hash = ?"
        ).get(contentHash) as { unique_file_id: string } | undefined;
        if (existingCanonical) return;

        this.db.prepare(
            "UPDATE sticker_descriptions SET content_hash = ? WHERE unique_file_id = ?"
        ).run(contentHash, uniqueFileId);
    }

    getStickerDescription(uniqueFileId: string, contentHash?: string): { description: string; emoji?: string; emojis?: string[] } | null {
        const row = this.getStickerDescriptionRow(uniqueFileId, contentHash);
        if (!row) return null;
        const emojis = normalizeStoredEmojis(row.emojis ?? undefined, row.emoji ?? undefined);
        return {
            description: row.description,
            emoji: emojis[0] ?? row.emoji ?? undefined,
            emojis,
        };
    }

    setStickerDescription(uniqueFileId: string, description: string, emoji?: string | string[], enabled?: boolean, contentHash?: string): void {
        const ts = now();
        const enabledValue = enabled === false ? 0 : 1;
        const emojis = normalizeEmojiCandidates(emoji);
        const primaryEmoji = emojis[0] ?? (typeof emoji === "string" ? emoji : undefined);
        const storedEmojis = emojis.length > 0 ? toJSON(emojis) : null;

        if (contentHash) {
            const saveByContent = this.db.transaction(() => {
                this.db.prepare(`
                    INSERT OR REPLACE INTO sticker_file_aliases (unique_file_id, content_hash, created_at)
                    VALUES (?, ?, ?)
                `).run(uniqueFileId, contentHash, ts);

                const canonical = this.db.prepare(
                    "SELECT unique_file_id FROM sticker_descriptions WHERE content_hash = ? LIMIT 1"
                ).get(contentHash) as { unique_file_id: string } | undefined;
                if (canonical) {
                    this.db.prepare(`
                        UPDATE sticker_descriptions
                        SET description = ?, emoji = ?, emojis = ?, enabled = ?, created_at = ?
                        WHERE unique_file_id = ?
                    `).run(description, primaryEmoji ?? null, storedEmojis, enabledValue, ts, canonical.unique_file_id);
                    return canonical.unique_file_id;
                }

                this.db.prepare(`
                    INSERT OR REPLACE INTO sticker_descriptions (unique_file_id, description, emoji, emojis, enabled, created_at, content_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(uniqueFileId, description, primaryEmoji ?? null, storedEmojis, enabledValue, ts, contentHash);
                return uniqueFileId;
            });
            const canonicalUniqueFileId = saveByContent();
            log.debug("setStickerDescription", { uniqueFileId, canonicalUniqueFileId, contentHash, emoji: primaryEmoji, emojis, enabled: enabledValue, descPreview: description.slice(0, 50) });
            return;
        }

        const canonicalUniqueFileId = this.resolveStickerDescriptionKey(uniqueFileId);
        const existing = this.db.prepare(
            "SELECT content_hash FROM sticker_descriptions WHERE unique_file_id = ?"
        ).get(canonicalUniqueFileId) as { content_hash?: string | null } | undefined;
        this.db.prepare(`
            INSERT OR REPLACE INTO sticker_descriptions (unique_file_id, description, emoji, emojis, enabled, created_at, content_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(canonicalUniqueFileId, description, primaryEmoji ?? null, storedEmojis, enabledValue, ts, existing?.content_hash ?? null);
        log.debug("setStickerDescription", { uniqueFileId, canonicalUniqueFileId, emoji: primaryEmoji, emojis, enabled: enabledValue, descPreview: description.slice(0, 50) });
    }

    getAllStickerDescriptions(): Array<{ uniqueFileId: string; description: string; emoji?: string; emojis?: string[]; enabled: boolean; createdAt: string }> {
        const rows = this.db.prepare(
            "SELECT unique_file_id, description, emoji, emojis, enabled, created_at FROM sticker_descriptions ORDER BY created_at DESC"
        ).all() as Array<{ unique_file_id: string; description: string; emoji?: string; emojis?: string; enabled: number; created_at: string }>;
        return rows.map(r => {
            const emojis = normalizeStoredEmojis(r.emojis, r.emoji);
            return {
                uniqueFileId: r.unique_file_id,
                description: r.description,
                emoji: emojis[0] ?? r.emoji ?? undefined,
                emojis,
                enabled: r.enabled !== 0,
                createdAt: r.created_at,
            };
        });
    }

    deleteStickerDescription(uniqueFileId: string): boolean {
        const canonicalUniqueFileId = this.resolveStickerDescriptionKey(uniqueFileId);
        const row = this.db.prepare(
            "SELECT content_hash FROM sticker_descriptions WHERE unique_file_id = ?"
        ).get(canonicalUniqueFileId) as { content_hash?: string | null } | undefined;
        const result = this.db.prepare(
            "DELETE FROM sticker_descriptions WHERE unique_file_id = ?"
        ).run(canonicalUniqueFileId);
        if (row?.content_hash) {
            this.db.prepare("DELETE FROM sticker_file_aliases WHERE content_hash = ?").run(row.content_hash);
        } else {
            this.db.prepare("DELETE FROM sticker_file_aliases WHERE unique_file_id = ?").run(uniqueFileId);
        }
        return result.changes > 0;
    }

    updateStickerDescription(uniqueFileId: string, description: string, emoji?: string | string[], enabled?: boolean): boolean {
        const canonicalUniqueFileId = this.resolveStickerDescriptionKey(uniqueFileId);
        const ts = now();
        const emojis = normalizeEmojiCandidates(emoji);
        const primaryEmoji = emojis[0] ?? (typeof emoji === "string" ? emoji : undefined);
        if (enabled !== undefined) {
            const result = this.db.prepare(
                "UPDATE sticker_descriptions SET description = ?, emoji = ?, emojis = ?, enabled = ?, created_at = ? WHERE unique_file_id = ?"
            ).run(description, primaryEmoji ?? null, emojis.length > 0 ? toJSON(emojis) : null, enabled ? 1 : 0, ts, canonicalUniqueFileId);
            return result.changes > 0;
        }
        const result = this.db.prepare(
            "UPDATE sticker_descriptions SET description = ?, emoji = ?, emojis = ?, created_at = ? WHERE unique_file_id = ?"
        ).run(description, primaryEmoji ?? null, emojis.length > 0 ? toJSON(emojis) : null, ts, canonicalUniqueFileId);
        return result.changes > 0;
    }

    /** 仅更新贴纸的启用/禁用状态 */
    setStickerEnabled(uniqueFileId: string, enabled: boolean): boolean {
        const canonicalUniqueFileId = this.resolveStickerDescriptionKey(uniqueFileId);
        const result = this.db.prepare(
            "UPDATE sticker_descriptions SET enabled = ? WHERE unique_file_id = ?"
        ).run(enabled ? 1 : 0, canonicalUniqueFileId);
        return result.changes > 0;
    }

    /** 根据 emoji 列表批量查找匹配的已知贴纸（用于贴纸发送功能） */
    searchStickersByEmoji(emojis: string[], limit = 10): Array<{ uniqueFileId: string; description: string; emoji: string; enabled: boolean }> {
        const queryEmojis = normalizeEmojiCandidates(emojis);
        if (queryEmojis.length === 0) return [];
        const wanted = new Set(queryEmojis);
        const rows = this.db.prepare(
            "SELECT unique_file_id, description, emoji, emojis, enabled FROM sticker_descriptions ORDER BY created_at DESC"
        ).all() as Array<{ unique_file_id: string; description: string; emoji: string | null; emojis: string | null; enabled: number }>;
        const result: Array<{ uniqueFileId: string; description: string; emoji: string; enabled: boolean }> = [];
        for (const r of rows) {
            const storedEmojis = normalizeStoredEmojis(r.emojis, r.emoji ?? undefined);
            const matchedEmoji = storedEmojis.find(item => wanted.has(item));
            if (!matchedEmoji) continue;
            result.push({
                uniqueFileId: r.unique_file_id,
                description: r.description,
                emoji: matchedEmoji,
                enabled: r.enabled !== 0,
            });
            if (result.length >= limit) break;
        }
        return result;
    }

    // ── Dashboard CRUD 方法 ──

    /** 分页列出全部 person_identities */
    listPersonIdentities(limit = 50, offset = 0): { items: PersonIdentity[]; total: number } {
        const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM person_identities").get() as { cnt: number }).cnt;
        const rows = this.db.prepare(
            "SELECT * FROM person_identities ORDER BY last_seen_at DESC LIMIT ? OFFSET ?"
        ).all(limit, offset) as Record<string, unknown>[];
        return {
            total,
            items: rows.map(row => ({
                userId: row.user_id as string,
                displayName: row.display_name as string,
                username: (row.username as string) ?? undefined,
                aliases: fromJSON(row.aliases as string, []),
                totalMessageCount: row.total_message_count as number,
                lastSeenAt: row.last_seen_at as string,
                firstSeenAt: row.first_seen_at as string,
                updatedAt: row.updated_at as string,
            })),
        };
    }

    /** 分页列出全部全局 person_profiles */
    listPersonProfiles(limit = 50, offset = 0): { items: PersonProfile[]; total: number } {
        const total = (this.db.prepare("SELECT COUNT(*) as cnt FROM person_profiles").get() as { cnt: number }).cnt;
        const rows = this.db.prepare(
            "SELECT * FROM person_profiles ORDER BY updated_at DESC LIMIT ? OFFSET ?"
        ).all(limit, offset) as Record<string, unknown>[];
        return {
            total,
            items: rows.map(row => ({
                userId: row.user_id as string,
                traits: fromJSON<string[]>(row.traits as string, []),
                interests: fromJSON<string[]>(row.interests as string, []),
                communicationStyle: (row.communication_style as string) ?? "",
                relationToAgent: (row.relation_to_agent as string) ?? "",
                stablePatterns: fromJSON<string[]>(row.stable_patterns as string, []),
                agentPolicyHints: fromJSON<string[]>(row.agent_policy_hints as string, []),
                followupCandidates: fromJSON<string[]>(row.followup_candidates as string, []),
                sourceChatIds: fromJSON<string[]>(row.source_chat_ids as string, []),
                confidence: (row.confidence as number) ?? 0,
                lastReflectedAt: (row.last_reflected_at as string) ?? null,
                createdAt: row.created_at as string,
                updatedAt: row.updated_at as string,
            })),
        };
    }

    /** 删除某个 PersonIdentity */
    deletePersonIdentity(userId: string): boolean {
        const result = this.db.prepare("DELETE FROM person_identities WHERE user_id = ?").run(userId);
        log.info("deletePersonIdentity", { userId, deleted: result.changes > 0 });
        return result.changes > 0;
    }

    /** 删除某个群内画像 */
    deletePersonGroupProfile(userId: string, chatId: string): boolean {
        const result = this.db.prepare(
            "DELETE FROM person_group_profiles WHERE user_id = ? AND chat_id = ?"
        ).run(userId, chatId);
        log.info("deletePersonGroupProfile", { userId, chatId, deleted: result.changes > 0 });
        return result.changes > 0;
    }

    /** 列出全部群组画像 */
    listGroupModels(): GroupModel[] {
        const rows = this.db.prepare(
            "SELECT * FROM group_models ORDER BY updated_at DESC"
        ).all() as Record<string, unknown>[];
        return rows.map(row => ({
            chatId: row.chat_id as string,
            chatTitle: row.chat_title as string,
            isDirectMessage: !!(row.is_direct_message as number),
            markedSensitive: !!(row.marked_sensitive as number),
            sensitiveReason: (row.sensitive_reason as string) ?? undefined,
            sensitiveAt: (row.sensitive_at as string) ?? null,
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
        }));
    }

    /** 分页列出/过滤 core_facts */
    listCoreFacts(options?: { subject?: string; category?: string; sourceChatId?: string; limit?: number; offset?: number }): { items: CoreFact[]; total: number } {
        const limit = options?.limit ?? 50;
        const offset = options?.offset ?? 0;

        let countSql = "SELECT COUNT(*) as cnt FROM core_facts WHERE 1=1";
        let querySql = "SELECT * FROM core_facts WHERE 1=1";
        const params: unknown[] = [];

        if (options?.subject) {
            countSql += " AND subject = ?";
            querySql += " AND subject = ?";
            params.push(options.subject);
        }
        if (options?.category) {
            countSql += " AND category = ?";
            querySql += " AND category = ?";
            params.push(options.category);
        }
        if (options?.sourceChatId) {
            countSql += " AND source_chat_id = ?";
            querySql += " AND source_chat_id = ?";
            params.push(options.sourceChatId);
        }

        const total = (this.db.prepare(countSql).get(...params) as { cnt: number }).cnt;
        querySql += " ORDER BY updated_at DESC LIMIT ? OFFSET ?";
        const rows = this.db.prepare(querySql).all(...params, limit, offset) as Record<string, unknown>[];

        return {
            total,
            items: rows.map(row => ({
                id: row.id as string,
                subject: row.subject as string,
                content: row.content as string,
                category: row.category as FactCategory,
                confidence: row.confidence as number,
                source: (row.source as string) ?? null,
                sourceChatId: (row.source_chat_id as string) ?? null,
                sourceChatTitle: (row.source_chat_title as string) ?? null,
                sourceTopicId: (row.source_topic_id as string) ?? null,
                sourceTopicLabel: (row.source_topic_label as string) ?? null,
                sourceMessageIds: fromJSON<string[]>(row.source_message_ids as string, []),
                sourceInteractionIds: fromJSON<string[]>(row.source_interaction_ids as string, []),
                observedAt: (row.observed_at as string) ?? null,
                visibility: ((row.visibility as string) ?? "contextual") as CoreFact["visibility"],
                sensitivity: ((row.sensitivity as string) ?? "low") as CoreFact["sensitivity"],
                createdAt: row.created_at as string,
                updatedAt: row.updated_at as string,
                expiresAt: (row.expires_at as string) ?? null,
            })),
        };
    }

    /** 按 ID 更新 core_fact */
    updateFact(id: string, data: {
        content?: string;
        category?: string;
        confidence?: number;
        expiresAt?: string | null;
    } & CoreFactProvenance): boolean {
        const ts = now();
        const builder = new SafeUpdateBuilder("core_facts");
        if (data.content !== undefined) builder.set("content", data.content);
        if (data.category !== undefined) builder.set("category", data.category);
        if (data.confidence !== undefined) builder.set("confidence", data.confidence);
        if (data.expiresAt !== undefined) builder.set("expires_at", data.expiresAt);
        if (data.sourceChatId !== undefined) builder.set("source_chat_id", data.sourceChatId);
        if (data.sourceChatTitle !== undefined) builder.set("source_chat_title", data.sourceChatTitle);
        if (data.sourceTopicId !== undefined) builder.set("source_topic_id", data.sourceTopicId);
        if (data.sourceTopicLabel !== undefined) builder.set("source_topic_label", data.sourceTopicLabel);
        if (data.sourceMessageIds !== undefined) builder.set("source_message_ids", toJSON(data.sourceMessageIds));
        if (data.sourceInteractionIds !== undefined) builder.set("source_interaction_ids", toJSON(data.sourceInteractionIds));
        if (data.observedAt !== undefined) builder.set("observed_at", data.observedAt);
        if (data.visibility !== undefined) builder.set("visibility", data.visibility);
        if (data.sensitivity !== undefined) builder.set("sensitivity", data.sensitivity);
        builder.set("updated_at", ts);
        builder.where("id", id);

        if (!builder.hasSets) return false;
        const { sql, params } = builder.build();
        const result = this.db.prepare(sql).run(...params);

        // 同步 FTS5
        if (data.content !== undefined) {
            try {
                const row = this.db.prepare("SELECT rowid, subject FROM core_facts WHERE id = ?").get(id) as { rowid: number; subject: string } | undefined;
                if (row) {
                    this.db.prepare("DELETE FROM core_facts_fts WHERE rowid = ?").run(row.rowid);
                    this.db.prepare("INSERT INTO core_facts_fts(rowid, content, subject) VALUES (?, ?, ?)").run(row.rowid, data.content, row.subject);
                }
            } catch { /* FTS sync */ }
        }

        log.info("updateFact", { id, changed: result.changes > 0 });
        return result.changes > 0;
    }

    /** 按 ID 删除 core_fact（含 FTS5 + vec0 清理） */
    deleteFact(id: string): boolean {
        // 先取 source_chat_id（用于解析远程 bank 做 tombstone）+ rowid（FTS 清理）
        const meta = this.db.prepare("SELECT rowid, source_chat_id FROM core_facts WHERE id = ?")
            .get(id) as { rowid: number; source_chat_id?: string | null } | undefined;

        // FTS5 cleanup
        try {
            if (meta) this.db.prepare("DELETE FROM core_facts_fts WHERE rowid = ?").run(meta.rowid);
        } catch { /* FTS */ }

        // vec0 cleanup
        if (this.sqliteVecAvailable) {
            try { this.db.prepare("DELETE FROM facts_vec WHERE fact_id = ?").run(id); } catch { /* vec */ }
        }

        const result = this.db.prepare("DELETE FROM core_facts WHERE id = ?").run(id);
        log.info("deleteFact", { id, deleted: result.changes > 0 });
        return result.changes > 0;
    }

    /** 分页列出 interactions */
    listInteractions(options?: { chatId?: string; userId?: string; limit?: number; offset?: number }): { items: InteractionEpisode[]; total: number } {
        const limit = options?.limit ?? 50;
        const offset = options?.offset ?? 0;

        let countSql = "SELECT COUNT(*) as cnt FROM interactions WHERE 1=1";
        let querySql = "SELECT * FROM interactions WHERE 1=1";
        const params: unknown[] = [];

        if (options?.chatId) {
            countSql += " AND chat_id = ?";
            querySql += " AND chat_id = ?";
            params.push(options.chatId);
        }
        if (options?.userId) {
            countSql += " AND user_id = ?";
            querySql += " AND user_id = ?";
            params.push(options.userId);
        }

        const total = (this.db.prepare(countSql).get(...params) as { cnt: number }).cnt;
        querySql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
        const rows = this.db.prepare(querySql).all(...params, limit, offset) as Record<string, unknown>[];

        return {
            total,
            items: rows.map(row => ({
                id: row.id as string,
                date: row.created_at as string,
                chatId: row.chat_id as string,
                userId: row.user_id as string,
                topicId: (row.topic_id as string) ?? null,
                type: row.type as InteractionEpisode["type"],
                summary: row.summary as string,
                sentiment: (row.sentiment as InteractionEpisode["sentiment"]) ?? "neutral",
                significance: (row.significance as number) ?? 0.5,
            })),
        };
    }

    /** 分页列出 message_log */
    listMessages(options?: { chatId?: string; userId?: string; keyword?: string; limit?: number; offset?: number }): { items: Array<Record<string, unknown>>; total: number } {
        const limit = options?.limit ?? 50;
        const offset = options?.offset ?? 0;

        let countSql = "SELECT COUNT(*) as cnt FROM message_log WHERE 1=1";
        let querySql = "SELECT * FROM message_log WHERE 1=1";
        const params: unknown[] = [];

        if (options?.chatId) {
            countSql += " AND chat_id = ?";
            querySql += " AND chat_id = ?";
            params.push(options.chatId);
        }
        if (options?.userId) {
            countSql += " AND user_id = ?";
            querySql += " AND user_id = ?";
            params.push(options.userId);
        }
        if (options?.keyword) {
            countSql += " AND text LIKE ?";
            querySql += " AND text LIKE ?";
            params.push(`%${options.keyword}%`);
        }

        const total = (this.db.prepare(countSql).get(...params) as { cnt: number }).cnt;
        querySql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
        const rows = this.db.prepare(querySql).all(...params, limit, offset) as Record<string, unknown>[];

        return {
            total,
            items: rows.map(row => ({
                messageId: row.message_id as string,
                chatId: row.chat_id as string,
                userId: row.user_id as string,
                displayName: row.display_name as string,
                text: row.text as string,
                replyToMessageId: (row.reply_to_message_id as string) ?? null,
                timestamp: row.timestamp as string,
                mediaType: (row.media_type as string) ?? null,
                mediaInfo: (row.media_info as string) ?? null,
            })),
        };
    }

    /** 批量删除 message_log 中的消息 */
    deleteMessages(chatId: string, messageIds: string[]): number {
        if (messageIds.length === 0) return 0;
        const placeholders = messageIds.map(() => "?").join(", ");
        const result = this.db.prepare(
            `DELETE FROM message_log WHERE chat_id = ? AND message_id IN (${placeholders})`
        ).run(chatId, ...messageIds);
        log.info("deleteMessages", { chatId, count: messageIds.length, deleted: result.changes });
        return result.changes;
    }

    /** 更新 message_log 中单条消息的文本 */
    updateMessage(chatId: string, messageId: string, data: { text?: string; displayName?: string }): boolean {
        const builder = new SafeUpdateBuilder("message_log");
        if (data.text !== undefined) builder.set("text", data.text);
        if (data.displayName !== undefined) builder.set("display_name", data.displayName);
        builder.where("chat_id", chatId);
        builder.where("message_id", messageId);
        if (!builder.hasSets) return false;
        const { sql, params } = builder.build();
        const result = this.db.prepare(sql).run(...params);
        log.info("updateMessage", { chatId, messageId, changed: result.changes > 0 });
        return result.changes > 0;
    }

    /** 按 ID 删除 interaction */
    deleteInteraction(id: string): boolean {
        const result = this.db.prepare("DELETE FROM interactions WHERE id = ?").run(id);
        log.info("deleteInteraction", { id, deleted: result.changes > 0 });
        return result.changes > 0;
    }

    // ─── Reflection (M2.4: 调用 reflection.ts) ───

    async reflect(
        chatId: string,
        llmConfigs?: LlmCallConfig[],
        reflectionConfig?: ReflectionExternalConfig,
    ): Promise<ReflectionResult> {
        const configs = llmConfigs?.length ? llmConfigs : resolveComponentProfiles("reflection");
        const { runReflection } = await import("./reflection.js");
        return runReflection(chatId, this, configs, reflectionConfig);
    }

    // ─── Todo Store ───

    private normalizeTodoDueAt(dueAt?: string | null): string | null {
        if (dueAt == null || dueAt === "") return null;
        const parsed = new Date(dueAt);
        if (Number.isNaN(parsed.getTime())) {
            throw new Error(`Invalid todo dueAt: ${dueAt}`);
        }
        return parsed.toISOString();
    }

    todoList(chatId: string, options?: { includeExpired?: boolean }): Array<{
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    }> {
        const nowIso = new Date().toISOString();
        const rows = this.db.prepare(`
            SELECT key, content, due_at, created_at, updated_at
            FROM todo_items
            WHERE chat_id = ?
            ORDER BY
                CASE WHEN due_at IS NULL THEN 1 ELSE 0 END ASC,
                due_at ASC,
                updated_at DESC
        `).all(chatId) as Array<{
            key: string;
            content: string;
            due_at: string | null;
            created_at: string;
            updated_at: string;
        }>;

        return rows
            .map((row) => ({
                key: row.key,
                content: row.content,
                dueAt: row.due_at,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                expired: !!row.due_at && row.due_at <= nowIso,
            }))
            .filter((row) => options?.includeExpired ? true : !row.expired);
    }

    todoGet(chatId: string, key: string): {
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    } | null {
        const row = this.db.prepare(`
            SELECT key, content, due_at, created_at, updated_at
            FROM todo_items
            WHERE chat_id = ? AND key = ?
        `).get(chatId, key) as {
            key: string;
            content: string;
            due_at: string | null;
            created_at: string;
            updated_at: string;
        } | undefined;
        if (!row) return null;
        const nowIso = new Date().toISOString();
        return {
            key: row.key,
            content: row.content,
            dueAt: row.due_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            expired: !!row.due_at && row.due_at <= nowIso,
        };
    }

    todoUpsert(chatId: string, key: string, content: string, dueAt?: string | null): {
        key: string;
        content: string;
        dueAt: string | null;
        createdAt: string;
        updatedAt: string;
        expired: boolean;
    } {
        const normalizedDueAt = this.normalizeTodoDueAt(dueAt);
        const nowIso = new Date().toISOString();
        this.db.prepare(`
            INSERT INTO todo_items (chat_id, key, content, due_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(chat_id, key) DO UPDATE SET
                content = excluded.content,
                due_at = excluded.due_at,
                updated_at = excluded.updated_at
        `).run(chatId, key, content, normalizedDueAt, nowIso, nowIso);
        return this.todoGet(chatId, key)!;
    }

    todoRemove(chatId: string, key: string): void {
        this.db.prepare("DELETE FROM todo_items WHERE chat_id = ? AND key = ?").run(chatId, key);
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
            associatedMemories: fromJSON<AssociatedMemory[]>(row.associated_memories as string, []),
            callbackPotential: Number(row.callback_potential ?? 0),
            embedding: row.embedding ? new Float32Array((row.embedding as Buffer).buffer) : undefined,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
        };
    }
}
