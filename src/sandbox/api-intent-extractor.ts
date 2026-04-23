/**
 * api-intent-extractor.ts — 从 LLM 生成的代码中提取 API 方法调用
 *
 * 用于 Two-pass Code Generation 的第一阶段解析：
 * 从 Agent 初次生成的代码中识别出它打算调用哪些模块方法，
 * 以便后续按需注入对应的完整 TypeDoc 文档。
 *
 * 模块前缀列表从 modules-docs.json 动态读取，无需硬编码。
 * 使用正则而非 AST 解析，因为 LLM 生成的代码不一定合法。
 */

import type { ModuleEntry } from "./modules/module-registry.js";

/** 固定的简单调用白名单（不需要查阅完整文档） */
const TRIVIAL_CALLS = new Set([
    "runtime.print",
    "runtime.ps",
    "scene.current",
    "telegram.sendText",
    "telegram.sendMedia",
    "discord.sendText",
    "discord.sendMedia",
    "onebot.sendText",
    "onebot.sendMedia",
    "onebot.sendSticker",
    "onebot.sendFace",
    "qq.sendText",
    "qq.sendMedia",
    "qq.sendSticker",
    "qq.sendFace",
    // fs 模块：简单操作不需要完整文档
    "fs.exists",
    "fs.readdir",
    "fs.readFile",
    "fs.mkdir",
    // skills 管理
    "skills.list",
    // mcp
    "mcp.list",
    // cron
    "cron.list",
    // todo
    "todo.get",
    "todo.list",
    "todo.remove",
]);

/**
 * 从 modules-docs.json 的模块列表中构建前缀映射
 *
 * 生成的映射格式：{ "telegram": "telegram", "todo": "todo", ... }
 *
 * @param registry 模块注册表
 * @param extraNames 额外的模块名（如动态加载的 TS Skills 名称列表）
 */
export function buildPrefixMap(
    registry: ModuleEntry[],
    extraNames: string[] = [],
): Record<string, string> {
    const map: Record<string, string> = {};

    // 从 registry 中提取模块名
    for (const mod of registry) {
        map[mod.name] = mod.name;
    }

    // 添加动态加载的 Skill 名称
    for (const name of extraNames) {
        if (!map[name]) {
            map[name] = name;
        }
    }

    return map;
}

/**
 * 从代码文本中提取所有被调用的 sandbox API 方法
 *
 * @param code - LLM 生成的代码字符串
 * @param prefixMap - 模块前缀映射表（由 buildPrefixMap 生成）
 * @returns 标准化的方法调用列表，如 ["telegram.sendText", "todo.list"]
 *
 * @example
 * ```ts
 * const map = buildPrefixMap(registry, ["github"]);
 * const calls = extractApiCalls(`
 *   const result = await todo.list();
 *   await telegram.sendText(chatId, "hello");
 *   const issues = await github.listIssues("owner", "repo");
 * `, map);
 * // calls = ["todo.list", "telegram.sendText", "github.listIssues"]
 * ```
 */
export function extractApiCalls(code: string, prefixMap: Record<string, string>): string[] {
    const found = new Set<string>();

    // 按前缀长度降序排列，确保较长前缀优先匹配
    const sortedPrefixes = Object.keys(prefixMap)
        .sort((a, b) => b.length - a.length);

    for (const prefix of sortedPrefixes) {
        const canonical = prefixMap[prefix];
        // 转义 prefix 中的 . 用于正则
        const escapedPrefix = prefix.replace(/\./g, "\\.");
        // 匹配 prefix.methodName( 或 prefix.methodName\s*(
        const regex = new RegExp(
            `(?:^|[^a-zA-Z0-9_.])${escapedPrefix}\\.([a-zA-Z_][a-zA-Z0-9_]*)\\s*\\(`,
            "g"
        );
        let match;
        while ((match = regex.exec(code)) !== null) {
            const methodName = match[1];
            // 跳过已知的非方法属性
            if (methodName === "length" || methodName === "prototype") continue;
            found.add(`${canonical}.${methodName}`);
        }
    }

    return [...found];
}

/**
 * 判断代码是否调用了需要查阅完整文档的 API
 *
 * 简单的调用（如 console.log、基本变量操作）不需要触发 Pass 2。
 * 只有当代码调用了 sandbox 注入的模块 API 时，才需要补充文档。
 *
 * @param calls extractApiCalls() 的返回值
 * @returns 是否需要触发 Pass 2
 */
export function needsDocLookup(calls: string[]): boolean {
    const significantCalls = calls.filter(c => !TRIVIAL_CALLS.has(c));
    return significantCalls.length > 0;
}
