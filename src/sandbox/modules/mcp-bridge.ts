/**
 * modules/mcp-bridge.ts — MCP Server 连接器
 *
 * 在 Sandbox Worker 内管理 MCP Server 子进程。
 * 通过 @modelcontextprotocol/sdk 的 Client 类与 MCP Server 通信：
 * - stdio transport 启动本地 MCP Server 进程
 * - 自动发现所有 tools（通过 tools/list）
 * - 将 tool schemas 动态注入 module-registry 供 Two-pass 使用
 *
 * 连接信息持久化到 workspace/<chatId>/mcp-connections.json，
 * Worker 重建时自动重连。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ModuleEntry, MethodDoc } from "./module-registry.js";

// ─── 类型定义 ───

export interface McpServerConfig {
    /** 显示名称（用于 LLM 上下文，也是 tool 命名空间） */
    name: string;
    /** 启动命令 */
    command: string;
    /** 命令参数 */
    args?: string[];
    /** 环境变量（如 API keys） */
    env?: Record<string, string>;
}

interface McpToolSchema {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

interface McpConnection {
    config: McpServerConfig;
    tools: McpToolSchema[];
    /** child process（非持久化，运行时重建） */
    process?: ChildProcess;
    /** JSON-RPC 请求计数器 */
    requestId?: number;
    /** 待处理的 JSON-RPC 响应 */
    pendingRequests?: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    /** readline 输出缓冲 */
    outputBuffer?: string;
}

// ─── 全局状态 ───

const connections = new Map<string, McpConnection>();

/** 持久化路径（由外部设置） */
let persistPath = "";

/** registry 变更回调（通知 code-act-executor 刷新缓存） */
let onRegistryChange: (() => void) | null = null;

// ─── 持久化 ───

function loadPersistedConnections(): McpServerConfig[] {
    if (!persistPath || !existsSync(persistPath)) return [];
    try {
        return JSON.parse(readFileSync(persistPath, "utf-8"));
    } catch {
        return [];
    }
}

function saveConnectionConfigs(): void {
    if (!persistPath) return;
    const configs = Array.from(connections.values()).map(c => c.config);
    try {
        const dir = dirname(persistPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(persistPath, JSON.stringify(configs, null, 2), "utf-8");
    } catch (err) {
        process.stderr.write(`[mcp-bridge] 持久化失败: ${err}\n`);
    }
}

// ─── JSON-RPC over stdio ───

function sendJsonRpc(conn: McpConnection, method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (!conn.process?.stdin?.writable) {
            reject(new Error(`MCP Server "${conn.config.name}" is not running`));
            return;
        }

        conn.requestId = (conn.requestId ?? 0) + 1;
        const id = conn.requestId;

        if (!conn.pendingRequests) conn.pendingRequests = new Map();
        conn.pendingRequests.set(id, { resolve, reject });

        const message = JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params: params ?? {},
        });

        conn.process.stdin.write(message + "\n");

        // Timeout after 30s
        setTimeout(() => {
            if (conn.pendingRequests?.has(id)) {
                conn.pendingRequests.delete(id);
                reject(new Error(`MCP call "${method}" timed out after 30s`));
            }
        }, 30_000);
    });
}

function setupStdoutHandler(conn: McpConnection): void {
    if (!conn.process?.stdout) return;
    conn.outputBuffer = "";

    conn.process.stdout.on("data", (data: Buffer) => {
        conn.outputBuffer += data.toString();
        // Process complete JSON lines
        const lines = conn.outputBuffer!.split("\n");
        conn.outputBuffer = lines.pop() ?? ""; // Keep incomplete line in buffer

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id && conn.pendingRequests?.has(msg.id)) {
                    const pending = conn.pendingRequests.get(msg.id)!;
                    conn.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
                // Notifications (no id) are silently ignored for now
            } catch {
                // Non-JSON output, ignore
            }
        }
    });
}

// ─── 核心功能 ───

async function connectServer(config: McpServerConfig): Promise<McpConnection> {
    if (connections.has(config.name)) {
        // Already connected, disconnect first
        await disconnectServer(config.name);
    }

    // Spawn MCP Server process
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (config.env) {
        Object.assign(env, config.env);
    }

    const child = spawn(config.command, config.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
    });

    const conn: McpConnection = {
        config,
        tools: [],
        process: child,
        requestId: 0,
        pendingRequests: new Map(),
    };

    setupStdoutHandler(conn);

    // Handle process exit
    child.on("exit", (code) => {
        process.stderr.write(`[mcp-bridge] MCP Server "${config.name}" exited (code ${code})\n`);
        conn.process = undefined;
    });

    child.stderr?.on("data", (data: Buffer) => {
        // MCP server stderr → our stderr (for debugging)
        process.stderr.write(`[mcp:${config.name}] ${data.toString()}`);
    });

    // Wait a bit for process to start
    await new Promise(resolve => setTimeout(resolve, 500));

    if (child.exitCode !== null) {
        throw new Error(`MCP Server "${config.name}" failed to start (exit code ${child.exitCode})`);
    }

    // Initialize MCP protocol
    try {
        await sendJsonRpc(conn, "initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "CyberGroupmate", version: "1.0.0" },
        });

        // Send initialized notification (no id, no response expected)
        conn.process?.stdin?.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
        }) + "\n");
    } catch (err) {
        child.kill();
        throw new Error(`MCP initialize failed for "${config.name}": ${err}`);
    }

    // Discover tools
    try {
        const result = await sendJsonRpc(conn, "tools/list", {}) as { tools?: McpToolSchema[] };
        conn.tools = result?.tools ?? [];
    } catch (err) {
        process.stderr.write(`[mcp-bridge] tools/list failed for "${config.name}": ${err}\n`);
        conn.tools = [];
    }

    connections.set(config.name, conn);
    saveConnectionConfigs();

    // Notify registry change
    onRegistryChange?.();

    return conn;
}

