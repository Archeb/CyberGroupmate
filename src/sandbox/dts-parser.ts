/**
 * dts-parser.ts — .d.ts 解析器（基于 TypeScript Compiler API）
 *
 * 使用 TypeScript AST 解析 .d.ts 文件，提取方法签名和 JSDoc。
 * 被 `generate-module-docs.ts` (构建时) 和 `skill-loader.ts` (运行时) 共享。
 */

import ts from "typescript";
import type { MethodDoc, ModuleEntry } from "./modules/module-registry.js";

// ─── JSDoc 提取 ───

/**
 * 从 AST 节点提取 JSDoc 注释原文（包含 /** ... * / 标记）
 */
function getJsDocText(node: ts.Node, sourceFile: ts.SourceFile): string {
    const fullText = sourceFile.getFullText();
    const ranges = ts.getLeadingCommentRanges(fullText, node.getFullStart());
    if (!ranges) return "";

    // 取最后一个 block comment（即紧邻声明的 JSDoc）
    for (let i = ranges.length - 1; i >= 0; i--) {
        const range = ranges[i];
        if (range.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
            const text = fullText.slice(range.pos, range.end);
            if (text.startsWith("/**")) return text;
        }
    }
    return "";
}

/**
 * 从 JSDoc 注释文本中提取描述（去除 / ** * / 标记和 @tag 行）
 */
function extractDescription(jsDoc: string): string {
    if (!jsDoc) return "";
    return jsDoc
        .replace(/^\/\*\*\s*/, "")
        .replace(/\s*\*\/\s*$/, "")
        .split("\n")
        .map(line => line.replace(/^\s*\*\s?/, ""))
        .join("\n")
        .trim();
}

/**
 * 从 JSDoc 中提取第一行非 @tag 的描述作为 brief
 */
function extractBrief(jsDoc: string): string {
    const desc = extractDescription(jsDoc);
    for (const line of desc.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("@")) return trimmed;
    }
    return "";
}

/**
 * 格式化完整的 Markdown 文档
 */
function formatFullDoc(jsDoc: string, signature: string): string {
    const desc = extractDescription(jsDoc);
    const parts: string[] = [];

    parts.push("```typescript\n" + signature + "\n```\n");

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

// ─── AST 方法提取 ───

/**
 * 将 AST 节点序列化为签名字符串
 */
function nodeToSignature(node: ts.Node, sourceFile: ts.SourceFile): string {
    return node.getText(sourceFile).replace(/;\s*$/, "").trim();
}

/**
 * 从类型字面量（object type literal）或 interface body 中提取方法
 */
function extractMethodsFromMembers(
    members: ts.NodeArray<ts.TypeElement>,
    sourceFile: ts.SourceFile,
    prefix?: string,
): MethodDoc[] {
    const methods: MethodDoc[] = [];

    for (const member of members) {
        const jsDoc = getJsDocText(member, sourceFile);

        if (ts.isMethodSignature(member) || ts.isPropertySignature(member)) {
            const name = member.name?.getText(sourceFile) ?? "";
            if (!name) continue;

            // 如果 property 的类型是 object literal，递归提取
            if (ts.isPropertySignature(member) && member.type && ts.isTypeLiteralNode(member.type)) {
                const nested = extractMethodsFromMembers(member.type.members, sourceFile, prefix ? `${prefix}.${name}` : name);
                methods.push(...nested);
                continue;
            }

            // 如果 property 的类型引用了一个 interface，解析该 interface 的方法
            if (ts.isPropertySignature(member) && member.type && ts.isTypeReferenceNode(member.type)) {
                const typeName = member.type.typeName.getText(sourceFile);
                const iface = findInterface(sourceFile, typeName);
                if (iface) {
                    const nested = extractMethodsFromMembers(iface.members, sourceFile, prefix ? `${prefix}.${name}` : name);
                    if (nested.length > 0) {
                        methods.push(...nested);
                        continue;
                    }
                }
            }

            const signature = nodeToSignature(member, sourceFile);
            const displayName = prefix ? `${prefix}.${name}` : name;
            const brief = jsDoc ? extractBrief(jsDoc) : signature;
            const fullDoc = jsDoc
                ? formatFullDoc(jsDoc, signature)
                : `\`\`\`typescript\n${signature}\n\`\`\``;

            methods.push({ name: displayName, brief, fullDoc });
        }

        // 处理 call signature: (param: Type) => ReturnType 作为函数式成员
        if (ts.isCallSignatureDeclaration(member)) {
            const signature = nodeToSignature(member, sourceFile);
            const brief = jsDoc ? extractBrief(jsDoc) : signature;
            const fullDoc = jsDoc
                ? formatFullDoc(jsDoc, signature)
                : `\`\`\`typescript\n${signature}\n\`\`\``;
            methods.push({ name: prefix ?? "call", brief, fullDoc });
        }
    }

    return methods;
}

/**
 * 在 source file 中查找指定名称的 interface 声明
 */
function findInterface(sourceFile: ts.SourceFile, typeName: string): ts.InterfaceDeclaration | undefined {
    for (const stmt of sourceFile.statements) {
        if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === typeName) {
            return stmt;
        }
    }
    return undefined;
}

