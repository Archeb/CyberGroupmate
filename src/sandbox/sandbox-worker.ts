/**
 * sandbox-worker.ts — Sandbox Worker 进程
 *
 * 运行在子进程中，通过 stdin/stdout JSON 行协议与 Host 通信。
 * 维护持久化的 ctx 命名空间，执行 agent 写的 TypeScript/JavaScript 代码。
 *
 * IPC 协议：
 * - Host → Worker: execute, input_response, host_call_result
 * - Worker → Host: result, notify, input_request, print, host_call
 */

import { createInterface } from "node:readline";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { installCapabilityRegistry } from "./capability-registry.js";

// ─── 顶层安全网：防止未捕获的异常导致 worker 进程崩溃 ───

process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    process.stderr.write(`[sandbox-worker] Unhandled rejection: ${msg}\n`);
});

process.on("uncaughtException", (err) => {
    process.stderr.write(`[sandbox-worker] Uncaught exception: ${err.stack ?? err.message}\n`);
});

// ─── IPC 消息类型 ───

/** Host → Worker: 执行代码 */
interface ExecuteMessage {
    type: "execute";
    id: string;
    code: string;
}

/** Host → Worker: 用户输入响应 */
interface InputResponseMessage {
    type: "input_response";
    id: string;
    value: string;
}

/** Host → Worker: host call 返回值 */
interface HostCallResultMessage {
    type: "host_call_result";
    id: string;
    ok: boolean;
    value?: unknown;
    error?: string;
}

/** Worker → Host: 代码执行结果 */
interface ResultMessage {
    type: "result";
    id: string;
    output: string;
    error: boolean;
}

/** Worker → Host: 后台任务推送事件 */
interface NotifyMessage {
    type: "notify";
    event: Record<string, unknown>;
}

/** Worker → Host: 请求用户输入 */
interface InputRequestMessage {
    type: "input_request";
    id: string;
    prompt: string;
}

/** Worker → Host: 直接打印到 CLI */
interface PrintMessage {
    type: "print";
    message: string;
}

/** Worker → Host: 请求 Host 端执行方法 */
interface HostCallMessage {
    type: "host_call";
    id: string;
    method: string;
    args: unknown[];
}

type IncomingMessage = ExecuteMessage | InputResponseMessage | HostCallResultMessage;
type OutgoingMessage = ResultMessage | NotifyMessage | InputRequestMessage | PrintMessage | HostCallMessage;

// ─── 全局上下文 ───

const ctx: Record<string, unknown> = {};

// ─── Docs 系统 ───

interface DocEntry { slug: string; title: string; content: string }

function loadAllDocs(): DocEntry[] {
    const DOCS_DIR = "workspace/agent-docs";
    if (!existsSync(DOCS_DIR)) return [];
    return readdirSync(DOCS_DIR)
        .filter(f => f.endsWith(".md") && !f.startsWith("CHANGELOG"))
        .map(f => {
            const content = readFileSync(join(DOCS_DIR, f), "utf-8");
            const slug = basename(f, extname(f));
            const titleMatch = content.match(/^#\s+(.+)$/m);
            return { slug, title: titleMatch?.[1] ?? slug, content };
        });
}

const allDocs = loadAllDocs();

const docs = {
    list: () => allDocs.map(d => ({ slug: d.slug, title: d.title })),
    read: (slug: string): string => {
        const exact = allDocs.find(d => d.slug === slug);
        if (exact) return exact.content;
        const fuzzy = allDocs.find(d => d.slug.includes(slug) || slug.includes(d.slug));
        if (fuzzy) return fuzzy.content;
        if (allDocs.length === 0) return `文档 "${slug}" 不存在，且没有可用的文档。`;
        return `文档 "${slug}" 不存在。可用文档：\n${allDocs.map(d => `  - ${d.slug}: ${d.title}`).join("\n")}`;
    },
};

// ─── IPC 通信 ───

function sendToHost(msg: OutgoingMessage): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
}

function notifyHost(event: Record<string, unknown>): void {
    sendToHost({ type: "notify", event });
}

/**
 * 直接打印消息到 Host CLI（不被 console.log 捕获）
 */
function printToHost(message: string): void {
    sendToHost({ type: "print", message });
}

// ─── 输入请求管理 ───

/** 等待中的 input 请求 */
const pendingInputs = new Map<string, (value: string) => void>();
let inputCounter = 0;
let hostCallCounter = 0;
const pendingHostCalls = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}>();

/**
 * 向 Host 请求用户输入（阻塞当前代码执行直到用户响应）
 *
 * @param prompt - 显示给用户的提示文本
 * @returns 用户输入的文本
 */
function requestInput(prompt: string): Promise<string> {
    return new Promise((resolve) => {
        const id = `input_${++inputCounter}`;
        pendingInputs.set(id, resolve);
        sendToHost({ type: "input_request", id, prompt });
    });
}

function callHost(method: string, args: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const id = `host_${++hostCallCounter}`;
        pendingHostCalls.set(id, { resolve, reject });
        sendToHost({ type: "host_call", id, method, args });
    });
}

// ─── 后台任务管理 ───

const backgroundTasks = new Map<string, AbortController>();

