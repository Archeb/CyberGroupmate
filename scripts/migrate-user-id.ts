/**
 * migrate-user-id.ts — userId composite key 迁移脚本
 *
 * 为所有 user_id 列中的纯数字 ID 加 `telegram:` 前缀。
 * 跳过非数字值（如 "agent", "Miu", 空字符串等）。
 *
 * 迁移范围：
 * - person_identities.user_id
 * - person_group_profiles.user_id
 * - message_log.user_id
 * - interactions.user_id
 *
 * 使用方式：
 *   npx tsx scripts/migrate-user-id.ts [--dry-run] [--db <path>]
 */

import Database from "better-sqlite3";
import { copyFileSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";

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
console.log(`🔧 模式: ${dryRun ? "DRY RUN" : "LIVE"}`);
console.log();

// ─── 备份 ───

if (!dryRun) {
    const backupPath = join(
        dirname(dbPath),
        `${basename(dbPath, ".db")}_backup_userid_${Date.now()}.db`,
    );
    console.log(`💾 备份到: ${backupPath}`);
    copyFileSync(dbPath, backupPath);
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${backupPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) copyFileSync(`${dbPath}-shm`, `${backupPath}-shm`);
    console.log("✅ 备份完成");
    console.log();
}

const PLATFORM_PREFIX = "telegram:";

/**
 * 需要迁移 user_id 列的表。
 * 条件：user_id 是纯数字（正/负）且没有 platform 前缀。
 */
const TABLES_WITH_USER_ID = [
    "person_identities",
    "person_group_profiles",
    "message_log",
    "interactions",
];

/**
 * 判断 user_id 是否应该被迁移。
 * 只迁移纯数字 ID，跳过 "agent"、persona 名、空字符串等。
 */
const NUMERIC_CONDITION = `user_id GLOB '[0-9]*' OR user_id GLOB '-[0-9]*'`;
const ALREADY_MIGRATED = `user_id LIKE 'telegram:%' OR user_id LIKE 'discord:%'`;

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const stats: Record<string, { total: number; needMigrate: number; alreadyMigrated: number; skipped: number }> = {};

for (const table of TABLES_WITH_USER_ID) {
    const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);

    if (!tableExists) {
        console.log(`⏭️  表 ${table} 不存在，跳过`);
        stats[table] = { total: 0, needMigrate: 0, alreadyMigrated: 0, skipped: 0 };
        continue;
    }

    const totalRow = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
    const alreadyRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE ${ALREADY_MIGRATED}`,
    ).get() as { cnt: number };
    const numericRow = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE (${NUMERIC_CONDITION}) AND NOT (${ALREADY_MIGRATED})`,
    ).get() as { cnt: number };
    const skipped = totalRow.cnt - alreadyRow.cnt - numericRow.cnt;

    stats[table] = {
        total: totalRow.cnt,
        needMigrate: numericRow.cnt,
        alreadyMigrated: alreadyRow.cnt,
        skipped,
    };

    console.log(
        `📊 ${table}: ${totalRow.cnt} 行总计, ${numericRow.cnt} 行需迁移, ${alreadyRow.cnt} 行已有前缀, ${skipped} 行非数字跳过`,
    );
}

console.log();

if (dryRun) {
    console.log("🔍 DRY RUN 完成，未做任何修改");
    db.close();
    process.exit(0);
}

const totalNeedMigrate = Object.values(stats).reduce((sum, s) => sum + s.needMigrate, 0);
if (totalNeedMigrate === 0) {
    console.log("✅ 所有数据已迁移，无需操作");
    db.close();
    process.exit(0);
}

console.log(`🚀 开始迁移 ${totalNeedMigrate} 行...`);
console.log();

const migrate = db.transaction(() => {
    for (const table of TABLES_WITH_USER_ID) {
        if (stats[table].needMigrate === 0) continue;

        const result = db.prepare(
            `UPDATE ${table} SET user_id = '${PLATFORM_PREFIX}' || user_id WHERE (${NUMERIC_CONDITION}) AND NOT (${ALREADY_MIGRATED})`,
        ).run();

        console.log(`  ✅ ${table}: ${result.changes} 行已更新`);
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

for (const table of TABLES_WITH_USER_ID) {
    const tableExists = verifyDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    ).get(table);
    if (!tableExists) continue;

    // 检查是否还有未迁移的纯数字 user_id
    const unmigrated = verifyDb.prepare(
        `SELECT COUNT(*) as cnt FROM ${table} WHERE (${NUMERIC_CONDITION}) AND NOT (${ALREADY_MIGRATED})`,
    ).get() as { cnt: number };

    if (unmigrated.cnt > 0) {
        console.error(`  ❌ ${table}: 仍有 ${unmigrated.cnt} 行未迁移!`);
        allGood = false;
    } else {
        const migrated = verifyDb.prepare(
            `SELECT COUNT(*) as cnt FROM ${table} WHERE ${ALREADY_MIGRATED}`,
        ).get() as { cnt: number };
        const nonNumeric = verifyDb.prepare(
            `SELECT COUNT(*) as cnt FROM ${table} WHERE NOT (${NUMERIC_CONDITION}) AND NOT (${ALREADY_MIGRATED})`,
        ).get() as { cnt: number };
        console.log(`  ✅ ${table}: ${migrated.cnt} 行已迁移, ${nonNumeric.cnt} 行非数字（正确跳过）`);
    }
}

verifyDb.close();

if (allGood) {
    console.log();
    console.log("🎉 验证通过！所有数字 user_id 均已加 telegram: 前缀");
} else {
    console.error();
    console.error("⚠️  验证发现问题，请检查!");
    process.exit(1);
}
