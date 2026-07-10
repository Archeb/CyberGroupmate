import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createLogger } from "../core/logger.js";
import { getHarnessHome, getHarnessInstructionPath } from "./home.js";
import { buildSystemPrompt, buildTaskPrompt, renderPendingFile, selectPendingNotifications, PENDING_FILE } from "./prompt.js";
import type {
    HarnessLauncher,
    HarnessMcpConfig,
    HarnessMcpServerConfig,
    HarnessNotify,
    HarnessRunEvent,
    HarnessRunRecord,
} from "./types.js";

const log = createLogger("harness-manager");

// dream-journal JSONL 文件每次运行可达数 MB，只保留最近若干份，由 manager 定时清理。
const MAX_JOURNAL_FILES = 10;
const JOURNAL_CLEANUP_INTERVAL_MS = 30 * 60_000;

// 定时做梦的强制最小间隔：两次「定时触发」的做梦至少相隔这么久，避免重启/cron 边界/重试叠加导致频繁做梦。
const DEFAULT_MIN_DREAM_INTERVAL_MS = 6 * 60 * 60_000;

export interface HarnessManagerConfig {
    launcher: HarnessLauncher;
    workDir: string;
    mcpUrl: string;
    mcpToken: string;
    persona: { name: string; description: string };
    model?: string;
    maxBudgetUsd?: number;
    extraArgs?: string[];
    /**
     * 启动前重建 background-dreaming.md 内容（本周期 subagent 任务回顾 + 群关系画像）。
     * 参数 sinceTs 是上次做梦的起始时间（ms），用于界定「本周期」。返回 null 表示无可用内容。
     */
    buildDreamingDigest?: (sinceTs: number | null) => string | null;
    /**
     * 定时做梦的强制最小间隔（ms）。距离上一次做梦不足此间隔时，定时触发会被忽略。
     * 仅作用于 triggerScheduled（cron 路径），不影响手动触发与失败重试/relaunch。
     * 缺省取 DEFAULT_MIN_DREAM_INTERVAL_MS；显式传 0 关闭。
     */
    minDreamIntervalMs?: number;
}

export class HarnessManager {
    private config: HarnessManagerConfig;
    private running = false;
    private shuttingDown = false;
    private child: ChildProcess | null = null;
    private pendingQueue: HarnessNotify[] = [];
    private history: HarnessRunRecord[] = [];
    private currentRun: HarnessRunRecord | null = null;
    private nextRunSeq = 1;
    private nextEventSeq = 1;
    private consecutiveFailures = 0;
    private lastError: string | null = null;
    // 一次性的做梦收集起点覆盖：undefined=默认（上次做梦起始），null=全部，number=指定时刻(ms)
    private dreamingSinceOverride: number | null | undefined = undefined;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;
    onSpawnFailure?: (error: string, pendingCount: number) => void;

    constructor(config: HarnessManagerConfig) {
        this.config = config;
        this.hydrateHistory();
        this.cleanupTimer = setInterval(() => this.cleanupJournal(), JOURNAL_CLEANUP_INTERVAL_MS);
        if (this.cleanupTimer.unref) this.cleanupTimer.unref();
    }

    get isRunning(): boolean {
        return this.running;
    }

    get queueLength(): number {
        return this.pendingQueue.length;
    }

    enqueue(notify: HarnessNotify): void {
        if (this.shuttingDown) return;
        this.pendingQueue.push(notify);
        if (!this.running) {
            void this.launch();
        } else {
            log.info("enqueue: instance running, queued", { queueLength: this.pendingQueue.length });
        }
    }

    /**
     * 手动触发一次做梦，可覆盖本周期收集起点 sinceTs（ms）：
     * - number：从该时刻起收集 subagent 任务
     * - null：收集全部留存任务（不限起点）
     * - undefined：沿用默认（上次做梦的起始时间）
     * 覆盖值是一次性的，只作用于下一次启动。
     */
    triggerManual(notify: HarnessNotify, sinceTs?: number | null): void {
        if (this.shuttingDown) return;
        if (sinceTs !== undefined) this.dreamingSinceOverride = sinceTs;
        this.enqueue(notify);
    }

