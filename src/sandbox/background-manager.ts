/**
 * background-manager.ts — 后台任务管理器
 *
 * 管理 agent 通过 runtime.spawn() 创建的后台长驻任务。
 * 每个任务运行在 async 协程中，通过 AbortController 支持取消。
 * 支持持久化任务（代码字符串形式），Worker 重启后自动恢复。
 *
 * 在整体架构中的位置：
 * - 运行在 sandbox worker 进程内
 * - Agent 代码通过 runtime.spawn/kill/ps 间接操作
 * - 任务崩溃时自动推送 system.background_error 事件到 NotificationCenter
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** 后台任务的状态 */
export type TaskStatus = "running" | "done" | "error" | "cancelled";

/** 后台任务信息 */
export interface TaskInfo {
    /** 任务名称 */
    name: string;
    /** 当前状态 */
    status: TaskStatus;
    /** 启动时间（ISO 8601） */
    startedAt: string;
    /** 结束时间（ISO 8601），尚未结束则为 null */
    endedAt: string | null;
    /** 错误信息（如果状态为 error） */
    error?: string;
}

/** 内部任务记录 */
interface TaskRecord {
    info: TaskInfo;
    abortController: AbortController;
    promise: Promise<void>;
}

/** 持久化任务记录（磁盘 JSON） */
interface PersistentTaskRecord {
    name: string;
    code: string;
}

/** BackgroundManager 构造选项 */
export interface BackgroundManagerOptions {
    /** 任务崩溃时回调，推送结构化事件 */
    notifyCallback: (event: Record<string, unknown>) => void;
    /** 打印到 Host CLI 的回调 */
    printCallback: (message: string) => void;
    /** 持久化任务 JSON 文件路径（空字符串则不持久化） */
    persistPath?: string;
}

/**
 * BackgroundManager — 后台任务管理器
 *
 * 管理命名的后台异步任务，支持启动、取消和状态查询。
 * 任务崩溃时通过回调通知（用于推送到 NotificationCenter）。
 * 支持持久化任务：以代码字符串保存到磁盘，Worker 重启后自动恢复。
 *
 * @example
 * ```ts
 * const bg = new BackgroundManager({
 *   notifyCallback: (event) => nc.push(event),
 *   printCallback: (msg) => printToHost(msg),
 *   persistPath: "/path/to/persistent-tasks.json",
 * });
 *
 * bg.spawn("listener", async (signal) => {
 *   while (!signal.aborted) {
 *     const msg = await getNextMessage();
 *     runtime.notify({ type: "telegram.message", ...msg });
 *   }
 * });
 *
 * console.log(bg.ps()); // [{ name: "listener", status: "running", ... }]
 * bg.kill("listener");
 * ```
 */
export class BackgroundManager {
    private tasks: Map<string, TaskRecord> = new Map();
    private notifyCallback: (event: Record<string, unknown>) => void;
    private printCallback: (message: string) => void;
    private persistPath: string;

    constructor(options: BackgroundManagerOptions) {
        this.notifyCallback = options.notifyCallback;
        this.printCallback = options.printCallback;
        this.persistPath = options.persistPath ?? "";
    }

    /**
     * 启动一个命名的后台协程
     *
     * 同名任务若已存在，会先自动取消再启动（对 LLM 更友好）。
     * 任务函数接收 AbortSignal 参数，用于检测取消请求。
     *
     * @param name - 任务名称（唯一标识）
     * @param fn - 异步任务函数，接收 AbortSignal
     */
    spawn(name: string, fn: (signal: AbortSignal) => Promise<void>): void {
        const existing = this.tasks.get(name);
        if (existing && existing.info.status === "running") {
            existing.abortController.abort();
        }

        const abortController = new AbortController();
        const info: TaskInfo = {
            name,
            status: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
        };

        const promise = this.guardedRun(name, fn, abortController.signal);

        this.tasks.set(name, { info, abortController, promise });
    }

    /**
     * 启动持久化后台任务（代码字符串形式，Worker 重启后自动恢复）
     *
     * 代码中可通过 `signal` 变量访问 AbortSignal。
     *
     * @param name - 任务名称
     * @param code - 要执行的 JavaScript/TypeScript 代码字符串
     */
    spawnPersistent(name: string, code: string): void {
        this.savePersistentRecord(name, code);
        this.runPersistentCode(name, code);
    }

    /**
     * 取消指定任务并移除其持久化记录（如有）
     *
     * @param name - 要取消的任务名称
     */
    killTask(name: string): void {
        const task = this.tasks.get(name);
        if (task && task.info.status === "running") {
            task.abortController.abort();
        }
        this.tasks.delete(name);
        this.removePersistentRecord(name);
        this.printCallback(`[Task Killed] ${name}`);
    }

