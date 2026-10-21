import { Script, createContext, type Context } from "node:vm";
import { createLogger } from "../core/logger.js";
import { normalizeProgrammaticTimestamps } from "../core/timezone.js";

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

export interface MetaSandboxOutputRecord {
    index: number;
    output: string;
    error: boolean;
    timestamp: string;
    source: "meta";
}

export interface MetaSandboxOptions {
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** pendingAsyncErrors 容量上限：防病态循环写爆内存，超限丢弃最旧的 */
const MAX_PENDING_ASYNC_ERRORS = 20;

export class MetaSandbox {
    private readonly context: Context;
    private readonly apiGlobalNames: Set<string>;
    private readonly scopeUnscopables: Record<string, true>;
    private activeSessionId: string | null = null;
    private outputLedger: MetaSandboxOutputRecord[] = [];
    /**
     * agent 未 await 的 API 悬空拒绝（含迟到拒绝）。execute 返回后由 runner
     * drainPendingAsyncErrors() 取走并注入 observation，保证失败对 agent 可见，
     * 而不是只留在 journal 里悄悄失败。
     */
    private pendingAsyncErrors: string[] = [];

    constructor(apiContext: Record<string, unknown>) {
        const metaApi = Object.freeze(this.decorateApiContext({ ...apiContext }));
        this.apiGlobalNames = new Set(Object.keys(metaApi));
        this.scopeUnscopables = Object.create(null) as Record<string, true>;
        for (const key of Object.keys(metaApi)) {
            this.scopeUnscopables[key] = true;
        }

        const contextGlobals: Record<string, unknown> = {
            __metaApi: metaApi,
            __metaScope: this.createSessionScope(),
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
        };
        for (const [key, value] of Object.entries(metaApi)) {
            Object.defineProperty(contextGlobals, key, {
                value,
                enumerable: true,
                configurable: false,
                writable: false,
            });
        }

        this.context = createContext(contextGlobals);
    }

    private decorateApiContext(apiContext: Record<string, unknown>): Record<string, unknown> {
        const seen = new WeakMap<object, unknown>();
        const wrap = (value: unknown, path: string): unknown => {
            if (!value || typeof value !== "object") {
                return value;
            }
            if (seen.has(value as object)) {
                return seen.get(value as object);
            }

            const wrapped = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
            seen.set(value as object, wrapped);
            for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
                const childPath = path ? `${path}.${key}` : key;
                if (typeof child === "function") {
                    wrapped[key] = (...args: unknown[]) => {
                        // 会话归因取发起时刻：迟到拒绝（execute 已返回、甚至会话已切换）不得
                        // 污染下一个会话的 observation，也不得在日志里错归因
                        const callSessionId = this.activeSessionId;
                        const invocation = (async () => {
                            const result = normalizeProgrammaticTimestamps(
                                await (child as (...params: unknown[]) => unknown).apply(value, args)
                            );
                            this.pushConsoleEntry("log", [`[meta-api] ${childPath} ->`, result]);
                            return result;
                        })();
                        // 安全 catch：挂上反应即视为已处理，agent 未 await 的悬空拒绝不再升级为
                        // unhandledRejection / 进程退出；正确 await 的调用方仍拿到原始拒绝，
                        // execute() 的错误路径与 two-pass 文档注入行为不变。
                        // 失败同时入队 pendingAsyncErrors，由 runner 注入 observation —— 悬空拒绝
                        // 必须 session-visible，不能只在 journal 里悄悄失败。await 路径的失败会
                        // 与当轮 Error 输出轻度重复（无法区分是否被 await），条目带方法名归属，
                        // 视为信息增量。
                        invocation.catch((error) => {
                            const message = error instanceof Error ? error.message : String(error);
                            log.warn("Meta API async rejection (agent 未 await?)", {
                                method: childPath,
                                sessionId: callSessionId,
                                error: message,
                            });
                            if (this.activeSessionId === callSessionId) {
                                this.pendingAsyncErrors.push(`[meta-api] ${childPath} 调用未被 await，已失败: ${message}`);
                                if (this.pendingAsyncErrors.length > MAX_PENDING_ASYNC_ERRORS) {
                                    this.pendingAsyncErrors.splice(0, this.pendingAsyncErrors.length - MAX_PENDING_ASYNC_ERRORS);
                                }
                            }
                        });
                        return invocation;
                    };
                } else {
                    wrapped[key] = wrap(child, childPath);
                }
            }
            return wrapped;
        };

        return wrap(apiContext, "") as Record<string, unknown>;
    }

    beginSession(sessionId: string): void {
        this.activeSessionId = sessionId;
        this.outputLedger = [];
        this.pendingAsyncErrors = [];
        (this.context as Record<string, unknown>).__metaScope = this.createSessionScope();
    }

    endSession(sessionId?: string): void {
        if (sessionId && this.activeSessionId && this.activeSessionId !== sessionId) {
            return;
        }
        this.activeSessionId = null;
        (this.context as Record<string, unknown>).__metaScope = this.createSessionScope();
        this.outputLedger = [];
        this.pendingAsyncErrors = [];
    }