function spawnTask(name: string, fn: (signal: AbortSignal) => Promise<void>): void {
    if (backgroundTasks.has(name)) {
        backgroundTasks.get(name)!.abort();
    }
    const controller = new AbortController();
    backgroundTasks.set(name, controller);

    // 不 await，让其在后台运行
    fn(controller.signal).catch(err => {
        const msg = err instanceof Error ? err.stack : String(err);
        printToHost(`[Task Error] ${name}: ${msg}`);
    }).finally(() => {
        if (backgroundTasks.get(name) === controller) {
            backgroundTasks.delete(name);
        }
    });
}

function killTask(name: string): void {
    if (backgroundTasks.has(name)) {
        backgroundTasks.get(name)!.abort();
        backgroundTasks.delete(name);
        printToHost(`[Task Killed] ${name}`);
    }
}

function listTasks(): string[] {
    return Array.from(backgroundTasks.keys());
}

// ─── 代码执行 ───

async function executeCode(id: string, code: string): Promise<void> {
    const outputLines: string[] = [];

    const originalConsole = {
        log: console.log,
        warn: console.warn,
        error: console.error,
        info: console.info,
    };

    const captureLog = (...args: unknown[]) => {
        const line = args
            .map((a) =>
                typeof a === "string" ? a : JSON.stringify(a, null, 2) ?? String(a)
            )
            .join(" ");
        outputLines.push(line);
    };

    console.log = captureLog;
    console.warn = captureLog;
    console.error = captureLog;
    console.info = captureLog;

    try {
        const hasBareAsyncIife =
            /\(\s*async\s*\(\)\s*=>\s*[\s\S]*?\)\s*\(\s*\)\s*;?/m.test(code) &&
            !/await\s+\(\s*async\s*\(\)\s*=>\s*[\s\S]*?\)\s*\(\s*\)\s*;?/m.test(code);
        if (hasBareAsyncIife) {
            outputLines.push("[Warning] 检测到未 await 的 async IIFE。异步发送可能在 observation 回写前悬空，导致模型误判为“没发出去”。优先直接顶层 await，或写成 await (async () => { ... })().");
        }

        // 检测未 await 的 async 函数调用模式（如 `async function main(){...} main();`）
        // 推一个警告让 LLM 知道消息可能已发出，避免重试导致重复发送
        {
            const asyncFuncNames: string[] = [];
            const asyncFuncDeclRe = /async\s+function\s+(\w+)\s*\(/g;
            let afm;
            while ((afm = asyncFuncDeclRe.exec(code)) !== null) {
                asyncFuncNames.push(afm[1]);
            }
            if (asyncFuncNames.length > 0) {
                const callPattern = new RegExp(
                    `(?<!await\\s)\\b(${asyncFuncNames.join("|")})\\s*\\([^)]*\\)\\s*;?\\s*$`
                );
                if (callPattern.test(code)) {
                    outputLines.push("[Warning] 检测到未 await 的异步函数调用。你的代码中的异步操作可能已经执行并发送了消息，但由于未 await，本次执行的 output 为空。请勿重复发送相同内容。下次请直接在顶层 await 调用。");
                }
            }
        }

        const { runtime, memory, scene, actions, skills } = installCapabilityRegistry({
            ctx,
            emitOutput: (line) => {
                outputLines.push(line);
            },
            notifyHost,
            requestInput,
            printToHost,
            spawnTask,
            killTask,
            listTasks,
            callHost,
        }) as {
            runtime: unknown;
            memory: unknown;
            scene: unknown;
            actions: unknown;
            skills: unknown;
        };

        // 构造 async wrapper，注入 ctx, runtime, memory, scene, docs, actions, skills
        const asyncFn = new Function(
            "ctx",
            "runtime",
            "memory",
            "scene",
            "docs",
            "actions",
            "skills",
            `return (async () => { ${code} })()`
        );

        await asyncFn(ctx, runtime, memory, scene, docs, actions, skills);

        sendToHost({
            type: "result",
            id,
            output: outputLines.join("\n"),
            error: false,
        });
    } catch (err: unknown) {

        const errorMsg =
            err instanceof Error
                ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
                : String(err);

        outputLines.push(errorMsg);

        sendToHost({
            type: "result",
            id,
            output: outputLines.join("\n"),
            error: true,
        });
    } finally {
        console.log = originalConsole.log;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        console.info = originalConsole.info;
    }
}

// ─── 主循环 ───

const rl = createInterface({
    input: process.stdin,
    terminal: false,
});

rl.on("line", async (line: string) => {
    try {
        const msg: IncomingMessage = JSON.parse(line);

        if (msg.type === "execute") {
            await executeCode(msg.id, msg.code);
        } else if (msg.type === "input_response") {
            // 用户输入响应 — 唤醒等待中的 runtime.input()
            const resolver = pendingInputs.get(msg.id);
            if (resolver) {
                pendingInputs.delete(msg.id);
                resolver(msg.value);
            }
        } else if (msg.type === "host_call_result") {
            const pending = pendingHostCalls.get(msg.id);
            if (pending) {
                pendingHostCalls.delete(msg.id);
                if (msg.ok) {
                    pending.resolve(msg.value);
                } else {
                    pending.reject(new Error(msg.error ?? "Unknown host call error"));
                }
            }
        }
    } catch (err: unknown) {
        const errorMsg =
            err instanceof Error ? err.message : String(err);
        sendToHost({
            type: "result",
            id: "unknown",
            output: `IPC parse error: ${errorMsg}`,
            error: true,
        });
    }
});

// 发送 ready 信号
sendToHost({
    type: "result",
    id: "__ready__",
    output: "worker ready",
    error: false,
});
