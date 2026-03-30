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
 * - .d.ts 文件已经是人工精心编写的 Agent 可见 API 文档
 * - 本脚本只是将其结构化为 JSON，以支持按需检索
 *
 * @see docs/sandbox-module-guide.md
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── 类型 ───

interface MethodDoc {
    name: string;
    brief: string;
    fullDoc: string;
}

interface ModuleEntry {
    name: string;
    description: string;
    methods: MethodDoc[];
}

// ─── 解析逻辑 ───

/**
 * 从一段 JSDoc 注释中提取描述文本
 */
function extractJsDocDescription(jsDoc: string): string {
    const trimmedDoc = jsDoc.trim();

    // 处理单行 JSDoc: /** text */
    const singleLine = trimmedDoc.match(/^\/\*\*\s*(.*?)\s*\*\/$/);
    if (singleLine) return singleLine[1].trim();

    // 多行 JSDoc
    return trimmedDoc
        .replace(/^\/\*\*\s*/, "")     // 去掉开头 /**
        .replace(/\s*\*\/\s*$/, "")    // 去掉结尾 */
        .split("\n")
        .map(line => line.replace(/^\s*\*\s?/, ""))  // 去掉行首 * 
        .join("\n")
        .trim();
}

/**
 * 从 JSDoc 中提取第一行作为 brief（一句话描述）
 */
function extractBrief(jsDoc: string): string {
    const desc = extractJsDocDescription(jsDoc);
    // 取第一行，去掉 @tag 行
    const lines = desc.split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("@")) {
            return trimmed;
        }
    }
    return "";
}

/**
 * 从 JSDoc 生成完整的 Markdown 格式文档
 */
function formatFullDoc(jsDoc: string, signature: string): string {
    const desc = extractJsDocDescription(jsDoc);
    const parts: string[] = [];

    // 签名
    parts.push("```typescript\n" + signature + "\n```\n");

    // 描述 (非 @tag 行)
    const descLines: string[] = [];
    const paramLines: string[] = [];
    const exampleBlocks: string[] = [];
    let inExample = false;
    let currentExample: string[] = [];

    for (const line of desc.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("@example")) {
            if (inExample && currentExample.length > 0) {
                exampleBlocks.push(currentExample.join("\n"));
            }
            inExample = true;
            currentExample = [];
            // @example 后面可能有标题文字
            const exTitle = trimmed.replace("@example", "").trim();
            if (exTitle) currentExample.push(`// ${exTitle}`);
        } else if (trimmed.startsWith("@param")) {
            inExample = false;
            if (currentExample.length > 0) {
                exampleBlocks.push(currentExample.join("\n"));
                currentExample = [];
            }
            const paramMatch = trimmed.match(/@param\s+(\S+)\s*-?\s*(.*)/);
            if (paramMatch) {
                paramLines.push(`- \`${paramMatch[1]}\`: ${paramMatch[2]}`);
            }
        } else if (trimmed.startsWith("@returns") || trimmed.startsWith("@return")) {
            inExample = false;
            if (currentExample.length > 0) {
                exampleBlocks.push(currentExample.join("\n"));
                currentExample = [];
            }
            const retDesc = trimmed.replace(/@returns?\s*/, "");
            if (retDesc) paramLines.push(`- **返回值**: ${retDesc}`);
        } else if (trimmed.startsWith("@")) {
            // 其他 tag，忽略
            inExample = false;
        } else if (inExample) {
            currentExample.push(line);
        } else {
            descLines.push(line);
        }
    }
    if (currentExample.length > 0) {
        exampleBlocks.push(currentExample.join("\n"));
    }

    // 组装
    const descText = descLines.join("\n").trim();
    if (descText) parts.push(descText);

    if (paramLines.length > 0) {
        parts.push("**参数：**\n" + paramLines.join("\n"));
    }

    if (exampleBlocks.length > 0) {
        parts.push("**示例：**\n" + exampleBlocks.map(ex =>
            "```typescript\n" + ex.trim() + "\n```"
        ).join("\n\n"));
    }

    return parts.join("\n\n");
}

/**
 * 解析 .d.ts 文件中的 `interface XXX { ... }` 或 `declare const xxx: { ... }` 块，
 * 提取方法签名和 JSDoc。
 */
