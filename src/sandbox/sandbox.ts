/**
 * sandbox.ts — Sandbox Host 侧管理
 *
 * 管理 sandbox worker 子进程的生命周期。通过 stdin/stdout JSON 行协议
 * 与 worker 通信，提供代码执行、交互式输入和崩溃检测能力。
 *
 * IPC 协议：
 * - Host → Worker: execute, input_response, host_call_result
 * - Worker → Host: result, notify, input_request, print, host_call
 */

import { spawn as cpSpawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { createLogger } from "../core/logger.js";
import { loadConfig } from "../core/config.js";
import { getAgentSkillScriptDirs } from "./skill-loader.js";
import * as pty from "node-pty";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger("sandbox");

function isValidEnvKey(key: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function buildEnhancedShellPath(projectRoot: string, existingPath: string): string {
    const skillsBinDir = join(projectRoot, "workspace", "skills", "node_modules", ".bin");
    const workspaceBinDir = join(projectRoot, "workspace", "node_modules", ".bin");
    const globalBinDir = join(projectRoot, "workspace", "bin");
    const localBinDir = join(projectRoot, "workspace", ".local", "bin");
    const pathEntries = [
        existsSync(localBinDir) ? localBinDir : "",
        existsSync(globalBinDir) ? globalBinDir : "",
        existsSync(skillsBinDir) ? skillsBinDir : "",
        existsSync(workspaceBinDir) ? workspaceBinDir : "",
        ...getAgentSkillScriptDirs(projectRoot),
        existingPath,
    ].filter(Boolean);

    return [...new Set(pathEntries)].join(":");
}

/** 执行结果 */
export interface ExecutionResult {
    /** 代码产生的输出（console.log 捕获） */
    output: string;
    /** 是否有错误 */
    error: boolean;
}

/** Worker → Host 消息 */
interface WorkerMessage {
    type: "result" | "notify" | "input_request" | "print" | "host_call";
    id?: string;
    output?: string;
    error?: boolean;
    extendSteps?: number;
    timeoutMs?: number;
    event?: Record<string, unknown>;
    prompt?: string;
    message?: string;
    method?: string;
    args?: unknown[];
}

interface HostCallHandler {
    (method: string, args: unknown[]): Promise<unknown> | unknown;
}

/** 单个 PTY 终端 Tab 的状态 */
interface PtyTab {
    id: string;
    process: pty.IPty;
    state: "idle" | "busy";
    scrollback: string[];
    pendingRequest: {
        id: string;
        command: string;
        resolve: (result: ExecutionResult) => void;
        reject: (err: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
    } | null;
    outputBuffer: string;
    /** 超时后保存的 sentinel ID，用于检测迟到的命令完成 */
    lastSentinelId?: string;
}

/**
 * Sandbox — 代码执行沙箱的 Host 侧管理器
 *
 * Events:
 * - "notify" — 来自 agent 的 runtime.notify() 事件
 * - "print" — 来自 agent 的 runtime.print() 直接输出
 * - "input_request" — 来自 agent 的 runtime.input() 请求（含 id 和 prompt）
 * - "stderr" — worker 子进程的 stderr 输出
 * - "exit" — worker 子进程退出
 * - "error" — worker 子进程错误
 *
 * @example
 * ```ts
 * const sandbox = new Sandbox();
 * await sandbox.start();
 *
 * // 处理 agent 的输入请求
 * sandbox.on("input_request", ({ id, prompt }) => {
 *   // ... 获取用户输入
 *   sandbox.sendInputResponse(id, userInput);
 * });
 *
 * const result = await sandbox.execute('console.log("hello")', 5000);
 * ```
 */
export class Sandbox extends EventEmitter {
    private child: ChildProcess | null = null;
    private rl: Interface | null = null;
    private pendingRequests: Map<
        string,
        {
            resolve: (result: ExecutionResult) => void;
            reject: (err: Error) => void;
            timer?: ReturnType<typeof setTimeout>;
        }
    > = new Map();
    private requestCounter = 0;
    private projectRoot: string;
    private hostCallHandler: HostCallHandler | null = null;
    /** 仅注入 sandbox 的额外环境变量 */
    private sandboxEnv: Record<string, string>;
    /** 仅限 host 的环境变量 key 列表（从 sandbox env 中剔除） */
    private hostOnlyKeys: string[];
    /** 当前 session 待消费的轮次增量（由 worker runtime.extendSteps 上报） */
    private pendingExtendedSteps = 0;
    /** 当前 session 待消费的超时覆盖（由 worker runtime.modifyTimeout 上报） */
    private pendingTimeoutOverrideMs: number | null = null;

    // ─── Multi-Tab PTY 管理 ───
    /** PTY Tab 存储 */
    private ptyTabs = new Map<string, PtyTab>();
    /** 最大同时存活 Tab 数 */
    private static MAX_TABS = 5;
    /** 每个 Tab 的滚动缓冲区最大行数 */
    private static MAX_SCROLLBACK_LINES = 500;
    /** 当前 shell 所在的 cwd（来自 default tab 的最近一次结果） */
    private shellCwd: string = "";
    /** shell home 目录（所有 tab 共享） */
    private shellHome: string = "";
    /** .bashrc 路径（缓存，所有 tab 共享） */
    private bashrcPath: string = "";
    /** PTY 启动用的 env（缓存，所有 tab 共享） */
    private ptyEnv: Record<string, string> = {};
    /** chatId（用于创建 per-chat home 目录） */
    private chatId: string;

    constructor(projectRoot?: string, chatId?: string, sandboxEnv?: Record<string, string>, hostOnlyKeys?: string[]) {
        super();
        // __dirname = src/sandbox/, need to go up 2 levels to reach project root
        this.projectRoot = projectRoot ?? join(__dirname, "..", "..");
        this.chatId = chatId ?? "default";
        this.sandboxEnv = sandboxEnv ?? {};
        this.hostOnlyKeys = hostOnlyKeys ?? [];
    }

    /**
     * 热更新 sandbox 可见环境变量（对现有 worker + PTY 即时生效，并影响后续重启）
     */
    async applyManagedEnv(sandboxVisibleEnv: Record<string, string>, managedKeys: string[]): Promise<void> {
        this.sandboxEnv = { ...sandboxVisibleEnv };
        this.hostOnlyKeys = managedKeys.filter((k) => !(k in sandboxVisibleEnv));

        if (!this.isAlive()) return;

        const toSet: Record<string, string> = {};
        const toUnset: string[] = [];
        for (const key of managedKeys) {
            if (key in sandboxVisibleEnv) {
                toSet[key] = String(sandboxVisibleEnv[key]);
            } else {
                toUnset.push(key);
            }
        }

        const patchCode = `(() => {
  const setMap = ${JSON.stringify(toSet)};
  const unsetKeys = ${JSON.stringify(toUnset)};
  for (const [k, v] of Object.entries(setMap)) process.env[k] = String(v);
  for (const k of unsetKeys) delete process.env[k];
})();`;

        try {
            await this.execute(patchCode, 5000);
        } catch (err) {
            log.warn("worker env 热更新失败", { chatId: this.chatId, error: String(err) });
        }

        const shellLines: string[] = [];
        for (const [k, v] of Object.entries(toSet)) {
            if (!isValidEnvKey(k)) continue;
            shellLines.push(`export ${k}=${shellQuote(String(v))}`);
        }
        for (const key of toUnset) {
            if (!isValidEnvKey(key)) continue;
            shellLines.push(`unset ${key}`);
        }
        if (shellLines.length > 0) {
            try {
                await this.executeShell(shellLines.join("\n"), 5000);
            } catch (err) {
                log.warn("PTY env 热更新失败", { chatId: this.chatId, error: String(err) });
            }
        }
    }

    /**
     * 构建子进程 env：基于 process.env，注入 sandboxEnv，剔除 hostOnlyKeys
     */
    private buildWorkerEnv(): Record<string, string> {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (v !== undefined) env[k] = v;
        }
        // 注入 sandbox 专属环境变量
        for (const [k, v] of Object.entries(this.sandboxEnv)) {
            env[k] = v;
        }
        // 剔除仅限 host 的环境变量
        for (const key of this.hostOnlyKeys) {
            delete env[key];
        }
        // ctx 持久化路径：per-chat 状态文件（隐藏在 sessions/.sandbox-state/ 下）
        const safeChatId = this.chatId.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
        env.SANDBOX_CTX_PATH = join(this.projectRoot, "workspace", "sessions", ".sandbox-state", safeChatId, "ctx.json");

        // MCP Server 预配置（config.yaml → 环境变量 → Worker）
        const config = loadConfig();
        if (config.mcpServers && config.mcpServers.length > 0) {
            env.SANDBOX_MCP_SERVERS = JSON.stringify(config.mcpServers);
        }

        return env;
    }

    /**
     * 启动 worker 子进程
     */
    async start(): Promise<void> {
        if (this.child) {
            throw new Error("Sandbox already started");
        }

        const workerPath = join(this.projectRoot, "src", "sandbox", "sandbox-worker.ts");
        const tsxCliPath = join(this.projectRoot, "node_modules", "tsx", "dist", "cli.mjs");

        if (!existsSync(tsxCliPath)) {
            throw new Error(`tsx runtime not found at ${tsxCliPath}. Did you run npm install?`);
        }

        const workspaceDir = join(this.projectRoot, "workspace");
        if (!existsSync(workspaceDir)) {
            mkdirSync(workspaceDir, { recursive: true });
        }
        this.child = cpSpawn(process.execPath, [tsxCliPath, workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: workspaceDir,
            env: this.buildWorkerEnv(),
        });

        this.child.stderr?.on("data", (data: Buffer) => {
            this.emit("stderr", data.toString());
        });

        this.child.on("exit", (code, signal) => {
            const isExpected = signal === "SIGTERM" || signal === "SIGKILL" || code === 0;
            const logFn = isExpected ? log.debug.bind(log) : log.warn.bind(log);
            logFn("Worker process exited", { code, signal, pendingRequests: this.pendingRequests.size });
            this.emit("exit", code, signal);
            for (const [id, req] of this.pendingRequests) {
                req.reject(
                    new Error(
                        `Sandbox worker exited (code=${code}, signal=${signal}) while request ${id} was pending`
                    )
                );
                if (req.timer) clearTimeout(req.timer);
            }
            this.pendingRequests.clear();
            this.child = null;
            this.rl = null;
        });

        this.child.on("error", (err) => {
            const readyPending = this.pendingRequests.get("__ready__");
            if (readyPending) {
                this.pendingRequests.delete("__ready__");
                readyPending.reject(err instanceof Error ? err : new Error(String(err)));
            }

            if (this.listenerCount("error") > 0) {
                this.emit("error", err);
            }
        });

        this.rl = createInterface({
            input: this.child.stdout!,
            terminal: false,
        });

        this.rl.on("line", (line: string) => {
            this.handleWorkerMessage(line);
        });

        // 等待 worker ready
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error("Sandbox worker did not become ready within 10s"));
            }, 10000);

            this.pendingRequests.set("__ready__", {
                resolve: () => {
                    clearTimeout(timer);
                    resolve();
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                },
            });
        });

        // ─── 启动 PTY shell ───
        await this.startPty();
    }

    /**
     * 确保 Shell 环境（home、bashrc、env）已初始化。
     * 只执行一次，后续 createPtyTab 复用缓存的配置。
     */
    private ensureShellSetup(): void {
        if (this.bashrcPath) return; // 已初始化

        this.shellHome = join(this.projectRoot, "workspace");
        if (!existsSync(this.shellHome)) {
            mkdirSync(this.shellHome, { recursive: true });
        }
        this.shellCwd = this.shellHome;

        const workerEnv = this.buildWorkerEnv();
        const existingPath = workerEnv.PATH || process.env.PATH || "";
        const enhancedPath = buildEnhancedShellPath(this.projectRoot, existingPath);

        const safeDirName = this.chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
        const sandboxStateDir = join(this.projectRoot, "workspace", "sessions", ".sandbox-state", safeDirName);
        if (!existsSync(sandboxStateDir)) {
            mkdirSync(sandboxStateDir, { recursive: true });
        }
        this.bashrcPath = join(sandboxStateDir, ".bashrc");
        const bashrcContent = [
            `# Auto-generated by Sandbox — do not edit manually`,
            `export PATH="${enhancedPath}"`,
            `export HOME="${this.shellHome}"`,
            `export PS1=""`,
            `export PS2=""`,
            `export PROMPT_COMMAND=""`,
            `export BASH_SILENCE_DEPRECATION_WARNING=1`,
            ``,
            `# 禁用交互和富文本输出（防 Agent 终端卡死或充斥 ANSI 乱码）`,
            `export CI=true`,
            `export NO_COLOR=1`,
            `export FORCE_COLOR=0`,
            ``,
            `# pip 持久化：安装到 workspace/.local（跨容器存活）`,
            `export PIP_TARGET="$HOME/.local/lib/python"`,
            `export PYTHONPATH="$HOME/.local/lib/python:$PYTHONPATH"`,
            `export PATH="$HOME/.local/bin:$PATH"`,
            ``,
            `# Aliases — 常用工具快捷入口`,
            `alias npm="npm --prefix $HOME"`,
            `alias npx="npx -y --prefix $HOME"`,
            `alias pip="pip install --target $PIP_TARGET"`,
            `alias pip3="pip3 install --target $PIP_TARGET"`,
            `alias node="node"`,
            `alias tsx="npx tsx"`,
            `alias git="git -C $HOME"`,
            `alias ll="ls -la"`,
            `alias la="ls -A"`,
        ].join("\n") + "\n";
        writeFileSync(this.bashrcPath, bashrcContent, "utf-8");

        this.ptyEnv = {
            ...workerEnv,
            HOME: this.shellHome,
            PATH: enhancedPath,
            PS1: "",
            PS2: "",
            PROMPT_COMMAND: "",
            BASH_SILENCE_DEPRECATION_WARNING: "1",
        };
    }

    /**
     * 创建一个新的 PTY Tab 并等待其就绪。
     */
    private async createPtyTab(tabId: string): Promise<PtyTab> {
        this.ensureShellSetup();

        if (this.ptyTabs.size >= Sandbox.MAX_TABS) {
            throw new Error(`终端 Tab 数量已达上限 (${Sandbox.MAX_TABS})。请先 shell.kill() 不需要的 Tab。`);
        }

        const proc = pty.spawn("/bin/bash", ["--rcfile", this.bashrcPath], {
            name: "dumb",
            cols: 200,
            rows: 50,
            cwd: this.shellHome,
            env: this.ptyEnv,
        });

        const tab: PtyTab = {
            id: tabId,
            process: proc,
            state: "idle",
            scrollback: [],
            pendingRequest: null,
            outputBuffer: "",
            lastSentinelId: undefined,
        };

        // Per-tab 数据处理（含 scrollback + sentinel 检测）
        proc.onData((data: string) => {
            this.handleTabData(tab, data);
        });

        proc.onExit(({ exitCode, signal }) => {
            log.warn("PTY tab exited", { chatId: this.chatId, tabId, exitCode, signal });
            if (tab.pendingRequest) {
                tab.pendingRequest.reject(
                    new Error(`PTY exited (code=${exitCode}, signal=${signal})`)
                );
                if (tab.pendingRequest.timer) clearTimeout(tab.pendingRequest.timer);
                tab.pendingRequest = null;
            }
            this.ptyTabs.delete(tabId);
        });

        this.ptyTabs.set(tabId, tab);

        // 等待 shell 初始化完成
        await new Promise<void>((resolve) => {
            const sentinel = `__SANDBOX_DONE___pty_ready____`;
            let buf = "";
            const disposable = proc.onData((data: string) => {
                buf += data;
                if (buf.includes(sentinel)) {
                    disposable.dispose();
                    resolve();
                }
            });
            proc.write(`echo '${sentinel}'\n`);
            setTimeout(() => {
                disposable.dispose();
                resolve();
            }, 3000);
        });

        log.info("PTY tab created", { chatId: this.chatId, tabId });
        return tab;
    }

    /**
     * 启动默认 PTY tab（兼容旧调用路径）
     */
    private async startPty(): Promise<void> {
        await this.createPtyTab("default");
    }

    /**
     * 处理 worker 发来的消息
     */
    private handleWorkerMessage(line: string): void {
        let msg: WorkerMessage;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }

        if (msg.type === "result" && msg.id) {
            if (Number.isInteger(msg.extendSteps) && (msg.extendSteps as number) > 0) {
                this.pendingExtendedSteps += msg.extendSteps as number;
            }
            if (Number.isInteger(msg.timeoutMs) && (msg.timeoutMs as number) > 0) {
                this.pendingTimeoutOverrideMs = msg.timeoutMs as number;
            }

            const pending = this.pendingRequests.get(msg.id);
            if (pending) {
                this.pendingRequests.delete(msg.id);
                if (pending.timer) clearTimeout(pending.timer);
                pending.resolve({
                    output: msg.output ?? "",
                    error: msg.error ?? false,
                });
            }
        } else if (msg.type === "notify" && msg.event) {
            this.emit("notify", msg.event);
        } else if (msg.type === "input_request" && msg.id && msg.prompt) {
            // Agent 请求用户输入
            this.emit("input_request", { id: msg.id, prompt: msg.prompt });
        } else if (msg.type === "print" && msg.message) {
            // Agent 直接打印
            this.emit("print", msg.message);
        } else if (msg.type === "host_call" && msg.id && msg.method) {
            void this.handleHostCall(msg.id, msg.method, msg.args ?? []);
        }
    }

    private async handleHostCall(id: string, method: string, args: unknown[]): Promise<void> {
        if (!this.child?.stdin) return;

        try {
            if (!this.hostCallHandler) {
                throw new Error(`No host call handler registered for ${method}`);
            }

            const value = await this.hostCallHandler(method, args);
            const msg = JSON.stringify({
                type: "host_call_result",
                id,
                ok: true,
                value,
            });
            this.child.stdin.write(msg + "\n");
        } catch (err) {
            const msg = JSON.stringify({
                type: "host_call_result",
                id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
            this.child.stdin.write(msg + "\n");
        }
    }

    /**
     * 在 sandbox 中执行代码
     */
    async execute(code: string, timeout: number = 30000): Promise<ExecutionResult> {
        if (!this.child || !this.child.stdin) {
            throw new Error("Sandbox worker is not running");
        }

        const id = `req_${++this.requestCounter}`;

        return new Promise<ExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Code execution timed out after ${timeout}ms`));
            }, timeout);

            this.pendingRequests.set(id, { resolve, reject, timer });

            const msg = JSON.stringify({ type: "execute", id, code });
            this.child!.stdin!.write(msg + "\n");
        });
    }

    /**
     * 在 PTY shell 中执行命令（持久化交互式 shell）
     *
     * 使用 sentinel 标记检测命令完成，提取输出、退出码和当前 cwd。
     * 结果末尾附加 [cwd: /current/path]。
     */
    async executeShell(command: string, timeout: number = 30000): Promise<ExecutionResult> {
        let tab = this.ptyTabs.get("default");
        if (!tab) {
            try {
                tab = await this.createPtyTab("default");
            } catch (err) {
                throw new Error(`PTY not available and restart failed: ${err}`);
            }
        }

        if (tab.state === "busy") {
            throw new Error(
                "Default terminal is busy (previous command still running). " +
                "Use shell.detach('name') to move it to background, or shell.kill() to force-kill it."
            );
        }

        if (tab.pendingRequest) {
            throw new Error("Another shell command is already executing");
        }

        const id = `req_${++this.requestCounter}`;
        const sentinel = `__SANDBOX_DONE_${id}`;

        return new Promise<ExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                // eslint-disable-next-line no-control-regex
                let partialOutput = tab!.outputBuffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
                tab!.outputBuffer = "";
                tab!.pendingRequest = null;
                tab!.state = "busy";
                tab!.lastSentinelId = id;
                resolve({
                    output: (partialOutput ? partialOutput + "\n" : "") +
                        `[⚠ Command timed out after ${timeout}ms]\n[cwd: ${this.shellCwd}]`,
                    error: true,
                });
            }, timeout);

            tab!.outputBuffer = "";
            tab!.pendingRequest = { id, command, resolve, reject, timer };

            const wrappedCommand = `${command}\necho '${sentinel}'_$?_$(pwd)__\n`;
            tab!.process.write(wrappedCommand);
        });
    }

    /**
     * Per-tab PTY 数据处理：scrollback + sentinel 检测
     */
    private handleTabData(tab: PtyTab, data: string): void {
        // ─── 始终追加到 scrollback（无论是否有 pendingRequest）───
        // eslint-disable-next-line no-control-regex
        const cleanData = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        const newLines = cleanData.split("\n");
        tab.scrollback.push(...newLines);
        // 限制 scrollback 大小
        if (tab.scrollback.length > Sandbox.MAX_SCROLLBACK_LINES) {
            tab.scrollback.splice(0, tab.scrollback.length - Sandbox.MAX_SCROLLBACK_LINES);
        }

        // ─── 有 pendingRequest：正常 sentinel 检测 ───
        if (tab.pendingRequest) {
            tab.outputBuffer += data;

            const sentinel = `__SANDBOX_DONE_${tab.pendingRequest.id}`;
            const sentinelRegex = new RegExp(
                `${sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)_(.+?)__`
            );
            const match = tab.outputBuffer.match(sentinelRegex);

            if (match) {
                const exitCode = parseInt(match[1], 10);
                const cwd = match[2].trim();
                if (tab.id === "default") this.shellCwd = cwd;

                const sentinelIdx = tab.outputBuffer.indexOf(match[0]);
                let output = tab.outputBuffer.slice(0, sentinelIdx).trim();

                const echoLine = `echo '${sentinel}'_$?_$(pwd)__`;
                output = output.split("\n")
                    .filter(line => !line.includes(echoLine) && !line.includes(sentinel))
                    .join("\n")
                    .trim();

                const commandLines = tab.pendingRequest.command.trim().split("\n");
                const outputLines = output.split("\n");
                let skipCount = 0;
                for (let i = 0; i < commandLines.length && i < outputLines.length; i++) {
                    if (outputLines[i].trim() === commandLines[i].trim()) {
                        skipCount++;
                    } else {
                        break;
                    }
                }
                if (skipCount > 0) {
                    output = outputLines.slice(skipCount).join("\n").trim();
                }

                // eslint-disable-next-line no-control-regex
                output = output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

                const finalOutput = output
                    ? `${output}\n[cwd: ${cwd}]`
                    : `[cwd: ${cwd}]`;

                const { resolve, timer } = tab.pendingRequest;
                if (timer) clearTimeout(timer);
                tab.pendingRequest = null;
                tab.outputBuffer = "";
                tab.state = "idle";
                tab.lastSentinelId = undefined;

                resolve({
                    output: finalOutput,
                    error: exitCode !== 0,
                });
            }
            return;
        }

        // ─── 无 pendingRequest + busy 状态：检测迟到的 sentinel（自动恢复 idle）───
        if (tab.state === "busy" && tab.lastSentinelId) {
            tab.outputBuffer += data;
            const sentinel = `__SANDBOX_DONE_${tab.lastSentinelId}`;
            if (tab.outputBuffer.includes(sentinel)) {
                tab.state = "idle";
                tab.outputBuffer = "";
                tab.lastSentinelId = undefined;
                log.info("PTY tab auto-recovered to idle", { tabId: tab.id });
            }
        }
    }

    /**
     * 发送用户输入响应到 worker（回应 runtime.input()）
     *
     * @param id - 输入请求的 ID
     * @param value - 用户输入的值
     */
    sendInputResponse(id: string, value: string): void {
        if (!this.child || !this.child.stdin) {
            throw new Error("Sandbox worker is not running");
        }

        const msg = JSON.stringify({ type: "input_response", id, value });
        this.child.stdin.write(msg + "\n");
    }

    /**
     * 注册 worker 侧 host_call 的处理函数。
     *
     * 用于把 sandbox 中的 runtime/todo/skills 等能力代理到 host 进程中的真实实现。
     */
    setHostCallHandler(handler: HostCallHandler): void {
        this.hostCallHandler = handler;
    }

    isAlive(): boolean {
        return this.child !== null && this.child.exitCode === null;
    }

    async stop(): Promise<void> {
        // Kill all PTY tabs
        for (const [, tab] of this.ptyTabs) {
            if (tab.pendingRequest) {
                if (tab.pendingRequest.timer) clearTimeout(tab.pendingRequest.timer);
                tab.pendingRequest.reject(new Error("Sandbox stopped"));
                tab.pendingRequest = null;
            }
            try { tab.process.kill(); } catch { /* ignore */ }
        }
        this.ptyTabs.clear();

        if (!this.child) return;

        return new Promise<void>((resolve) => {
            this.child!.once("exit", () => {
                this.child = null;
                this.rl = null;
                resolve();
            });
            this.child!.kill("SIGTERM");

            setTimeout(() => {
                if (this.child) {
                    this.child.kill("SIGKILL");
                }
            }, 3000);
        });
    }

    // ─── Shell Tab 管理（供 shell 模块 host call 使用） ───

    listShellTabs(): Array<{ id: string; state: "idle" | "busy"; recentOutput: string }> {
        const result: Array<{ id: string; state: "idle" | "busy"; recentOutput: string }> = [];
        for (const [, tab] of this.ptyTabs) {
            const preview = tab.scrollback.slice(-5).join("\n").trim();
            result.push({
                id: tab.id,
                state: tab.state,
                recentOutput: preview.slice(0, 500),
            });
        }
        return result;
    }

    async detachDefaultTab(newTabId: string): Promise<void> {
        if (!newTabId || newTabId === "default") {
            throw new Error("新 Tab ID 不能为空或 'default'");
        }
        if (this.ptyTabs.has(newTabId)) {
            throw new Error(`Tab '${newTabId}' 已存在。请选择另一个名称或先 shell.kill('${newTabId}')。`);
        }

        const defaultTab = this.ptyTabs.get("default");
        if (!defaultTab) {
            throw new Error("没有可分离的 default 终端");
        }

        // 重命名：default → newTabId
        this.ptyTabs.delete("default");
        defaultTab.id = newTabId;
        this.ptyTabs.set(newTabId, defaultTab);

        // 创建新的 default tab
        await this.createPtyTab("default");
        log.info("Shell tab detached", { chatId: this.chatId, from: "default", to: newTabId });
    }

    readShellTab(tabId?: string, lines?: number): string {
        const id = tabId || "default";
        const tab = this.ptyTabs.get(id);
        if (!tab) {
            const available = [...this.ptyTabs.keys()].join(", ") || "(无)";
            throw new Error(`终端 Tab '${id}' 不存在。可用 Tabs: ${available}`);
        }
        const n = Math.min(lines ?? 50, Sandbox.MAX_SCROLLBACK_LINES);
        return tab.scrollback.slice(-n).join("\n");
    }

    sendShellInput(input: string, tabId?: string): void {
        const id = tabId || "default";
        const tab = this.ptyTabs.get(id);
        if (!tab) {
            throw new Error(`终端 Tab '${id}' 不存在`);
        }
        tab.process.write(input);
    }

    async killShellTab(tabId?: string): Promise<void> {
        const id = tabId || "default";
        const tab = this.ptyTabs.get(id);
        if (tab) {
            if (tab.pendingRequest) {
                const { resolve, timer } = tab.pendingRequest;
                if (timer) clearTimeout(timer);
                resolve({ output: "[⚠ Shell 进程由于卡死已被强行重置]", error: true });
                tab.pendingRequest = null;
            }
            try { tab.process.kill(); } catch { /* ignore */ }
            this.ptyTabs.delete(id);
        }

        // 如果 kill 的是 default，自动重建
        if (id === "default") {
            await this.createPtyTab("default");
        }
    }

    getShellCwd(): string {
        return this.shellCwd || this.shellHome;
    }

    /**
     * 取出并清空本次执行累计的控制指令（仅当前 session 使用）
     */
    consumeExecutionControl(): { extendSteps: number; timeoutMs: number | null } {
        const control = {
            extendSteps: this.pendingExtendedSteps,
            timeoutMs: this.pendingTimeoutOverrideMs,
        };
        this.pendingExtendedSteps = 0;
        this.pendingTimeoutOverrideMs = null;
        return control;
    }

}
