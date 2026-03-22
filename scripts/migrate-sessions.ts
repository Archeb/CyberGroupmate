/**
 * migrate-sessions.ts — Session 文件迁移脚本
 *
 * 将 workspace/sessions/telegram/{rawChatId}.json 重命名为
 * workspace/sessions/telegram/{compositeFileName}.json，
 * 并更新 JSON 内部的 chatId 字段。
 *
 * 使用方式：
 *   npx tsx scripts/migrate-sessions.ts [--dry-run] [--dir <path>]
 */

import { readdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { composeChatId, chatIdToFileName, isValidCompositeChatId } from "../src/core/chat-id.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dirIdx = args.indexOf("--dir");
const sessionsDir = dirIdx !== -1 && args[dirIdx + 1]
    ? args[dirIdx + 1]
    : join(process.cwd(), "workspace", "sessions", "telegram");

if (!existsSync(sessionsDir)) {
    console.log(`⏭️  目录不存在: ${sessionsDir}`);
    process.exit(0);
}

console.log(`📂 Session 目录: ${sessionsDir}`);
console.log(`🔧 模式: ${dryRun ? "DRY RUN" : "LIVE"}`);
console.log();

const files = readdirSync(sessionsDir).filter(f => f.endsWith(".json"));

let migrated = 0;
let skipped = 0;
let errors = 0;

for (const file of files) {
    const rawChatId = basename(file, ".json");

    // 已经是 composite key 格式的文件名（含 telegram_ 前缀），跳过
    if (rawChatId.startsWith("telegram_") || rawChatId.startsWith("discord_")) {
        console.log(`  ⏭️  ${file} — 已迁移，跳过`);
        skipped++;
        continue;
    }

    const compositeChatId = composeChatId("telegram", rawChatId);
    const newFileName = chatIdToFileName(compositeChatId) + ".json";

    console.log(`  📝 ${file} → ${newFileName}`);

    if (!dryRun) {
        const srcPath = join(sessionsDir, file);
        const dstPath = join(sessionsDir, newFileName);

        try {
            // 更新 JSON 内部的 chatId 字段
            const content = readFileSync(srcPath, "utf-8");
            const json = JSON.parse(content);

            if (json.chatId && !isValidCompositeChatId(json.chatId)) {
                json.chatId = compositeChatId;
            }

            writeFileSync(srcPath, JSON.stringify(json, null, 2));

            // 重命名文件
            renameSync(srcPath, dstPath);

            migrated++;
        } catch (err) {
            console.error(`  ❌ 迁移失败: ${file} — ${err}`);
            errors++;
        }
    } else {
        migrated++;
    }
}

console.log();
console.log(`✅ 完成: ${migrated} 迁移, ${skipped} 跳过, ${errors} 错误`);
