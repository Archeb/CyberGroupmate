/**
 * modules/mcp-bridge.ts — MCP Server 连接器
 *
 * 在 Sandbox Worker 内管理 MCP Server 连接。
 * 当前支持两种传输：
 * - stdio：启动本地 MCP Server 子进程，通过 stdin/stdout 进行 JSON-RPC
 * - Streamable HTTP：对远端 MCP endpoint 发起 HTTP POST，请求结果可为 JSON 或 SSE
 *
 * 连接信息持久化到 workspace/<chatId>/mcp-connections.json，
 * Worker 重建时自动重连。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModuleEntry, MethodDoc } from "../module-registry.js";

// ─── 类型定义 ───

export type McpTransportKind = "stdio" | "streamable-http";

export interface McpServerConfig {
    /** 显示名称（用于 LLM 上下文，也是 tool 命名空间） */
    name: string;
    /** 服务器用途描述，会透传给模块名册和 mcp.list() */
    description?: string;
    /** 传输方式。未指定时：有 url 则视为 streamable-http，否则视为 stdio */
    transport?: McpTransportKind;
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
}

interface McpToolSchema {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

interface JsonRpcErrorObject {
    code?: number;
    message?: string;
    data?: unknown;
}

interface JsonRpcMessage {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: JsonRpcErrorObject;
}

interface McpConnection {
    config: McpServerConfig;
    transportKind: McpTransportKind;
    tools: McpToolSchema[];
    /** stdio child process（仅 stdio transport 使用） */
    process?: ChildProcess;
    /** JSON-RPC 请求计数器 */
    requestId: number;
    /** stdio 待处理的 JSON-RPC 响应 */
    pendingRequests?: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    /** stdio 输出缓冲 */
    outputBuffer?: string;
    /** Streamable HTTP 会话 ID */
    sessionId?: string;
    /** SSE 最后一个 event id（用于后续可恢复扩展） */
    lastEventId?: string;
}

interface ParsedSseEvent {
    event: string;
    data: string;
    id?: string;
}

interface McpProxyCallbacks {
    callHost: (method: string, args?: unknown[]) => Promise<unknown>;
}

export interface McpServerInfo {
    name: string;
    description?: string;
    transport: "stdio" | "streamable-http";
    url?: string;
    tools: string[];
    running: boolean;
}

// ─── 全局状态 ───

const connections = new Map<string, McpConnection>();

/** 持久化路径（由外部设置） */
let persistPath = "";

/** registry 变更回调（通知 code-act-executor 刷新缓存） */
let onRegistryChange: (() => void) | null = null;

/** Worker 代理回调：启用后所有操作转发到 Host 全局 MCP 管理器 */
let proxyCallbacks: McpProxyCallbacks | null = null;

/** Worker 侧缓存的全局 MCP 列表快照，用于同步 mcp.list() */
let cachedServerList: McpServerInfo[] = [];

const MCP_PROTOCOL_VERSION = "2024-11-05";
const HTTP_ACCEPT = "application/json, text/event-stream";
const SSE_CONTENT_TYPE = "text/event-stream";

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
    const configs = Array.from(connections.values()).map((connection) => connection.config);
    try {
        const dir = dirname(persistPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(persistPath, JSON.stringify(configs, null, 2), "utf-8");
    } catch (err) {
        process.stderr.write(`[mcp-bridge] 持久化失败: ${err}\n`);
    }
}

function listConnectionsLocal(): McpServerInfo[] {
    return Array.from(connections.entries()).map(([name, conn]) => ({
        name,
        description: conn.config.description,
        transport: conn.transportKind,
        url: conn.config.url,
        tools: conn.tools.map((tool) => tool.name),
        running: conn.transportKind === "streamable-http" ? true : !!conn.process,
    }));
}

function cloneServerList(list: McpServerInfo[]): McpServerInfo[] {
    return list.map((server) => ({
        ...server,
        tools: [...server.tools],
    }));
}

// ─── 配置 / transport 判定 ───

function getTransportKind(config: McpServerConfig): McpTransportKind {
    if (config.transport) return config.transport;
    return config.url ? "streamable-http" : "stdio";
}

function validateConfig(config: McpServerConfig): void {
    const transportKind = getTransportKind(config);
    if (!config.name?.trim()) {
        throw new Error("MCP Server 配置缺少 name");
    }
    if (transportKind === "stdio" && !config.command) {
        throw new Error(`MCP Server "${config.name}" 使用 stdio transport 时必须提供 command`);
    }
    if (transportKind === "streamable-http" && !config.url) {
        throw new Error(`MCP Server "${config.name}" 使用 Streamable HTTP transport 时必须提供 url`);
    }
}

function createConnection(config: McpServerConfig): McpConnection {
    validateConfig(config);
    return {
        config,
        transportKind: getTransportKind(config),
        tools: [],
        requestId: 0,
        pendingRequests: new Map(),
    };
}

function nextRequestId(conn: McpConnection): number {
    conn.requestId += 1;
    return conn.requestId;
}

function initializeParams(): Record<string, unknown> {
    return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "CyberGroupmate", version: "1.0.0" },
    };
}

