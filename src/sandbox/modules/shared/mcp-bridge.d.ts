/**
 * mcp-bridge.d.ts — MCP Server 连接器类型定义
 *
 * 连接外部 MCP (Model Context Protocol) Server，自动发现并代理其工具。
 * MCP Server 通过 stdio 通信，启动后自动扫描可用 tools。
 */

declare const mcp: {
    /**
     * 连接到一个 MCP Server。
     * 启动子进程并通过 stdio 通信，自动发现所有 tools。
     *
     * @param config - Server 配置
     * @returns 包含 tools 列表和 call 方法的代理对象
     *
     * @example
     * // 连接 GitHub MCP Server
     * const github = await mcp.connect({
     *   name: "github",
     *   command: "npx",
     *   args: ["-y", "@modelcontextprotocol/server-github"],
     *   env: { GITHUB_TOKEN: "ghp_xxx" }
     * });
     * console.log("可用工具:", github.tools);
     *
     * // 调用 tool
     * const repos = await github.call("search_repositories", { query: "mcp typescript" });
     * console.log(repos);
     */
    connect(config: {
        /** 显示名称，也用作 tool 命名空间 */
        name: string;
        /** 启动命令 */
        command: string;
        /** 命令参数 */
        args?: string[];
        /** 环境变量（如 API keys） */
        env?: Record<string, string>;
    }): Promise<{
        name: string;
        tools: Array<{ name: string; description: string }>;
        /** 调用指定 tool */
        call(toolName: string, args?: Record<string, unknown>): Promise<unknown>;
    }>;

    /**
     * 断开连接并清理 MCP Server 子进程
     * @param name 连接时指定的 name
     */
    disconnect(name: string): Promise<void>;

    /**
     * 列出所有已连接的 MCP Servers 及其工具
     *
     * @example
     * const servers = mcp.list();
     * for (const s of servers) {
     *   console.log(`${s.name}: ${s.tools.join(", ")} (running: ${s.running})`);
     * }
     */
    list(): Array<{
        name: string;
        tools: string[];
        running: boolean;
    }>;

    /**
     * 直接调用指定 server 的 tool（无需先调用 connect 返回的代理对象）
     * @param serverName MCP Server 名称
     * @param toolName 工具名称
     * @param args 工具参数
     */
    call(serverName: string, toolName: string, args?: Record<string, unknown>): Promise<unknown>;
};
