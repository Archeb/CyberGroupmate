/**
 * skill-loader.ts — 动态 Skill 加载器
 *
 * 扫描 workspace/skills/ 目录，动态加载用户定义的纯 Worker 端 Skills，
 * 并将其导出的对象挂载到 Sandbox ctx 上。
 *
 * 约定：
 * - workspace/skills/<name>/index.ts  — 入口文件，default export 或命名 export
 * - workspace/skills/<name>/<name>.d.ts — Agent 可见的 API 文档
 * - workspace/skills/package.json — 聚合所有 Skill 的依赖
 *
 * @see docs/sandbox-module-guide.md
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SKILLS_DIR = resolve("workspace/skills");

export interface LoadedSkill {
    /** Skill 名称（目录名） */
    name: string;
    /** 挂载到 ctx 上的对象 */
    exports: Record<string, unknown>;
    /** d.ts 文件路径（如有） */
    dtsPath?: string;
}

/**
 * 扫描 workspace/skills/ 目录，发现所有可用的 Skill
 *
 * @returns Skill 名称及路径列表
 */
export function discoverSkills(): Array<{ name: string; indexPath: string; dtsPath?: string }> {
    if (!existsSync(SKILLS_DIR)) return [];

    const entries = readdirSync(SKILLS_DIR);
    const skills: Array<{ name: string; indexPath: string; dtsPath?: string }> = [];

    for (const entry of entries) {
        const dirPath = join(SKILLS_DIR, entry);
        // 跳过非目录（package.json, node_modules, .env 等）
        if (!statSync(dirPath).isDirectory()) continue;
        if (entry === "node_modules" || entry.startsWith(".")) continue;

        // 查找入口文件（优先 index.ts，其次 index.js）
        const indexTs = join(dirPath, "index.ts");
        const indexJs = join(dirPath, "index.js");
        const indexPath = existsSync(indexTs) ? indexTs : existsSync(indexJs) ? indexJs : null;

        if (!indexPath) {
            process.stderr.write(`[skill-loader] ⚠ 跳过 ${entry}/: 未找到 index.ts 或 index.js\n`);
            continue;
        }

        // 查找 d.ts 文件
        const dtsFiles = readdirSync(dirPath).filter(f => f.endsWith(".d.ts"));
        const dtsPath = dtsFiles.length > 0 ? join(dirPath, dtsFiles[0]) : undefined;

        skills.push({ name: entry, indexPath, dtsPath });
    }

    return skills;
}

/**
 * 动态加载单个 Skill
 *
 * @param name Skill 名称
 * @param indexPath 入口文件路径
 * @returns 加载后的导出对象，失败返回 null（不阻断其他 Skill 加载）
 */
async function loadSingleSkill(name: string, indexPath: string): Promise<Record<string, unknown> | null> {
    try {
        // 使用 file:// URL 动态 import（ESM 兼容）
        const mod = await import(pathToFileURL(indexPath).href);

        // 约定：优先使用 default export，其次使用同名 export，最后用整个 module
        if (mod.default) return mod.default;
        if (mod[name]) return mod[name];

        // 过滤掉 __esModule 等内部属性
        const exports: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(mod)) {
            if (!key.startsWith("__")) exports[key] = value;
        }
        return exports;
    } catch (err) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        process.stderr.write(`[skill-loader] ❌ 加载 Skill "${name}" 失败:\n${msg}\n`);
        return null;
    }
}

/**
 * 加载所有可用的 Skills 并返回结果
 *
 * 失败的 Skill 不会阻断其他 Skill 的加载。
 */
export async function loadAllSkills(): Promise<LoadedSkill[]> {
    const discovered = discoverSkills();
    if (discovered.length === 0) return [];

    process.stderr.write(`[skill-loader] 发现 ${discovered.length} 个 Skills: ${discovered.map(s => s.name).join(", ")}\n`);

    const loaded: LoadedSkill[] = [];

    for (const skill of discovered) {
        const exports = await loadSingleSkill(skill.name, skill.indexPath);
        if (exports) {
            loaded.push({
                name: skill.name,
                exports,
                dtsPath: skill.dtsPath,
            });
            process.stderr.write(`[skill-loader] ✅ ${skill.name} 已加载\n`);
        }
    }

    return loaded;
}

/**
 * 将加载好的 Skills 挂载到 ctx 上
 *
 * @param ctx Sandbox 运行时上下文
 * @param skills 已加载的 Skill 列表
 */
export function mountSkillsToCtx(ctx: Record<string, unknown>, skills: LoadedSkill[]): void {
    for (const skill of skills) {
        ctx[skill.name] = skill.exports;
    }
}

/**
 * 获取所有已加载 Skills 的模块名称列表（用于动态构建 api-intent-extractor 的前缀）
 */
export function getSkillNames(skills: LoadedSkill[]): string[] {
    return skills.map(s => s.name);
}
