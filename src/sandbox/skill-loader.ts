/**
 * skill-loader.ts — 动态 Skill 加载器
 *
 * 扫描 workspace/skills/ 目录，动态加载用户定义的纯 Worker 端 Skills，
 * 并将其导出的对象作为顶层变量注入 Sandbox 环境。
 *
 * 约定：
 * - workspace/skills/<name>/index.ts  — 入口文件，default export 或命名 export
 * - workspace/skills/<name>/<name>.d.ts — Agent 可见的 API 文档
 * - workspace/skills/package.json — 聚合所有 Skill 的依赖
 *
 * @see docs/sandbox-module-guide.md
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { parseDtsFile } from "./dts-parser.js";
import { createLogger } from "../core/logger.js";
import type { ModuleEntry } from "./modules/module-registry.js";

const log = createLogger("skill-loader");

/**
 * 解析 SKILL.md 的 YAML frontmatter（name / description）
 * 与 docs/index.ts parseFrontmatter 保持一致的逻辑。
 */
function parseSkillMdFrontmatter(markdown: string): { name?: string; description?: string; body: string } {
    const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?/);
    if (!match) return { body: markdown };
    const fm = match[1];
    const body = markdown.slice(match[0].length);
    const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    return { name, description, body };
}

/**
 * 将名称转为合法 JS 标识符（与 docs/index.ts 保持一致：不做 camelCase 转换，
 * 仅替换非法字符为下划线）。
 */
function toSafeSkillName(str: string): string {
    let name = str.replace(/[^a-zA-Z0-9_$]/g, "_");
    if (/^[0-9]/.test(name)) name = "_" + name;
    return name;
}
/** 基于源码位置定位项目根（src/sandbox/skill-loader.ts → 项目根），不依赖 process.cwd() */
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");
const SKILLS_DIR = resolve(PROJECT_ROOT, "workspace/skills");

export interface LoadedSkill {
    /** Skill 名称（目录名） */
    name: string;
    /** 作为顶层变量注入 sandbox 的对象 */
    exports: Record<string, unknown>;
    /** d.ts 文件路径（如有） */
    dtsPath?: string;
    /** 是否为纯 AgentSkill（SKILL.md 驱动，无代码入口） */
    isAgentSkill?: boolean;
}

/** discoverSkills 返回的发现结果 */
export interface DiscoveredSkill {
    name: string;
    indexPath: string;
    dtsPath?: string;
    /** 纯 AgentSkill 标记 */
    isAgentSkill?: boolean;
    /** SKILL.md 路径（纯 AgentSkill 必有） */
    skillMdPath?: string;
}

function toSafeIdentifier(str: string): string {
    let name = str.replace(/-+([a-zA-Z0-9])/g, (_, letter) => letter.toUpperCase());
    name = name.replace(/[^a-zA-Z0-9_$]/g, "_");
    if (/^[0-9]/.test(name)) name = "_" + name;
    return name;
}

/**
 * 扫描 workspace/skills/ 目录，发现所有可用的 Skill
 *
 * @returns Skill 名称及路径列表
 */
