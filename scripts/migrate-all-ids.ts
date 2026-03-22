/**
 * migrate-all-ids.ts — 全量 ID 迁移 + 去重脚本 (v2)
 *
 * 策略：对有唯一约束的表，逐行处理；对无约束的表，批量 UPDATE。
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

if (!dryRun) {
    const backupPath = join(dirname(dbPath), `${basename(dbPath, ".db")}_backup_allids_${Date.now()}.db`);
    console.log(`💾 备份到: ${backupPath}`);
    copyFileSync(dbPath, backupPath);
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, `${backupPath}-wal`);
    if (existsSync(`${dbPath}-shm`)) copyFileSync(`${dbPath}-shm`, `${backupPath}-shm`);
    console.log("✅ 备份完成\n");
}

const PREFIX = "telegram:";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

function tableExists(t: string): boolean {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
}

function isNumericId(val: string): boolean {
    return /^-?\d+$/.test(val);
}

function needsMigrate(val: string): boolean {
    return !val.startsWith("telegram:") && !val.startsWith("discord:");
}

/**
 * 给无唯一约束问题的表做批量迁移
 */
function bulkMigrateChatId(table: string): number {
    const cond = `chat_id != '' AND chat_id NOT LIKE 'telegram:%' AND chat_id NOT LIKE 'discord:%'`;
    const cnt = (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${cond}`).get() as any).cnt;
    if (cnt === 0) return 0;
    if (dryRun) { console.log(`  ${table}.chat_id: ${cnt} 行需迁移`); return cnt; }
    const r = db.prepare(`UPDATE ${table} SET chat_id = '${PREFIX}' || chat_id WHERE ${cond}`).run();
    console.log(`  ✅ ${table}.chat_id: ${r.changes} 行已更新`);
    return r.changes;
}

function bulkMigrateUserId(table: string): number {
    const cond = `user_id != '' AND user_id NOT LIKE 'telegram:%' AND user_id NOT LIKE 'discord:%' AND (user_id GLOB '[0-9]*' OR user_id GLOB '-[0-9]*')`;
    const cnt = (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${cond}`).get() as any).cnt;
    if (cnt === 0) return 0;
    if (dryRun) { console.log(`  ${table}.user_id: ${cnt} 行需迁移`); return cnt; }
    const r = db.prepare(`UPDATE ${table} SET user_id = '${PREFIX}' || user_id WHERE ${cond}`).run();
    console.log(`  ✅ ${table}.user_id: ${r.changes} 行已更新`);
    return r.changes;
}

