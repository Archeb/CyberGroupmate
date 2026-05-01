/**
 * registry.ts — Prometheus 文本格式自实现 + Metrics 注册中心
 *
 * 实现三种 metric 类型（无外部依赖）：
 * - Counter: 单调递增计数器
 * - Gauge:   任意方向瞬时值
 * - Histogram: 分桶分布统计
 *
 * 所有 cybergroupmate_* metric 对象在此文件统一注册。
 */

// ─── Label 工具 ───

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
    const parts = Object.entries(labels)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
        .join(",");
    return `{${parts}}`;
}

function escapeLabel(v: string): string {
    return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderSamples(name: string, samples: Map<string, number>): string {
    const lines: string[] = [];
    for (const [lk, value] of samples) {
        // Normalize empty label set: omit "{}"
        const labelSuffix = lk === "{}" ? "" : lk;
        lines.push(`${name}${labelSuffix} ${formatValue(value)}`);
    }
    return lines.join("\n");
}

function formatValue(v: number): string {
    if (v === Infinity) return "+Inf";
    if (v === -Infinity) return "-Inf";
    if (isNaN(v)) return "NaN";
    return String(v);
}

// ─── Counter ───

export class Counter {
    private values = new Map<string, number>();

    inc(labels: Labels = {}, delta = 1): void {
        const key = labelKey(labels);
        this.values.set(key, (this.values.get(key) ?? 0) + delta);
    }

    get(labels: Labels = {}): number {
        return this.values.get(labelKey(labels)) ?? 0;
    }

    render(name: string, help: string): string {
        const lines = [
            `# HELP ${name} ${help}`,
            `# TYPE ${name} counter`,
        ];
        if (this.values.size === 0) {
            // Always emit at least one sample so Prometheus sees the metric
            lines.push(`${name} 0`);
        } else {
            lines.push(renderSamples(name, this.values));
        }
        return lines.join("\n");
    }

    /** 重置（测试用） */
    reset(): void {
        this.values.clear();
    }
}

// ─── Gauge ───

export class Gauge {
    private values = new Map<string, number>();

    set(labels: Labels = {}, value: number): void {
        this.values.set(labelKey(labels), value);
    }

    get(labels: Labels = {}): number {
        return this.values.get(labelKey(labels)) ?? 0;
    }

    render(name: string, help: string): string {
        const lines = [
            `# HELP ${name} ${help}`,
            `# TYPE ${name} gauge`,
        ];
        if (this.values.size === 0) {
            lines.push(`${name} 0`);
        } else {
            lines.push(renderSamples(name, this.values));
        }
        return lines.join("\n");
    }

    reset(): void {
        this.values.clear();
    }
}

// ─── Histogram ───

interface HistogramSeries {
    buckets: Map<number, number>; // le → count
    sum: number;
    count: number;
}

export class Histogram {
    readonly buckets: readonly number[];

    private series = new Map<string, HistogramSeries>();

    constructor(buckets: number[]) {
        this.buckets = [...buckets].sort((a, b) => a - b);
    }

    observe(labels: Labels = {}, value: number): void {
        const key = labelKey(labels);
        let s = this.series.get(key);
        if (!s) {
            s = {
                buckets: new Map(this.buckets.map(b => [b, 0])),
                sum: 0,
                count: 0,
            };
            this.series.set(key, s);
        }
        s.sum += value;
        s.count += 1;
        for (const b of this.buckets) {
            if (value <= b) {
                s.buckets.set(b, (s.buckets.get(b) ?? 0) + 1);
            }
        }
    }

    render(name: string, help: string): string {
        const lines = [
            `# HELP ${name} ${help}`,
            `# TYPE ${name} histogram`,
        ];
        if (this.series.size === 0) {
            // Emit empty histogram template
            for (const b of this.buckets) {
                lines.push(`${name}_bucket{le="${b}"} 0`);
            }
            lines.push(`${name}_bucket{le="+Inf"} 0`);
            lines.push(`${name}_sum 0`);
            lines.push(`${name}_count 0`);
        } else {
            for (const [lk, s] of this.series) {
                // Strip outer braces to inject more labels
                const baseLabelStr = lk === "{}" ? "" : lk.slice(1, -1);
                const prefix = baseLabelStr ? `{${baseLabelStr},` : `{`;
                // Note: s.buckets already stores cumulative counts per bucket
                // (observe() increments ALL buckets where value <= b)
                // So we just read them directly without re-accumulating.
                for (const b of this.buckets) {
                    const cumCount = s.buckets.get(b) ?? 0;
                    lines.push(`${name}_bucket${prefix}le="${b}"} ${cumCount}`);
                }
                // +Inf bucket = total count
                lines.push(`${name}_bucket${prefix}le="+Inf"} ${s.count}`);
                lines.push(`${name}_sum${lk === "{}" ? "" : lk} ${formatValue(s.sum)}`);
                lines.push(`${name}_count${lk === "{}" ? "" : lk} ${s.count}`);
            }
        }
        return lines.join("\n");
    }

    getCount(labels: Labels = {}): number {
        return this.series.get(labelKey(labels))?.count ?? 0;
    }

    reset(): void {
        this.series.clear();
    }
}

// ─── Registry ───

interface MetricEntry {
    name: string;
    help: string;
    metric: Counter | Gauge | Histogram;
}

export class MetricsRegistry {
    private entries: MetricEntry[] = [];

    register<T extends Counter | Gauge | Histogram>(name: string, help: string, metric: T): T {
        this.entries.push({ name, help, metric });
        return metric;
    }

    render(): string {
        return this.entries.map(e => e.metric.render(e.name, e.help)).join("\n\n") + "\n";
    }
}

// ─── 全局 Registry 单例 ───

export const registry = new MetricsRegistry();

// ─── LLM Token 用量 Counters ───

export const llmTokensPrompt = registry.register(
    "cybergroupmate_llm_tokens_prompt_total",
    "累计 prompt (input) token 数",
    new Counter(),
);

export const llmTokensCompletion = registry.register(
    "cybergroupmate_llm_tokens_completion_total",
    "累计 completion (output) token 数",
    new Counter(),
);

export const llmTokensCached = registry.register(
    "cybergroupmate_llm_tokens_cached_total",
    "累计 cache 命中 token 数（prompt 中被缓存命中的部分）",
    new Counter(),
);

export const llmTokensCacheCreation = registry.register(
    "cybergroupmate_llm_tokens_cache_creation_total",
    "累计 cache 写入 token 数（Anthropic prompt caching）",
    new Counter(),
);

// ─── LLM 推理 SLA ───

/** Buckets: 500ms, 1s, 2s, 5s, 10s, 30s, 60s */
export const llmRequestDurationMs = registry.register(
    "cybergroupmate_llm_request_duration_ms",
    "LLM 请求端到端耗时（毫秒）。当前为非流式调用，TTFT ≈ total latency（TODO: 流式调用后新增精确 TTFT 指标）",
    new Histogram([500, 1000, 2000, 5000, 10000, 30000, 60000]),
);

export const llmRequests = registry.register(
    "cybergroupmate_llm_requests_total",
    "LLM 调用总次数",
    new Counter(),
);

export const llmRetries = registry.register(
    "cybergroupmate_llm_retries_total",
    "LLM 自动重试次数",
    new Counter(),
);

/** Buckets: 5, 10, 20, 50, 100, 200 tokens/s
 * TODO: 当前为非流式调用推算值（completion_tokens / duration_s），
 * 待切换流式调用后可从 Provider 层 streaming hook 获取精确 ITL/TPS。
 */
export const llmTps = registry.register(
    "cybergroupmate_llm_tps",
    "LLM 每秒生成 token 数（非流式推算：completion_tokens / duration_s）",
    new Histogram([5, 10, 20, 50, 100, 200]),
);

// ─── 群聊统计 ───

export const groupsTotal = registry.register(
    "cybergroupmate_groups_total",
    "当前活跃 subagent（群组）总数",
    new Gauge(),
);

export const groupMessagesTotal = registry.register(
    "cybergroupmate_group_messages_total",
    "各群组接收消息总量（自启动以来）",
    new Counter(),
);

export const groupAttendsTotal = registry.register(
    "cybergroupmate_group_attends_total",
    "主 Agent attend 并做出决策的总次数",
    new Counter(),
);

export const groupEngagementScore = registry.register(
    "cybergroupmate_group_engagement_score",
    "群组 engagement 分数（0-100）",
    new Gauge(),
);

export const groupStickiness = registry.register(
    "cybergroupmate_group_stickiness",
    "群组亲密度等级指示器（值为 1 表示当前等级）",
    new Gauge(),
);

export const groupBufferSize = registry.register(
    "cybergroupmate_group_buffer_size",
    "Observer Q2 buffer 中未处理消息数",
    new Gauge(),
);

export const groupTopicCount = registry.register(
    "cybergroupmate_group_topic_count",
    "TopicRegistry 中各状态话题数量",
    new Gauge(),
);

export const groupCodeActQueueSize = registry.register(
    "cybergroupmate_group_codeact_queue_size",
    "CodeActExecutor Q4 待执行任务数",
    new Gauge(),
);

export const groupLastAttendAgeSeconds = registry.register(
    "cybergroupmate_group_last_attend_age_seconds",
    "距上次 attend 的时间（秒）",
    new Gauge(),
);

// ─── 主循环 & 系统 ───

export const mainLoopTicksTotal = registry.register(
    "cybergroupmate_main_loop_ticks_total",
    "主 Agent event loop 总 tick 次数",
    new Gauge(), // Gauge 而非 Counter 以支持 scrape 时实时读取（Counter 需累计）
);

export const mainLoopRunning = registry.register(
    "cybergroupmate_main_loop_running",
    "主 Agent event loop 是否运行中（1=运行，0=停止）",
    new Gauge(),
);

export const sandboxPoolActive = registry.register(
    "cybergroupmate_sandbox_pool_active",
    "SandboxPool 当前使用中的沙盒数",
    new Gauge(),
);

export const sandboxPoolIdle = registry.register(
    "cybergroupmate_sandbox_pool_idle",
    "SandboxPool 当前空闲的沙盒数",
    new Gauge(),
);

export const accumulatorQueueSize = registry.register(
    "cybergroupmate_accumulator_queue_size",
    "AttentionAccumulator 当前待处理群组数",
    new Gauge(),
);

export const q5CallbackPending = registry.register(
    "cybergroupmate_q5_callback_pending",
    "回调队列（Q5）待处理回调数",
    new Gauge(),
);

export const feedbackLoopWindowsActive = registry.register(
    "cybergroupmate_feedback_loop_windows_active",
    "FeedbackLoop 当前活跃追问窗口数",
    new Gauge(),
);

// ─── 进程级 ───

export const processUptimeSeconds = registry.register(
    "cybergroupmate_process_uptime_seconds",
    "进程运行时间（秒）",
    new Gauge(),
);

export const processHeapUsedBytes = registry.register(
    "cybergroupmate_process_heap_used_bytes",
    "V8 堆内存已使用字节数",
    new Gauge(),
);

export const processHeapTotalBytes = registry.register(
    "cybergroupmate_process_heap_total_bytes",
    "V8 堆内存总分配字节数",
    new Gauge(),
);

export const processRssBytes = registry.register(
    "cybergroupmate_process_rss_bytes",
    "进程 RSS（常驻内存集）字节数",
    new Gauge(),
);