export function discoverSkills(): DiscoveredSkill[] {
    if (!existsSync(SKILLS_DIR)) return [];

    const entries = readdirSync(SKILLS_DIR);
    const skills: DiscoveredSkill[] = [];

    for (const entry of entries) {
        const dirPath = join(SKILLS_DIR, entry);
        // 跳过非目录（package.json, node_modules, .env 等）
        if (!statSync(dirPath).isDirectory()) continue;
        if (entry === "node_modules" || entry.startsWith(".")) continue;

        const skillMd = join(dirPath, "SKILL.md");

        // 查找入口文件（优先 index.ts，其次 index.js）
        const indexTs = join(dirPath, "index.ts");
        const indexJs = join(dirPath, "index.js");
        const indexPath = existsSync(indexTs) ? indexTs : existsSync(indexJs) ? indexJs : null;

        if (!indexPath) {
            if (existsSync(skillMd)) {
                // ═══ 纯 AgentSkill：只有 SKILL.md，无代码入口 ═══
                // 从 frontmatter 提取名称（与 docs/index.ts 保持一致）
                try {
                    const raw = readFileSync(skillMd, "utf-8");
                    const parsed = parseSkillMdFrontmatter(raw);
                    const name = parsed.name ? toSafeSkillName(parsed.name) : toSafeSkillName(entry);
                    skills.push({ name, indexPath: "", isAgentSkill: true, skillMdPath: skillMd });
                } catch {
                    skills.push({ name: toSafeSkillName(entry), indexPath: "", isAgentSkill: true, skillMdPath: skillMd });
                }
            } else {
                log.warn(`[skill-loader] ⚠ 跳过 ${entry}/: 未找到 index.ts、index.js 或 SKILL.md\n`);
            }
            continue;
        }

        // 查找 d.ts 文件（优先 <name>.d.ts，其次取第一个）
        const dtsFiles = readdirSync(dirPath).filter(f => f.endsWith(".d.ts"));
        const preferredDts = dtsFiles.find(f => f === `${entry}.d.ts`);
        const dtsPath = preferredDts ? join(dirPath, preferredDts)
            : dtsFiles.length > 0 ? join(dirPath, dtsFiles[0]) : undefined;

        skills.push({ name: toSafeIdentifier(entry), indexPath, dtsPath });
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
        // ═══ 纯 AgentSkill：生成虚拟 use() 导出 ═══
        if (skill.isAgentSkill && skill.skillMdPath) {
            try {
                const raw = readFileSync(skill.skillMdPath, "utf-8");
                const parsed = parseSkillMdFrontmatter(raw);
                const description = parsed.description || "Agent Skill";
                const body = parsed.body;
                const skillName = skill.name;

                loaded.push({
                    name: skillName,
                    exports: {
                        use: () => {
                            const header = `\n═══ [AgentSkill: ${skillName}] ${description} ═══`;
                            const footer = `═══ [/${skillName}] ═══\n`;
                            const content = `${header}\n${body}\n${footer}`;
                            console.log(content);
                            return content;
                        },
                    },
                    isAgentSkill: true,
                });
                log.info(`[skill-loader] ✅ ${skillName} (AgentSkill) 已加载\n`);
            } catch (err) {
                const msg = err instanceof Error ? err.stack ?? err.message : String(err);
                log.warn(`[skill-loader] ❌ 加载 AgentSkill "${skill.name}" 失败:\n${msg}\n`);
            }
            continue;
        }

        // ═══ 代码型 TS Skill：从 index.ts/js 动态 import ═══
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
        // ═══ 纯 AgentSkill：从 SKILL.md frontmatter 生成 ModuleEntry ═══
        if (skill.isAgentSkill && skill.skillMdPath) {
            try {
                const raw = readFileSync(skill.skillMdPath, "utf-8");
                const parsed = parseSkillMdFrontmatter(raw);
                const description = parsed.description || "Agent Skill";
                entries.push({
                    name: skill.name,
                    description,
                    methods: [{
                        name: "use",
                        brief: `打印并阅读该 Skill 的详细指南。调用方式: await ${skill.name}.use()`,
                        fullDoc: `调用 \`await ${skill.name}.use()\` 查看完整使用指南。\n\n返回值: string（指南全文）`,
                    }],
                });
            } catch (err) {
                const msg = err instanceof Error ? err.stack ?? err.message : String(err);
                log.warn(`解析 AgentSkill "${skill.name}" 的文档失败`, { error: msg });
            }
            continue;
        }

        // ═══ 代码型 TS Skill：从 .d.ts 解析 ═══
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

// ─── 热重载支持 ───

/** 热重载计数器（用于 cache-busting import） */
let reloadCounter = 0;

/**
 * 热重载所有 Skills。
 * 通过在 import URL 上追加 query string 绕过 ESM 缓存。
 * 
 * @returns 重新加载后的 LoadedSkill 列表
 */
export async function reloadAllSkills(): Promise<LoadedSkill[]> {
    reloadCounter++;
    const discovered = discoverSkills();
    if (discovered.length === 0) return [];

    log.info(`[skill-loader] 🔄 热重载 Skills (round ${reloadCounter}): ${discovered.map(s => s.name).join(", ")}`);

    const loaded: LoadedSkill[] = [];

    for (const skill of discovered) {
        // ═══ 纯 AgentSkill：重新读取 SKILL.md 并生成新的 use() 闭包 ═══
        if (skill.isAgentSkill && skill.skillMdPath) {
            try {
                const raw = readFileSync(skill.skillMdPath, "utf-8");
                const parsed = parseSkillMdFrontmatter(raw);
                const description = parsed.description || "Agent Skill";
                const body = parsed.body;
                const skillName = skill.name;

                loaded.push({
                    name: skillName,
                    exports: {
                        use: () => {
                            const header = `\n═══ [AgentSkill: ${skillName}] ${description} ═══`;
                            const footer = `═══ [/${skillName}] ═══\n`;
                            const content = `${header}\n${body}\n${footer}`;
                            console.log(content);
                            return content;
                        },
                    },
                    isAgentSkill: true,
                });
                log.info(`[skill-loader] ✅ ${skillName} (AgentSkill) 已重载`);
            } catch (err) {
                const msg = err instanceof Error ? err.stack ?? err.message : String(err);
                log.warn(`[skill-loader] ❌ 重载 AgentSkill "${skill.name}" 失败:\n${msg}`);
            }
            continue;
        }

        // ═══ 代码型 TS Skill：绕过 ESM 缓存重新 import ═══
        try {
            // 追加 ?reload=N 绕过 ESM import 缓存
            const fileUrl = pathToFileURL(skill.indexPath).href + `?reload=${reloadCounter}`;
            const mod = await import(fileUrl);

            let exports: Record<string, unknown>;
            if (mod.default) {
                exports = mod.default;
            } else if (mod[skill.name]) {
                exports = mod[skill.name];
            } else {
                exports = {};
                for (const [key, value] of Object.entries(mod)) {
                    if (!key.startsWith("__")) exports[key] = value;
                }
            }

            loaded.push({
                name: skill.name,
                exports,
                dtsPath: skill.dtsPath,
            });
            log.info(`[skill-loader] ✅ ${skill.name} 已重载`);
        } catch (err) {
            const msg = err instanceof Error ? err.stack ?? err.message : String(err);
            log.warn(`[skill-loader] ❌ 重载 Skill "${skill.name}" 失败:\n${msg}`);
        }
    }

    return loaded;
}

/**
 * 在运行时执行 npm install（用于 LLM 自助安装依赖）
 * 
 * @param packages 要安装的包列表（如 ["axios", "cheerio"]）
 * @returns npm install 的 stdout 输出
 */
export async function installDepsRuntime(packages: string[]): Promise<string> {
    if (packages.length === 0) {
        throw new Error("请指定至少一个要安装的包名");
    }

    // 安全检查：包名只允许 @scope/name 格式
    for (const pkg of packages) {
        if (!/^(@[\w-]+\/)?[\w.-]+(@[\w.^~>=<-]+)?$/.test(pkg)) {
            throw new Error(`无效的包名: "${pkg}"`);
        }
    }

    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

    return new Promise<string>((resolve, reject) => {
        const child = spawn(npmCmd, ["install", "--save", "--no-audit", "--no-fund", ...packages], {
            cwd: SKILLS_DIR,
            env: process.env,
        });

        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
        child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

        child.on("close", (code) => {
            if (code === 0) {
                resolve(stdout || "安装成功");
            } else {
                reject(new Error(`npm install failed (code ${code}): ${stderr || stdout}`));
            }
        });
        child.on("error", reject);
    });
}
