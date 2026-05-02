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
    private activeSessionId: string | null = null;

    constructor(apiContext: Record<string, unknown>) {
        this.context = createContext({
            ...apiContext,
            __metaScope: Object.create(null),
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

    beginSession(sessionId: string): void {
        this.activeSessionId = sessionId;
        (this.context as Record<string, unknown>).__metaScope = Object.create(null);
    }

    endSession(sessionId?: string): void {
        if (sessionId && this.activeSessionId && this.activeSessionId !== sessionId) {
            return;
        }
        this.activeSessionId = null;
        (this.context as Record<string, unknown>).__metaScope = Object.create(null);
    }

    async execute(code: string, options?: MetaSandboxOptions): Promise<MetaSandboxExecutionResult> {
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const logs: MetaSandboxConsoleEntry[] = [];
        this.installLogBuffer(logs);

        try {
            const script = new Script(this.wrapCode(code), {
                filename: "meta-agent.js",
            });

            const execution = script.runInContext(this.context, { timeout: timeoutMs });
            let timeout: NodeJS.Timeout | undefined;
            const result = await Promise.race([
                Promise.resolve(execution),
                new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error(`Meta sandbox timeout (${timeoutMs}ms)`)), timeoutMs);
                    timeout.unref?.();
                }),
            ]).finally(() => {
                if (timeout) clearTimeout(timeout);
            });

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

    private wrapCode(code: string): string {
        return `(async () => {\nwith (__metaScope) {\n${hoistTopLevelDeclarations(code)}\n}\n})()`;
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

function hoistTopLevelDeclarations(code: string): string {
    const lines = code.split(/\r?\n/);
    let depth = 0;
    return lines.map((line) => {
        const beforeDepth = depth;
        const transformed = beforeDepth === 0 ? transformTopLevelLine(line) : line;
        depth = Math.max(0, depth + braceDelta(line));
        return transformed;
    }).join("\n");
}

function transformTopLevelLine(line: string): string {
    const declaration = /^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (declaration) {
        return line.replace(/^(\s*)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "$1__metaScope.$2 =");
    }

    const fn = /^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (fn) {
        return line.replace(/^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/, "$1__metaScope.$2 = function $2(");
    }

    const klass = /^(\s*)class\s+([A-Za-z_$][\w$]*)\b/.exec(line);
    if (klass) {
        return line.replace(/^(\s*)class\s+([A-Za-z_$][\w$]*)\b/, "$1__metaScope.$2 = class $2");
    }

    return line;
}

function braceDelta(line: string): number {
    let delta = 0;
    let quote: "'" | "\"" | "`" | null = null;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = line[i + 1];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === "/" && next === "/") break;
        if (ch === "'" || ch === "\"" || ch === "`") {
            quote = ch;
            continue;
        }
        if (ch === "{") delta += 1;
        if (ch === "}") delta -= 1;
    }
    return delta;
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
