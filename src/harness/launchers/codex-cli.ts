import { spawn, type ChildProcess } from "node:child_process";
import { createLogger } from "../../core/logger.js";
import { buildHarnessEnv, getHarnessHome, writeHarnessInstructionsWithRestore } from "../home.js";
import { serializeCodexMcpConfig } from "../mcp-config.js";
import type { HarnessLaunchOptions, HarnessLauncher } from "../types.js";

const log = createLogger("harness-codex-cli");

export class CodexCliLauncher implements HarnessLauncher {
    readonly name = "codex";
    private codexPath: string;

    constructor(codexPath?: string) {
        this.codexPath = codexPath ?? "codex";
    }

    async start(options: HarnessLaunchOptions): Promise<ChildProcess> {
        const homeDir = getHarnessHome();
        // Codex gives AGENTS.override.md precedence, so the dreaming prompt is guaranteed to win for this run.
        const { instructionPath, restore } = writeHarnessInstructionsWithRestore(homeDir, this.name, options.systemPrompt);

        const args = [
            "exec",
            "--json",
            "--ephemeral",
            "--dangerously-bypass-approvals-and-sandbox",
            "-c", `mcp_servers=${serializeCodexMcpConfig(options.mcpConfig)}`,
        ];

        if (options.model) {
            args.push("--model", options.model);
        }

        if (options.extraArgs) {
            args.push(...options.extraArgs);
        }

        args.push(options.prompt);

        log.info("launching codex cli", {
            codex: this.codexPath,
            model: options.model ?? "(default)",
            home: homeDir,
            instructionPath,
        });

        const child = spawn(this.codexPath, args, {
            cwd: options.workDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: buildHarnessEnv(process.env),
        });

        const cleanup = () => { restore(); };
        child.once("exit", cleanup);
        child.once("error", cleanup);

        return child;
    }
}
