import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { buildHarnessEnv, getHarnessHome, getHarnessInstructionPath, writeHarnessInstructions } from "../src/harness/home.js";
import { HarnessManager } from "../src/harness/manager.js";
import { serializeClaudeMcpConfig, serializeCodexMcpConfig, serializeCopilotMcpConfig } from "../src/harness/mcp-config.js";
import { buildSystemPrompt, buildTaskPrompt } from "../src/harness/prompt.js";
import type { HarnessMcpConfig } from "../src/harness/types.js";

describe("HarnessManager MCP config loading", () => {
    it("loads HTTP and stdio MCP configs and keeps cybergroupmate reserved", () => {
        const root = join(process.cwd(), "workspace", ".test-harness-manager");
        rmSync(root, { recursive: true, force: true });
        mkdirSync(join(root, "workspace"), { recursive: true });
        writeFileSync(join(root, "workspace", "mcp-connections.json"), JSON.stringify([
            {
                name: "remote-http",
                description: "HTTP MCP",
                transport: "streamable-http",
                url: "http://127.0.0.1:9999/mcp",
                headers: { Authorization: "Bearer token" },
            },
            {
                name: "stdio-tool",
                description: "stdio MCP",
                transport: "stdio",
                command: "node",
                args: ["server.js"],
                env: { API_KEY: "secret" },
            },
            {
                name: "cybergroupmate",
                transport: "streamable-http",
                url: "http://127.0.0.1:1/mcp",
            },
        ]), "utf-8");

        try {
            const manager = new HarnessManager({
                launcher: {
                    name: "test",
                    start: async () => {
                        throw new Error("not used");
                    },
                },
                workDir: root,
                mcpUrl: "http://127.0.0.1:3100/mcp",
                mcpToken: "token",
                persona: { name: "D", description: "desc" },
            });

            const loadExternal = (manager as unknown as {
                loadExternalMcpServers(): Record<string, Record<string, unknown>>;
            }).loadExternalMcpServers.bind(manager);

            assert.deepEqual(loadExternal(), {
                "remote-http": {
                    type: "streamable-http",
                    url: "http://127.0.0.1:9999/mcp",
                    headers: { Authorization: "Bearer token" },
                },
                "stdio-tool": {
                    type: "stdio",
                    command: "node",
                    args: ["server.js"],
                    env: { API_KEY: "secret" },
                },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("Harness MCP config serialization", () => {
    it("maps each harness schema and escapes Codex TOML boundary values", () => {
        const config: HarnessMcpConfig = {
            mcpServers: {
                "remote-http": {
                    type: "streamable-http",
                    url: "http://127.0.0.1:9999/mcp",
                    headers: { Authorization: "Bearer token" },
                },
                "stdio-tool": {
                    type: "stdio",
                    command: "node",
                    args: ["server.js", "say \"hello\""],
                    env: { API_KEY: "secret value" },
                },
                cybergroupmate: {
                    type: "streamable-http",
                    url: "http://127.0.0.1:3100/mcp?token=dream",
                },
            },
        };

        assert.equal(JSON.parse(serializeClaudeMcpConfig(config)).mcpServers["remote-http"].type, "streamable-http");
        assert.deepEqual(JSON.parse(serializeCopilotMcpConfig(config)), {
            mcpServers: {
                "remote-http": {
                    type: "http",
                    url: "http://127.0.0.1:9999/mcp",
                    headers: { Authorization: "Bearer token" },
                    tools: ["*"],
                },
                "stdio-tool": {
                    type: "local",
                    command: "node",
                    args: ["server.js", "say \"hello\""],
                    env: { API_KEY: "secret value" },
                    tools: ["*"],
                },
                cybergroupmate: {
                    type: "http",
                    url: "http://127.0.0.1:3100/mcp?token=dream",
                    tools: ["*"],
                },
            },
        });

        assert.equal(
            serializeCodexMcpConfig(config),
            '{ remote-http = { url = "http://127.0.0.1:9999/mcp", http_headers = { Authorization = "Bearer token" } }, '
            + 'stdio-tool = { command = "node", args = ["server.js", "say \\"hello\\""], env = { API_KEY = "secret value" } }, '
            + 'cybergroupmate = { url = "http://127.0.0.1:3100/mcp?token=dream", required = true } }',
        );
    });
});

describe("Harness prompt and user home handling", () => {
    it("keeps identity in system prompt and task context in task prompt", () => {
        const root = join(process.cwd(), "workspace", ".test-harness-prompt");
        rmSync(root, { recursive: true, force: true });
        mkdirSync(join(root, "workspace"), { recursive: true });
        writeFileSync(join(root, "workspace", "background-dreaming.md"), "整理今天冒出来的工具想法。", "utf-8");

        try {
            const systemPrompt = buildSystemPrompt(root, { name: "D酱", description: "你是一个后台同伴。" });
            const taskPrompt = buildTaskPrompt(root, [{ source: "dashboard", content: "检查 MCP 安装路径" }]);

            assert.match(systemPrompt, /你是「D酱」/);
            assert.match(systemPrompt, /后台同伴/);
            assert.doesNotMatch(taskPrompt, /你是「D酱」/);
            assert.doesNotMatch(taskPrompt, /后台同伴/);
            // 任务 prompt 不内联任何可能很长的内容（避免 E2BIG），只指引 agent 去读文件
            assert.doesNotMatch(taskPrompt, /整理今天冒出来的工具想法/);
            assert.doesNotMatch(taskPrompt, /检查 MCP 安装路径/);
            assert.match(taskPrompt, /background-dreaming\.md/);
            assert.match(taskPrompt, /background-pending\.md/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("writes launcher instructions under the selected user HOME", () => {
        const root = join(process.cwd(), "workspace", ".test-harness-home");
        rmSync(root, { recursive: true, force: true });

        try {
            const claudeHome = getHarnessHome({ HOME: join(root, "user-home") });
            const copilotHome = getHarnessHome({ HOME: join(root, "user-home") });
            const codexHome = getHarnessHome({ HOME: join(root, "user-home") });
            const codexEnv = { CODEX_HOME: join(root, "codex-home") };
            const claudePath = writeHarnessInstructions(claudeHome, "claude-code", "system for claude");
            const copilotPath = writeHarnessInstructions(copilotHome, "copilot", "system for copilot");
            const codexPath = writeHarnessInstructions(codexHome, "codex", "system for codex", codexEnv);

            assert.equal(claudePath, getHarnessInstructionPath(claudeHome, "claude-code"));
            assert.equal(copilotPath, getHarnessInstructionPath(copilotHome, "copilot"));
            assert.equal(codexPath, getHarnessInstructionPath(codexHome, "codex", codexEnv));
            assert.ok(claudePath.endsWith(join(".claude", "CLAUDE.md")));
            assert.ok(copilotPath.endsWith(join(".copilot", "copilot-instructions.md")));
            assert.equal(codexPath, join(root, "codex-home", "AGENTS.override.md"));
            assert.equal(readFileSync(claudePath, "utf-8"), "system for claude\n");
            assert.equal(readFileSync(copilotPath, "utf-8"), "system for copilot\n");
            assert.equal(readFileSync(codexPath, "utf-8"), "system for codex\n");
            assert.equal(existsSync(claudePath), true);
            assert.equal(existsSync(copilotPath), true);
            assert.equal(existsSync(codexPath), true);

            const env = buildHarnessEnv({ HOME: "real-home", USERPROFILE: "real-profile" }, { CLAUDE_CODE_ENTRYPOINT: "background-agent" });
            assert.equal(env.HOME, "real-home");
            assert.equal(env.USERPROFILE, "real-profile");
            assert.equal(env.CLAUDE_CODE_ENTRYPOINT, "background-agent");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