async function disconnectServer(name: string): Promise<void> {
    const conn = connections.get(name);
    if (!conn) return;

    if (conn.process) {
        conn.process.kill();
        conn.process = undefined;
    }

    // Reject all pending requests
    if (conn.pendingRequests) {
        for (const [, pending] of conn.pendingRequests) {
            pending.reject(new Error("MCP Server disconnected"));
        }
        conn.pendingRequests.clear();
    }

    connections.delete(name);
    saveConnectionConfigs();
    onRegistryChange?.();
}

async function callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const conn = connections.get(serverName);
    if (!conn) throw new Error(`MCP Server "${serverName}" is not connected`);
    if (!conn.process) throw new Error(`MCP Server "${serverName}" process is not running`);

    const result = await sendJsonRpc(conn, "tools/call", {
        name: toolName,
        arguments: args,
    }) as { content?: Array<{ type: string; text?: string }> };

    // 简化返回值：text content 合并为字符串
    if (result?.content) {
        const texts = result.content
            .filter(c => c.type === "text" && c.text)
            .map(c => c.text);
        return texts.length === 1 ? texts[0] : texts.length > 1 ? texts.join("\n") : result;
    }
    return result;
}

// ─── 动态注入 Module Registry ───

/**
 * 将所有已连接 MCP Server 的 tools 转换为 ModuleEntry[]
 * 用于注入 _moduleRegistryCache，驱动 Two-pass 文档系统
 */
export function getMcpModuleEntries(): ModuleEntry[] {
    const entries: ModuleEntry[] = [];

    for (const [name, conn] of connections) {
        if (conn.tools.length === 0) continue;

        const methods: MethodDoc[] = conn.tools.map(tool => ({
            name: tool.name,
            brief: tool.description ?? tool.name,
            fullDoc: tool.inputSchema
                ? `/**\n * ${tool.description ?? tool.name}\n * @param args ${JSON.stringify(tool.inputSchema, null, 2)}\n */\n${tool.name}(args: ${formatSchemaAsType(tool.inputSchema)}): Promise<unknown>`
                : `/** ${tool.description ?? tool.name} */\n${tool.name}(args: Record<string, unknown>): Promise<unknown>`,
        }));

        entries.push({
            name,
            description: `MCP Server: ${name} (${conn.tools.length} tools)`,
            methods,
        });
    }

    return entries;
}

/** 简单的 JSON Schema → TypeScript 类型字符串转换 */
function formatSchemaAsType(schema: Record<string, unknown>): string {
    if (!schema || schema.type !== "object" || !schema.properties) {
        return "Record<string, unknown>";
    }

    const props = schema.properties as Record<string, { type?: string; description?: string }>;
    const required = new Set((schema.required as string[]) ?? []);
    const lines: string[] = ["{"];

    for (const [key, prop] of Object.entries(props)) {
        const opt = required.has(key) ? "" : "?";
        const tsType = prop.type === "string" ? "string"
            : prop.type === "number" || prop.type === "integer" ? "number"
            : prop.type === "boolean" ? "boolean"
            : prop.type === "array" ? "unknown[]"
            : "unknown";
        const comment = prop.description ? ` /** ${prop.description} */` : "";
        lines.push(`  ${comment}`);
        lines.push(`  ${key}${opt}: ${tsType};`);
    }

    lines.push("}");
    return lines.join("\n");
}

// ─── 公共 API（暴露给 LLM） ───

export const mcpBridge = {
    /**
     * 连接到 MCP Server。
     * 启动子进程并通过 stdio 通信，自动发现所有 tools。
     */
    connect: async (config: McpServerConfig) => {
        const conn = await connectServer(config);
        return {
            name: conn.config.name,
            tools: conn.tools.map(t => ({
                name: t.name,
                description: t.description ?? "",
            })),
            /** 调用指定 tool */
            call: (toolName: string, args: Record<string, unknown> = {}) =>
                callTool(conn.config.name, toolName, args),
        };
    },

    /** 断开连接并清理子进程 */
    disconnect: async (name: string) => disconnectServer(name),

    /** 列出已连接的 MCP Servers */
    list: () => Array.from(connections.entries()).map(([name, conn]) => ({
        name,
        tools: conn.tools.map(t => t.name),
        running: !!conn.process,
    })),

    /** 调用指定 server 的 tool */
    call: (serverName: string, toolName: string, args: Record<string, unknown> = {}) =>
        callTool(serverName, toolName, args),
};

// ─── 初始化 ───

/**
 * 设置持久化路径和 registry 变更回调
 */
export function initMcpBridge(options: {
    persistPath: string;
    onRegistryChange?: () => void;
}): void {
    persistPath = options.persistPath;
    onRegistryChange = options.onRegistryChange ?? null;
}

/**
 * 自动重连持久化的 MCP Servers
 */
export async function autoReconnect(): Promise<void> {
    const configs = loadPersistedConnections();
    for (const config of configs) {
        try {
            await connectServer(config);
            process.stderr.write(`[mcp-bridge] ✅ 重连 "${config.name}" 成功\n`);
        } catch (err) {
            process.stderr.write(`[mcp-bridge] ❌ 重连 "${config.name}" 失败: ${err}\n`);
        }
    }
}

/**
 * 断开所有连接（cleanup）
 */
export async function disconnectAll(): Promise<void> {
    for (const name of connections.keys()) {
        await disconnectServer(name);
    }
}
