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
import { existsSync, mkdirSync } from "node:fs";
import { createLogger } from "../core/logger.js";
import * as pty from "node-pty";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const log = createLogger("sandbox");

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
    event?: Record<string, unknown>;
    prompt?: string;
    message?: string;
    method?: string;
    args?: unknown[];
}

interface HostCallHandler {
    (method: string, args: unknown[]): Promise<unknown> | unknown;
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

    /** PTY 持久化交互式 shell */
    private ptyProcess: pty.IPty | null = null;
    /** PTY 输出缓冲区（按请求 ID 收集） */
    private ptyOutputBuffer: string = "";
    /** PTY 待处理的 shell 请求 */
    private pendingShellRequest: {
        id: string;
        command: string;
        resolve: (result: ExecutionResult) => void;
        reject: (err: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
    } | null = null;
    /** 当前 shell 所在的 cwd */
    private shellCwd: string = "";
    /** shell home 目录 */
    private shellHome: string = "";
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
        // ctx 持久化路径：per-chat 状态文件
        const safeChatId = this.chatId.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
        env.SANDBOX_CTX_PATH = join(this.projectRoot, "workspace", safeChatId, "ctx.json");
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

        this.child = cpSpawn(process.execPath, [tsxCliPath, workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: this.projectRoot,
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
     * 启动 PTY 持久化交互式 shell
     */
    private async startPty(): Promise<void> {
        // 创建 per-chat home 目录
        const safeDirName = this.chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
        this.shellHome = join(this.projectRoot, "workspace", safeDirName);
        if (!existsSync(this.shellHome)) {
            mkdirSync(this.shellHome, { recursive: true });
        }
        this.shellCwd = this.shellHome;

        // 构建子进程 env
        const workerEnv = this.buildWorkerEnv();

        this.ptyProcess = pty.spawn("/bin/bash", ["--norc", "--noprofile"], {
            name: "xterm-256color",
            cols: 200,
            rows: 50,
            cwd: this.shellHome,
            env: {
                ...workerEnv,
                HOME: this.shellHome,
                // 使用简单提示符，避免干扰输出
                PS1: "",
                PS2: "",
                // 禁用 bash 的 prompt command
                PROMPT_COMMAND: "",
                // 确保 non-interactive 式无额外输出
                BASH_SILENCE_DEPRECATION_WARNING: "1",
            },
        });

        this.ptyProcess.onData((data: string) => {
            this.handlePtyData(data);
        });

        this.ptyProcess.onExit(({ exitCode, signal }) => {
            log.warn("PTY exited", { chatId: this.chatId, exitCode, signal });
            this.ptyProcess = null;
            // 如果有待处理的请求，拒绝它
            if (this.pendingShellRequest) {
                this.pendingShellRequest.reject(
                    new Error(`PTY exited (code=${exitCode}, signal=${signal})`)
                );
                if (this.pendingShellRequest.timer) clearTimeout(this.pendingShellRequest.timer);
                this.pendingShellRequest = null;
            }
        });

        // 等待 shell 初始化完成（发送一个空命令确认 ready）
        await new Promise<void>((resolve) => {
            const readyId = "__pty_ready__";
            const sentinel = `__SANDBOX_DONE_${readyId}__`;
            let buf = "";
            const onData = (data: string) => {
                buf += data;
                if (buf.includes(sentinel)) {
                    this.ptyProcess?.onData(() => {}); // noop, will be overridden by real handler
                    resolve();
                }
            };
            // 临时替换 handler
            const disposable = this.ptyProcess!.onData(onData);
            this.ptyProcess!.write(`echo '${sentinel}'\n`);
            // 超时兜底
            setTimeout(() => {
                disposable.dispose();
                resolve();
            }, 3000);
        });

        log.info("PTY shell started", { chatId: this.chatId, home: this.shellHome });
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
        if (!this.ptyProcess) {
            // PTY 已死，尝试重启
            try {
                await this.startPty();
            } catch (err) {
                throw new Error(`PTY not available and restart failed: ${err}`);
            }
        }

        if (this.pendingShellRequest) {
            throw new Error("Another shell command is already executing");
        }

        const id = `req_${++this.requestCounter}`;
        const sentinel = `__SANDBOX_DONE_${id}`;

        return new Promise<ExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                const partialOutput = this.ptyOutputBuffer;
                this.ptyOutputBuffer = "";
                this.pendingShellRequest = null;
                resolve({
                    output: (partialOutput ? partialOutput + "\n" : "") +
                        `[⚠ Command timed out after ${timeout}ms]\n[cwd: ${this.shellCwd}]`,
                    error: true,
                });
            }, timeout);

            this.ptyOutputBuffer = "";
            this.pendingShellRequest = { id, command, resolve, reject, timer };

            // 写入命令 + sentinel echo（输出退出码和 pwd）
            // 使用 ; 确保即使命令失败也会执行 sentinel
            const wrappedCommand = `${command}\necho '${sentinel}'_$?_$(pwd)__\n`;
            this.ptyProcess!.write(wrappedCommand);
        });
    }

    /**
     * 处理 PTY 输出数据
     */
    private handlePtyData(data: string): void {
        if (!this.pendingShellRequest) return;

        this.ptyOutputBuffer += data;

        const sentinel = `__SANDBOX_DONE_${this.pendingShellRequest.id}`;
        // 匹配 sentinel 格式: __SANDBOX_DONE_<id>_<exitCode>_<cwd>__
        const sentinelRegex = new RegExp(
            `${sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_(\\d+)_(.+?)__`
        );
        const match = this.ptyOutputBuffer.match(sentinelRegex);

        if (match) {
            const exitCode = parseInt(match[1], 10);
            const cwd = match[2].trim();
            this.shellCwd = cwd;

            // 提取 sentinel 之前的输出
            const sentinelIdx = this.ptyOutputBuffer.indexOf(match[0]);
            let output = this.ptyOutputBuffer.slice(0, sentinelIdx).trim();

            // 移除 echo sentinel 命令本身的回显行（PTY 会回显输入的命令）
            const echoLine = `echo '${sentinel}'_$?_$(pwd)__`;
            output = output.split("\n")
                .filter(line => !line.includes(echoLine) && !line.includes(sentinel))
                .join("\n")
                .trim();

            // 同时移除原始命令的回显（PTY 的第一行通常是命令本身的回显）
            const commandLines = this.pendingShellRequest.command.trim().split("\n");
            const outputLines = output.split("\n");
            // 如果输出的前几行和命令匹配，跳过回显
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

            // 附加 cwd 信息
            const finalOutput = output
                ? `${output}\n[cwd: ${cwd}]`
                : `[cwd: ${cwd}]`;

            const { resolve, timer } = this.pendingShellRequest;
            if (timer) clearTimeout(timer);
            this.pendingShellRequest = null;
            this.ptyOutputBuffer = "";

            resolve({
                output: finalOutput,
                error: exitCode !== 0,
            });
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
     * 用于把 sandbox 中的 memory/actions/skills 代理到 host 进程中的真实实现。
     */
    setHostCallHandler(handler: HostCallHandler): void {
        this.hostCallHandler = handler;
    }

    isAlive(): boolean {
        return this.child !== null && this.child.exitCode === null;
    }

    async stop(): Promise<void> {
        // Kill PTY
        if (this.ptyProcess) {
            try {
                this.ptyProcess.kill();
            } catch { /* ignore */ }
            this.ptyProcess = null;
        }

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
}