/**
 * 从类型节点中解析出方法列表
 */
function extractMethodsFromType(
    typeNode: ts.TypeNode,
    sourceFile: ts.SourceFile,
): MethodDoc[] {
    // 直接是 { ... } 类型字面量
    if (ts.isTypeLiteralNode(typeNode)) {
        return extractMethodsFromMembers(typeNode.members, sourceFile);
    }

    // 类型引用 → 查找 interface
    if (ts.isTypeReferenceNode(typeNode)) {
        const typeName = typeNode.typeName.getText(sourceFile);
        const iface = findInterface(sourceFile, typeName);
        if (iface) {
            return extractMethodsFromMembers(iface.members, sourceFile);
        }
    }

    // Union type (如 ((file: ...) => ...) | null) → 递归每个分支
    if (ts.isUnionTypeNode(typeNode)) {
        for (const member of typeNode.types) {
            // 跳过 null / undefined 字面量
            if (member.kind === ts.SyntaxKind.NullKeyword ||
                member.kind === ts.SyntaxKind.UndefinedKeyword ||
                (ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword)) {
                continue;
            }
            const methods = extractMethodsFromType(member, sourceFile);
            if (methods.length > 0) return methods;
        }
    }

    // 带括号的类型 → 解包
    if (ts.isParenthesizedTypeNode(typeNode)) {
        return extractMethodsFromType(typeNode.type, sourceFile);
    }

    // 函数类型 → 整体作为单个 method
    if (ts.isFunctionTypeNode(typeNode)) {
        return []; // 由 caller 处理（需要变量名信息）
    }

    // Intersection type → 合并所有分支
    if (ts.isIntersectionTypeNode(typeNode)) {
        const methods: MethodDoc[] = [];
        for (const member of typeNode.types) {
            methods.push(...extractMethodsFromType(member, sourceFile));
        }
        return methods;
    }

    return [];
}

/**
 * 判断类型节点是否是函数类型（可能被 union 或 parenthesized 包裹）
 */
function isFunctionLikeType(typeNode: ts.TypeNode): boolean {
    if (ts.isFunctionTypeNode(typeNode)) return true;
    if (ts.isParenthesizedTypeNode(typeNode)) return isFunctionLikeType(typeNode.type);
    if (ts.isUnionTypeNode(typeNode)) {
        return typeNode.types.some(t => {
            if (t.kind === ts.SyntaxKind.NullKeyword || t.kind === ts.SyntaxKind.UndefinedKeyword) return false;
            if (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword) return false;
            return isFunctionLikeType(t);
        });
    }
    return false;
}

// ─── 类型定义提取 ───

/**
 * 提取 interface / type alias / enum 定义的原文（供 LLM 参考参数/返回值结构）
 */
