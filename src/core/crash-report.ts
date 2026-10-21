import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("crash-report");

export type CrashKind = "uncaughtException" | "unhandledRejection";

/**
 * uncaughtException / unhandledRejection 的**兜底取证**，不是根治：
 * 落一份结构化崩溃报告到 workspace/crash-reports/，并把完整 message+stack 打进
 * journal（保持与 Node 默认致命退出等价的第一现场），随后由调用方按默认语义
 * 退出进程、交给 systemd Restart=always 拉起。
 *
 * 根治在别处：meta 沙箱内 agent 未 await 产生的 API 悬空拒绝由 MetaSandbox
 * 包装层消化并转成 session-visible observation（meta-sandbox.ts
 * decorateApiContext / drainPendingAsyncErrors），不应再走到这里。这里兜的是
 * 其它未知来源——一旦触发，进程**仍然会退出**，不要把本 handler 当成
 * "应用层不再出现 unhandled rejection" 的保证。
 */
export function writeCrashReport(kind: CrashKind, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? null) : null;
    // journal 第一现场优先：即便文件落盘失败，stack 也不丢
    log.error(`致命 ${kind}，进程即将退出（兜底取证，非根治）`, { message, stack });
    try {
        const dir = join(process.cwd(), "workspace", "crash-reports");
        mkdirSync(dir, { recursive: true });
        const report = {
            kind,
            timestamp: new Date().toISOString(),
            pid: process.pid,
            message,
            stack,
        };
        const file = join(dir, `crash-${Date.now()}.json`);
        writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
        log.error("崩溃报告已落盘", { kind, file });
    } catch (writeError) {
        // 取证失败不能阻塞原始终止路径
        log.error("崩溃报告落盘失败", { kind, error: String(writeError) });
    }
}
