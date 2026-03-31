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

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseDtsFile } from "./dts-parser.js";
import { createLogger } from "../core/logger.js";
import type { ModuleEntry } from "./modules/module-registry.js";

const log = createLogger("skill-loader");
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
            log.warn(`[skill-loader] ⚠ 跳过 ${entry}/: 未找到 index.ts 或 index.js\n`);
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
        log.warn(`[skill-loader] ❌ 加载 Skill "${name}" 失败:\n${msg}\n`);
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

    log.info(`[skill-loader] 发现 ${discovered.length} 个 Skills: ${discovered.map(s => s.name).join(", ")}\n`);

    const loaded: LoadedSkill[] = [];

    for (const skill of discovered) {
        const exports = await loadSingleSkill(skill.name, skill.indexPath);
        if (exports) {
            loaded.push({
                name: skill.name,
                exports,
                dtsPath: skill.dtsPath,
            });
            log.info(`[skill-loader] ✅ ${skill.name} 已加载\n`);
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

/**
 * 纯静态扫描并解析所有 Skills 的 d.ts 文件（供 Host 进程调用，防止执行不受信任代码）
 * 依赖 dts-parser 纯正则解析，杜绝引入实际的 Node 模块。
 *
 * @returns 解析后的 ModuleEntry 列表，可直接馈入 LLM Context
 */
export function parseAllSkillDocs(): ModuleEntry[] {
    const discovered = discoverSkills();
    const entries: ModuleEntry[] = [];

    for (const skill of discovered) {
        if (!skill.dtsPath) continue;
        try {
            const content = readFileSync(skill.dtsPath, "utf-8");
            const parsed = parseDtsFile(content, skill.dtsPath);

            // 修正默认占位符名称为实际的 skill.name
            for (const mod of parsed) {
                if (mod.name === "default") {
                    mod.name = skill.name;
                }
                entries.push(mod);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.stack ?? err.message : String(err);
            log.warn(`解析 Skill "${skill.name}" 的文档失败`, { error: msg });
        }
    }

    return entries;
}

/**
 * 检查 workspace/skills 目录，如有 package.json 且 hash 发生变化，则自动执行 npm install
 * @param skillsPath skills 根目录路径
 */
export async function installSkillsDependencies(skillsPath: string): Promise<void> {
    const pkgPath = join(skillsPath, "package.json");
    if (!existsSync(pkgPath)) return;

    try {
        const pkgContent = readFileSync(pkgPath, "utf-8");
        const currentHash = createHash("md5").update(pkgContent).digest("hex");

        const hashFilePath = join(skillsPath, ".skills-deps-hash");
        const nodeModulesPath = join(skillsPath, "node_modules");

        // 检查 node_modules 是否缺失，或者 hash 是否改变
        let shouldInstall = false;
        if (!existsSync(nodeModulesPath)) {
            shouldInstall = true;
        } else if (existsSync(hashFilePath)) {
            const savedHash = readFileSync(hashFilePath, "utf-8").trim();
            if (savedHash !== currentHash) {
                shouldInstall = true;
            }
        } else {
            shouldInstall = true;
        }

        if (shouldInstall) {
            log.info("📦 检测到 Skills 依赖变更，正在自动安装...");

            await new Promise<void>((resolve, reject) => {
                // 使用跨平台方式执行 npm (主要防 windows 环境)
                const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

                const child = spawn(npmCmd, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
                    cwd: skillsPath,
                    stdio: "inherit",
                    env: process.env
                });

                child.on("close", (code) => {
                    if (code === 0) {
                        try { writeFileSync(hashFilePath, currentHash, "utf-8"); } catch { }
                        log.info("✅ Skills 依赖安装完成");
                        resolve();
                    } else {
                        reject(new Error(`npm install failed with code ${code}`));
                    }
                });
                child.on("error", reject);
            });
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("自动安装 Skills 依赖失败", { error: msg });
    }
}
