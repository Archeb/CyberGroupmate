/**
 * notification-center.ts — 事件队列与 JSONL 持久化
 *
 * NotificationCenter 是系统的事件中枢。所有外部事件（Telegram 消息、cron 触发等）
 * 和内部事件（后台任务崩溃、代码执行记录等）都通过这里流转。
 *
 * 支持跨进程通知：通过 fs.watch 监视 JSONL 文件变更，
 * 当外部进程（如 CLI）写入新事件时自动读取并加入队列。
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
    /** 是否为加急事件（立即触发 drain） */
    _urgent?: boolean;
    /** 事件携带的任意数据 */
    [key: string]: unknown;
}

/** push 方法接受的输入：type + 任意附加字段，_id 和 _ts 由系统填充 */
export type NotificationInput = Omit<NotificationEvent, "_id" | "_ts"> & {
    type: string;
};

/**
 * NotificationCenter — 内存事件队列 + append-only JSONL 持久化 + 文件监视
 *
 * 支持：
 * - 同进程 push → drain 立即唤醒
 * - 跨进程 push（CLI 追加 JSONL）→ fs.watch 检测 → 自动读入队列
 * - 加急事件（_urgent: true）→ 立即唤醒 drain
 *
 * @example
 * ```ts
 * const nc = new NotificationCenter("workspace/events.jsonl");
 * nc.push({ type: "telegram.message", text: "hello" });
 * const events = await nc.drain(5000, 10);
 * nc.dispose(); // 停止文件监视
 * ```
 */
export class NotificationCenter {
    private queue: NotificationEvent[] = [];
    private waiters: Array<() => void> = [];
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

    /** push 后同步调用的钩子列表 (S1: 用于 MessageLogWriter + GroupDispatcher) */
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
     * 推入一个事件到队列，并 append 到 JSONL 日志文件
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

        // 同步调用 push 钩子 (S1: MessageLogWriter 实时落盘 + GroupDispatcher 事件分发)
        for (const hook of this.pushHooks) {
            try {
                hook(event);
            } catch (err) {
                log.error("push hook 异常", { type: event.type, error: String(err) });
            }
        }

        // 唤醒所有等待中的 drain 调用
        this.wakeWaiters();

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
     * 异步等待并批量取出事件
     *
     * @param timeout - 队列为空时的最大等待时间（毫秒），0 表示不等待
     * @param maxBatch - 单次最多取出的事件数，默认 50
     * @param batchWindow - 队列非空时的静默收集窗口（毫秒），默认 30000ms。若期间无重要/紧急提及事件，则暂不弹出，让消息聚合
     * @param urgentWords - 触发紧急事件的关键字列表
     * @returns 事件数组（可能为空）
     */
    async drain(
        timeout: number = 30000,
        maxBatch: number = 50,
        batchWindow: number = 30000,
        urgentWords: string[] = ["?", "？", "呢", "吗"]
    ): Promise<NotificationEvent[]> {
        const startTime = Date.now();

        const isUrgent = (event: NotificationEvent) => {
            if (event._urgent) return true;
            if (event.type !== "telegram.message") return true;

            // 在某些旧版本的残留或者自定义透传里，可能是这些字段。
            if (event.isMention || event.replyToMessage) return true;

            const text = (typeof event.text === "string" ? event.text : "").toLowerCase();
            // 在缺乏精准 API 判断的情况下，通过文字嗅探
            if (urgentWords.some(word => text.includes(word.toLowerCase()))) {
                return true;
            }

            return false;
        };

        while (true) {
            const now = Date.now();

            // 如果队列空，等待直到有消息或硬超时
            if (this.queue.length === 0) {
                const remaining = timeout - (now - startTime);
                if (remaining <= 0) break;
                await this.waitForWakeup(remaining);
                continue;
            }

            // 如果队列中有紧急消息，立即触发处理
            if (this.queue.some(isUrgent)) {
                break;
            }

            // 如果队列中有非紧急消息，我们看看它有多老
            if (batchWindow > 0) {
                const oldestTs = new Date(this.queue[0]._ts).getTime();
                const windowRemaining = (oldestTs + batchWindow) - now;

                if (windowRemaining <= 0) {
                    // 已在队列中积攒了 batchWindow 时间，该处理了
                    break;
                }

                // 还没有积攒满 batchWindow 时间，继续等待（中间可能被新的紧急消息打断唤醒）
                await this.waitForWakeup(windowRemaining);
                continue;
            }

            break; // 不需要批处理，直接返回
        }

        const batch = this.queue.splice(0, maxBatch);
        return batch;
    }

    private waitForWakeup(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                const idx = this.waiters.indexOf(wrappedResolve);
                if (idx !== -1) this.waiters.splice(idx, 1);
                resolve();
            }, ms);

            const wrappedResolve = () => {
                clearTimeout(timer);
                resolve();
            };
            this.waiters.push(wrappedResolve);
        });
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
                log.debug("fs.watch 触发");
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

            // 读取文件为 Buffer（字节精确切割——UTF-8 多字节字符安全）
            const buf = readFileSync(this.logPath);
            const newContent = buf.subarray(this.fileOffset).toString("utf-8");
            this.fileOffset = stat.size;

            // 逐行解析
            const lines = newContent.split("\n").filter((l) => l.trim());
            let added = 0;

            for (const line of lines) {
                try {
                    const event = JSON.parse(line) as NotificationEvent;
                    // 跳过已知事件（自己 push 的）
                    if (event._id && this.knownIds.has(event._id)) continue;

                    this.knownIds.add(event._id);
                    this.queue.push(event);
                    added++;
                } catch {
                    // 解析失败的行跳过
                }
            }

            // 有新事件则唤醒 waiter
            if (added > 0) {
                log.debug(`读取了 ${added} 个新事件`, { queue: this.queue.length });
                this.wakeWaiters();
            }
        } catch (err) {
            log.debug("readNewEntries 失败", { error: String(err) });
        }
    }

    /**
     * 唤醒所有等待中的 drain
     */
    private wakeWaiters(): void {
        for (const resolve of this.waiters.splice(0)) {
            resolve();
        }
    }
}
