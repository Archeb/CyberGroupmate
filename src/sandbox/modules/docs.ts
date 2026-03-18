/**
 * modules/docs.ts — Docs 文档系统模块
 *
 * 从 workspace/agent-docs/ 目录读取 markdown 文档，
 * 提供给 Agent 通过 docs.list() / docs.read(slug) 查阅。
 *
 * 完全在 worker 进程内本地执行，不经过 Host callHost。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";

interface DocEntry {
    slug: string;
    title: string;
    content: string;
}

function loadAllDocs(): DocEntry[] {
    const DOCS_DIR = "workspace/agent-docs";
    if (!existsSync(DOCS_DIR)) return [];
    return readdirSync(DOCS_DIR)
        .filter(f => f.endsWith(".md") && !f.startsWith("CHANGELOG"))
        .map(f => {
            const content = readFileSync(join(DOCS_DIR, f), "utf-8");
            const slug = basename(f, extname(f));
            const titleMatch = content.match(/^#\s+(.+)$/m);
            return { slug, title: titleMatch?.[1] ?? slug, content };
        });
}

const allDocs = loadAllDocs();

export const docs = {
    list: () => allDocs.map(d => ({ slug: d.slug, title: d.title })),
    read: (slug: string): string => {
        const exact = allDocs.find(d => d.slug === slug);
        if (exact) return exact.content;
        const fuzzy = allDocs.find(d => d.slug.includes(slug) || slug.includes(d.slug));
        if (fuzzy) return fuzzy.content;
        if (allDocs.length === 0) return `文档 "${slug}" 不存在，且没有可用的文档。`;
        return `文档 "${slug}" 不存在。可用文档：\n${allDocs.map(d => `  - ${d.slug}: ${d.title}`).join("\n")}`;
    },
};