function parseDtsFile(content: string, fileName: string): ModuleEntry[] {
    const entries: ModuleEntry[] = [];

    // 提取文件级 JSDoc（第一行 /** ... */）
    const fileDocMatch = content.match(/^\/\*\*[\s\S]*?\*\//m);
    const fileDesc = fileDocMatch ? extractBrief(fileDocMatch[0]) : "";

    // ─── 解析 declare const xxx: { ... } 形式的模块 ───
    const declareConstRegex = /declare\s+const\s+(\w+)\s*:\s*\{([\s\S]*?)\n\};/g;
    let declMatch;
    while ((declMatch = declareConstRegex.exec(content)) !== null) {
        const moduleName = declMatch[1];
        const body = declMatch[2];
        const methods = parseMethodsFromBody(body);

        if (methods.length > 0) {
            entries.push({
                name: moduleName,
                description: fileDesc,
                methods,
            });
        }
    }

    // ─── 解析 declare const xxx: TypeName 引用形式 ───
    const declareRefRegex = /declare\s+const\s+(\w+)\s*:\s*(\w+)\s*;/g;
    let refMatch;
    while ((refMatch = declareRefRegex.exec(content)) !== null) {
        const moduleName = refMatch[1];
        const typeName = refMatch[2];

        // 查找对应的 interface
        const ifaceRegex = new RegExp(
            `interface\\s+${typeName}\\s*\\{([\\s\\S]*?)\\n\\}`,
            "g"
        );
        const ifaceMatch = ifaceRegex.exec(content);
        if (ifaceMatch) {
            const methods = parseMethodsFromBody(ifaceMatch[1]);
            if (methods.length > 0) {
                entries.push({
                    name: moduleName,
                    description: fileDesc,
                    methods,
                });
            }
        }
    }

    // ─── 解析 declare const xxx: { key: InterfaceName } 中引用的嵌套表结构 ───
    // （如 ctx.tg → TelegramClient）
    const nestedDeclRegex = /declare\s+const\s+(\w+)\s*:\s*\{\s*(\w+)\s*:\s*(\w+)\s*;/g;
    let nestedMatch;
    while ((nestedMatch = nestedDeclRegex.exec(content)) !== null) {
        const parentName = nestedMatch[1];   // "ctx"
        const childKey = nestedMatch[2];      // "tg"
        const typeName = nestedMatch[3];      // "TelegramClient"

        // 查找对应的 interface
        const ifaceRegex2 = new RegExp(
            `interface\\s+${typeName}\\s*\\{([\\s\\S]*?)\\n\\}`,
            "g"
        );
        const ifaceMatch2 = ifaceRegex2.exec(content);
        if (ifaceMatch2) {
            const methods = parseMethodsFromBody(ifaceMatch2[1]);
            if (methods.length > 0) {
                const moduleName = `${parentName}.${childKey}`;
                // 避免和前面重复
                if (!entries.find(e => e.name === moduleName)) {
                    entries.push({
                        name: moduleName,
                        description: fileDesc,
                        methods,
                    });
                }
            }
        }
    }

    return entries;
}

/**
 * 从 interface / object literal body 中解析方法签名和 JSDoc
 */
function parseMethodsFromBody(body: string): MethodDoc[] {
    const methods: MethodDoc[] = [];
    const lines = body.split("\n");

    let currentJsDoc = "";
    let collectingJsDoc = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // 收集 JSDoc
        if (trimmed.startsWith("/**")) {
            currentJsDoc = line + "\n";
            if (trimmed.endsWith("*/")) {
                collectingJsDoc = false;
            } else {
                collectingJsDoc = true;
            }
            continue;
        }
        if (collectingJsDoc) {
            currentJsDoc += line + "\n";
            if (trimmed.includes("*/")) {
                collectingJsDoc = false;
            }
            continue;
        }

        // 跳过注释行和分隔线
        if (trimmed.startsWith("//") || trimmed === "" || trimmed.startsWith("*")) continue;

        // 检测多行方法签名的开始: methodName( 但没有以 ; 结尾
        const multiLineStart = trimmed.match(/^(?:readonly\s+)?(\w+)\s*\(/);
        if (multiLineStart && !trimmed.endsWith(";")) {
            // 累积后续行直到找到 ;
            let fullSig = trimmed;
            let j = i + 1;
            while (j < lines.length) {
                const nextLine = lines[j].trim();
                fullSig += " " + nextLine;
                if (nextLine.endsWith(";")) break;
                j++;
            }

            const name = multiLineStart[1];
            const signature = fullSig.replace(/;\s*$/, "");
            const brief = currentJsDoc ? extractBrief(currentJsDoc) : signature;
            const fullDoc = currentJsDoc
                ? formatFullDoc(currentJsDoc, signature)
                : `\`\`\`typescript\n${signature}\n\`\`\``;

            methods.push({ name, brief, fullDoc });
            currentJsDoc = "";
            i = j;
            continue;
        }

        // 匹配单行方法签名: methodName(...): ReturnType;
        // 也匹配 readonly property: get current: string;
        const methodMatch = trimmed.match(
            /^(?:readonly\s+)?(\w+)(?:\s*\([\s\S]*?\)[\s\S]*?)?;\s*$/
        );
        if (methodMatch) {
            const name = methodMatch[1];
            // 清理签名（移除末尾分号，保留完整类型）
            const signature = trimmed.replace(/;\s*$/, "");
            const brief = currentJsDoc ? extractBrief(currentJsDoc) : signature;
            const fullDoc = currentJsDoc
                ? formatFullDoc(currentJsDoc, signature)
                : `\`\`\`typescript\n${signature}\n\`\`\``;


            methods.push({ name, brief, fullDoc });
            currentJsDoc = "";
        }

        // 匹配嵌套对象中的方法 (如 skills.memory.recall)
        // 形如: key: { ... }
        const nestedObjMatch = trimmed.match(/^(\w+)\s*:\s*\{/);
        if (nestedObjMatch) {
            // 找到闭合 }
            let depth = 1;
            let j = i + 1;
            let nestedBody = "";
            while (j < lines.length && depth > 0) {
                nestedBody += lines[j] + "\n";
                if (lines[j].includes("{")) depth++;
                if (lines[j].includes("}")) depth--;
                j++;
            }
            // 递归解析嵌套方法
            const nestedMethods = parseMethodsFromBody(nestedBody);
            for (const nm of nestedMethods) {
                methods.push(nm);
            }
            i = j - 1;
            currentJsDoc = "";
        }

        // 不匹配时清除 JSDoc（防止错误关联）
        if (!methodMatch && !collectingJsDoc) {
            currentJsDoc = "";
        }
    }

    return methods;
}

// ─── 主流程 ───

function main(): void {
    const modulesDir = join(__dirname, "..", "sandbox", "modules");
    const skillsDir = join(process.cwd(), "workspace", "skills");

    if (!existsSync(modulesDir)) {
        console.error(`模块目录不存在: ${modulesDir}`);
        process.exit(1);
    }

    const allEntries: ModuleEntry[] = [];

    // ─── 1. 扫描内置模块 d.ts ───
    const builtinDts = readdirSync(modulesDir)
        .filter(f => f.endsWith(".d.ts"))
        .sort();

    console.log(`内置模块: 发现 ${builtinDts.length} 个 .d.ts 文件`);
    builtinDts.forEach(f => console.log(`  - ${f}`));

    for (const f of builtinDts) {
        const content = readFileSync(join(modulesDir, f), "utf-8");
        const entries = parseDtsFile(content, f);
        mergeEntries(allEntries, entries);
    }

    // ─── 2. 扫描 workspace/skills/ 下的 d.ts ───
    if (existsSync(skillsDir)) {
        const skillDirs = readdirSync(skillsDir)
            .filter(entry => {
                const p = join(skillsDir, entry);
                return existsSync(p) && statSync(p).isDirectory()
                    && entry !== "node_modules" && !entry.startsWith(".");
            });

        if (skillDirs.length > 0) {
            console.log(`\n用户 Skills: 发现 ${skillDirs.length} 个 Skill 目录`);

            for (const dir of skillDirs) {
                const dirPath = join(skillsDir, dir);
                const dtsFiles = readdirSync(dirPath).filter(f => f.endsWith(".d.ts"));

                for (const dts of dtsFiles) {
                    console.log(`  - ${dir}/${dts}`);
                    const content = readFileSync(join(dirPath, dts), "utf-8");
                    const entries = parseDtsFile(content, dts);

                    // 若 Skill 的 d.ts 没有 declare const，则用目录名作为模块名
                    if (entries.length === 0) {
                        // 尝试解析所有 interface 中的方法作为该 skill 的 API
                        const ifaceRegex = /interface\s+\w+\s*\{([\s\S]*?)\n\}/g;
                        let ifaceMatch;
                        const methods: MethodDoc[] = [];
                        while ((ifaceMatch = ifaceRegex.exec(content)) !== null) {
                            methods.push(...parseMethodsFromBody(ifaceMatch[1]));
                        }
                        if (methods.length > 0) {
                            entries.push({
                                name: dir,
                                description: `用户 Skill: ${dir}`,
                                methods,
                            });
                        }
                    }

                    mergeEntries(allEntries, entries);
                }
            }
        }
    } else {
        console.log(`\nworkspace/skills/ 不存在，跳过用户 Skills`);
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

/** 合并模块条目（同名模块合并方法列表） */
function mergeEntries(allEntries: ModuleEntry[], newEntries: ModuleEntry[]): void {
    for (const entry of newEntries) {
        const existing = allEntries.find(e => e.name === entry.name);
        if (existing) {
            existing.methods.push(...entry.methods);
            if (!existing.description && entry.description) {
                existing.description = entry.description;
            }
        } else {
            allEntries.push(entry);
        }
    }
}

main();