// ─── JSON-RPC over stdio ───

function sendJsonRpcStdioRequest(conn: McpConnection, method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
        if (!conn.process?.stdin?.writable) {
            reject(new Error(`MCP Server "${conn.config.name}" is not running`));
            return;
        }

        const id = nextRequestId(conn);
        conn.pendingRequests ??= new Map();
        conn.pendingRequests.set(id, { resolve, reject });

        conn.process.stdin.write(
            JSON.stringify({
                jsonrpc: "2.0",
                id,
                method,
                params: params ?? {},
            }) + "\n"
        );

        setTimeout(() => {
            if (conn.pendingRequests?.has(id)) {
                conn.pendingRequests.delete(id);
                reject(new Error(`MCP call "${method}" timed out after 30s`));
            }
        }, 30_000);
    });
}

function sendJsonRpcStdioNotification(conn: McpConnection, method: string, params?: unknown): void {
    if (!conn.process?.stdin?.writable) {
        throw new Error(`MCP Server "${conn.config.name}" is not running`);
    }
    conn.process.stdin.write(
        JSON.stringify({
            jsonrpc: "2.0",
            method,
            ...(params !== undefined ? { params } : {}),
        }) + "\n"
    );
}

function setupStdoutHandler(conn: McpConnection): void {
    if (!conn.process?.stdout) return;
    conn.outputBuffer = "";

    conn.process.stdout.on("data", (data: Buffer) => {
        conn.outputBuffer = (conn.outputBuffer ?? "") + data.toString();
        const lines = conn.outputBuffer.split("\n");
        conn.outputBuffer = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line) as JsonRpcMessage;
                if (typeof msg.id === "number" && conn.pendingRequests?.has(msg.id)) {
                    const pending = conn.pendingRequests.get(msg.id)!;
                    conn.pendingRequests.delete(msg.id);
                    if (msg.error) {
                        pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
                    } else {
                        pending.resolve(msg.result);
                    }
                }
            } catch {
                // 非 JSON 行忽略
            }
        }
    });
}

// ─── Streamable HTTP ───

function buildHttpHeaders(
    conn: McpConnection,
    options?: { includeContentType?: boolean; skipSessionId?: boolean; accept?: string }
): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: options?.accept ?? HTTP_ACCEPT,
        ...(conn.config.headers ?? {}),
    };
    if (options?.includeContentType !== false) {
        headers["Content-Type"] = "application/json";
    }
    if (!options?.skipSessionId && conn.sessionId) {
        headers["Mcp-Session-Id"] = conn.sessionId;
    }
    return headers;
}

async function buildHttpError(response: Response): Promise<Error> {
    let details = "";
    try {
        const text = await response.text();
        details = text.trim();
    } catch {
        details = "";
    }
    return new Error(`HTTP ${response.status} ${response.statusText}${details ? `: ${details}` : ""}`);
}

