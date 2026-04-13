/**
 * modules/docs.ts — Docs 文档系统模块
 *
 * 从 workspace/agent-docs/ 目录读取 markdown 文档，
 * 同时扫描 workspace/skills/*/SKILL.md，挂载标准 Agent Skills。
 *
 * 完全在 worker 进程内本地执行，不经过 Host callHost。
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, extname, resolve } from "node:path";

const DOCS_DIR = "workspace/agent-docs";
const AGENT_SKILLS_DIR = "workspace/skills";

export interface DocEntry {
    slug: string;
    title: string;
    content: string;
    kind: "doc" | "agent-skill";
}

interface AgentSkillEntry {
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

function loadAgentSkillDocs(projectRoot: string = process.cwd()): AgentSkillEntry[] {
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
    return [...loadMarkdownDocs(), ...loadAgentSkillDocs()];
}

export function getAgentSkillsBriefs(): string {
    const skills = loadAgentSkillDocs();
    if (skills.length === 0) return "";

    return skills
        .map(skill =>
            `- ${skill.name}: ${skill.description}. (阅读详细指令请使用 \`docs.read("${skill.name}")\`)`
        )
        .join("\n");
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

        const skillExact = loadAgentSkillDocs().find(skill =>
            skill.name.toLowerCase() === normalized || skill.dirName.toLowerCase() === normalized
        );
        if (skillExact) return skillExact.content;

        const fuzzy = allDocs.find(d =>
            d.slug.toLowerCase().includes(normalized) || normalized.includes(d.slug.toLowerCase())
        );
        if (fuzzy) return fuzzy.content;

        if (allDocs.length === 0) return `文档 "${slug}" 不存在，且没有可用的文档。`;
        return `文档 "${slug}" 不存在。可用文档：\n${allDocs.map(d => `  - ${d.slug}: ${d.title}`).join("\n")}`;
    },
};
