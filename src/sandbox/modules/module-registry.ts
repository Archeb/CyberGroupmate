/**
 * module-registry.ts — Sandbox 模块注册表
 *
 * 统一声明所有暴露给 sandbox 的模块。每个模块条目包含：
 * - 简短摘要（用于 Pass 1 轻量 prompt）
 * - 完整 TypeDoc 文档（用于 Pass 2 按需注入）
 *
 * 由 `generate-module-docs` 工具自动填充 `fullDoc` 字段，
 * 人工只需维护 `methods` 中的方法列表和 `brief` 描述。
 *
 * @see docs/sandbox-module-guide.md 了解如何添加新模块
 */

// ─── 类型定义 ───

/** 单个方法的文档条目 */
export interface MethodDoc {
    /** 方法名 */
    name: string;
    /** 一句话签名摘要（Pass 1 用） */
    brief: string;
    /** 完整 TypeDoc 文档（MD 格式，含参数、返回值、示例代码等）（Pass 2 用） */
    fullDoc: string;
}

/** 单个模块的注册条目 */
export interface ModuleEntry {
    /** 模块名（sandbox 中的全局变量名，如 "runtime", "memory", "telegram"） */
    name: string;
    /** 模块一句话描述 */
    description: string;
    /** 方法列表 */
    methods: MethodDoc[];
    /** 该模块涉及的 interface / type / enum 定义原文（Pass 2 按需注入） */
    typeDefs?: string;
}

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __mr_filename = fileURLToPath(import.meta.url);
const __mr_dirname = dirname(__mr_filename);

/**
 * 从 modules-docs.json 加载模块注册表。
 * 该 JSON 文件由 `npm run gen:module-docs` 生成。
 *
 * 返回值结构：ModuleEntry[]
 */
export function loadModuleRegistry(): ModuleEntry[] {
    try {
        const jsonPath = join(__mr_dirname, "modules-docs.json");
        const raw = readFileSync(jsonPath, "utf-8");
        return JSON.parse(raw) as ModuleEntry[];
    } catch {
        // fallback: 返回空（此时回退到旧的 d.ts 流程）
        return [];
    }
}

/**
 * 生成 Pass 1 轻量概览：每个模块的方法名 + 简短签名
 *
 * 输出格式示例：
 * ```
 * ## runtime
 * - notify(event): 推送事件到通知中心
 * - input(prompt): 请求用户输入
 * ...
 * ## telegram (TelegramClient)
 * - sendText(chatId, text, opts?): 发送文本消息
 * ...
 * ```
 */
export function generateBriefOverview(registry: ModuleEntry[], allowedModules?: Set<string>): string {
    const sections: string[] = [];
    for (const mod of registry) {
        // 如果指定了白名单，则过滤未包含的模块
        if (allowedModules && !allowedModules.has(mod.name)) continue;
        const header = `## ${mod.name}`;
        const desc = mod.description ? `${mod.description}\n` : "";
        const methodLines = mod.methods.map(m => `- ${m.name}: ${m.brief}`);
        sections.push(`${header}\n${desc}${methodLines.join("\n")}`);
    }
    return sections.join("\n\n");
}

/**
 * 生成极简模块名册（供主 Agent 决策时浏览）
 *
 * 每个模块只占一行，格式：“- moduleName: description”
 * 不包含方法列表、参数签名等细节。
 *
 * @param registry 模块注册表
 * @param excludeBaseSkills 不需要展示的常驻模块名称集（它们已经始终可见，无需主脑指派）
 */
export function generateModuleRoster(registry: ModuleEntry[], excludeBaseSkills?: Set<string>): string {
    const lines: string[] = [];
    for (const mod of registry) {
        if (excludeBaseSkills && excludeBaseSkills.has(mod.name)) continue;
        lines.push(`- ${mod.name}: ${mod.description || mod.methods.map(m => m.brief).join('; ')}`);
    }
    return lines.join("\n");
}

/**
 * 根据方法调用列表检索完整文档
 *
 * @param registry 模块注册表
 * @param calledMethods 从代码中提取的方法调用列表，格式如 ["telegram.sendText", "memory.recall"]
 * @returns 拼接好的完整 TypeDoc 文档字符串
 */
export function lookupFullDocs(registry: ModuleEntry[], calledMethods: string[]): string {
    const found: string[] = [];
    const seen = new Set<string>();
    /** 收集涉及的模块（用于追加 typeDefs） */
    const referencedModules = new Set<string>();

    for (const call of calledMethods) {
        // 解析 "telegram.sendText" → moduleName="telegram", methodName="sendText"
        // 解析 "memory.recall" → moduleName="memory", methodName="recall"
        const lastDot = call.lastIndexOf(".");
        if (lastDot === -1) continue;
        const moduleName = call.slice(0, lastDot);
        const methodName = call.slice(lastDot + 1);

        const mod = registry.find(m => m.name === moduleName);
        if (!mod) continue;
        const method = mod.methods.find(m => m.name === methodName);
        if (!method || !method.fullDoc) continue;

        const key = `${moduleName}.${methodName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(`### ${moduleName}.${methodName}\n\n${method.fullDoc}`);
        referencedModules.add(moduleName);
    }

    if (found.length === 0) return "";

    // 追加涉及模块的 interface / type / enum 定义
    const typeDefSections: string[] = [];
    for (const modName of referencedModules) {
        const mod = registry.find(m => m.name === modName);
        if (mod?.typeDefs) {
            typeDefSections.push(`#### ${modName} 相关类型定义\n\n\`\`\`typescript\n${mod.typeDefs}\n\`\`\``);
        }
    }

    let result = `# 完整 API 文档\n\n${found.join("\n\n---\n\n")}`;
    if (typeDefSections.length > 0) {
        result += `\n\n---\n\n# 相关类型定义\n\n${typeDefSections.join("\n\n")}`;
    }
    return result;
}