    /**
     * 列出所有运行中的任务名称
     */
    listNames(): string[] {
        return Array.from(this.tasks.entries())
            .filter(([, t]) => t.info.status === "running")
            .map(([name]) => name);
    }

    /**
     * 从磁盘恢复持久化任务（Worker 启动时调用）
     */
    restorePersistentTasks(): void {
        if (!this.persistPath || !existsSync(this.persistPath)) return;
        try {
            const tasks: PersistentTaskRecord[] = JSON.parse(
                readFileSync(this.persistPath, "utf-8")
            );
            for (const task of tasks) {
                this.runPersistentCode(task.name, task.code);
            }
            if (tasks.length > 0) {
                this.printCallback(
                    `[Persistent Tasks] 已恢复 ${tasks.length} 个持久化任务`
                );
            }
        } catch {
            /* ignore corrupt file */
        }
    }

    // ─── 原有 API（保留完整） ───

    /**
     * 包裹任务执行的安全运行器
     *
     * 捕获非正常取消的异常，自动推送 system.background_error 事件。
     */
    private async guardedRun(
        name: string,
        fn: (signal: AbortSignal) => Promise<void>,
        signal: AbortSignal
    ): Promise<void> {
        const record = () => this.tasks.get(name);

        try {
            await fn(signal);

            const r = record();
            if (r) {
                r.info.status = "done";
                r.info.endedAt = new Date().toISOString();
            }
        } catch (err: unknown) {
            const r = record();
            if (!r) return;

            if (signal.aborted) {
                r.info.status = "cancelled";
                r.info.endedAt = new Date().toISOString();
            } else {
                const errorMsg =
                    err instanceof Error
                        ? `${err.name}: ${err.message}`
                        : String(err);
                const stack = err instanceof Error ? err.stack : undefined;

                r.info.status = "error";
                r.info.error = errorMsg;
                r.info.endedAt = new Date().toISOString();

                this.notifyCallback({
                    type: "system.background_error",
                    taskName: name,
                    error: errorMsg,
                    stack: stack ?? "",
                });
            }
        }
    }

    /**
     * 通过 AbortController 取消指定任务（不移除持久化记录）
     *
     * @returns 是否成功发送取消信号
     */
    kill(name: string): boolean {
        const task = this.tasks.get(name);
        if (!task || task.info.status !== "running") {
            return false;
        }

        task.abortController.abort();
        return true;
    }

    /**
     * 列出所有任务及其状态
     */
    ps(): TaskInfo[] {
        return Array.from(this.tasks.values()).map((t) => ({ ...t.info }));
    }

    /**
     * 获取当前运行中的任务数量
     */
    get runningCount(): number {
        let count = 0;
        for (const t of this.tasks.values()) {
            if (t.info.status === "running") count++;
        }
        return count;
    }

    /**
     * 停止所有运行中的任务
     */
    killAll(): void {
        for (const [, task] of this.tasks) {
            if (task.info.status === "running") {
                task.abortController.abort();
            }
        }
    }

    // ─── 持久化内部方法 ───

    /**
     * 执行持久化任务的代码字符串（注入 signal 变量）
     */
    private runPersistentCode(name: string, code: string): void {
        const fn = (signal: AbortSignal): Promise<void> => {
            const asyncFn = new Function("signal", `return (async () => { ${code} })()`);
            return asyncFn(signal) as Promise<void>;
        };
        this.spawn(name, fn);
    }

    /**
     * 将持久化任务记录保存到磁盘
     */
    private savePersistentRecord(name: string, code: string): void {
        if (!this.persistPath) return;
        try {
            let tasks: PersistentTaskRecord[] = [];
            if (existsSync(this.persistPath)) {
                tasks = JSON.parse(readFileSync(this.persistPath, "utf-8"));
            }
            tasks = tasks.filter((t) => t.name !== name);
            tasks.push({ name, code });
            const dir = dirname(this.persistPath);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(
                this.persistPath,
                JSON.stringify(tasks, null, 2),
                "utf-8"
            );
        } catch {
            /* ignore */
        }
    }

    /**
     * 从磁盘移除指定持久化任务记录
     */
    private removePersistentRecord(name: string): void {
        if (!this.persistPath) return;
        try {
            if (!existsSync(this.persistPath)) return;
            let tasks: PersistentTaskRecord[] = JSON.parse(
                readFileSync(this.persistPath, "utf-8")
            );
            tasks = tasks.filter((t) => t.name !== name);
            writeFileSync(
                this.persistPath,
                JSON.stringify(tasks, null, 2),
                "utf-8"
            );
        } catch {
            /* ignore */
        }
    }
}
