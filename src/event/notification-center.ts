/**
 * notification-center.ts — 事件总线
 *
 * NotificationCenter 是系统的事件中枢。所有外部事件（Telegram 消息、cron 触发等）
 * 和内部事件（后台任务崩溃、代码执行记录等）都通过这里流转。
 *
 * 事件通过 push() 写入，通过 onPush() 注册的同步钩子实时分发到各组件。
 * 注：文件持久化与跨进程监视功能已被移除。
 */

import { monotonicFactory } from "ulid";
import { createLogger } from "../core/logger.js";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const log = createLogger("nc");

const ulidGen = monotonicFactory();

/** 通知事件的基础结构 */
export interface NotificationEvent {
    /** ULID 事件 ID，由 push 自动生成 */
    _id: string;
    /** 事件时间戳（ISO 8601），由 push 自动生成 */
    _ts: string;
    /** 事件类型标识，如 "telegram.message", "system.background_error" */
    type: string;
    /** 事件携带的任意数据 */
    [key: string]: unknown;
}

/** push 方法接受的输入：type + 任意附加字段，_id 和 _ts 由系统填充 */
export type NotificationInput = Omit<NotificationEvent, "_id" | "_ts"> & {
    type: string;
};

/**
 * NotificationCenter — 内存事件总线
 *
 * @example
 * ```ts
 * const nc = new NotificationCenter("workspace/events.jsonl"); // path is ignored
 * nc.onPush(event => console.log("new event:", event.type));
 * nc.push({ type: "telegram.message", text: "hello" });
 * ```
 */
export class NotificationCenter {
    private queue: NotificationEvent[] = [];
    private knownIds = new Set<string>();
    private pushHooks: Array<(event: NotificationEvent) => void> = [];
    private drainWaiters: Array<{
        maxBatch: number;
        resolve: (events: NotificationEvent[]) => void;
        timer?: ReturnType<typeof setTimeout>;
    }> = [];
    private readonly logPath?: string;

    /**
     * 创建 NotificationCenter 实例
     * @param logPath - JSONL 持久化路径（可选）
     * @param enableWatch - 预留参数，当前未使用
     */
    constructor(logPath?: string, _enableWatch?: boolean) {
        this.logPath = logPath;
        if (this.logPath) {
            try {
                const dir = dirname(this.logPath);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            } catch (err) {
                log.warn("NotificationCenter 初始化持久化目录失败", { error: String(err), logPath: this.logPath });
            }
        }
    }

    /**
     * 推入一个事件，处理，并同步触发所有 push 钩子
     */
    push(input: NotificationInput): NotificationEvent {
        const event: NotificationEvent = {
            ...input,
            _id: ulidGen(),
            _ts: new Date().toISOString(),
        };

        this.queue.push(event);
        this.knownIds.add(event._id);

        if (this.logPath) {
            try {
                appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, "utf-8");
            } catch (err) {
                log.error("事件持久化失败", { type: event.type, error: String(err), logPath: this.logPath });
            }
        }

        this.flushDrainWaiters();

        // 同步调用 push 钩子
        for (const hook of this.pushHooks) {
            try {
                hook(event);
            } catch (err) {
                log.error("push hook 异常", { type: event.type, error: String(err) });
            }
        }

        return event;
    }

    /**
     * 注册 push 后同步调用的钩子
     * @returns 取消注册的函数
     */
    onPush(hook: (event: NotificationEvent) => void): () => void {
        this.pushHooks.push(hook);
        return () => {
            const idx = this.pushHooks.indexOf(hook);
            if (idx >= 0) this.pushHooks.splice(idx, 1);
        };
    }

    /**
     * 按批次取出事件；若当前为空，可等待 timeoutMs。
     */
    async drain(timeoutMs: number = 0, maxBatch: number = 50): Promise<NotificationEvent[]> {
        const limit = Math.max(1, Math.floor(maxBatch));
        if (this.queue.length > 0) {
            return this.queue.splice(0, limit);
        }
        if (timeoutMs <= 0) {
            return [];
        }

        return await new Promise<NotificationEvent[]>((resolve) => {
            const waiter: {
                maxBatch: number;
                resolve: (events: NotificationEvent[]) => void;
                timer?: ReturnType<typeof setTimeout>;
            } = {
                maxBatch: limit,
                resolve: (events) => {
                    if (waiter.timer) clearTimeout(waiter.timer);
                    resolve(events);
                },
            };

            waiter.timer = setTimeout(() => {
                const idx = this.drainWaiters.indexOf(waiter);
                if (idx >= 0) this.drainWaiters.splice(idx, 1);
                resolve([]);
            }, timeoutMs);

            this.drainWaiters.push(waiter);
        });
    }

    private flushDrainWaiters(): void {
        while (this.queue.length > 0 && this.drainWaiters.length > 0) {
            const waiter = this.drainWaiters.shift();
            if (!waiter) break;
            const batch = this.queue.splice(0, waiter.maxBatch);
            waiter.resolve(batch);
        }
    }

    /**
     * 获取当前队列中的待处理事件数量
     */
    get pendingCount(): number {
        return this.queue.length;
    }

    /**
     * 清理资源
     */
    dispose(): void {
        for (const waiter of this.drainWaiters.splice(0)) {
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve([]);
        }
    }
}
