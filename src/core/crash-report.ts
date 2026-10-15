import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("crash-report");

export type CrashKind = "uncaughtException" | "unhandledRejection";

/**
 * uncaughtException / unhandledRejection 的取证兜底：落一份结构化崩溃报告到
 * workspace/crash-reports/，随后由调用方按 Node 默认语义退出（交给 systemd 拉起，
 * 干净重启优于带病运行）。
 *
 * 注意：meta 沙箱内 agent 未 await 产生的 API 悬空拒绝已由 MetaSandbox 包装层
 * 拦截（meta-sandbox.ts decorateApiContext），不会走到这里；本模块只兜其它来源。
 */
export function writeCrashReport(kind: CrashKind, error: unknown): void {
    try {
        const dir = join(process.cwd(), "workspace", "crash-reports");
        mkdirSync(dir, { recursive: true });
        const report = {
            kind,
            timestamp: new Date().toISOString(),
            pid: process.pid,
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack ?? null) : null,
        };
        const file = join(dir, `crash-${Date.now()}.json`);
        writeFileSync(file, JSON.stringify(report, null, 2), "utf8");
        log.error("崩溃报告已落盘", { kind, file });
    } catch (writeError) {
        // 取证失败不能阻塞原始终止路径
        log.error("崩溃报告落盘失败", { kind, error: String(writeError) });
    }
}
