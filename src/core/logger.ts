/**
 * logger.ts — 结构化日志
 *
 * 统一的日志输出，支持 level 过滤、JSON/Text 两种格式、
 * 自动附加时间戳和模块标签。
 *
 * 用法：
 *   import { createLogger } from "./logger.js";
 *   const log = createLogger("sandbox");
 *   log.info("Worker started", { pid: 1234 });
 *   log.error("Crash", { code: 1 });
 */

// ─── 类型 ───

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
    debug: "\x1b[90m",  // gray
    info: "\x1b[36m",   // cyan
    warn: "\x1b[33m",   // yellow
    error: "\x1b[31m",  // red
};

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

/** 日志配置 */
export interface LogConfig {
    /** 最低输出级别，默认 "info" */
    level: LogLevel;
    /** 输出格式："text"（人类可读）| "json"（机器可解析），默认 "text" */
    format: "text" | "json";
    /** 是否使用颜色（仅 text 格式），默认 true */
    color: boolean;
    /** 自定义输出 sink（如设置，所有日志通过此函数输出，不再写 stdout/stderr） */
    sink?: (line: string) => void;
}

// ─── 全局配置 ───

let globalConfig: LogConfig = {
    level: (process.env.LOG_LEVEL as LogLevel) ?? "info",
    format: (process.env.LOG_FORMAT as "text" | "json") ?? "text",
    color: process.env.NO_COLOR === undefined,
};

/**
 * 设置全局日志配置
 */
export function configureLogger(config: Partial<LogConfig>): void {
    globalConfig = { ...globalConfig, ...config };
}

/**
 * 获取当前日志配置（用于测试）
 */
export function getLogConfig(): LogConfig {
    return { ...globalConfig };
}

// ─── Logger 类 ───

export interface Logger {
    debug(msg: string, data?: Record<string, unknown>): void;
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    child(subModule: string): Logger;
}

/**
 * 创建一个带模块名的 Logger 实例
 *
 * @param module - 模块名称，如 "sandbox", "main", "session"
 * @returns Logger 实例
 *
 * @example
 * ```ts
 * const log = createLogger("main");
 * log.info("Starting up");
 * log.error("Connection failed", { host: "api.telegram.org", code: 503 });
 *
 * const childLog = log.child("bootstrap");
 * childLog.info("Replaying saved code"); // [main:bootstrap] Replaying saved code
 * ```
 */
export function createLogger(module: string): Logger {
    function emit(
        level: LogLevel,
        msg: string,
        data?: Record<string, unknown>
    ): void {
        if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[globalConfig.level]) {
            return;
        }

        const ts = new Date().toISOString();

        if (globalConfig.format === "json") {
            const record: Record<string, unknown> = {
                ts,
                level,
                module,
                msg,
            };
            if (data && Object.keys(data).length > 0) {
                record.data = data;
            }
            const output = JSON.stringify(record);
            if (globalConfig.sink) {
                globalConfig.sink(output);
            } else {
                const stream = level === "error" ? process.stderr : process.stdout;
                stream.write(output + "\n");
            }
        } else {
            // Text 格式
            const time = ts.slice(11, 23); // HH:mm:ss.SSS
            let line: string;

            if (globalConfig.color) {
                const color = LEVEL_COLORS[level];
                const levelTag = level.toUpperCase().padEnd(5);
                line = `${"\x1b[90m"}${time}${RESET} ${color}${levelTag}${RESET} ${BOLD}[${module}]${RESET} ${msg}`;
            } else {
                const levelTag = level.toUpperCase().padEnd(5);
                line = `${time} ${levelTag} [${module}] ${msg}`;
            }

            if (data && Object.keys(data).length > 0) {
                const dataStr = Object.entries(data)
                    .map(([k, v]) => {
                        const val =
                            typeof v === "string"
                                ? v
                                : JSON.stringify(v);
                        return `${k}=${val}`;
                    })
                    .join(" ");
                line += ` ${globalConfig.color ? "\x1b[90m" : ""}${dataStr}${globalConfig.color ? RESET : ""}`;
            }

            if (globalConfig.sink) {
                globalConfig.sink(line);
            } else {
                const stream = level === "error" ? process.stderr : process.stdout;
                stream.write(line + "\n");
            }
        }
    }

    return {
        debug: (msg, data) => emit("debug", msg, data),
        info: (msg, data) => emit("info", msg, data),
        warn: (msg, data) => emit("warn", msg, data),
        error: (msg, data) => emit("error", msg, data),
        child: (subModule) => createLogger(`${module}:${subModule}`),
    };
}
