/**
 * notification-center.ts — 事件总线与 JSONL 持久化
 *
 * NotificationCenter 是系统的事件中枢。所有外部事件（Telegram 消息、cron 触发等）
 * 和内部事件（后台任务崩溃、代码执行记录等）都通过这里流转。
 *
 * 事件通过 push() 写入，通过 onPush() 注册的同步钩子实时分发到各组件。
 *
 * 支持跨进程通知：通过 fs.watch 监视 JSONL 文件变更，
 * 当外部进程（如 CLI）写入新事件时自动读取并触发钩子。
 */

import { monotonicFactory } from "ulid";
import {
    appendFileSync,
    mkdirSync,
    existsSync,
    readFileSync,
    statSync,
    watch,
    FSWatcher,
} from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../core/logger.js";

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
 * NotificationCenter — 事件总线 + append-only JSONL 持久化 + 文件监视
 *
 * @example
 * ```ts
 * const nc = new NotificationCenter("workspace/events.jsonl");
 * nc.onPush(event => console.log("new event:", event.type));
 * nc.push({ type: "telegram.message", text: "hello" });
 * nc.dispose(); // 停止文件监视
 * ```
 */
export class NotificationCenter {
    private queue: NotificationEvent[] = [];
    private logPath: string;

    /** 已知的事件 ID 集合（防止重复读取） */
    private knownIds = new Set<string>();

    /** JSONL 文件上次已读的字节偏移 */
    private fileOffset: number = 0;

    /** 文件监视器 */
    private watcher: FSWatcher | null = null;

    /** 轮询计时器（fs.watch 的后备方案） */
    private pollTimer: ReturnType<typeof setInterval> | null = null;

    /** 是否正在自己写文件（避免自触发） */
    private selfWriting = false;

    /** push 后同步调用的钩子列表 */
    private pushHooks: Array<(event: NotificationEvent) => void> = [];

    /**
     * 创建 NotificationCenter 实例
     * @param logPath - JSONL 事件日志文件路径
     * @param enableWatch - 是否启用文件监视（默认 true，测试时可关闭）
     */
    constructor(logPath: string, enableWatch: boolean = true) {
        this.logPath = logPath;

        // 确保日志目录存在
        const dir = dirname(logPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        // 记录当前文件大小作为初始偏移（忽略历史数据）
        if (existsSync(logPath)) {
            try {
                this.fileOffset = statSync(logPath).size;
            } catch {
                this.fileOffset = 0;
            }
        }

        // 启用文件监视：检测外部进程追加的事件
        if (enableWatch) {
            this.startWatching();
        }
    }

    /**
     * 推入一个事件，append 到 JSONL 日志文件，并同步触发所有 push 钩子
     */
    push(input: NotificationInput): NotificationEvent {
        const event: NotificationEvent = {
            ...input,
            _id: ulidGen(),
            _ts: new Date().toISOString(),
        };

        this.queue.push(event);
        this.knownIds.add(event._id);

        // Append to JSONL (synchronous to guarantee ordering)
        this.selfWriting = true;
        appendFileSync(this.logPath, JSON.stringify(event) + "\n", "utf-8");
        this.selfWriting = false;

        // 更新偏移
        try {
            this.fileOffset = statSync(this.logPath).size;
        } catch { /* ignore */ }

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
     * 获取当前队列中的待处理事件数量
     */
    get pendingCount(): number {
        return this.queue.length;
    }

    /**
     * 停止文件监视（清理资源）
     */
    dispose(): void {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    // ─── 内部方法 ───

    /**
     * 启动文件监视，检测外部进程追加的事件
     */
    private startWatching(): void {
        try {
            // 确保文件存在
            if (!existsSync(this.logPath)) {
                appendFileSync(this.logPath, "", "utf-8");
            }

            this.watcher = watch(this.logPath, () => {
                // 忽略自己的写入
                if (this.selfWriting) return;
                this.readNewEntries();
            });

            // 不阻塞进程退出
            this.watcher.unref();
        } catch {
            // watch 不支持的环境下静默降级
            log.warn("fs.watch 不可用，使用轮询模式");
        }

        // 后备轮询：每 2 秒检查文件变更（macOS 的 fs.watch 可能丢失事件）
        this.pollTimer = setInterval(() => {
            if (!this.selfWriting) {
                this.readNewEntries();
            }
        }, 2000);
        this.pollTimer.unref();
    }

    /**
     * 读取 JSONL 文件中自上次读取以来的新行
     */
    private readNewEntries(): void {
        try {
            const stat = statSync(this.logPath);
            if (stat.size <= this.fileOffset) return;

            const buf = readFileSync(this.logPath);
            const newContent = buf.subarray(this.fileOffset).toString("utf-8");
            this.fileOffset = stat.size;

            const lines = newContent.split("\n").filter((l) => l.trim());
            let added = 0;

            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as NotificationEvent;
                    if (event._id && this.knownIds.has(event._id)) continue;

                    this.knownIds.add(event._id);
                    this.queue.push(event);

                    // 触发 push 钩子（跨进程写入的事件也需要分发）
                    for (const hook of this.pushHooks) {
                        try {
                            hook(event);
                        } catch (err) {
                            log.error("push hook 异常 (file watch)", { type: event.type, error: String(err) });
                        }
                    }
                    added++;
                } catch {
                    // 解析失败的行跳过
                }
            }

            if (added > 0) {
                log.debug(`读取了 ${added} 个新事件`, { queue: this.queue.length });
            }
        } catch (err) {
            log.debug("readNewEntries 失败", { error: String(err) });
        }
    }
}
