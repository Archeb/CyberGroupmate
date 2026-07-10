import type { HarnessMcpConfig, HarnessMcpServerConfig } from "./types.js";

export function serializeClaudeMcpConfig(config: HarnessMcpConfig): string {
    return JSON.stringify(config, null, 2);
}

export function serializeCopilotMcpConfig(config: HarnessMcpConfig): string {
    return JSON.stringify({
        mcpServers: Object.fromEntries(
            Object.entries(config.mcpServers).map(([name, server]) => [
                name,
                toCopilotMcpServer(server),
            ]),
        ),
    }, null, 2);
}

/** Serialize MCP servers as a TOML inline table accepted by `codex -c mcp_servers=...`. */
export function serializeCodexMcpConfig(config: HarnessMcpConfig): string {
    const servers = Object.entries(config.mcpServers).map(([name, server]) => {
        const entry = toCodexMcpServer(server, name === "cybergroupmate");
        return `${tomlKey(name)} = ${tomlInlineTable(entry)}`;
    });
    return `{ ${servers.join(", ")} }`;
}

function toCopilotMcpServer(server: HarnessMcpServerConfig): Record<string, unknown> {
    if (server.type === "streamable-http") {
        const entry: Record<string, unknown> = {
            type: "http",
            tools: ["*"],
        };
        if (server.url) entry.url = server.url;
        if (server.headers) entry.headers = server.headers;
        return entry;
    }

    const entry: Record<string, unknown> = {
        type: "local",
        tools: ["*"],
    };
    if (server.command) entry.command = server.command;
    if (server.args) entry.args = server.args;
    if (server.env) entry.env = server.env;
    return entry;
}

function toCodexMcpServer(server: HarnessMcpServerConfig, required: boolean): Record<string, unknown> {
    if (server.type === "streamable-http") {
        const entry: Record<string, unknown> = {};
        if (server.url) entry.url = server.url;
        if (server.headers) entry.http_headers = server.headers;
        if (required) entry.required = true;
        return entry;
    }

    const entry: Record<string, unknown> = {};
    if (server.command) entry.command = server.command;
    if (server.args) entry.args = server.args;
    if (server.env) entry.env = server.env;
    if (required) entry.required = true;
    return entry;
}

function tomlKey(value: string): string {
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : tomlString(value);
}

function tomlString(value: string): string {
    return JSON.stringify(value);
}

function tomlInlineTable(value: Record<string, unknown>): string {
    const entries = Object.entries(value).map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`);
    return `{ ${entries.join(", ")} }`;
}

function tomlValue(value: unknown): string {
    if (typeof value === "string") return tomlString(value);
    if (typeof value === "boolean" || typeof value === "number") return String(value);
    if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
    if (value && typeof value === "object") return tomlInlineTable(value as Record<string, unknown>);
    throw new TypeError(`Unsupported TOML value: ${String(value)}`);
}