function extractJsonRpcResult(payload: unknown, expectedId: number): { found: boolean; value?: unknown } {
    const messages = Array.isArray(payload) ? payload : [payload];
    for (const message of messages) {
        if (!message || typeof message !== "object") continue;
        const rpc = message as JsonRpcMessage;
        if (rpc.id !== expectedId) continue;
        if (rpc.error) {
            throw new Error(rpc.error.message ?? JSON.stringify(rpc.error));
        }
        return { found: true, value: rpc.result };
    }
    return { found: false };
}

async function parseSseStream(response: Response, onEvent: (event: ParsedSseEvent) => void): Promise<void> {
    if (!response.body) {
        throw new Error("SSE response body is empty");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let eventId: string | undefined;
    let dataLines: string[] = [];

    const flushEvent = () => {
        if (dataLines.length === 0 && !eventId) {
            eventName = "message";
            eventId = undefined;
            return;
        }
        onEvent({
            event: eventName,
            data: dataLines.join("\n"),
            id: eventId,
        });
        eventName = "message";
        eventId = undefined;
        dataLines = [];
    };

    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

        let lineBreakIndex = buffer.search(/\r?\n/);
        while (lineBreakIndex >= 0) {
            const rawLine = buffer.slice(0, lineBreakIndex);
            const delimiterLength = buffer[lineBreakIndex] === "\r" && buffer[lineBreakIndex + 1] === "\n" ? 2 : 1;
            buffer = buffer.slice(lineBreakIndex + delimiterLength);

            if (rawLine === "") {
                flushEvent();
            } else if (!rawLine.startsWith(":")) {
                const colonIndex = rawLine.indexOf(":");
                const field = colonIndex >= 0 ? rawLine.slice(0, colonIndex) : rawLine;
                const rawValue = colonIndex >= 0 ? rawLine.slice(colonIndex + 1) : "";
                const fieldValue = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

                if (field === "event") eventName = fieldValue || "message";
                if (field === "data") dataLines.push(fieldValue);
                if (field === "id") eventId = fieldValue;
            }

            lineBreakIndex = buffer.search(/\r?\n/);
        }

        if (done) {
            if (buffer.length > 0) {
                if (buffer.startsWith("data:")) {
                    dataLines.push(buffer.slice(5).trimStart());
                }
                buffer = "";
            }
            flushEvent();
            return;
        }
    }
}

async function extractHttpResponseResult(conn: McpConnection, response: Response, expectedId: number): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    const maybeSessionId = response.headers.get("Mcp-Session-Id");
    if (maybeSessionId) conn.sessionId = maybeSessionId;

    if (contentType.includes(SSE_CONTENT_TYPE)) {
        let matched = false;
        let matchedValue: unknown;

        await parseSseStream(response, (event) => {
            if (event.id) conn.lastEventId = event.id;
            if (!event.data) return;
            try {
                const parsed = JSON.parse(event.data);
                const result = extractJsonRpcResult(parsed, expectedId);
                if (result.found) {
                    matched = true;
                    matchedValue = result.value;
                }
            } catch {
                // 忽略非 JSON 事件，例如兼容模式 endpoint event
            }
        });

        if (!matched) {
            throw new Error(`MCP Server "${conn.config.name}" 未在 SSE 流中返回请求 ${expectedId} 的响应`);
        }
        return matchedValue;
    }

    const text = await response.text();
    if (!text.trim()) {
        throw new Error(`MCP Server "${conn.config.name}" 返回了空响应`);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error(`MCP Server "${conn.config.name}" 返回了非 JSON 响应: ${text}`);
    }

    const result = extractJsonRpcResult(parsed, expectedId);
    if (!result.found) {
        throw new Error(`MCP Server "${conn.config.name}" 返回中缺少请求 ${expectedId} 的响应`);
    }
    return result.value;
}

