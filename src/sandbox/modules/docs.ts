/**
 * modules/docs.ts — Docs 文档系统模块
 *
 * 从 workspace/agent-docs/ 目录读取 markdown 文档，
 * 同时扫描 workspace/skills/<skill-name>/SKILL.md，挂载标准 Agent Skills。
 *
 * 完全在 worker 进程内本地执行，不经过 Host callHost。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** 基于源码位置定位项目根（src/sandbox/modules/docs.ts → 项目根），不依赖 process.cwd() */
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../..");
const DOCS_DIR = resolve(PROJECT_ROOT, "workspace/agent-docs");
const AGENT_SKILLS_DIR = resolve(PROJECT_ROOT, "workspace/skills");

export interface DocEntry {
    slug: string;
    title: string;
    content: string;
    kind: "doc" | "agent-skill";
}

export interface AgentSkillEntry {
    slug: string;
    title: string;
    content: string;
    kind: "agent-skill";
    name: string;
    description: string;
    dirName: string;
    scriptsDir?: string;
}

interface ParsedFrontmatter {
    name?: string;
    description?: string;
    body: string;
}

function parseFrontmatter(markdown: string): ParsedFrontmatter {
    const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?/);
    if (!match) {
        return { body: markdown };
    }

    const frontmatter = match[1];
    const body = markdown.slice(match[0].length);
    const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    return { name, description, body };
}

function loadMarkdownDocs(): DocEntry[] {
    if (!existsSync(DOCS_DIR)) return [];

    return readdirSync(DOCS_DIR)
        .filter(f => f.endsWith(".md") && !f.startsWith("CHANGELOG"))
        .map(f => {
            const content = readFileSync(join(DOCS_DIR, f), "utf-8");
            const slug = basename(f, extname(f));
            const titleMatch = content.match(/^#\s+(.+)$/m);
            return { slug, title: titleMatch?.[1] ?? slug, content, kind: "doc" as const };
        });
}

export function loadAgentSkillDocs(projectRoot: string = process.cwd()): AgentSkillEntry[] {
    const skillsDir = resolve(projectRoot, AGENT_SKILLS_DIR);
    if (!existsSync(skillsDir)) return [];

    const entries: AgentSkillEntry[] = [];

    for (const entry of readdirSync(skillsDir)) {
        const skillDir = join(skillsDir, entry);
        if (!statSync(skillDir).isDirectory()) continue;
        if (entry === "node_modules" || entry.startsWith(".")) continue;

        const skillMdPath = join(skillDir, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;

        const raw = readFileSync(skillMdPath, "utf-8");
        const parsed = parseFrontmatter(raw);
        const name = parsed.name || entry;
        const description = parsed.description || "Standard Agent Skill";
        const scriptsDir = join(skillDir, "scripts");

        entries.push({
            slug: name,
            title: `[AgentSkill] ${name}${parsed.description ? ` - ${parsed.description}` : ""}`,
            content: parsed.body,
            kind: "agent-skill",
            name,
            description,
            dirName: entry,
            scriptsDir: existsSync(scriptsDir) && statSync(scriptsDir).isDirectory() ? scriptsDir : undefined,
        });
    }

    return entries;
}

function loadAllDocs(): DocEntry[] {
    return loadMarkdownDocs();
}

export function getAgentSkillsApiBriefs(projectRoot: string = process.cwd(), allowedSkills?: Set<string>): string {
    const skills = loadAgentSkillDocs(projectRoot);
    if (skills.length === 0) return "";

    const filtered = allowedSkills ? skills.filter(s => allowedSkills.has(s.name) || allowedSkills.has(s.dirName)) : skills;
    if (filtered.length === 0) return "";

    const lines: string[] = [];
    for (const skill of filtered) {
        lines.push(`## ${skill.name}`);
        lines.push(`${skill.description}`);
        lines.push(`- use: 打印并阅读该 Skill 的详细指南。调用方式: await ${skill.name}.use()`);
    }

    return lines.join("\n");
}

export function getAgentSkillsBriefs(allowedSkills?: Set<string>): string {
    const skills = loadAgentSkillDocs();
    if (skills.length === 0) return "";

    const filtered = allowedSkills ? skills.filter(s => allowedSkills.has(s.name) || allowedSkills.has(s.dirName)) : skills;
    if (filtered.length === 0) return "";

    return filtered
        .map(skill =>
            `- ${skill.name}: ${skill.description}. (调用 \`await ${skill.name}.use()\` 查看详细指南)`
        )
        .join("\n");
}

/**
 * 生成 AgentSkills 的极简名册（供主 Agent 决策时浏览，与 TS Skills 拍平展示）
 *
 * 每个 Skill 只占一行，格式：“- skillName: description”
 */
export function getAgentSkillsRoster(excludeBaseSkills?: Set<string>): string {
    const skills = loadAgentSkillDocs();
    if (skills.length === 0) return "";

    const lines: string[] = [];
    for (const skill of skills) {
        if (excludeBaseSkills && (excludeBaseSkills.has(skill.name) || excludeBaseSkills.has(skill.dirName))) continue;
        lines.push(`- ${skill.name}: ${skill.description}`);
    }
    return lines.join("\n");
}

/**
 * 构建 AgentSkill 注入对象（供 Sandbox Worker 动态注入）
 *
 * 每个 AgentSkill 会被转化为一个 { use(): Promise<string> } 对象，
 * 调用 .use() 时将 SKILL.md 内容通过 console.log 打印到 outputLines。
 */
export function buildAgentSkillUseObjects(): Array<{ name: string; obj: { use: () => string } }> {
    const skills = loadAgentSkillDocs();
    return skills.map(skill => ({
        name: skill.name,
        obj: {
            use: () => {
                const header = `\n═══ [AgentSkill: ${skill.name}] ${skill.description} ═══`;
                const footer = `═══ [/${skill.name}] ═══\n`;
                const content = `${header}\n${skill.content}\n${footer}`;
                console.log(content);
                return content;
            },
        },
    }));
}

export function getAgentSkillScriptDirs(projectRoot: string = process.cwd()): string[] {
    return loadAgentSkillDocs(projectRoot)
        .map(skill => skill.scriptsDir)
        .filter((dir): dir is string => Boolean(dir));
}

export const docs = {
    list: () => loadAllDocs().map(d => ({ slug: d.slug, title: d.title, kind: d.kind })),
    read: (slug: string): string => {
        const normalized = slug.trim().toLowerCase();
        const allDocs = loadAllDocs();

        const exact = allDocs.find(d => d.slug.toLowerCase() === normalized);
        if (exact) return exact.content;

        const fuzzy = allDocs.find(d =>
            d.slug.toLowerCase().includes(normalized) || normalized.includes(d.slug.toLowerCase())
        );
        if (fuzzy) return fuzzy.content;

        if (allDocs.length === 0) return `文档 "${slug}" 不存在，且没有可用的文档。`;
        return `文档 "${slug}" 不存在。可用文档：\n${allDocs.map(d => `  - ${d.slug}: ${d.title}`).join("\n")}`;
    },
};