    triggerScheduled(): void {
        if (this.shuttingDown) return;
        const minInterval = this.config.minDreamIntervalMs ?? DEFAULT_MIN_DREAM_INTERVAL_MS;
        if (minInterval > 0) {
            const last = this.lastDreamStartedAt();
            if (last != null) {
                const elapsed = Date.now() - last;
                if (elapsed < minInterval) {
                    log.info("定时做梦被强制间隔拦截，跳过本次", {
                        minIntervalMin: Math.round(minInterval / 60_000),
                        sinceLastMin: Math.round(elapsed / 60_000),
                        remainMin: Math.ceil((minInterval - elapsed) / 60_000),
                        running: this.running,
                    });
                    return;
                }
            }
        }
        this.enqueue({ content: "scheduled-dreaming", source: "scheduler" });
    }

    /** 最近一次做梦的起始时间（ms）：当前运行优先，否则取历史中最新一次。无任何记录返回 null。 */
    private lastDreamStartedAt(): number | null {
        let last: number | null = this.currentRun?.startedAt ?? null;
        for (const run of this.history) {
            if (last == null || run.startedAt > last) last = run.startedAt;
        }
        return last;
    }

    getStatus(): {
        running: boolean;
        queueLength: number;
        historyCount: number;
        currentRun?: Omit<HarnessRunRecord, "events">;
        lastRun?: Omit<HarnessRunRecord, "events">;
        lastError: string | null;
        consecutiveFailures: number;
        harness: string;
    } {
        return {
            running: this.running,
            queueLength: this.pendingQueue.length,
            historyCount: this.history.length,
            currentRun: this.currentRun ? this.summarizeRun(this.currentRun) : undefined,
            lastRun: this.history.length > 0 ? this.summarizeRun(this.history[this.history.length - 1]) : undefined,
            lastError: this.lastError,
            consecutiveFailures: this.consecutiveFailures,
            harness: this.config.launcher.name,
        };
    }

    getRecentRuns(limit = 20): HarnessRunRecord[] {
        const runs = [...this.history].reverse().slice(0, Math.max(0, limit));
        return runs.map((run) => this.cloneRun(run));
    }

    getCurrentRun(): HarnessRunRecord | null {
        return this.currentRun ? this.cloneRun(this.currentRun) : null;
    }

    getRun(runId: string): HarnessRunRecord | null {
        if (this.currentRun?.id === runId) return this.cloneRun(this.currentRun);
        const run = this.history.find((item) => item.id === runId);
        return run ? this.cloneRun(run) : null;
    }

