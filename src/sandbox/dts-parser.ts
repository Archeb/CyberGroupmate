/**
 * dts-parser.ts — 轻量级 .d.ts 解析器
 *
 * 用于静态生成或在运行时纯正则解析 .d.ts 文件，提取方法签名和 JSDoc。
 * 被 `generate-module-docs.ts` (构建时) 和 `skill-loader.ts` (运行时) 共享。
 */

import type { MethodDoc, ModuleEntry } from "./modules/module-registry.js";

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
 * 从 interface / object literal body 中解析方法签名和 JSDoc
 */
export function parseMethodsFromBody(body: string): MethodDoc[] {
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

/**
 * 从 .d.ts 文件内容中提取所有 interface / type / enum 定义的原文。
 * 提取的类型定义将附加到 ModuleEntry.typeDefs，
 * 在 Pass 2 文档注入时一并提供给 LLM，使其能理解参数/返回值的结构。
 */
function extractTypeDefs(content: string): string {
    const defs: string[] = [];

    // 提取 interface 块（含可选的前置 JSDoc）
    const ifaceRegex = /(?:(?:\/\*\*[\s\S]*?\*\/\s*)?\n)?(interface\s+\w+[\s\S]*?\n\})/g;
    let m;
    while ((m = ifaceRegex.exec(content)) !== null) {
        defs.push(m[1].trim());
    }

    // 提取 type alias
    const typeRegex = /(?:(?:\/\*\*[\s\S]*?\*\/\s*)?\n)?(type\s+\w+\s*=[\s\S]*?;)/g;
    while ((m = typeRegex.exec(content)) !== null) {
        defs.push(m[1].trim());
    }

    // 提取 enum 块
    const enumRegex = /(?:(?:\/\*\*[\s\S]*?\*\/\s*)?\n)?((?:const\s+)?enum\s+\w+\s*\{[\s\S]*?\n\})/g;
    while ((m = enumRegex.exec(content)) !== null) {
        defs.push(m[1].trim());
    }

    return defs.join("\n\n");
}

/**
 * 解析 .d.ts 文件中的 `interface XXX { ... }` 或 `declare const xxx: { ... }` 块，
 * 提取方法签名和 JSDoc，同时提取 interface/type/enum 定义附加到 typeDefs。
 */
export function parseDtsFile(content: string, fileName: string): ModuleEntry[] {
    const entries: ModuleEntry[] = [];

    // 提取文件级 JSDoc（第一行 /** ... */）
    const fileDocMatch = content.match(/^\/\*\*[\s\S]*?\*\//m);
    const fileDesc = fileDocMatch ? extractBrief(fileDocMatch[0]) : "";

    // 提取文件中所有类型定义
    const typeDefs = extractTypeDefs(content);

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
                ...(typeDefs ? { typeDefs } : {}),
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
                    ...(typeDefs ? { typeDefs } : {}),
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
                        ...(typeDefs ? { typeDefs } : {}),
                    });
                }
            }
        }
    }

    // 如果没有使用 declare const，但有 interface，将这些暴露的方法打包成一个默认 entry (Skill 名字后续会覆盖它)
    if (entries.length === 0) {
        const ifaceRegex = /interface\s+\w+\s*\{([\s\S]*?)\n\}/g;
        let ifaceMatch;
        const methods: MethodDoc[] = [];
        while ((ifaceMatch = ifaceRegex.exec(content)) !== null) {
            methods.push(...parseMethodsFromBody(ifaceMatch[1]));
        }
        if (methods.length > 0) {
            entries.push({
                name: "default", // 这是一个占位符，外部加载器会替换为真实 Skill name
                description: fileDesc,
                methods,
                ...(typeDefs ? { typeDefs } : {}),
            });
        }
    }

    return entries;
}