async function postHttpMessage(conn: McpConnection, payload: JsonRpcMessage, options?: { skipSessionId?: boolean }): Promise<Response> {
    return fetch(conn.config.url!, {
        method: "POST",
        headers: buildHttpHeaders(conn, { skipSessionId: options?.skipSessionId }),
        body: JSON.stringify(payload),
    });
}

async function sendJsonRpcHttpRequest(
    conn: McpConnection,
    method: string,
    params?: unknown,
    options?: { skipSessionId?: boolean; retryOnSessionReset?: boolean }
): Promise<unknown> {
    const id = nextRequestId(conn);
    const response = await postHttpMessage(
        conn,
        {
            jsonrpc: "2.0",
            id,
            method,
            params: params ?? {},
        },
        { skipSessionId: options?.skipSessionId }
    );

    if (response.status === 404 && conn.sessionId && options?.skipSessionId !== true && options?.retryOnSessionReset !== false) {
        conn.sessionId = undefined;
        await initializeHttpConnection(conn);
        return sendJsonRpcHttpRequest(conn, method, params, { retryOnSessionReset: false });
    }

    if (!response.ok) {
        throw await buildHttpError(response);
    }

    return extractHttpResponseResult(conn, response, id);
}

async function sendJsonRpcHttpNotification(
    conn: McpConnection,
    method: string,
    params?: unknown,
    options?: { skipSessionId?: boolean; retryOnSessionReset?: boolean }
): Promise<void> {
    const response = await postHttpMessage(
        conn,
        {
            jsonrpc: "2.0",
            method,
            ...(params !== undefined ? { params } : {}),
        },
        { skipSessionId: options?.skipSessionId }
    );

    if (response.status === 404 && conn.sessionId && options?.skipSessionId !== true && options?.retryOnSessionReset !== false) {
        conn.sessionId = undefined;
        await initializeHttpConnection(conn);
        await sendJsonRpcHttpNotification(conn, method, params, { retryOnSessionReset: false });
        return;
    }

    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
        throw await buildHttpError(response);
    }
    await response.text().catch(() => {});
}

async function initializeHttpConnection(conn: McpConnection): Promise<void> {
    conn.sessionId = undefined;
    const initializeResult = await sendJsonRpcHttpRequest(conn, "initialize", initializeParams(), {
        skipSessionId: true,
        retryOnSessionReset: false,
    });
    if (!initializeResult || typeof initializeResult !== "object") {
        throw new Error(`MCP Server "${conn.config.name}" initialize 返回了无效结果`);
    }
    await sendJsonRpcHttpNotification(conn, "notifications/initialized");
}

async function closeHttpConnection(conn: McpConnection): Promise<void> {
    if (!conn.sessionId) return;
    try {
        const response = await fetch(conn.config.url!, {
            method: "DELETE",
            headers: buildHttpHeaders(conn, { includeContentType: false, accept: "application/json" }),
        });
        if (!response.ok && response.status !== 404 && response.status !== 405) {
            throw await buildHttpError(response);
        }
    } finally {
        conn.sessionId = undefined;
    }
}

// ─── transport 抽象 ───

async function sendJsonRpc(conn: McpConnection, method: string, params?: unknown): Promise<unknown> {
    if (conn.transportKind === "streamable-http") {
        return sendJsonRpcHttpRequest(conn, method, params);
    }
    return sendJsonRpcStdioRequest(conn, method, params);
}

async function sendJsonRpcNotification(conn: McpConnection, method: string, params?: unknown): Promise<void> {
    if (conn.transportKind === "streamable-http") {
        await sendJsonRpcHttpNotification(conn, method, params);
        return;
    }
    sendJsonRpcStdioNotification(conn, method, params);
}

async function initializeConnection(conn: McpConnection): Promise<void> {
    if (conn.transportKind === "streamable-http") {
        await initializeHttpConnection(conn);
        return;
    }

    await sendJsonRpc(conn, "initialize", initializeParams());
    await sendJsonRpcNotification(conn, "notifications/initialized");
}

