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
import { installCapabilityRegistry } from "./capability-registry.js";
import { createPromiseTracker } from "./promise-tracker.js";
import { docs } from "./modules/docs.js";
import { loadAllSkills, mountSkillsToCtx, type LoadedSkill } from "./skill-loader.js";

// ─── 全局 Skills 缓存（Worker 启动时加载一次） ───
let loadedSkills: LoadedSkill[] = [];

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
        // ─── 执行守卫：防止 dangling async 在 executeCode 结束后继续调用 host API ───
        // LLM 生成的 unawaited async 函数可能包含 setTimeout 等异步延迟，
        // 导致 tracker.flush() 无法等到所有 sendText 调用。这些"逃逸"的调用
        // 会在 executeCode 返回后继续执行，产生不受追踪的副作用（如重复发消息）。
        // 通过 execGuardId 标记当前执行，结束后使旧 guard 失效，阻止逃逸调用。
        const execGuardId = `exec_${id}`;
        let activeExecGuard = execGuardId;

        const guardedCallHost = (method: string, args?: unknown[]) => {
            if (activeExecGuard !== execGuardId) {
                // 逃逸调用：当前 executeCode 已结束，拒绝 host call
                printToHost(`[⚠ 逃逸调用已拦截] ${method} — 代码执行已结束，该调用来自未被 await 的异步函数`);
                return Promise.reject(new Error(
                    `Stale async call blocked: ${method}. 代码执行已结束，请确保所有异步函数都使用 await 调用。`
                ));
            }
            return callHost(method, args);
        };

        const guardedNotifyHost = (event: Record<string, unknown>) => {
            if (activeExecGuard !== execGuardId) return; // 静默丢弃逃逸 notify
            notifyHost(event);
        };

        const { runtime, memory, scene, actions, skills } = installCapabilityRegistry({
            ctx,
            emitOutput: (line) => {
                outputLines.push(line);
            },
            notifyHost: guardedNotifyHost,
            requestInput,
            printToHost,
            spawnTask,
            killTask,
            listTasks,
            callHost: guardedCallHost,
        }) as {
            runtime: unknown;
            memory: unknown;
            scene: unknown;
            actions: unknown;
            skills: unknown;
        };

        // 用 PromiseTracker 包装注入的 API，追踪所有返回的 Promise
        const tracker = createPromiseTracker();
        const rt = tracker.wrap(runtime as Record<string, unknown>);
        const mem = tracker.wrap(memory as Record<string, unknown>);
        const act = tracker.wrap(actions as Record<string, unknown>);
        const sk = tracker.wrap(skills as Record<string, unknown>);

        // 也包装 ctx.tg（LLM 可能直接调用 ctx.tg.sendText() 而不 await）
        // 使用 Proxy 而非浅拷贝，保证对 ctx 的写入仍然持久化
        const wrappedTg = ctx.tg ? tracker.wrap(ctx.tg as Record<string, unknown>) : undefined;
        const trackedCtx = wrappedTg
            ? new Proxy(ctx, {
                get(target, prop, receiver) {
                    if (prop === "tg") return wrappedTg;
                    return Reflect.get(target, prop, receiver);
                },
            })
            : ctx;

        // 构造 async wrapper，注入 ctx, runtime, memory, scene, docs, actions, skills
        // ─── 动态注入 TS Skills ───
        // 将 loadedSkills 挂载到 ctx 并 tracker.wrap，然后作为额外参数注入
        mountSkillsToCtx(ctx, loadedSkills);
        const skillArgNames: string[] = [];
        const skillArgValues: unknown[] = [];
        for (const skill of loadedSkills) {
            skillArgNames.push(skill.name);
            // wrap skill exports 以追踪未 await 的 Promise
            const wrapped = tracker.wrap(skill.exports as Record<string, unknown>);
            skillArgValues.push(wrapped);
            // 同时更新 ctx 上的引用为 wrapped 版本
            (trackedCtx as Record<string, unknown>)[skill.name] = wrapped;
        }

        // 构造参数列表：固定参数 + 动态 Skill 参数
        const fixedArgNames = ["ctx", "runtime", "memory", "scene", "docs", "actions", "skills"];
        const fixedArgValues = [trackedCtx, rt, mem, scene, docs, act, sk];
        const allArgNames = [...fixedArgNames, ...skillArgNames];
        const allArgValues = [...fixedArgValues, ...skillArgValues];

        const asyncFn = new Function(
            ...allArgNames,
            `return (async () => { ${code} })()`
        );

        await asyncFn(...allArgValues);

        // 兜底：等待所有未被 await 的 API 调用完成
        const { warning } = await tracker.flush();
        if (warning) outputLines.push(warning);

        // 使执行守卫失效：此后任何逃逸的 async 调用将被 guardedCallHost 拦截
        activeExecGuard = "";

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

// ─── Worker 初始化 ───

async function initWorker(): Promise<void> {
    // 加载用户 TS Skills（失败不阻断启动）
    try {
        loadedSkills = await loadAllSkills();
    } catch (err) {
        process.stderr.write(`[sandbox-worker] Skills 加载失败: ${err}\n`);
        loadedSkills = [];
    }

    // 发送 ready 信号
    sendToHost({
        type: "result",
        id: "__ready__",
        output: `worker ready (${loadedSkills.length} skills loaded)`,
        error: false,
    });
}

initWorker();