const migrate = db.transaction(() => {
    let totalMigrated = 0;
    let totalDeduped = 0;

    // ─── 1. message_log (no unique on chat_id/user_id — safe to bulk migrate) ───
    if (tableExists("message_log")) {
        totalMigrated += bulkMigrateChatId("message_log");
        totalMigrated += bulkMigrateUserId("message_log");
    }

    // ─── 2. topics (might have unique constraint on chat_id+id) ───
    if (tableExists("topics")) {
        // 先去重
        const dupes = db.prepare(`
            SELECT t1.rowid FROM topics t1
            WHERE t1.chat_id NOT LIKE 'telegram:%' AND t1.chat_id NOT LIKE 'discord:%'
              AND EXISTS (SELECT 1 FROM topics t2 WHERE t2.chat_id = 'telegram:' || t1.chat_id AND t2.id = t1.id)
        `).all() as { rowid: number }[];
        if (dupes.length > 0 && !dryRun) {
            for (const d of dupes) {
                db.prepare("DELETE FROM topics WHERE rowid = ?").run(d.rowid);
            }
        }
        totalDeduped += dupes.length;
        if (dupes.length > 0) console.log(`  topics: ${dupes.length} 重复行已删除`);

        totalMigrated += bulkMigrateChatId("topics");
    }

    // ─── 3. group_models (PK = chat_id) ───
    if (tableExists("group_models")) {
        const dupes = db.prepare(`
            SELECT chat_id FROM group_models
            WHERE chat_id NOT LIKE 'telegram:%' AND chat_id NOT LIKE 'discord:%'
              AND EXISTS (SELECT 1 FROM group_models gm2 WHERE gm2.chat_id = 'telegram:' || group_models.chat_id)
        `).all() as { chat_id: string }[];
        if (dupes.length > 0 && !dryRun) {
            for (const d of dupes) db.prepare("DELETE FROM group_models WHERE chat_id = ?").run(d.chat_id);
        }
        totalDeduped += dupes.length;
        if (dupes.length > 0) console.log(`  group_models: ${dupes.length} 重复行已删除`);

        totalMigrated += bulkMigrateChatId("group_models");
    }

    // ─── 4. person_group_profiles (PK = user_id + chat_id) ── 最复杂的 ───
    if (tableExists("person_group_profiles")) {
        // 逐行处理：对每个需迁移的行，计算目标 key，如已存在则删除当前行，否则更新
        const bareRows = db.prepare(`
            SELECT rowid, user_id, chat_id FROM person_group_profiles
            WHERE (user_id NOT LIKE 'telegram:%' AND user_id NOT LIKE 'discord:%' AND (user_id GLOB '[0-9]*' OR user_id GLOB '-[0-9]*'))
               OR (chat_id NOT LIKE 'telegram:%' AND chat_id NOT LIKE 'discord:%')
        `).all() as { rowid: number; user_id: string; chat_id: string }[];

        let migrated = 0, deduped = 0;
        for (const row of bareRows) {
            const targetUid = (row.user_id.startsWith("telegram:") || row.user_id.startsWith("discord:") || !isNumericId(row.user_id))
                ? row.user_id
                : `telegram:${row.user_id}`;
            const targetCid = (row.chat_id.startsWith("telegram:") || row.chat_id.startsWith("discord:"))
                ? row.chat_id
                : `telegram:${row.chat_id}`;

            if (targetUid === row.user_id && targetCid === row.chat_id) continue; // already migrated

            // Check if target already exists
            const exists = db.prepare(
                "SELECT 1 FROM person_group_profiles WHERE user_id = ? AND chat_id = ?"
            ).get(targetUid, targetCid);

            if (exists) {
                if (!dryRun) db.prepare("DELETE FROM person_group_profiles WHERE rowid = ?").run(row.rowid);
                deduped++;
            } else {
                if (!dryRun) {
                    db.prepare("UPDATE person_group_profiles SET user_id = ?, chat_id = ? WHERE rowid = ?")
                        .run(targetUid, targetCid, row.rowid);
                }
                migrated++;
            }
        }
        totalDeduped += deduped;
        totalMigrated += migrated;
        console.log(`  person_group_profiles: ${migrated} 行迁移, ${deduped} 行去重删除`);
    }

    // ─── 5. person_identities (PK = user_id) ───
    if (tableExists("person_identities")) {
        const bareRows = db.prepare(`
            SELECT rowid, user_id FROM person_identities
            WHERE (user_id GLOB '[0-9]*' OR user_id GLOB '-[0-9]*')
              AND user_id NOT LIKE 'telegram:%' AND user_id NOT LIKE 'discord:%'
        `).all() as { rowid: number; user_id: string }[];

        let migrated = 0, deduped = 0;
        for (const row of bareRows) {
            const target = `telegram:${row.user_id}`;
            const exists = db.prepare("SELECT 1 FROM person_identities WHERE user_id = ?").get(target);
            if (exists) {
                if (!dryRun) db.prepare("DELETE FROM person_identities WHERE rowid = ?").run(row.rowid);
                deduped++;
            } else {
                if (!dryRun) db.prepare("UPDATE person_identities SET user_id = ? WHERE rowid = ?").run(target, row.rowid);
                migrated++;
            }
        }
        totalDeduped += deduped;
        totalMigrated += migrated;
        console.log(`  person_identities: ${migrated} 行迁移, ${deduped} 行去重删除`);
    }

    // ─── 6. interactions (no unique constraint on chat_id+user_id) ───
    if (tableExists("interactions")) {
        totalMigrated += bulkMigrateChatId("interactions");
        totalMigrated += bulkMigrateUserId("interactions");
    }

    // ─── 7. conversation_log (chat_id might have .0 suffix from float) ───
    if (tableExists("conversation_log")) {
        // 先修复 float 后缀: "682932098.0" → "682932098"
        const floatRows = (db.prepare(
            `SELECT COUNT(*) as cnt FROM conversation_log WHERE chat_id LIKE '%.0'`
        ).get() as any).cnt;
        if (floatRows > 0 && !dryRun) {
            db.prepare(`UPDATE conversation_log SET chat_id = REPLACE(chat_id, '.0', '') WHERE chat_id LIKE '%.0'`).run();
            console.log(`  conversation_log: ${floatRows} 行修复 .0 后缀`);
        }

        totalMigrated += bulkMigrateChatId("conversation_log");
    }

    console.log(`\n📊 总计: ${totalMigrated} 行迁移, ${totalDeduped} 行去重删除`);
});

try {
    migrate();
    console.log("\n✅ 迁移完成！");
} catch (err) {
    console.error("\n❌ 迁移失败（已自动回滚）:", err);
    db.close();
    process.exit(1);
}

// ─── 验证 ───

console.log("\n═══ 验证 ═══\n");

const checks = [
    { table: "message_log", col: "chat_id", type: "chat" },
    { table: "message_log", col: "user_id", type: "user" },
    { table: "topics", col: "chat_id", type: "chat" },
    { table: "group_models", col: "chat_id", type: "chat" },
    { table: "person_group_profiles", col: "chat_id", type: "chat" },
    { table: "person_group_profiles", col: "user_id", type: "user" },
    { table: "person_identities", col: "user_id", type: "user" },
    { table: "interactions", col: "chat_id", type: "chat" },
    { table: "interactions", col: "user_id", type: "user" },
    { table: "conversation_log", col: "chat_id", type: "chat" },
];

let allGood = true;
for (const { table, col, type } of checks) {
    if (!tableExists(table)) continue;
    const cond = type === "chat"
        ? `${col} != '' AND ${col} NOT LIKE 'telegram:%' AND ${col} NOT LIKE 'discord:%'`
        : `${col} != '' AND ${col} NOT LIKE 'telegram:%' AND ${col} NOT LIKE 'discord:%' AND (${col} GLOB '[0-9]*' OR ${col} GLOB '-[0-9]*')`;
    const remaining = (db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE ${cond}`).get() as any).cnt;
    if (remaining > 0) {
        console.error(`  ❌ ${table}.${col}: ${remaining} 行未迁移`);
        allGood = false;
    } else {
        console.log(`  ✅ ${table}.${col}`);
    }
}

db.close();
console.log(allGood ? "\n🎉 全量验证通过！" : "\n⚠️ 验证发现问题！");
if (!allGood) process.exit(1);
