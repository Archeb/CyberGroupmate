/**
 * prompt-loader.ts — 统一 System Prompt 加载器
 *
 * 所有 system prompt 文件的读取统一走此模块。
 * 加载优先级：workspace/system-prompts-overrides/{path} > system-prompts/{path}
 *
 * Override 文件保存在 workspace/system-prompts-overrides/ 下，目录结构与 system-prompts/ 一致。
 */

import { readFileSync, existsSync, writeFileSync, unlinkSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";

const log = createLogger("prompt-loader");

// ─── 路径解析 ───

let _projectRoot: string | null = null;

function getProjectRoot(): string {
    if (_projectRoot) return _projectRoot;
    try {
        const thisFile = fileURLToPath(import.meta.url);
        _projectRoot = join(dirname(thisFile), "..", "..");
    } catch {
        _projectRoot = process.cwd();
    }
    return _projectRoot;
}

/** 原始 system-prompts 目录 */
function getBaseDir(): string {
    return join(getProjectRoot(), "system-prompts");
}

/** Override 目录：workspace/system-prompts-overrides/ */
function getOverrideDir(): string {
    return join(getProjectRoot(), "workspace", "system-prompts-overrides");
}

// ─── 公开 API ───

/**
 * 加载 prompt 文件，优先读取 override 版本
 *
 * @param relativePath 相对于 system-prompts/ 的路径，如 "memory/reflection-system.md"
 * @returns 文件内容字符串，如果两者都不存在返回 null
 */
export function loadPromptFile(relativePath: string): string | null {
    const overridePath = join(getOverrideDir(), relativePath);
    if (existsSync(overridePath)) {
        const content = readFileSync(overridePath, "utf-8");
        log.debug("loadPromptFile: 使用 override", { relativePath, path: overridePath });
        return content;
    }

    const basePath = join(getBaseDir(), relativePath);
    if (existsSync(basePath)) {
        const content = readFileSync(basePath, "utf-8");
        return content;
    }

    log.warn("loadPromptFile: 文件不存在", { relativePath });
    return null;
}

/**
 * 检查指定 prompt 文件是否有 override 版本
 */
export function hasOverride(relativePath: string): boolean {
    return existsSync(join(getOverrideDir(), relativePath));
}

/**
 * 读取原始 prompt 文件内容（不经过 override）
 */
export function loadOriginalPrompt(relativePath: string): string | null {
    const basePath = join(getBaseDir(), relativePath);
    if (!existsSync(basePath)) return null;
    return readFileSync(basePath, "utf-8");
}

/**
 * 读取 override 文件内容
 */
export function loadOverridePrompt(relativePath: string): string | null {
    const overridePath = join(getOverrideDir(), relativePath);
    if (!existsSync(overridePath)) return null;
    return readFileSync(overridePath, "utf-8");
}

/**
 * 保存 override 文件
 */
export function saveOverride(relativePath: string, content: string): void {
    const overridePath = join(getOverrideDir(), relativePath);
    const dir = dirname(overridePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(overridePath, content, "utf-8");
    log.info("saveOverride: 已保存", { relativePath, length: content.length });
}

/**
 * 删除 override 文件（恢复到原始版本）
 */
export function deleteOverride(relativePath: string): boolean {
    const overridePath = join(getOverrideDir(), relativePath);
    if (!existsSync(overridePath)) return false;
    unlinkSync(overridePath);
    log.info("deleteOverride: 已删除", { relativePath });
    return true;
}

/**
 * 递归扫描 system-prompts/ 目录，返回所有 prompt 文件的元信息
 */
export function listAllPrompts(): Array<{
    relativePath: string;
    hasOverride: boolean;
}> {
    const baseDir = getBaseDir();
    if (!existsSync(baseDir)) return [];

    const results: Array<{ relativePath: string; hasOverride: boolean }> = [];

    function walk(dir: string): void {
        const entries = readdirSync(dir);
        for (const entry of entries) {
            const fullPath = join(dir, entry);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                walk(fullPath);
            } else if (entry.endsWith(".md")) {
                const relPath = relative(baseDir, fullPath);
                results.push({
                    relativePath: relPath,
                    hasOverride: existsSync(join(getOverrideDir(), relPath)),
                });
            }
        }
    }

    walk(baseDir);
    return results;
}

// ─── 缓存清除回调注册 ───

type CacheClearFn = () => void;
const _cacheClearCallbacks: CacheClearFn[] = [];

/**
 * 注册一个缓存清除回调（各模块在初始化时调用）
 */
export function registerCacheClear(fn: CacheClearFn): void {
    _cacheClearCallbacks.push(fn);
}

/**
 * 触发所有已注册的缓存清除回调
 * 在 override 保存/删除后调用，使更改即时生效
 */
export function reloadAllPrompts(): void {
    for (const fn of _cacheClearCallbacks) {
        try {
            fn();
        } catch (err) {
            log.warn("reloadAllPrompts: 缓存清除回调失败", { error: String(err) });
        }
    }
    log.info("reloadAllPrompts: 所有 prompt 缓存已清除", { callbackCount: _cacheClearCallbacks.length });
}
