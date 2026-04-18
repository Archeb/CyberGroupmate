/**
 * generate-module-docs.ts — 自动化 Sandbox 模块文档生成工具
 *
 * 从 src/sandbox/modules/ 下的 .d.ts 文件中解析方法签名和 JSDoc 注释，
 * 生成结构化的 modules-docs.json 用于 Two-pass Code Generation。
 *
 * 用法：npx tsx src/tools/generate-module-docs.ts
 *
 * 输出：src/sandbox/modules/modules-docs.json
 *
 * 设计理念：
 * - 不引入 ts-morph / typedoc 等重型依赖
 * - 直接用正则 + 简单解析器读 .d.ts 文件
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleEntry } from "../sandbox/modules/module-registry.js";
import { parseDtsFile } from "../sandbox/dts-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── 主流程 ───

function main(): void {
    const modulesDir = join(__dirname, "..", "sandbox", "modules");

    if (!existsSync(modulesDir)) {
        console.error(`模块目录不存在: ${modulesDir}`);
        process.exit(1);
    }

    const allEntries: ModuleEntry[] = [];

    // ─── 递归扫描 modules/ 下所有子目录中的 .d.ts ───
    const subDirs = readdirSync(modulesDir).filter(f => {
        const fullPath = join(modulesDir, f);
        return existsSync(fullPath) && statSync(fullPath).isDirectory();
    }).sort();

    const allDtsFiles: Array<{ relPath: string; absPath: string }> = [];
    for (const dir of subDirs) {
        const dirPath = join(modulesDir, dir);
        const dtsFiles = readdirSync(dirPath).filter(f => f.endsWith(".d.ts"));
        for (const f of dtsFiles) {
            allDtsFiles.push({
                relPath: `${dir}/${f}`,
                absPath: join(dirPath, f),
            });
        }
    }

    console.log(`模块: 发现 ${allDtsFiles.length} 个 .d.ts 文件`);
    allDtsFiles.forEach(f => console.log(`  - ${f.relPath}`));

    for (const { relPath, absPath } of allDtsFiles) {
        const content = readFileSync(absPath, "utf-8");
        const entries = parseDtsFile(content, relPath);
        mergeEntries(allEntries, entries);
    }

    // ─── 输出统计 ───
    console.log(`\n解析结果:`);
    for (const entry of allEntries) {
        console.log(`  ${entry.name}: ${entry.methods.length} 个方法`);
        for (const m of entry.methods) {
            console.log(`    - ${m.name}: ${m.brief}`);
        }
    }

    // 写入 JSON
    const outputPath = join(modulesDir, "modules-docs.json");
    writeFileSync(outputPath, JSON.stringify(allEntries, null, 2), "utf-8");
    console.log(`\n✅ 已生成: ${outputPath}`);

    // 同时生成 brief-overview.md 供人工审阅
    const briefSections: string[] = [];
    for (const mod of allEntries) {
        briefSections.push(`## ${mod.name}\n${mod.description}\n`);
        for (const m of mod.methods) {
            briefSections.push(`- \`${m.name}\`: ${m.brief}`);
        }
        briefSections.push("");
    }
    const briefPath = join(modulesDir, "brief-overview.md");
    writeFileSync(briefPath, `# Sandbox API Brief Overview\n\n${briefSections.join("\n")}`, "utf-8");
    console.log(`✅ 已生成: ${briefPath}`);
}

/** 合并模块条目（同名模块合并方法列表和类型定义） */
function mergeEntries(allEntries: ModuleEntry[], newEntries: ModuleEntry[]): void {
    for (const entry of newEntries) {
        const existing = allEntries.find(e => e.name === entry.name);
        if (existing) {
            existing.methods.push(...entry.methods);
            if (!existing.description && entry.description) {
                existing.description = entry.description;
            }
            // 合并 typeDefs
            if (entry.typeDefs) {
                existing.typeDefs = existing.typeDefs
                    ? `${existing.typeDefs}\n\n${entry.typeDefs}`
                    : entry.typeDefs;
            }
        } else {
            allEntries.push(entry);
        }
    }
}

main();