    async shutdown(): Promise<void> {
        this.shuttingDown = true;
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        if (this.child) {
            log.info("shutdown: killing harness process");
            this.child.kill("SIGTERM");
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                    this.child?.kill("SIGKILL");
                    resolve();
                }, 10_000);
                this.child?.once("exit", () => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            this.child = null;
            this.running = false;
        }
    }

    private async launch(): Promise<void> {
        if (this.running || this.shuttingDown) return;
        this.running = true;

        const pending = this.drainQueue();
        const trigger = pending.some(n => n.source === "scheduler") ? "scheduled" : "enqueued";
        this.regenerateDreamingDigest();
        this.writePendingFile(pending);
        const systemPrompt = buildSystemPrompt(this.config.workDir, this.config.persona);
        const prompt = buildTaskPrompt(this.config.workDir, pending);

        const externalMcpServers = this.loadExternalMcpServers();
        const mcpConfig: HarnessMcpConfig = {
            mcpServers: {
                ...externalMcpServers,
                cybergroupmate: {
                    type: "streamable-http" as const,
                    url: `${this.config.mcpUrl}?token=${this.config.mcpToken}`,
                },
            },
        };
        const mcpServers = Object.keys(mcpConfig.mcpServers);

        const runId = this.createRunId();
        const logPath = join(this.config.workDir, "workspace", "dream-journal", `${runId}.jsonl`);
        const harnessHome = getHarnessHome();
        const instructionPath = getHarnessInstructionPath(harnessHome, this.config.launcher.name);
        mkdirSync(join(this.config.workDir, "workspace", "dream-journal"), { recursive: true });
        this.cleanupJournal();

        const record: HarnessRunRecord = {
            id: runId,
            startedAt: Date.now(),
            trigger,
            pendingCount: pending.length,
            harness: this.config.launcher.name,
            mcpServers,
            logPath,
            harnessHome,
            instructionPath,
            events: [],
            eventCount: 0,
        };
        this.currentRun = record;
        this.recordEvent(record, "system", "launch", `启动 ${record.harness}，触发方式 ${trigger}，待处理 ${pending.length} 条，MCP: ${mcpServers.join(", ")}`);
        this.recordEvent(record, "system", "home", `HOME=${harnessHome}；system prompt 写入 ${instructionPath}`);

        let receivedResult = false;

        try {
            this.child = await this.config.launcher.start({
                prompt,
                systemPrompt,
                mcpConfig,
                workDir: this.config.workDir,
                model: this.config.model,
                maxBudgetUsd: this.config.maxBudgetUsd,
                extraArgs: this.config.extraArgs,
            });

            record.pid = this.child.pid ?? undefined;
            this.recordEvent(record, "system", "spawn", `进程已启动，pid=${record.pid ?? "unknown"}`);

            log.info("launch: harness started", {
                launcher: this.config.launcher.name,
                pid: this.child.pid,
                trigger,
                pendingCount: pending.length,
            });

            this.collectOutput(this.child, record, () => { receivedResult = true; });

            this.child.once("exit", (code) => {
                record.endedAt = Date.now();
                record.exitCode = code;
                record.durationMs = record.durationMs ?? (record.endedAt - record.startedAt);

                const durationSec = (record.durationMs / 1000).toFixed(1);
                log.info("launch: harness exited", { code, durationSec, trigger, cost: record.costUsd });
                this.recordEvent(record, "system", "exit", `进程退出，code=${code}, duration=${durationSec}s${record.costUsd != null ? `, cost=$${record.costUsd}` : ""}`);

                this.child = null;
                this.running = false;
                this.currentRun = null;

                if (code !== 0 && !this.shuttingDown && !receivedResult) {
                    this.handleSpawnFailure(`harness exited with code ${code}`, pending, record);
                    return;
                }

                this.history.push(record);
                if (this.history.length > 50) this.history.shift();

                if (code === 0 || this.shuttingDown) {
                    this.consecutiveFailures = 0;
                    this.lastError = null;
                } else {
                    this.lastError = `harness exited with code ${code} (partial work done)`;
                    this.consecutiveFailures = 0;
                    this.onSpawnFailure?.(this.lastError, this.pendingQueue.length);
                }

                if (!this.shuttingDown && this.pendingQueue.length > 0) {
                    log.info("launch: pending queue not empty, relaunching", { queueLength: this.pendingQueue.length });
                    void this.launch();
                }
            });

            this.child.once("error", (err) => {
                this.handleSpawnFailure(String(err), pending, record);
            });
        } catch (err) {
            this.handleSpawnFailure(String(err), pending, record);
        }
    }

    private handleSpawnFailure(error: string, pending: HarnessNotify[], record: HarnessRunRecord): void {
        log.error("launch: harness spawn failed", { error, consecutiveFailures: this.consecutiveFailures + 1 });
        this.recordEvent(record, "system", "failure", error);
        this.pendingQueue.unshift(...pending);
        if (!record.endedAt) record.endedAt = Date.now();
        if (record.exitCode == null) record.exitCode = -1;
        if (record.durationMs == null) record.durationMs = record.endedAt - record.startedAt;
        this.history.push(record);
        if (this.history.length > 50) this.history.shift();
        this.child = null;
        this.running = false;
        this.currentRun = null;
        this.consecutiveFailures++;
        this.lastError = error;
        this.onSpawnFailure?.(error, this.pendingQueue.length);

        if (!this.shuttingDown && this.pendingQueue.length > 0 && this.consecutiveFailures <= 3) {
            const delaySec = Math.min(30, 5 * Math.pow(2, this.consecutiveFailures - 1));
            log.info("launch: scheduling retry", { delaySec, attempt: this.consecutiveFailures });
            setTimeout(() => {
                if (!this.shuttingDown && !this.running && this.pendingQueue.length > 0) {
                    void this.launch();
                }
            }, delaySec * 1000);
        }
    }

    private loadExternalMcpServers(): Record<string, HarnessMcpServerConfig> {
        const result: Record<string, HarnessMcpServerConfig> = {};
        try {
            const raw = readFileSync(join(this.config.workDir, "workspace", "mcp-connections.json"), "utf-8");
            const parsed = JSON.parse(raw);
            const connections = Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : [];
            for (const conn of connections) {
                const name = typeof conn.name === "string" ? conn.name.trim() : "";
                if (!name) continue;
                if (name === "cybergroupmate") {
                    log.warn("skipping external MCP with reserved name", { name });
                    continue;
                }

                const transport = conn.transport === "stdio" || conn.transport === "streamable-http"
                    ? conn.transport
                    : typeof conn.url === "string" && conn.url.trim()
                        ? "streamable-http"
                        : "stdio";

                if (transport === "streamable-http") {
                    if (typeof conn.url !== "string" || !conn.url.trim()) {
                        log.warn("skipping external HTTP MCP without url", { name });
                        continue;
                    }
                    const entry: HarnessMcpServerConfig = {
                        type: "streamable-http",
                        url: conn.url,
                    };
                    const headers = normalizeStringMap(conn.headers);
                    if (headers) entry.headers = headers;
                    result[name] = entry;
                    continue;
                }

                if (typeof conn.command !== "string" || !conn.command.trim()) {
                    log.warn("skipping external stdio MCP without command", { name });
                    continue;
                }
                const entry: HarnessMcpServerConfig = {
                    type: "stdio",
                    command: conn.command,
                };
                if (Array.isArray(conn.args)) entry.args = conn.args.map(String);
                const env = normalizeStringMap(conn.env);
                if (env) entry.env = env;
                result[name] = entry;
            }
            if (Object.keys(result).length > 0) {
                log.info("loaded external MCP servers for harness", { servers: Object.keys(result) });
            }
        } catch {
            // no external connections or file unreadable — fine
        }
        return result;
    }

    /**
     * 启动前重建 workspace/background-dreaming.md：本周期（上次做梦以来）的 subagent
     * 任务回顾 + 群关系画像。无内容时删除旧文件，避免做梦时读到上个周期的陈旧内容。
     */
    private regenerateDreamingDigest(): void {
        if (!this.config.buildDreamingDigest) return;
        const path = join(this.config.workDir, "workspace", "background-dreaming.md");
        try {
            // 一次性覆盖优先；否则默认从「上次成功做梦」的起始时间收集。
            // 必须用成功的运行做基线：失败的 spawn（如 E2BIG）会作为 retry 反复入队，
            // 若用「上一次运行」做基线，retry 会把窗口塌缩成 0，反而清掉刚写好的文件。
            const override = this.dreamingSinceOverride;
            this.dreamingSinceOverride = undefined;
            const lastSuccessful = [...this.history].reverse().find((run) => run.exitCode === 0);
            const sinceTs = override !== undefined ? override : (lastSuccessful?.startedAt ?? null);
            const digest = this.config.buildDreamingDigest(sinceTs);
            if (digest && digest.trim()) {
                mkdirSync(join(this.config.workDir, "workspace"), { recursive: true });
                writeFileSync(path, digest.trim() + "\n", "utf-8");
                log.info("background-dreaming.md 已重建", { sinceTs, length: digest.length });
            } else {
                try {
                    unlinkSync(path);
                    log.info("本周期无 subagent 任务，已清除旧 background-dreaming.md");
                } catch {
                    // 文件本就不存在，忽略
                }
            }
        } catch (err) {
            log.warn("background-dreaming.md 重建失败", { error: String(err) });
        }
    }

    /**
     * 启动前把「有人找你」的通知写入 workspace/background-pending.md，task prompt 只引用它，
     * 不内联（通知可能很长）。没有真实通知时删除旧文件。
     */
    private writePendingFile(pending: HarnessNotify[]): void {
        const path = join(this.config.workDir, PENDING_FILE);
        try {
            const meaningful = selectPendingNotifications(pending);
            if (meaningful.length > 0) {
                mkdirSync(join(this.config.workDir, "workspace"), { recursive: true });
                writeFileSync(path, renderPendingFile(meaningful), "utf-8");
                log.info("background-pending.md 已写入", { count: meaningful.length });
            } else {
                try {
                    unlinkSync(path);
                } catch {
                    // 文件本就不存在，忽略
                }
            }
        } catch (err) {
            log.warn("background-pending.md 写入失败", { error: String(err) });
        }
    }

    private drainQueue(): HarnessNotify[] {
        const items = [...this.pendingQueue];
        this.pendingQueue = [];
        return items;
    }

    private createRunId(): string {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        return `harness-${stamp}-${this.nextRunSeq++}`;
    }

    /** 启动时从 dream-journal 目录把历史运行记录读回内存，避免重启后界面记录清空。 */
    private hydrateHistory(): void {
        const dir = join(this.config.workDir, "workspace", "dream-journal");
        let names: string[];
        try {
            names = readdirSync(dir).filter((name) => name.startsWith("harness-") && name.endsWith(".jsonl"));
        } catch {
            return; // 目录还没建，首次运行无需恢复
        }
        names.sort(); // 文件名内嵌 ISO 时间戳，字典序≈时间序（旧 → 新）
        const records: HarnessRunRecord[] = [];
        for (const name of names) {
            try {
                const record = this.parseRunFile(dir, name);
                if (record) records.push(record);
            } catch (err) {
                log.debug("failed to hydrate dream-journal run", { name, error: String(err) });
            }
        }
        this.history = records.slice(-50); // 与运行期保持一致的上限
        if (this.history.length > 0) log.info("hydrated dream-journal history", { runs: this.history.length });
    }

    /** 把一份 JSONL 日志还原成 HarnessRunRecord（尽量补齐时间、退出码、花费、结果等元信息）。 */
    private parseRunFile(dir: string, name: string): HarnessRunRecord | null {
        const logPath = join(dir, name);
        const lines = readFileSync(logPath, "utf-8").split(/\r?\n/).filter(Boolean);
        const events: HarnessRunEvent[] = [];
        for (const line of lines) {
            try {
                events.push(JSON.parse(line) as HarnessRunEvent);
            } catch {
                // 跳过坏行
            }
        }
        if (!events.length) return null;

        const first = events[0];
        const last = events[events.length - 1];
        const record: HarnessRunRecord = {
            id: name.replace(/\.jsonl$/, ""),
            startedAt: first.timestamp ?? Date.now(),
            endedAt: last.timestamp, // 从磁盘读回的运行必然已结束
            trigger: "enqueued",
            pendingCount: 0,
            harness: this.config.launcher.name,
            logPath,
            events: events.slice(-1000), // 与运行期内存上限一致；详情仍从文件读取
            eventCount: events.length,
        };

        for (const ev of events) {
            const raw = ev.event as Record<string, unknown> | undefined;
            if (ev.kind === "launch" && ev.text) {
                if (ev.text.includes("scheduled")) record.trigger = "scheduled";
                const mcpMatch = ev.text.match(/MCP:\s*(.+)$/);
                if (mcpMatch) record.mcpServers = mcpMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
            } else if (ev.kind === "home" && ev.text) {
                const homeMatch = ev.text.match(/HOME=([^；;]+)/);
                if (homeMatch) record.harnessHome = homeMatch[1].trim();
            } else if (ev.kind === "spawn" && ev.text) {
                const pidMatch = ev.text.match(/pid=(\d+)/);
                if (pidMatch) record.pid = Number(pidMatch[1]);
            } else if (ev.kind === "exit" && ev.text) {
                const codeMatch = ev.text.match(/code=(-?\d+)/);
                if (codeMatch) record.exitCode = Number(codeMatch[1]);
            }
            if (raw && raw.type === "result") {
                if (raw.total_cost_usd != null) record.costUsd = Number(raw.total_cost_usd);
                else if (raw.cost_usd != null) record.costUsd = Number(raw.cost_usd);
                if (raw.duration_ms != null) record.durationMs = Number(raw.duration_ms);
                else if (raw.usage && typeof raw.usage === "object") {
                    const usage = raw.usage as Record<string, unknown>;
                    if (usage.sessionDurationMs != null) record.durationMs = Number(usage.sessionDurationMs);
                }
                if (typeof raw.result === "string") record.resultSummary = raw.result.slice(0, 500);
                if (record.exitCode == null && raw.exitCode != null) record.exitCode = Number(raw.exitCode);
            } else if (raw?.type === "item.completed") {
                const item = raw.item && typeof raw.item === "object"
                    ? raw.item as Record<string, unknown>
                    : null;
                if (item?.type === "agent_message" && typeof item.text === "string") {
                    record.resultSummary = item.text.slice(0, 500);
                }
            }
        }
        if (record.durationMs == null && record.endedAt != null) record.durationMs = record.endedAt - record.startedAt;
        if (record.exitCode === undefined) record.exitCode = null; // 已结束但退出码未知
        return record;
    }

    /** 只保留最近 MAX_JOURNAL_FILES 份 dream-journal JSONL，删掉更早的，避免磁盘膨胀。 */
    private cleanupJournal(): void {
        const dir = join(this.config.workDir, "workspace", "dream-journal");
        let names: string[];
        try {
            names = readdirSync(dir).filter((name) => name.startsWith("harness-") && name.endsWith(".jsonl"));
        } catch {
            return; // 目录还没建或不可读，无需清理
        }
        if (names.length <= MAX_JOURNAL_FILES) return;

        const entries = names.map((name) => {
            let mtime = 0;
            try {
                mtime = statSync(join(dir, name)).mtimeMs;
            } catch {
                // 取不到时间就当作最旧，优先淘汰
            }
            return { name, mtime };
        });
        entries.sort((a, b) => b.mtime - a.mtime); // 新的在前

        const currentName = this.currentRun?.logPath ? basename(this.currentRun.logPath) : null;
        let removed = 0;
        for (const entry of entries.slice(MAX_JOURNAL_FILES)) {
            if (entry.name === currentName) continue; // 别删正在写入的那份
            try {
                unlinkSync(join(dir, entry.name));
                removed++;
            } catch (err) {
                log.debug("failed to remove old dream-journal log", { name: entry.name, error: String(err) });
            }
        }
        if (removed > 0) log.info("dream-journal cleanup removed old logs", { removed, kept: MAX_JOURNAL_FILES });
    }

    private recordEvent(
        record: HarnessRunRecord,
        stream: HarnessRunEvent["stream"],
        kind: string,
        text?: string,
        event?: Record<string, unknown>,
    ): void {
        const entry: HarnessRunEvent = {
            id: this.nextEventSeq++,
            timestamp: Date.now(),
            stream,
            kind,
            ...(text ? { text } : {}),
            ...(event ? { event: trimJsonForDashboard(event) } : {}),
        };
        record.eventCount++;
        record.events.push(entry);
        if (record.events.length > 1000) record.events.shift();
        if (record.logPath) {
            try {
                appendFileSync(record.logPath, JSON.stringify(entry) + "\n", "utf-8");
            } catch (err) {
                log.debug("failed to append harness run log", { runId: record.id, error: String(err) });
            }
        }
    }

    private summarizeRun(record: HarnessRunRecord): Omit<HarnessRunRecord, "events"> {
        const { events: _events, ...summary } = record;
        return { ...summary };
    }

    private cloneRun(record: HarnessRunRecord): HarnessRunRecord {
        return {
            ...record,
            events: record.events.map((event) => ({
                ...event,
                event: event.event ? { ...event.event } : undefined,
            })),
        };
    }

    private collectOutput(child: ChildProcess, record: HarnessRunRecord, onResult?: () => void): void {
        let stdoutBuffer = "";
        let stderrTail = "";
        let lastEvent: Record<string, unknown> | null = null;
        const processLine = (line: string) => {
            if (!line.trim()) return;
            try {
                const event = JSON.parse(line) as Record<string, unknown>;
                lastEvent = event;
                this.recordEvent(record, "stdout", String(event.type ?? "json"), summarizeHarnessEvent(event), event);
                // Claude Code: { type: "result", cost_usd, duration_ms, result }
                // Copilot CLI: { type: "result", ... } (similar JSONL in --output-format json)
                if (event.type === "result") {
                    log.info("harness result", { cost: event.cost_usd, duration: event.duration_ms });
                    if (event.cost_usd != null) record.costUsd = Number(event.cost_usd);
                    if (event.duration_ms != null) record.durationMs = Number(event.duration_ms);
                    if (event.result) record.resultSummary = String(event.result).slice(0, 500);
                    onResult?.();
                } else if (event.type === "item.completed") {
                    const item = event.item && typeof event.item === "object"
                        ? event.item as Record<string, unknown>
                        : null;
                    if (item?.type === "agent_message" && typeof item.text === "string") {
                        record.resultSummary = item.text.slice(0, 500);
                    }
                } else if (event.type === "turn.completed") {
                    log.info("codex harness turn completed", { usage: event.usage });
                    onResult?.();
                }
            } catch {
                log.debug("harness stdout", { line: line.slice(0, 200) });
                this.recordEvent(record, "stdout", "text", line);
            }
        };
        child.stdout?.on("data", (chunk: Buffer) => {
            stdoutBuffer += chunk.toString();
            const lines = stdoutBuffer.split("\n");
            stdoutBuffer = lines.pop() ?? "";
            for (const line of lines) processLine(line);
        });
        child.once("exit", () => {
            if (stdoutBuffer.trim()) processLine(stdoutBuffer);
            stdoutBuffer = "";
            if (stderrTail.trim()) record.stderrTail = stderrTail.trim().slice(-500);
            if (!record.resultSummary && lastEvent) {
                log.debug("harness: no result event parsed, recording last JSONL event", {
                    type: lastEvent.type, keys: Object.keys(lastEvent).join(","),
                });
                record.resultSummary = `[no result event] last: ${JSON.stringify(lastEvent).slice(0, 300)}`;
            }
        });

        child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString().trim();
            if (text) {
                log.warn("harness stderr", { text: text.slice(0, 500) });
                stderrTail = (stderrTail + "\n" + text).slice(-500);
                this.recordEvent(record, "stderr", "stderr", text);
            }
        });
    }
}

