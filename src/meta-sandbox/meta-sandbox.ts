import { Script, createContext, type Context } from "node:vm";
import { createLogger } from "../core/logger.js";

const log = createLogger("meta-sandbox");

export interface MetaSandboxConsoleEntry {
    level: "log" | "warn" | "error";
    text: string;
}

export interface MetaSandboxExecutionResult {
    output: string;
    error: boolean;
    logs: MetaSandboxConsoleEntry[];
}

export interface MetaSandboxOptions {
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class MetaSandbox {
    private readonly context: Context;

    constructor(apiContext: Record<string, unknown>) {
        this.context = createContext({
            ...apiContext,
            console: this.createConsoleProxy(),
            JSON,
            Math,
            Date,
            Array,
            Object,
            Map,
            Set,
            Promise,
            String,
            Number,
            Boolean,
            RegExp,
            URL,
            URLSearchParams,
            TextEncoder,
            TextDecoder,
            setTimeout: undefined,
            setInterval: undefined,
            clearTimeout: undefined,
            clearInterval: undefined,
        });
    }

    async execute(code: string, options?: MetaSandboxOptions): Promise<MetaSandboxExecutionResult> {
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const logs: MetaSandboxConsoleEntry[] = [];
        this.installLogBuffer(logs);

        try {
            const script = new Script(`(async () => {\n${code}\n})()`, {
                filename: "meta-agent.js",
            });

            const execution = script.runInContext(this.context, { timeout: timeoutMs });
            const result = await Promise.race([
                Promise.resolve(execution),
                new Promise<never>((_, reject) => {
                    setTimeout(() => reject(new Error(`Meta sandbox timeout (${timeoutMs}ms)`)), timeoutMs);
                }),
            ]);

            return {
                output: formatOutput(result, logs),
                error: false,
                logs,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn("Meta sandbox execution failed", { error: message });
            return {
                output: formatErrorOutput(message, logs),
                error: true,
                logs,
            };
        } finally {
            this.installLogBuffer(null);
        }
    }

    private createConsoleProxy(): Console {
        const sandbox = this;
        return {
            log: (...args: unknown[]) => sandbox.pushConsoleEntry("log", args),
            warn: (...args: unknown[]) => sandbox.pushConsoleEntry("warn", args),
            error: (...args: unknown[]) => sandbox.pushConsoleEntry("error", args),
        } as Console;
    }

    private installLogBuffer(buffer: MetaSandboxConsoleEntry[] | null): void {
        Object.defineProperty(this.context, "__metaSandboxLogs", {
            value: buffer,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    }

    private pushConsoleEntry(level: MetaSandboxConsoleEntry["level"], args: unknown[]): void {
        const bucket = Reflect.get(this.context, "__metaSandboxLogs") as MetaSandboxConsoleEntry[] | null | undefined;
        if (!bucket) {
            return;
        }

        bucket.push({
            level,
            text: args.map(stringifyForConsole).join(" "),
        });
    }
}

function stringifyForConsole(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }
    if (value instanceof Error) {
        return value.stack ?? value.message;
    }
    if (typeof value === "undefined") {
        return "undefined";
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function formatOutput(result: unknown, logs: MetaSandboxConsoleEntry[]): string {
    const consoleOutput = logs.map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
    const valueOutput = typeof result === "undefined" ? "(no output)" : stringifyForConsole(result);

    if (!consoleOutput) {
        return valueOutput;
    }
    if (valueOutput === "(no output)") {
        return consoleOutput;
    }
    return `${consoleOutput}\n${valueOutput}`;
}

function formatErrorOutput(message: string, logs: MetaSandboxConsoleEntry[]): string {
    const consoleOutput = logs.map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
    const errorLine = `Error: ${message}`;
    return consoleOutput ? `${consoleOutput}\n${errorLine}` : errorLine;
}