function extractTypeDefs(sourceFile: ts.SourceFile): string {
    const defs: string[] = [];

    for (const stmt of sourceFile.statements) {
        if (ts.isInterfaceDeclaration(stmt)) {
            defs.push(stmt.getText(sourceFile));
        } else if (ts.isTypeAliasDeclaration(stmt)) {
            defs.push(stmt.getText(sourceFile));
        } else if (ts.isEnumDeclaration(stmt)) {
            defs.push(stmt.getText(sourceFile));
        }
    }

    return defs.join("\n\n");
}

// ─── 主入口 ───

/**
 * 解析 .d.ts 文件，提取模块名、方法签名、JSDoc 和类型定义
 *
 * 支持的声明形式：
 * - `declare const xxx: { method(): Type; ... };`  — 对象类型字面量
 * - `declare const xxx: InterfaceName;`            — 类型引用
 * - `declare const xxx: ((arg: T) => R) | null;`   — 函数类型
 * - `declare const xxx: { key: InterfaceName };`   — 嵌套类型引用
 * - `interface XXX { ... }` (无 declare const)       — fallback
 */
export function parseDtsFile(content: string, fileName: string): ModuleEntry[] {
    const sourceFile = ts.createSourceFile(
        fileName,
        content,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TS,
    );

    const entries: ModuleEntry[] = [];
    const seenNames = new Set<string>();

    // 提取文件级 JSDoc（第一个 /** ... */ 注释）
    const fileDesc = (() => {
        const fullText = sourceFile.getFullText();
        const match = fullText.match(/^\/\*\*[\s\S]*?\*\//m);
        return match ? extractBrief(match[0]) : "";
    })();

    // 提取类型定义
    const typeDefs = extractTypeDefs(sourceFile);

    // 遍历顶层声明
    for (const stmt of sourceFile.statements) {
        // ─── declare const xxx: ... ───
        if (ts.isVariableStatement(stmt)) {
            const isAmbient = stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.DeclareKeyword);
            if (!isAmbient) continue;

            for (const decl of stmt.declarationList.declarations) {
                const name = decl.name.getText(sourceFile);
                if (seenNames.has(name)) continue;

                const typeNode = decl.type;
                if (!typeNode) continue;

                // 1) 对象类型字面量、类型引用、嵌套对象 → 提取方法
                const methods = extractMethodsFromType(typeNode, sourceFile);

                if (methods.length > 0) {
                    seenNames.add(name);
                    entries.push({
                        name,
                        description: fileDesc,
                        methods,
                        ...(typeDefs ? { typeDefs } : {}),
                    });
                    continue;
                }

                // 2) 函数类型（如 saucenao）→ 整体作为单个方法
                if (isFunctionLikeType(typeNode)) {
                    const jsDoc = getJsDocText(stmt, sourceFile);
                    const typeText = typeNode.getText(sourceFile);
                    const signature = `${name}: ${typeText}`;
                    const brief = jsDoc ? extractBrief(jsDoc) : typeText;
                    const fullDoc = jsDoc
                        ? formatFullDoc(jsDoc, signature)
                        : `\`\`\`typescript\n${signature}\n\`\`\``;

                    seenNames.add(name);
                    entries.push({
                        name,
                        description: fileDesc,
                        methods: [{ name, brief, fullDoc }],
                        ...(typeDefs ? { typeDefs } : {}),
                    });
                }
            }
        }
    }

    // ─── Fallback: 没有 declare const，但有 interface → 聚合所有 interface 的方法 ───
    if (entries.length === 0) {
        const methods: MethodDoc[] = [];
        for (const stmt of sourceFile.statements) {
            if (ts.isInterfaceDeclaration(stmt)) {
                methods.push(...extractMethodsFromMembers(stmt.members, sourceFile));
            }
        }
        if (methods.length > 0) {
            entries.push({
                name: "default",
                description: fileDesc,
                methods,
                ...(typeDefs ? { typeDefs } : {}),
            });
        }
    }

    return entries;
}