/**
 * modules/filesystem.ts — 沙箱文件系统模块
 *
 * 提供给 LLM 代码使用的文件操作 API。
 * 所有路径操作限定在 workspace/ 目录下（防目录穿越）。
 * 完全在 Worker 进程内本地执行，不经过 Host callHost。
 */

import {
    readFileSync,
    writeFileSync,
    appendFileSync,
    readdirSync,
    existsSync,
    unlinkSync,
    mkdirSync,
    statSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";

interface ReadFileOptions {
    withLineNumbers?: boolean;
    startLine?: number;
    endLine?: number;
}

interface ReplaceOptions {
    all?: boolean;
}

interface PatchHunk {
    oldStart: number;
    oldLines: number;
    newLines: string[];
}

// ─── 安全路径解析 ───

/** workspace 根目录（Worker 进程 CWD 已被设置为 workspace/） */
const WORKSPACE_ROOT = resolve(process.cwd());

/** 单文件大小限制 (bytes) */
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * 解析并验证路径安全性。
 * 所有路径必须在 workspace/ 下。
 * 支持相对路径（相对于 workspace/）和绝对路径。
 * 
 * @throws 路径超出 workspace 范围时抛出错误
 */
function safePath(userPath: string): string {
    let resolved: string;
    if (userPath.startsWith("/")) {
        resolved = resolve(userPath);
    } else {
        // 相对路径基于 workspace/
        resolved = resolve(WORKSPACE_ROOT, userPath);
    }

    // 检查是否在 workspace/ 下
    const rel = relative(WORKSPACE_ROOT, resolved);
    if (rel.startsWith("..") || resolve(WORKSPACE_ROOT, rel) !== resolved) {
        throw new Error(
            `[fs 安全限制] 路径 "${userPath}" 超出 workspace 范围。所有文件操作必须在 workspace/ 目录下。`
        );
    }

    return resolved;
}

function normalizeReadOptions(options?: ReadFileOptions): Required<ReadFileOptions> {
    const startLine = options?.startLine == null ? 1 : Math.trunc(options.startLine);
    const endLine = options?.endLine == null ? Number.MAX_SAFE_INTEGER : Math.trunc(options.endLine);
    if (!Number.isInteger(startLine) || startLine < 1) {
        throw new Error("startLine 必须是大于等于 1 的整数");
    }
    if (!Number.isInteger(endLine) || endLine < startLine) {
        throw new Error("endLine 必须是大于等于 startLine 的整数");
    }
    return {
        withLineNumbers: options?.withLineNumbers === true,
        startLine,
        endLine,
    };
}

function sliceLines(content: string, options?: ReadFileOptions): string {
    const normalized = normalizeReadOptions(options);
    const endsWithNewline = content.endsWith("\n");
    const lines = content.split("\n");
    const effectiveLines = endsWithNewline ? lines.slice(0, -1) : lines;
    const selected = effectiveLines.slice(normalized.startLine - 1, normalized.endLine);
    if (normalized.withLineNumbers) {
        return selected.map((line, index) => `${normalized.startLine + index}: ${line}`).join("\n");
    }
    return selected.join("\n");
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseUnifiedPatch(diff: string): PatchHunk[] {
    const lines = diff.replace(/\r\n/g, "\n").split("\n");
    const hunks: PatchHunk[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index];
        if (!line) {
            index++;
            continue;
        }
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (!match) {
            throw new Error(`无效 patch hunk 头: ${line}`);
        }

        const oldStart = Number(match[1]);
        const oldLines = Number(match[2] ?? "1");
        const newLines: string[] = [];
        index++;

        while (index < lines.length && !lines[index].startsWith("@@ ")) {
            const hunkLine = lines[index] ?? "";
            if (hunkLine.startsWith("+") || hunkLine.startsWith(" ")) {
                newLines.push(hunkLine.slice(1));
            } else if (hunkLine.startsWith("-")) {
                // 删除行由 oldLines 体现
            } else if (hunkLine === "\\ No newline at end of file") {
                // ignore
            } else if (hunkLine === "") {
                newLines.push("");
            } else {
                throw new Error(`无效 patch 内容: ${hunkLine}`);
            }
            index++;
        }

        hunks.push({ oldStart, oldLines, newLines });
    }

    return hunks;
}

function applyUnifiedPatch(original: string, diff: string): string {
    const endsWithNewline = original.endsWith("\n");
    const lines = original.split("\n");
    const bodyLines = endsWithNewline ? lines.slice(0, -1) : lines;
    const hunks = parseUnifiedPatch(diff);
    let offset = 0;

    for (const hunk of hunks) {
        const startIndex = hunk.oldStart - 1 + offset;
        if (startIndex < 0 || startIndex > bodyLines.length) {
            throw new Error(`patch 行号超出范围: ${hunk.oldStart}`);
        }
        bodyLines.splice(startIndex, hunk.oldLines, ...hunk.newLines);
        offset += hunk.newLines.length - hunk.oldLines;
    }

    const next = bodyLines.join("\n");
    return endsWithNewline ? `${next}\n` : next;
}

// ─── API 实现 ───

export const filesystem = {
    /**
     * 读取文件内容
     */
    readFile(path: string, options?: ReadFileOptions): string {
        const resolved = safePath(path);
        if (!existsSync(resolved)) {
            throw new Error(`文件不存在: ${path}`);
        }
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
            throw new Error(`"${path}" 是目录，不是文件。请使用 fs.readdir() 列出目录内容。`);
        }
        if (stat.size > MAX_FILE_SIZE) {
            throw new Error(`文件过大: ${path} (${(stat.size / 1024 / 1024).toFixed(1)}MB)，限制 ${MAX_FILE_SIZE / 1024 / 1024}MB`);
        }
        return sliceLines(readFileSync(resolved, "utf-8"), options);
    },

    /**
     * 写入文件（自动创建目录）
     */
    writeFile(path: string, content: string): void {
        const resolved = safePath(path);
        const contentBytes = Buffer.byteLength(content, "utf-8");
        if (contentBytes > MAX_FILE_SIZE) {
            throw new Error(`内容过大 (${(contentBytes / 1024 / 1024).toFixed(1)}MB)，限制 ${MAX_FILE_SIZE / 1024 / 1024}MB`);
        }
        const dir = resolve(resolved, "..");
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        writeFileSync(resolved, content, "utf-8");
    },

    /**
     * 追加写入文件
     */
    appendFile(path: string, content: string): void {
        const resolved = safePath(path);
        const dir = resolve(resolved, "..");
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        appendFileSync(resolved, content, "utf-8");
    },

    /**
     * 按字符串查找替换（类似 sed）
     */
    replace(path: string, search: string, replacement: string, options?: ReplaceOptions): { ok: true; count: number } {
        const resolved = safePath(path);
        if (!existsSync(resolved)) {
            throw new Error(`文件不存在: ${path}`);
        }
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
            throw new Error(`"${path}" 是目录，不是文件。`);
        }
        if (!search) {
            throw new Error("search 不能为空");
        }
        const original = readFileSync(resolved, "utf-8");
        const pattern = new RegExp(escapeRegExp(search), options?.all ? "g" : "");
        const count = original.match(pattern)?.length ?? 0;
        if (count === 0) {
            throw new Error(`未找到要替换的内容: ${search}`);
        }
        writeFileSync(resolved, original.replace(pattern, replacement), "utf-8");
        return { ok: true, count };
    },

    /**
     * 应用 unified diff patch
     */
    patch(path: string, diff: string): { ok: true } {
        const resolved = safePath(path);
        if (!existsSync(resolved)) {
            throw new Error(`文件不存在: ${path}`);
        }
        const stat = statSync(resolved);
        if (stat.isDirectory()) {
            throw new Error(`"${path}" 是目录，不是文件。`);
        }
        const original = readFileSync(resolved, "utf-8");
        writeFileSync(resolved, applyUnifiedPatch(original, diff), "utf-8");
        return { ok: true };
    },

    /**
     * 列出目录内容
     */
    readdir(path: string): string[] {
        const resolved = safePath(path);
        if (!existsSync(resolved)) {
            throw new Error(`目录不存在: ${path}`);
        }
        return readdirSync(resolved);
    },

    /**
     * 检查文件或目录是否存在
     */
    exists(path: string): boolean {
        const resolved = safePath(path);
        return existsSync(resolved);
    },

    /**
     * 删除文件
     */
    unlink(path: string): void {
        const resolved = safePath(path);
        if (!existsSync(resolved)) {
            throw new Error(`文件不存在: ${path}`);
        }
        unlinkSync(resolved);
    },

    /**
     * 创建目录（递归）
     */
    mkdir(path: string): void {
        const resolved = safePath(path);
        if (!existsSync(resolved)) {
            mkdirSync(resolved, { recursive: true });
        }
    },

    /**
     * 获取文件/目录状态
     */
    stat(path: string): { size: number; isDirectory: boolean; isFile: boolean; mtime: string } {
        const resolved = safePath(path);
        if (!existsSync(resolved)) {
            throw new Error(`路径不存在: ${path}`);
        }
        const s = statSync(resolved);
        return {
            size: s.size,
            isDirectory: s.isDirectory(),
            isFile: s.isFile(),
            mtime: s.mtime.toISOString(),
        };
    },
};
