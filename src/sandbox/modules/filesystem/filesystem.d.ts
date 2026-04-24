/**
 * filesystem.d.ts — 文件系统操作模块类型定义
 * 
 * 所有路径操作限定在 workspace/ 目录下。
 * 支持相对路径（相对于 workspace/）和绝对路径。
 */

declare const fs: {
    /**
     * 读取文件内容。
     * @param path - 文件路径（相对于 workspace/ 或绝对路径）
     * @returns 文件内容字符串（UTF-8）
     * @throws 文件不存在或超出 workspace 范围时抛出错误
     * 
     * @example
     * const content = fs.readFile("skills/myskill/index.ts");
     * console.log(content);
     */
    readFile(path: string, options?: {
        /** 起始行号（1-based） */
        startLine?: number;
        /** 结束行号（1-based，含） */
        endLine?: number;
        /** 是否在返回结果中附带行号前缀 */
        withLineNumbers?: boolean;
    }): string;

    /**
     * 写入文件。如果目标目录不存在会自动创建。
     * @param path - 文件路径
     * @param content - 文件内容
     * 
     * @example
     * fs.writeFile("notes/todo.md", "# TODO\n- 完成作业");
     * 
     * @example
     * // 创建新的 TS Skill
     * fs.writeFile("skills/weather/index.ts", `
     *   import { fetch } from "node-fetch";
     *   export const weather = {
     *     current: async (city: string) => { ... }
     *   };
     * `);
     */
    writeFile(path: string, content: string): void;

    /**
     * 追加写入文件。文件不存在时会自动创建。
     * @param path - 文件路径
     * @param content - 追加的内容
     * 
     * @example
     * fs.appendFile("logs/activity.log", `${new Date().toISOString()} 执行了任务\n`);
     */
    appendFile(path: string, content: string): void;

    /**
     * 按字符串查找并替换文件内容，类似 sed。
     * 默认仅替换第一个匹配；传 all=true 可全量替换。
     */
    replace(path: string, search: string, replacement: string, options?: {
        all?: boolean;
    }): { ok: true; count: number };

    /**
     * 对文件应用 unified diff patch。
     * 适合 agent 在读取带行号内容后做小范围修改。
     */
    patch(path: string, diff: string): { ok: true };

    /**
     * 列出目录下的文件和子目录名。
     * @param path - 目录路径
     * @returns 文件名数组
     * 
     * @example
     * const files = fs.readdir("skills");
     * console.log("已安装的 Skills:", files);
     */
    readdir(path: string): string[];

    /**
     * 检查文件或目录是否存在。
     * @param path - 路径
     * @returns 是否存在
     */
    exists(path: string): boolean;

    /**
     * 删除文件。
     * @param path - 文件路径
     */
    unlink(path: string): void;

    /**
     * 创建目录（递归创建，类似 mkdir -p）。
     * @param path - 目录路径
     */
    mkdir(path: string): void;

    /**
     * 获取文件或目录的状态信息。
     * @param path - 路径
     * @returns 状态对象
     * 
     * @example
     * const info = fs.stat("skills/tavily/index.ts");
     * console.log(`文件大小: ${info.size} bytes, 最后修改: ${info.mtime}`);
     */
    stat(path: string): {
        /** 文件大小（字节） */
        size: number;
        /** 是否是目录 */
        isDirectory: boolean;
        /** 是否是文件 */
        isFile: boolean;
        /** 最后修改时间（ISO 字符串） */
        mtime: string;
    };
};
