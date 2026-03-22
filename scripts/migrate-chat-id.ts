/**
 * migrate-chat-id.ts — SQLite chat_id 迁移脚本
 *
 * 为所有 chat_id 列值加 `telegram:` 前缀，将裸 chatId 迁移为 composite key 格式。
 *
 * 迁移范围：
 * - message_log.chat_id
 * - topics.chat_id
 * - group_models.chat_id
 * - person_group_profiles.chat_id
 * - interactions.chat_id
 * - topics_vec.chat_id（如果存在）
 *
 * 不迁移：
 * - core_facts.subject — 内容混合，模糊查询不依赖精确格式
 * - person_identities.user_id — 用户 ID，不是 chatId
 *
 * 使用方式：
 *   npx tsx scripts/migrate-chat-id.ts [--dry-run] [--db <path>]
 *
 * 安全措施：
 * - 迁移前自动备份 .db 文件
 * - --dry-run 模式只统计不修改
 * - 事务包裹，失败自动回滚
 * - 幂等：已有 `telegram:` 前缀的行不重复迁移
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";

// ─── 参数解析 ───

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIdx = args.indexOf("--db");
const dbPath = dbIdx !== -1 && args[dbIdx + 1]
    ? args[dbIdx + 1]
    : join(process.cwd(), "workspace", "memory.db");

if (!existsSync(dbPath)) {
    console.error(`❌ 数据库文件不存在: ${dbPath}`);
    process.exit(1);
}

console.log(`📦 目标数据库: ${dbPath}`);
console.log(`🔧 模式: ${dryRun ? "DRY RUN (只统计不修改)" : "LIVE (实际迁移)"}`);
console.log();

// ─── 备份 ───

if (!dryRun) {
    const backupPath = join(
        dirname(dbPath),
        `${basename(dbPath, ".db")}_backup_${Date.now()}.db`,
    );
    console.log(`💾 备份到: ${backupPath}`);
    copyFileSync(dbPath, backupPath);
    // WAL 文件也备份
    if (existsSync(`${dbPath}-wal`)) {
        copyFileSync(`${dbPath}-wal`, `${backupPath}-wal`);
    }
    if (existsSync(`${dbPath}-shm`)) {
        copyFileSync(`${dbPath}-shm`, `${backupPath}-shm`);
    }
    console.log("✅ 备份完成");
    console.log();
}

// ─── 迁移逻辑 ───

const PLATFORM_PREFIX = "telegram:";

/** 需要迁移 chat_id 列的表 */
const TABLES_WITH_CHAT_ID = [
    "message_log",
    "topics",
    "group_models",
    "person_group_profiles",
    "interactions",
];

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// 统计
const stats: Record<string, { total: number; needMigrate: number; alreadyMigrated: number }> = {};

for (const table of TABLES_WITH_CHAT_ID) {
    // 检查表是否存在
    const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);

    if (!tableExists) {
        console.log(`⏭️  表 ${table} 不存在，跳过`);
        stats[table] = { total: 0, needMigrate: 0, alreadyMigrated: 0 };
        continue;
    }

    // 统计行数
    const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
    const alreadyRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE chat_id LIKE 'telegram:%' OR chat_id LIKE 'discord:%'`,
    ).get() as { cnt: number };
    const needMigrate = totalRow.cnt - alreadyRow.cnt;

    stats[table] = {
        total: totalRow.cnt,
        needMigrate,
        alreadyMigrated: alreadyRow.cnt,
    };

    console.log(
        `📊 ${table}: ${totalRow.cnt} 行总计, ${needMigrate} 行需迁移, ${alreadyRow.cnt} 行已有前缀`,
    );
}

// 检查 topics_vec 虚拟表
let hasTopicsVec = false;
try {
    const vecExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='topics_vec'",
    ).get();
    if (vecExists) {
        hasTopicsVec = true;
        const vecCount = db.prepare("SELECT COUNT(*) as cnt FROM topics_vec").get() as { cnt: number };
        console.log(`📊 topics_vec (虚拟表): ${vecCount.cnt} 行`);
    }
} catch {
    // topics_vec 可能不存在或 sqlite-vec 未加载
}

console.log();

if (dryRun) {
    console.log("🔍 DRY RUN 完成，未做任何修改");
    db.close();
    process.exit(0);
}

// ─── 执行迁移 ───

const totalNeedMigrate = Object.values(stats).reduce((sum, s) => sum + s.needMigrate, 0);
if (totalNeedMigrate === 0) {
    console.log("✅ 所有数据已迁移，无需操作");
    db.close();
    process.exit(0);
}

console.log(`🚀 开始迁移 ${totalNeedMigrate} 行...`);
console.log();

const migrate = db.transaction(() => {
    for (const table of TABLES_WITH_CHAT_ID) {
        if (stats[table].needMigrate === 0) continue;

        const result = db.prepare(
            `UPDATE ${table} SET chat_id = '${PLATFORM_PREFIX}' || chat_id WHERE chat_id NOT LIKE 'telegram:%' AND chat_id NOT LIKE 'discord:%'`,
        ).run();

        console.log(`  ✅ ${table}: ${result.changes} 行已更新`);
    }

    // topics_vec 虚拟表比较特殊 — vec0 不支持 UPDATE，需要重建
    // 但 topics_vec 会在应用启动时通过 rebuildVecIndex() 自动从 topics 表重建
    // 所以这里只需要迁移主表，不需要迁移 vec0
    if (hasTopicsVec) {
        console.log(`  ℹ️  topics_vec: 将在应用下次启动时自动从 topics 表重建`);
    }
});

try {
    migrate();
    console.log();
    console.log("✅ 迁移完成！");
} catch (err) {
    console.error();
    console.error("❌ 迁移失败（已自动回滚）:", err);
    process.exit(1);
} finally {
    db.close();
}

// ─── 验证 ───

console.log();
console.log("🔍 验证迁移结果...");

const verifyDb = new Database(dbPath);
let allGood = true;

for (const table of TABLES_WITH_CHAT_ID) {
    const tableExists = verifyDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    if (!tableExists) continue;

    const unmigrated = verifyDb.prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE chat_id NOT LIKE 'telegram:%' AND chat_id NOT LIKE 'discord:%'`,
    ).get() as { cnt: number };

    if (unmigrated.cnt > 0) {
        console.error(`  ❌ ${table}: 仍有 ${unmigrated.cnt} 行未迁移!`);
        allGood = false;
    } else {
        const total = verifyDb.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
        console.log(`  ✅ ${table}: ${total.cnt} 行全部已迁移`);
    }
}

verifyDb.close();

if (allGood) {
    console.log();
    console.log("🎉 验证通过！所有 chat_id 列值均已加 telegram: 前缀");
} else {
    console.error();
    console.error("⚠️  验证发现问题，请检查!");
    process.exit(1);
}
