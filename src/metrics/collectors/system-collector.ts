/**
 * system-collector.ts — 进程级 & 系统组件指标收集器
 *
 * scrape 时读取：
 * - process.memoryUsage() / process.uptime() — 进程指标
 * - SandboxPool.getStats()                   — 沙盒池状态
 * - q3.getAll().length                        — 注意力队列长度
 * - q5.peek().length                          — 回调队列积压
 * - mainLoop.isRunning() / getTickCount()     — 主循环状态
 * - feedbackLoop.getActiveWindows().length    — 追问窗口数
 */

import type { SandboxPool } from "../../sandbox/sandbox-pool.js";
import type { DynamicAttentionQueue } from "../../subagent/attention-queue.js";
import type { CallbackQueue } from "../../subagent/callback-queue.js";
import type { MainAgentLoop } from "../../main-agent/main-agent-loop.js";
import type { FeedbackLoop } from "../../pipeline/feedback-loop.js";

import {
    mainLoopTicksTotal,
    mainLoopRunning,
    sandboxPoolActive,
    sandboxPoolIdle,
    q3QueueSize,
    q5CallbackPending,
    feedbackLoopWindowsActive,
    processUptimeSeconds,
    processHeapUsedBytes,
    processHeapTotalBytes,
    processRssBytes,
} from "../registry.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("metrics:system-collector");

export interface SystemCollectorDeps {
    sandboxPool: SandboxPool;
    q3: DynamicAttentionQueue;
    q5: CallbackQueue;
    mainLoop: MainAgentLoop;
    feedbackLoop: FeedbackLoop;
}

export class SystemCollector {
    private deps: SystemCollectorDeps;

    constructor(deps: SystemCollectorDeps) {
        this.deps = deps;
        log.info("SystemCollector 已初始化");
    }

    /**
     * Prometheus scrape 时调用，更新所有系统 Gauge 指标。
     */
    collect(): void {
        const { sandboxPool, q3, q5, mainLoop, feedbackLoop } = this.deps;

        // ─── 进程指标 ───
        processUptimeSeconds.set({}, process.uptime());
        const mem = process.memoryUsage();
        processHeapUsedBytes.set({}, mem.heapUsed);
        processHeapTotalBytes.set({}, mem.heapTotal);
        processRssBytes.set({}, mem.rss);

        // ─── 沙盒池 ───
        try {
            const poolStats = sandboxPool.getStats();
            sandboxPoolActive.set({}, poolStats.inUse ?? 0);
            sandboxPoolIdle.set({}, poolStats.idle ?? 0);
        } catch (err) {
            log.warn("SystemCollector: sandboxPool.getStats() 失败", { error: String(err) });
        }

        // ─── 队列 ───
        try {
            q3QueueSize.set({}, q3.getAll().length);
        } catch (err) {
            log.warn("SystemCollector: q3.getAll() 失败", { error: String(err) });
        }

        try {
            q5CallbackPending.set({}, q5.peek().length);
        } catch (err) {
            log.warn("SystemCollector: q5.peek() 失败", { error: String(err) });
        }

        // ─── 主循环 ───
        try {
            mainLoopTicksTotal.set({}, mainLoop.getTickCount());
            mainLoopRunning.set({}, mainLoop.isRunning() ? 1 : 0);
        } catch (err) {
            log.warn("SystemCollector: mainLoop stats 失败", { error: String(err) });
        }

        // ─── FeedbackLoop ───
        try {
            feedbackLoopWindowsActive.set({}, feedbackLoop.getActiveWindows().length);
        } catch (err) {
            log.warn("SystemCollector: feedbackLoop.getActiveWindows() 失败", { error: String(err) });
        }
    }
}
