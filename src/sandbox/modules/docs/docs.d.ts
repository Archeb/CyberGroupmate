/**
 * docs.d.ts — 文档查阅系统类型定义
 *
 * Agent 可通过 docs 对象查阅 workspace/agent-docs/ 下的 markdown 文档。
 * 文档在 worker 启动时加载，支持精确匹配和模糊匹配。
 */

declare const docs: {
    /** 列出所有可用文档（返回 slug、标题，以及是否为标准 Agent Skill） */
    list(): Array<{ slug: string; title: string; kind: "doc" | "agent-skill" }>;

    /**
     * 读取指定文档的完整内容
     * 支持精确 slug 匹配和模糊匹配
     * @param slug - 文档标识符（不含 .md 后缀的文件名）
     * @returns 文档内容字符串；不存在时返回提示信息
     */
    read(slug: string): string;
};