// ─── 核心功能 ───

async function connectServer(config: McpServerConfig): Promise<McpConnection> {
    if (connections.has(config.name)) {
        await disconnectServer(config.name);
    }

    const conn = createConnection(config);

    if (conn.transportKind === "stdio") {
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        if (config.env) Object.assign(env, config.env);

        const child = spawn(config.command!, config.args ?? [], {
            stdio: ["pipe", "pipe", "pipe"],
            env,
        });

        conn.process = child;
        setupStdoutHandler(conn);

        child.on("exit", (code) => {
            process.stderr.write(`[mcp-bridge] MCP Server "${config.name}" exited (code ${code})\n`);
            conn.process = undefined;
        });

        child.stderr?.on("data", (data: Buffer) => {
            process.stderr.write(`[mcp:${config.name}] ${data.toString()}`);
        });

        await new Promise((resolve) => setTimeout(resolve, 500));

        if (child.exitCode !== null) {
            throw new Error(`MCP Server "${config.name}" failed to start (exit code ${child.exitCode})`);
        }
    }

    try {
        await initializeConnection(conn);
    } catch (err) {
        if (conn.process) conn.process.kill();
        throw new Error(`MCP initialize failed for "${config.name}": ${err}`);
    }

    try {
        const result = (await sendJsonRpc(conn, "tools/list", {})) as { tools?: McpToolSchema[] };
        conn.tools = result?.tools ?? [];
    } catch (err) {
        process.stderr.write(`[mcp-bridge] tools/list failed for "${config.name}": ${err}\n`);
        conn.tools = [];
    }

    connections.set(config.name, conn);
    saveConnectionConfigs();
    onRegistryChange?.();

    return conn;
}

async function disconnectServer(name: string): Promise<void> {
    const conn = connections.get(name);
    if (!conn) return;

    if (conn.transportKind === "streamable-http") {
        await closeHttpConnection(conn).catch((err) => {
            process.stderr.write(`[mcp-bridge] Streamable HTTP 关闭失败 "${name}": ${err}\n`);
        });
    }

    if (conn.process) {
        conn.process.kill();
        conn.process = undefined;
    }

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
    if (conn.transportKind === "stdio" && !conn.process) {
        throw new Error(`MCP Server "${serverName}" process is not running`);
    }

    const result = (await sendJsonRpc(conn, "tools/call", {
        name: toolName,
        arguments: args,
    })) as { content?: Array<{ type: string; text?: string }> };

    if (result?.content) {
        const texts = result.content
            .filter((content) => content.type === "text" && content.text)
            .map((content) => content.text);
        return texts.length === 1 ? texts[0] : texts.length > 1 ? texts.join("\n") : result;
    }
    return result;
}

// ─── 动态注入 Module Registry ───

export function getMcpModuleEntries(): ModuleEntry[] {
    const entries: ModuleEntry[] = [];

    for (const [name, conn] of connections) {
        if (conn.tools.length === 0) continue;

        const methods: MethodDoc[] = conn.tools.map((tool) => ({
            name: tool.name,
            brief: tool.description ?? tool.name,
            fullDoc: tool.inputSchema
                ? `/**\n * ${tool.description ?? tool.name}\n * @param args ${JSON.stringify(tool.inputSchema, null, 2)}\n */\n${tool.name}(args: ${formatSchemaAsType(tool.inputSchema)}): Promise<unknown>`
                : `/** ${tool.description ?? tool.name} */\n${tool.name}(args: Record<string, unknown>): Promise<unknown>`,
        }));

        entries.push({
            name,
            description: `MCP Server (${conn.tools.length} tools)` +
                (conn.transportKind === "streamable-http" ? " via Streamable HTTP" : " via stdio") +
                (conn.config.description?.trim() ? ` - ${conn.config.description.trim()}` : ""),
            methods,
        });
    }

    return entries;
}