    getOutput(index: number): MetaSandboxOutputRecord | null {
        return this.outputLedger[index] ? { ...this.outputLedger[index] } : null;
    }

    /**
     * 取走并清空本会话积压的悬空异步错误（agent 未 await 的 API 失败）。
     * runner 在每次 execute 后调用，把结果注入本轮 observation；迟到的拒绝
     * 会留在队列里，注入下一轮。队列随 beginSession/endSession 清空。
     */
    drainPendingAsyncErrors(): string[] {
        if (this.pendingAsyncErrors.length === 0) {
            return [];
        }
        const drained = this.pendingAsyncErrors;
        this.pendingAsyncErrors = [];
        return drained;
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

            const output = formatOutput(result, logs);
            this.recordOutput(output, false);
            return {
                output,
                error: false,
                logs,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn("Meta sandbox execution failed", { error: message });
            const output = formatErrorOutput(message, logs);
            this.recordOutput(output, true);
            return {
                output,
                error: true,
                logs,
            };
        } finally {
            this.installLogBuffer(null);
        }
    }

    private recordOutput(output: string, error: boolean): void {
        this.outputLedger.push({
            index: this.outputLedger.length,
            output,
            error,
            timestamp: new Date().toISOString(),
            source: "meta",
        });
    }

    private wrapCode(code: string): string {
        return `(async () => {\nwith (__metaScope) {\n${hoistTopLevelDeclarations(code, this.apiGlobalNames)}\n}\n})()`;
    }

    private createSessionScope(): Record<string, unknown> {
        const scope = Object.create(null) as Record<string | symbol, unknown>;
        Object.defineProperty(scope, Symbol.unscopables, {
            value: this.scopeUnscopables,
            enumerable: false,
            configurable: false,
            writable: false,
        });
        return scope as Record<string, unknown>;
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

function hoistTopLevelDeclarations(code: string, apiGlobalNames: Set<string>): string {
    const lines = code.split(/\r?\n/);
    let depth = 0;
    return lines.map((line) => {
        const beforeDepth = depth;
        const transformed = beforeDepth === 0 ? transformTopLevelLine(line, apiGlobalNames) : line;
        depth = Math.max(0, depth + braceDelta(line));
        return transformed;
    }).join("\n");
}

function transformTopLevelLine(line: string, apiGlobalNames: Set<string>): string {
    const declaration = /^(\s*)(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(.*)$/.exec(line);
    if (declaration) {
        const [, indent, keyword, name, initializer] = declaration;
        if (apiGlobalNames.has(name)) {
            return `${indent}${keyword} ${name} = ${replaceIdentifierReferences(initializer, name, `__metaApi.${name}`)}`;
        }
        return `${indent}__metaScope.${name} = ${initializer}`;
    }

    const fn = /^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    if (fn) {
        if (apiGlobalNames.has(fn[2])) {
            return line;
        }
        return line.replace(/^(\s*)function\s+([A-Za-z_$][\w$]*)\s*\(/, "$1__metaScope.$2 = function $2(");
    }

    const klass = /^(\s*)class\s+([A-Za-z_$][\w$]*)\b/.exec(line);
    if (klass) {
        if (apiGlobalNames.has(klass[2])) {
            return line;
        }
        return line.replace(/^(\s*)class\s+([A-Za-z_$][\w$]*)\b/, "$1__metaScope.$2 = class $2");
    }

    return line;
}

function replaceIdentifierReferences(source: string, name: string, replacement: string): string {
    let result = "";
    let quote: "'" | "\"" | "`" | null = null;
    let escaped = false;
    for (let i = 0; i < source.length; i++) {
        const ch = source[i];
        const next = source[i + 1];
        if (quote) {
            result += ch;
            if (escaped) {
                escaped = false;
            } else if (ch === "\\") {
                escaped = true;
            } else if (ch === quote) {
                quote = null;
            }
            continue;
        }
        if (ch === "/" && next === "/") {
            result += source.slice(i);
            break;
        }
        if (ch === "'" || ch === "\"" || ch === "`") {
            quote = ch;
            result += ch;
            continue;
        }
        if (source.startsWith(name, i) && isIdentifierBoundary(source[i - 1]) && isIdentifierBoundary(source[i + name.length])) {
            const previous = previousNonWhitespace(source, i - 1);
            result += previous === "." ? name : replacement;
            i += name.length - 1;
            continue;
        }
        result += ch;
    }
    return result;
}

function previousNonWhitespace(source: string, index: number): string | undefined {
    for (let i = index; i >= 0; i--) {
        if (!/\s/.test(source[i])) {
            return source[i];
        }
    }
    return undefined;
}

function isIdentifierBoundary(ch: string | undefined): boolean {
    return !ch || !/[A-Za-z0-9_$]/.test(ch);
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