function normalizeStringMap(value: unknown): Record<string, string> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key.trim())
        .map(([key, val]) => [key, String(val)] as const);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function trimJsonForDashboard(value: Record<string, unknown>): Record<string, unknown> {
    const json = JSON.stringify(value);
    if (json.length <= 8000) return value;
    return {
        type: value.type,
        truncated: true,
        preview: json.slice(0, 8000),
    };
}

function summarizeHarnessEvent(event: Record<string, unknown>): string {
    const type = String(event.type ?? "json");
    if (type === "result") {
        const result = event.result != null ? String(event.result).trim() : "";
        const cost = event.cost_usd != null ? ` cost=$${event.cost_usd}` : "";
        const duration = event.duration_ms != null ? ` duration=${event.duration_ms}ms` : "";
        return result ? `result:${cost}${duration} ${truncate(result, 500)}` : `result:${cost}${duration}`.trim();
    }

    if (type.startsWith("item.")) {
        const item = event.item && typeof event.item === "object"
            ? event.item as Record<string, unknown>
            : null;
        if (item?.type === "agent_message" && typeof item.text === "string") {
            return `assistant: ${truncate(item.text, 700)}`;
        }
        if (item?.type === "reasoning" && typeof item.text === "string") {
            return `reasoning: ${truncate(item.text, 700)}`;
        }
        if (item?.type === "command_execution") {
            return truncate(`${type}: ${String(item.command ?? "command")} (${String(item.status ?? "")})`, 700);
        }
        if (item?.type === "mcp_tool_call") {
            const tool = [item.server, item.tool].filter(Boolean).join(".") || "mcp";
            return truncate(`${type}: ${tool} (${String(item.status ?? "")})`, 700);
        }
    }

    if (type === "turn.completed" && event.usage && typeof event.usage === "object") {
        return `turn.completed ${JSON.stringify(event.usage)}`;
    }

    const message = event.message;
    if (message && typeof message === "object") {
        const msg = message as Record<string, unknown>;
        const role = typeof msg.role === "string" ? msg.role : type;
        const content = msg.content;
        const parts: string[] = [];
        if (typeof content === "string") {
            parts.push(content);
        } else if (Array.isArray(content)) {
            for (const part of content) {
                if (!part || typeof part !== "object") continue;
                const p = part as Record<string, unknown>;
                if (p.type === "text" && typeof p.text === "string") {
                    parts.push(p.text);
                } else if (p.type === "tool_use") {
                    const name = typeof p.name === "string" ? p.name : "tool";
                    const input = p.input && typeof p.input === "object"
                        ? Object.keys(p.input as Record<string, unknown>).join(",")
                        : "";
                    parts.push(`tool_use ${name}${input ? `(${input})` : ""}`);
                } else if (p.type === "tool_result") {
                    const contentText = typeof p.content === "string"
                        ? p.content
                        : JSON.stringify(p.content ?? "");
                    parts.push(`tool_result ${truncate(contentText, 300)}`);
                }
            }
        }
        if (parts.length > 0) return `${role}: ${truncate(parts.join("\n"), 700)}`;
    }

    const subtype = event.subtype ? `/${String(event.subtype)}` : "";
    return truncate(`${type}${subtype} ${JSON.stringify(event)}`, 700);
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}...` : text;
}
