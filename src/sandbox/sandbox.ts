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

import { spawn, ChildProcess } from "node:child_process";
import { createInterface, Interface } from "node:readline";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { createLogger } from "../core/logger.js";

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

    constructor(projectRoot?: string) {
        super();
        // __dirname = src/sandbox/, need to go up 2 levels to reach project root
        this.projectRoot = projectRoot ?? join(__dirname, "..", "..");
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

        this.child = spawn(process.execPath, [tsxCliPath, workerPath], {
            stdio: ["pipe", "pipe", "pipe"],
            cwd: this.projectRoot,
            env: { ...process.env },
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
     * 在 sandbox 中执行 shell 命令
     */
    async executeShell(command: string, timeout: number = 30000): Promise<ExecutionResult> {
        if (!this.child || !this.child.stdin) {
            throw new Error("Sandbox worker is not running");
        }

        const id = `req_${++this.requestCounter}`;

        return new Promise<ExecutionResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(id);
                reject(new Error(`Shell execution timed out after ${timeout}ms`));
            }, timeout);

            this.pendingRequests.set(id, { resolve, reject, timer });

            const msg = JSON.stringify({ type: "execute_shell", id, command });
            this.child!.stdin!.write(msg + "\n");
        });
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
