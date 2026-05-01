/**
 * context-engine/template-engine.ts — Mustache-lite 模板渲染引擎
 *
 * 从旧 prompt-renderer.ts 迁移的模板加载 + 渲染逻辑。
 * 支持：
 * - {{variable}} — 简单变量替换
 * - {{#flag}}...{{/flag}} — 条件块（flag 为真时显示）
 *
 * 用于 executor system prompt / task prompt 等仍需要 Mustache 模板的场景。
 * attend/callback/pipeline 等场景已由 SectionProvider.render() 替代。
 */

import { createLogger } from "../core/logger.js";
import { loadPromptFile, registerCacheClear } from "../core/prompt-loader.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const log = createLogger("template-engine");

// ─── 模板文件映射 ───

/** Prompt 类型 → 文件名映射 */
const PROMPT_FILE_MAP: Record<string, string> = {
    EXECUTION: "executor/subagent-execution.md",
};

export type PromptType = keyof typeof PROMPT_FILE_MAP;

// ─── 模板缓存 ───

const _templateCache = new Map<string, string>();
let _promptDir: string | null = null;

// 注册缓存清除回调，供 prompt-loader 热重载使用
registerCacheClear(() => _templateCache.clear());

/**
 * 设置 prompt 模板目录（用于测试或自定义路径）
 */
export function setPromptDirectory(dir: string): void {
    _promptDir = dir;
    _templateCache.clear();
}

/**
 * 获取 prompt 模板目录
 */
function getPromptDir(): string {
    if (_promptDir) return _promptDir;
    try {
        const thisFile = fileURLToPath(import.meta.url);
        const projectRoot = join(dirname(thisFile), "..", "..");
        return join(projectRoot, "system-prompts");
    } catch {
        return "system-prompts";
    }
}

/**
 * 读取 prompt 模板文件（带缓存，支持 override）
 */
export function loadTemplate(type: PromptType): string {
    const cached = _templateCache.get(type);
    if (cached) return cached;

    const filename = PROMPT_FILE_MAP[type];
    if (!filename) {
        throw new Error(`Unknown prompt type: ${type}`);
    }

    if (_promptDir) {
        const filePath = join(_promptDir, filename);
        if (!existsSync(filePath)) {
            log.warn("loadTemplate: 文件不存在, 使用空模板", { type, filePath });
            return "";
        }
        const content = readFileSync(filePath, "utf-8");
        _templateCache.set(type, content);
        return content;
    }

    const content = loadPromptFile(filename);
    if (content === null) {
        log.warn("loadTemplate: 文件不存在, 使用空模板", { type, filename });
        return "";
    }

    _templateCache.set(type, content);
    log.debug("loadTemplate: 已加载", { type, filename, length: content.length });
    return content;
}

/**
 * 清除模板缓存（用于测试或热重载）
 */
export function clearTemplateCache(): void {
    _templateCache.clear();
}

/**
 * 渲染 prompt 模板（Mustache-lite）
 */
export function renderPrompt(type: PromptType, variables: Record<string, unknown>): string {
    const template = loadTemplate(type);
    return renderTemplate(template, variables);
}

/**
 * 渲染任意模板字符串
 */
export function renderTemplate(template: string, variables: Record<string, unknown>): string {
    let result = template;

    // 条件块处理：{{#flag}}content{{/flag}}
    result = result.replace(
        /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
        (_, flag: string, content: string) => {
            return variables[flag] ? content : "";
        }
    );

    // 变量替换：{{variable}}
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const val = variables[key];
        if (val === undefined || val === null) return "";
        if (typeof val === "object") return JSON.stringify(val, null, 2);
        return String(val);
    });

    return result.trim();
}