function formatSchemaAsType(schema: Record<string, unknown>): string {
    if (!schema || schema.type !== "object" || !schema.properties) {
        return "Record<string, unknown>";
    }

    const props = schema.properties as Record<string, { type?: string; description?: string }>;
    const required = new Set((schema.required as string[]) ?? []);
    const lines: string[] = ["{"];

    for (const [key, prop] of Object.entries(props)) {
        const opt = required.has(key) ? "" : "?";
        const tsType = prop.type === "string"
            ? "string"
            : prop.type === "number" || prop.type === "integer"
                ? "number"
                : prop.type === "boolean"
                    ? "boolean"
                    : prop.type === "array"
                        ? "unknown[]"
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
    connect: async (config: McpServerConfig) => {
        if (proxyCallbacks) {
            const connected = await proxyCallbacks.callHost("mcp.connect", [config]) as {
                name: string;
                tools: Array<{ name: string; description: string }>;
            };
            const latest = await proxyCallbacks.callHost("mcp.list", []) as McpServerInfo[];
            cachedServerList = cloneServerList(latest ?? []);
            return {
                name: connected.name,
                tools: connected.tools ?? [],
                call: (toolName: string, args: Record<string, unknown> = {}) =>
                    proxyCallbacks!.callHost("mcp.call", [connected.name, toolName, args]),
            };
        }
        const conn = await connectServer(config);
        return {
            name: conn.config.name,
            tools: conn.tools.map((tool) => ({
                name: tool.name,
                description: tool.description ?? "",
            })),
            call: (toolName: string, args: Record<string, unknown> = {}) =>
                callTool(conn.config.name, toolName, args),
        };
    },

    disconnect: async (name: string) => {
        if (proxyCallbacks) {
            await proxyCallbacks.callHost("mcp.disconnect", [name]);
            const latest = await proxyCallbacks.callHost("mcp.list", []) as McpServerInfo[];
            cachedServerList = cloneServerList(latest ?? []);
            return;
        }
        await disconnectServer(name);
    },

    list: () => proxyCallbacks ? cloneServerList(cachedServerList) : listConnectionsLocal(),

    call: (serverName: string, toolName: string, args: Record<string, unknown> = {}) => {
        if (proxyCallbacks) {
            return proxyCallbacks.callHost("mcp.call", [serverName, toolName, args]);
        }
        return callTool(serverName, toolName, args);
    },
};

// ─── 初始化 ───

export function initMcpBridge(options: {
    persistPath: string;
    onRegistryChange?: () => void;
}): void {
    persistPath = options.persistPath;
    onRegistryChange = options.onRegistryChange ?? null;
}

export function setMcpProxyCallbacks(callbacks: McpProxyCallbacks | null): void {
    proxyCallbacks = callbacks;
}

export function setMcpListSnapshot(servers: McpServerInfo[]): void {
    cachedServerList = cloneServerList(servers);
}

export function getConnectionConfigs(): McpServerConfig[] {
    return Array.from(connections.values()).map((connection) => ({
        name: connection.config.name,
        ...(connection.config.description ? { description: connection.config.description } : {}),
        ...(connection.config.transport ? { transport: connection.config.transport } : {}),
        ...(connection.config.command ? { command: connection.config.command } : {}),
        ...(connection.config.args ? { args: [...connection.config.args] } : {}),
        ...(connection.config.env ? { env: { ...connection.config.env } } : {}),
        ...(connection.config.url ? { url: connection.config.url } : {}),
        ...(connection.config.headers ? { headers: { ...connection.config.headers } } : {}),
    }));
}

export async function replaceConnectionConfigs(configs: McpServerConfig[]): Promise<void> {
    await disconnectAll();
    for (const config of configs) {
        await connectServer(config);
    }
}

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

export async function disconnectAll(): Promise<void> {
    for (const name of Array.from(connections.keys())) {
        await disconnectServer(name);
    }
}
