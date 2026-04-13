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
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
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

    // ─── 仅仅扫描内置模块 d.ts (Host-coupled) ───
    const builtinDts = readdirSync(modulesDir)
        .filter(f => f.endsWith(".d.ts"))
        .sort();

    // 同时扫描 shared/ 子目录（新增的 worker-local 模块类型）
    const sharedDir = join(modulesDir, "shared");
    const sharedDts = existsSync(sharedDir)
        ? readdirSync(sharedDir).filter(f => f.endsWith(".d.ts")).sort()
        : [];

    console.log(`内置模块: 发现 ${builtinDts.length} 个 .d.ts 文件`);
    builtinDts.forEach(f => console.log(`  - ${f}`));
    if (sharedDts.length > 0) {
        console.log(`Shared 模块: 发现 ${sharedDts.length} 个 .d.ts 文件`);
        sharedDts.forEach(f => console.log(`  - shared/${f}`));
    }

    for (const f of builtinDts) {
        const content = readFileSync(join(modulesDir, f), "utf-8");
        const entries = parseDtsFile(content, f);
        mergeEntries(allEntries, entries);
    }

    for (const f of sharedDts) {
        const content = readFileSync(join(sharedDir, f), "utf-8");
        const entries = parseDtsFile(content, `shared/${f}`);
        mergeEntries(allEntries, entries);
    }

    // ─── 输出统计 ───
    console.log(`\n解析结果:`);
    for (const entry of allEntries) {
        console.log(`  ${entry.name}: ${entry.methods.length} 个方法`);
        for (const m of entry.methods) {
            console.log(`    - ${m.name}: ${m.brief.slice(0, 60)}`);
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

