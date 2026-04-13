/**
 * mcp-bridge.d.ts — MCP Server 连接器类型定义
 *
 * 连接外部 MCP (Model Context Protocol) Server，自动发现并代理其工具。
 * 支持 stdio 和 Streamable HTTP 两种传输。
 */

declare const mcp: {
    /**
     * 连接到一个 MCP Server。
    * 根据配置使用 stdio 或 Streamable HTTP 建立连接，自动发现所有 tools。
     *
     * @param config - Server 配置
     * @returns 包含 tools 列表和 call 方法的代理对象
     *
     * @example
     * // 连接 GitHub MCP Server
     * const github = await mcp.connect({
     *   name: "github",
    *   transport: "streamable-http",
    *   url: "https://example.com/mcp",
    *   headers: { Authorization: "Bearer xxx" }
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
        /** 传输方式。省略时：有 url 则视为 streamable-http，否则视为 stdio */
        transport?: "stdio" | "streamable-http";
        /** stdio 启动命令 */
        command?: string;
        /** stdio 命令参数 */
        args?: string[];
        /** stdio 环境变量（如 API keys） */
        env?: Record<string, string>;
        /** Streamable HTTP endpoint */
        url?: string;
        /** Streamable HTTP 附加请求头（如 Authorization） */
        headers?: Record<string, string>;
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
        transport: "stdio" | "streamable-http";
        url?: string;
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
