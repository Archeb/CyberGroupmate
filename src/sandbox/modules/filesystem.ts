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

// ─── API 实现 ───

export const filesystem = {
    /**
     * 读取文件内容
     */
    readFile(path: string): string {
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
        return readFileSync(resolved, "utf-8");
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
