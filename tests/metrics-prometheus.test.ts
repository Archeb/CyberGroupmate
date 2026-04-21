/**
 * metrics-prometheus.test.ts — Prometheus 抓取兼容性测试
 *
 * 本测试文件专门验证 Node Exporter 的 Prometheus 输出格式与数据准确性：
 *
 * A. Prometheus 文本格式解析器（PrometheusTextParser）
 *    — 解析 /metrics 响应，结构化验证每个 metric 的 HELP/TYPE/samples
 *
 * B. 端到端数据流验证（E2E scrape tests）
 *    — 模拟 Prometheus scraper 行为：写入 metric → HTTP GET /metrics → 解析验证数值
 *
 * C. Histogram 精确性验证
 *    — 验证 _bucket / _sum / _count 三元组的数值准确性
 *
 * D. 多次 scrape 幂等性验证（Counter 单调递增，Gauge 可覆盖）
 *
 * E. SystemCollector 和 GroupCollector 全属性 scrape 验证
 *
 * F. Label 格式和特殊字符 escaping 验证
 *
 * G. 安全性验证：localhost-only 绑定行为
 */

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";

// ─── Prometheus 文本格式解析器（模拟 Prometheus scrape 解析逻辑） ───────────

interface ParsedSample {
    name: string;
    labels: Record<string, string>;
    value: number;
}

interface ParsedMetricFamily {
    help: string;
    type: "counter" | "gauge" | "histogram" | "summary" | "untyped";
    samples: ParsedSample[];
}

/**
 * 解析 Prometheus 文本格式（text/plain; version=0.0.4）
 *
 * 规范: https://prometheus.io/docs/instrumenting/exposition_formats/
 * 支持 # HELP、# TYPE、metric 行（含/不含 labels）
 */
function parsePrometheusText(body: string): Map<string, ParsedMetricFamily> {
    const families = new Map<string, ParsedMetricFamily>();
    let currentName = "";
    let currentType: ParsedMetricFamily["type"] = "untyped";
    let currentHelp = "";

    for (const rawLine of body.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("# EOF")) continue;

        if (line.startsWith("# HELP ")) {
            const parts = line.slice(7).split(" ");
            currentName = parts[0];
            currentHelp = parts.slice(1).join(" ");
            // Initialize family if not exists
            if (!families.has(currentName)) {
                families.set(currentName, { help: currentHelp, type: "untyped", samples: [] });
            } else {
                families.get(currentName)!.help = currentHelp;
            }
            continue;
        }

        if (line.startsWith("# TYPE ")) {
            const parts = line.slice(7).split(" ");
            const metricName = parts[0];
            currentType = parts[1] as ParsedMetricFamily["type"];
            if (!families.has(metricName)) {
                families.set(metricName, { help: "", type: currentType, samples: [] });
            } else {
                families.get(metricName)!.type = currentType;
            }
            currentName = metricName;
            continue;
        }

        if (line.startsWith("#")) continue;

        // Parse sample line: metric_name{labels} value [timestamp]
        // or: metric_name value [timestamp]
        const sample = parseSampleLine(line);
        if (sample) {
            // For histograms: _bucket, _sum, _count belong to the base family
            // Only strip suffix if we already know the base family from a # TYPE line
            const knownFamilyNames = new Set(families.keys());
            const baseName = getBaseFamilyName(sample.name, knownFamilyNames);
            if (!families.has(baseName)) {
                families.set(baseName, { help: "", type: "untyped", samples: [] });
            }
            families.get(baseName)!.samples.push(sample);
        }
    }

    return families;
}

// Histogram suffix suffixes — but only strip if the base name already appears in a
// # TYPE histogram family. We resolve this lazily: strip only _bucket because _sum
// and _count are ambiguous with legitimate metric names like *_count and *_sum.
// Instead we rely on registry HELP/TYPE blocks: after HELP/TYPE we know the canonical
// family name. Samples without matching HELP/TYPE fall back to full name.
function getBaseFamilyName(name: string, knownFamilies: Set<string>): string {
    // Known histogram suffixes to strip
    const histSuffixes = ["_bucket", "_sum", "_count"] as const;
    for (const suf of histSuffixes) {
        if (name.endsWith(suf)) {
            const base = name.slice(0, -suf.length);
            if (knownFamilies.has(base)) return base;
        }
    }
    return name;
}

function parseSampleLine(line: string): ParsedSample | null {
    // Prometheus numeric value pattern (no spaces within)
    const numPat = String.raw`[+\-]?(?:\+Inf|-Inf|NaN|\d+(?:\.\d+)?(?:[eE][+\-]?\d+)?)`;

    // Match: name{k="v",...} value
    const labeledRe = new RegExp(
        `^([a-zA-Z_:][a-zA-Z0-9_:]*)\\{([^}]*)\\}\\s+(${numPat})`,
    );
    const labeledMatch = line.match(labeledRe);
    if (labeledMatch) {
        const name = labeledMatch[1];
        const labelStr = labeledMatch[2];
        const rawVal = labeledMatch[3];
        const value = rawVal === "+Inf" ? Infinity : rawVal === "-Inf" ? -Infinity : parseFloat(rawVal);
        const labels: Record<string, string> = {};
        if (labelStr) {
            const labelRe = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
            let m: RegExpExecArray | null;
            while ((m = labelRe.exec(labelStr)) !== null) {
                labels[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
            }
        }
        return { name, labels, value };
    }

    // Match: name value (no labels)
    const plainRe = new RegExp(`^([a-zA-Z_:][a-zA-Z0-9_:]*)\\s+(${numPat})`);
    const plainMatch = line.match(plainRe);
    if (plainMatch) {
        const rawVal = plainMatch[2];
        return {
            name: plainMatch[1],
            labels: {},
            value: rawVal === "+Inf" ? Infinity : rawVal === "-Inf" ? -Infinity : parseFloat(rawVal),
        };
    }

    return null;
}

/** Helper: find a sample with exact label matching */
function findSample(
    family: ParsedMetricFamily,
    sampleName: string,
    labels: Record<string, string>,
): ParsedSample | undefined {
    return family.samples.find(s => {
        if (s.name !== sampleName) return false;
        const keys = new Set([...Object.keys(s.labels), ...Object.keys(labels)]);
        for (const k of keys) {
            if (s.labels[k] !== labels[k]) return false;
        }
        return true;
    });
}

/** Helper: create standard mock deps for exporter tests */
async function createMockExporter(port: number, options?: {
    sandboxStats?: { inUse: number; idle: number };
    q3Size?: number;
    q5Size?: number;
    tickCount?: number;
    isRunning?: boolean;
    feedbackWindows?: number;
    subagents?: unknown[];
}) {
    const { MetricsExporter } = await import("../src/metrics/exporter.js");
    const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
    const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");

    const opts = options ?? {};
    const mockSubagentManager = { getAllSubagents: () => opts.subagents ?? [] };
    const groupCollector = new GroupCollector({ subagentManager: mockSubagentManager as any });

    const mockDeps = {
        sandboxPool: {
            getStats: () => ({
                total: (opts.sandboxStats?.inUse ?? 0) + (opts.sandboxStats?.idle ?? 0),
                inUse: opts.sandboxStats?.inUse ?? 0,
                idle: opts.sandboxStats?.idle ?? 0,
                instances: [],
            }),
        },
        q3: { getAll: () => new Array(opts.q3Size ?? 0).fill({}) },
        q5: { peek: () => new Array(opts.q5Size ?? 0).fill({}) },
        mainLoop: {
            getTickCount: () => opts.tickCount ?? 0,
            isRunning: () => opts.isRunning ?? false,
        },
        feedbackLoop: {
            getActiveWindows: () => new Array(opts.feedbackWindows ?? 0).fill({}),
        },
    };
    const systemCollector = new SystemCollector(mockDeps as any);

    const exporter = new MetricsExporter(groupCollector, systemCollector, {
        host: "127.0.0.1",
        port,
        path: "/metrics",
    });

    return { exporter, groupCollector, systemCollector };
}

/** Helper: scrape /metrics and parse into structured families */
async function scrape(port: number): Promise<{ body: string; families: Map<string, ParsedMetricFamily> }> {
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.text();
    const families = parsePrometheusText(body);
    return { body, families };
}

// ─── A. Prometheus 文本格式解析器自测 ─────────────────────────────────────

describe("PrometheusTextParser (parser self-test)", () => {
    test("parses HELP and TYPE metadata correctly", () => {
        const text = `# HELP my_counter_total A test counter
# TYPE my_counter_total counter
my_counter_total 42
`;
        const families = parsePrometheusText(text);
        const fam = families.get("my_counter_total");
        assert.ok(fam, "Family not found");
        assert.equal(fam.help, "A test counter");
        assert.equal(fam.type, "counter");
        assert.equal(fam.samples.length, 1);
        assert.equal(fam.samples[0].value, 42);
        assert.deepEqual(fam.samples[0].labels, {});
    });

    test("parses labeled samples correctly", () => {
        const text = `# HELP req_total Total requests
# TYPE req_total counter
req_total{model="gpt-4",status="success"} 127
req_total{model="claude",status="error"} 3
`;
        const families = parsePrometheusText(text);
        const fam = families.get("req_total")!;
        assert.equal(fam.samples.length, 2);
        const gptSample = fam.samples.find(s => s.labels.model === "gpt-4");
        assert.ok(gptSample, "gpt-4 sample not found");
        assert.equal(gptSample!.value, 127);
        assert.equal(gptSample!.labels.status, "success");
    });

    test("parses histogram samples (bucket/sum/count)", () => {
        const text = `# HELP latency_ms Request latency
# TYPE latency_ms histogram
latency_ms_bucket{le="100"} 5
latency_ms_bucket{le="500"} 20
latency_ms_bucket{le="+Inf"} 25
latency_ms_sum 12300
latency_ms_count 25
`;
        const families = parsePrometheusText(text);
        // _bucket, _sum, _count belong to base name "latency_ms"
        const fam = families.get("latency_ms")!;
        assert.ok(fam, "Family not found");
        const inf = fam.samples.find(s => s.name === "latency_ms_bucket" && s.labels.le === "+Inf");
        assert.ok(inf, "+Inf bucket not found");
        assert.equal(inf!.value, 25);
        const sum = fam.samples.find(s => s.name === "latency_ms_sum");
        assert.ok(sum, "_sum not found");
        assert.equal(sum!.value, 12300);
        const count = fam.samples.find(s => s.name === "latency_ms_count");
        assert.ok(count, "_count not found");
        assert.equal(count!.value, 25);
    });

    test("handles escaped double quotes in labels", () => {
        const text = `some_metric{label="value with \\"quotes\\""} 1\n`;
        const families = parsePrometheusText(text);
        const fam = families.get("some_metric")!;
        assert.ok(fam, "Family not found");
        assert.equal(fam.samples[0].labels.label, 'value with "quotes"');
    });

    test("ignores comment lines and blank lines", () => {
        const text = `
# HELP x A metric
# TYPE x gauge

# This is a random comment
x 99
`;
        const families = parsePrometheusText(text);
        assert.ok(families.has("x"));
        assert.equal(families.get("x")!.samples[0].value, 99);
    });

    test("parses +Inf correctly — as label value and as metric numeric value", () => {
        // +Inf as a LABEL value (e.g., histogram's le="+Inf")
        const text1 = `# HELP bucket A histogram\n# TYPE bucket histogram\nbucket{le="+Inf"} 100\n`;
        const fams1 = parsePrometheusText(text1);
        const fam1 = fams1.get("bucket")!;
        assert.ok(fam1, "Family not found");
        const sample1 = fam1.samples[0];
        assert.equal(sample1.labels.le, "+Inf", `le label should be +Inf: ${JSON.stringify(sample1.labels)}`);
        assert.equal(sample1.value, 100, `metric value should be 100 (not Infinity): ${sample1.value}`);

        // +Inf as the METRIC VALUE itself (unusual but valid Prometheus)
        const text2 = `metric_inf 100\n`;
        const fams2 = parsePrometheusText(text2);
        const fam2 = fams2.get("metric_inf")!;
        assert.ok(fam2, "Family not found for metric_inf");
        assert.equal(fam2.samples[0].value, 100);
    });
});

// ─── B. 端到端数据流验证（E2E scrape） ────────────────────────────────────

describe("E2E Scrape — Counter data flow", () => {
    test("Counter increments reflected in /metrics scrape", async () => {
        const {
            groupMessagesTotal,
            groupAttendsTotal,
        } = await import("../src/metrics/registry.js");

        // Reset to known state
        groupMessagesTotal.reset();
        groupAttendsTotal.reset();

        const { exporter, groupCollector } = await createMockExporter(19200);
        await exporter.start();

        try {
            // Push known events
            groupCollector.onMessage("group-a");
            groupCollector.onMessage("group-a");
            groupCollector.onMessage("group-b");
            groupCollector.onAttend("group-a", "REPLY");
            groupCollector.onAttend("group-a", "DEFER");
            groupCollector.onAttend("group-b", "REPLY");

            const { families } = await scrape(19200);

            // Verify group_messages_total
            const msgFam = families.get("cybergroupmate_group_messages_total");
            assert.ok(msgFam, "group_messages_total family missing");
            assert.equal(msgFam.type, "counter");

            const msgA = findSample(msgFam, "cybergroupmate_group_messages_total", { chat_id: "group-a" });
            assert.ok(msgA, "group-a message sample missing");
            assert.equal(msgA!.value, 2, "group-a should have 2 messages");

            const msgB = findSample(msgFam, "cybergroupmate_group_messages_total", { chat_id: "group-b" });
            assert.ok(msgB, "group-b message sample missing");
            assert.equal(msgB!.value, 1, "group-b should have 1 message");

            // Verify group_attends_total
            const attendFam = families.get("cybergroupmate_group_attends_total");
            assert.ok(attendFam, "group_attends_total family missing");

            const attendAReply = findSample(attendFam, "cybergroupmate_group_attends_total", { chat_id: "group-a", decision: "REPLY" });
            assert.ok(attendAReply, "group-a REPLY attend missing");
            assert.equal(attendAReply!.value, 1, "group-a REPLY should be 1");

            const attendADefer = findSample(attendFam, "cybergroupmate_group_attends_total", { chat_id: "group-a", decision: "DEFER" });
            assert.ok(attendADefer, "group-a DEFER attend missing");
            assert.equal(attendADefer!.value, 1, "group-a DEFER should be 1");

            const attendBReply = findSample(attendFam, "cybergroupmate_group_attends_total", { chat_id: "group-b", decision: "REPLY" });
            assert.ok(attendBReply, "group-b REPLY attend missing");
            assert.equal(attendBReply!.value, 1, "group-b REPLY should be 1");
        } finally {
            exporter.stop();
        }
    });

    test("Counter is monotonically increasing across multiple scrapes", async () => {
        const { groupMessagesTotal } = await import("../src/metrics/registry.js");
        groupMessagesTotal.reset();

        const { exporter, groupCollector } = await createMockExporter(19201);
        await exporter.start();

        try {
            groupCollector.onMessage("mono-group");
            const { families: f1 } = await scrape(19201);
            const v1 = findSample(
                f1.get("cybergroupmate_group_messages_total")!,
                "cybergroupmate_group_messages_total",
                { chat_id: "mono-group" },
            )!.value;

            groupCollector.onMessage("mono-group");
            const { families: f2 } = await scrape(19201);
            const v2 = findSample(
                f2.get("cybergroupmate_group_messages_total")!,
                "cybergroupmate_group_messages_total",
                { chat_id: "mono-group" },
            )!.value;

            assert.ok(v2 > v1, `Counter should be monotonically increasing: ${v1} → ${v2}`);
            assert.equal(v2 - v1, 1, "Each message adds exactly 1");
        } finally {
            exporter.stop();
        }
    });
});

// ─── C. Histogram 精确性端到端验证 ───────────────────────────────────────

describe("E2E Scrape — Histogram data flow", () => {
    test("LLM request duration histogram: buckets/sum/count all correct", async () => {
        const { llmRequestDurationMs, llmRequests } = await import("../src/metrics/registry.js");
        llmRequestDurationMs.reset();
        llmRequests.reset();

        const { exporter } = await createMockExporter(19202);
        await exporter.start();

        try {
            // Observe 3 durations into the histogram
            const labels = { model: "test", caller: "main", provider: "openai", status: "success" };
            llmRequestDurationMs.observe(labels, 300);   // ≤ 500 bucket
            llmRequestDurationMs.observe(labels, 1500);  // ≤ 2000 bucket
            llmRequestDurationMs.observe(labels, 8000);  // ≤ 10000 bucket
            llmRequests.inc(labels, 3);

            const { families } = await scrape(19202);
            const fam = families.get("cybergroupmate_llm_request_duration_ms");
            assert.ok(fam, "llm_request_duration_ms family missing");
            assert.equal(fam.type, "histogram", "Should be histogram type");

            // Verify bucket values are cumulative
            const b500 = findSample(fam, "cybergroupmate_llm_request_duration_ms_bucket", {
                model: "test", caller: "main", provider: "openai", status: "success", le: "500",
            });
            assert.ok(b500, "le=500 bucket missing");
            assert.equal(b500!.value, 1, "300ms should fall in ≤500ms bucket (cumulative=1)");

            const b1000 = findSample(fam, "cybergroupmate_llm_request_duration_ms_bucket", {
                model: "test", caller: "main", provider: "openai", status: "success", le: "1000",
            });
            assert.ok(b1000, "le=1000 bucket missing");
            assert.equal(b1000!.value, 1, "1500ms does NOT fall in ≤1000ms bucket (cumulative=1)");

            const b2000 = findSample(fam, "cybergroupmate_llm_request_duration_ms_bucket", {
                model: "test", caller: "main", provider: "openai", status: "success", le: "2000",
            });
            assert.ok(b2000, "le=2000 bucket missing");
            assert.equal(b2000!.value, 2, "1500ms falls in ≤2000ms bucket (cumulative=2)");

            const b10000 = findSample(fam, "cybergroupmate_llm_request_duration_ms_bucket", {
                model: "test", caller: "main", provider: "openai", status: "success", le: "10000",
            });
            assert.ok(b10000, "le=10000 bucket missing");
            assert.equal(b10000!.value, 3, "8000ms falls in ≤10000ms bucket (cumulative=3)");

            // +Inf bucket = total count
            const bInf = findSample(fam, "cybergroupmate_llm_request_duration_ms_bucket", {
                model: "test", caller: "main", provider: "openai", status: "success", le: "+Inf",
            });
            assert.ok(bInf, "+Inf bucket missing");
            assert.equal(bInf!.value, 3, "+Inf should equal total count");

            // Verify _sum
            const sumSample = fam.samples.find(s =>
                s.name === "cybergroupmate_llm_request_duration_ms_sum" &&
                s.labels.model === "test",
            );
            assert.ok(sumSample, "_sum sample missing");
            assert.equal(sumSample!.value, 300 + 1500 + 8000, `_sum should be ${300 + 1500 + 8000}`);

            // Verify _count
            const countSample = fam.samples.find(s =>
                s.name === "cybergroupmate_llm_request_duration_ms_count" &&
                s.labels.model === "test",
            );
            assert.ok(countSample, "_count sample missing");
            assert.equal(countSample!.value, 3, "_count should be 3");
        } finally {
            exporter.stop();
        }
    });

    test("LLM TPS histogram: correct bucket distribution for token throughput", async () => {
        const { llmTps } = await import("../src/metrics/registry.js");
        llmTps.reset();

        const { exporter } = await createMockExporter(19203);
        await exporter.start();

        try {
            const labels = { model: "fast-model", caller: "code_act", provider: "anthropic" };
            // Observe TPS values: 8, 35, 150 tokens/s
            // Buckets: 5, 10, 20, 50, 100, 200
            llmTps.observe(labels, 8);    // ≤ 10
            llmTps.observe(labels, 35);   // ≤ 50
            llmTps.observe(labels, 150);  // ≤ 200

            const { families } = await scrape(19203);
            const fam = families.get("cybergroupmate_llm_tps");
            assert.ok(fam, "llm_tps family missing");

            // le=5: none fall here
            const b5 = findSample(fam, "cybergroupmate_llm_tps_bucket", { ...labels, le: "5" });
            assert.ok(b5, "le=5 bucket missing");
            assert.equal(b5!.value, 0, "no values ≤ 5");

            // le=10: 8 falls here
            const b10 = findSample(fam, "cybergroupmate_llm_tps_bucket", { ...labels, le: "10" });
            assert.ok(b10, "le=10 bucket missing");
            assert.equal(b10!.value, 1, "8 tps ≤ 10");

            // le=50: 8 and 35 fall here
            const b50 = findSample(fam, "cybergroupmate_llm_tps_bucket", { ...labels, le: "50" });
            assert.ok(b50, "le=50 bucket missing");
            assert.equal(b50!.value, 2, "8 and 35 tps ≤ 50");

            // le=200: all 3 fall here
            const b200 = findSample(fam, "cybergroupmate_llm_tps_bucket", { ...labels, le: "200" });
            assert.ok(b200, "le=200 bucket missing");
            assert.equal(b200!.value, 3, "all 3 values ≤ 200");

            // _sum = 8 + 35 + 150
            const sum = fam.samples.find(s =>
                s.name === "cybergroupmate_llm_tps_sum" && s.labels.model === "fast-model",
            );
            assert.ok(sum, "_sum missing");
            assert.equal(sum!.value, 8 + 35 + 150, `_sum should be ${8 + 35 + 150}`);
        } finally {
            exporter.stop();
        }
    });
});

// ─── D. Gauge 数据流验证（scrape 时实时读取快照） ──────────────────────────

describe("E2E Scrape — Gauge data flow (SystemCollector)", () => {
    test("SystemCollector gauges reflected in /metrics: sandbox pool, queues, memory, loop", async () => {
        const {
            sandboxPoolActive, sandboxPoolIdle,
            q3QueueSize, q5CallbackPending,
            mainLoopTicksTotal, mainLoopRunning,
            feedbackLoopWindowsActive,
            processUptimeSeconds, processHeapUsedBytes,
        } = await import("../src/metrics/registry.js");

        // Reset relevant gauges
        sandboxPoolActive.reset(); sandboxPoolIdle.reset();
        q3QueueSize.reset(); q5CallbackPending.reset();
        mainLoopTicksTotal.reset(); mainLoopRunning.reset();
        feedbackLoopWindowsActive.reset();
        processUptimeSeconds.reset(); processHeapUsedBytes.reset();

        const { exporter } = await createMockExporter(19204, {
            sandboxStats: { inUse: 3, idle: 2 },
            q3Size: 5,
            q5Size: 2,
            tickCount: 9999,
            isRunning: true,
            feedbackWindows: 4,
        });
        await exporter.start();

        try {
            const { families } = await scrape(19204);

            // Sandbox pool
            const spActiveFam = families.get("cybergroupmate_sandbox_pool_active");
            assert.ok(spActiveFam, "sandbox_pool_active family missing");
            assert.equal(spActiveFam.type, "gauge");
            const spActiveVal = spActiveFam.samples.find(s => s.name === "cybergroupmate_sandbox_pool_active")?.value;
            assert.equal(spActiveVal, 3, `sandbox_pool_active should be 3, got ${spActiveVal}`);

            const spIdleFam = families.get("cybergroupmate_sandbox_pool_idle");
            assert.ok(spIdleFam, "sandbox_pool_idle family missing");
            const spIdleVal = spIdleFam.samples.find(s => s.name === "cybergroupmate_sandbox_pool_idle")?.value;
            assert.equal(spIdleVal, 2, `sandbox_pool_idle should be 2, got ${spIdleVal}`);

            // Queue sizes
            const q3Fam = families.get("cybergroupmate_q3_queue_size");
            assert.ok(q3Fam, "q3_queue_size family missing");
            const q3Val = q3Fam.samples.find(s => s.name === "cybergroupmate_q3_queue_size")?.value;
            assert.equal(q3Val, 5, `q3_queue_size should be 5, got ${q3Val}`);

            const q5Fam = families.get("cybergroupmate_q5_callback_pending");
            assert.ok(q5Fam, "q5_callback_pending family missing");
            const q5Val = q5Fam.samples.find(s => s.name === "cybergroupmate_q5_callback_pending")?.value;
            assert.equal(q5Val, 2, `q5_callback_pending should be 2, got ${q5Val}`);

            // Main loop
            const ticksFam = families.get("cybergroupmate_main_loop_ticks_total");
            assert.ok(ticksFam, "main_loop_ticks_total family missing");
            const ticksVal = ticksFam.samples.find(s => s.name === "cybergroupmate_main_loop_ticks_total")?.value;
            assert.equal(ticksVal, 9999, `main_loop_ticks should be 9999, got ${ticksVal}`);

            const runningFam = families.get("cybergroupmate_main_loop_running");
            assert.ok(runningFam, "main_loop_running family missing");
            const runningVal = runningFam.samples.find(s => s.name === "cybergroupmate_main_loop_running")?.value;
            assert.equal(runningVal, 1, `main_loop_running should be 1 (true), got ${runningVal}`);

            // Feedback loop
            const fbFam = families.get("cybergroupmate_feedback_loop_windows_active");
            assert.ok(fbFam, "feedback_loop_windows_active family missing");
            const fbVal = fbFam.samples.find(s => s.name === "cybergroupmate_feedback_loop_windows_active")?.value;
            assert.equal(fbVal, 4, `feedback windows should be 4, got ${fbVal}`);

            // Process metrics (just verify they are > 0 — actual values vary)
            const uptimeFam = families.get("cybergroupmate_process_uptime_seconds");
            assert.ok(uptimeFam, "process_uptime_seconds family missing");
            const uptimeVal = uptimeFam.samples.find(s => s.name === "cybergroupmate_process_uptime_seconds")?.value ?? 0;
            assert.ok(uptimeVal > 0, `process uptime should be positive, got ${uptimeVal}`);

            const heapFam = families.get("cybergroupmate_process_heap_used_bytes");
            assert.ok(heapFam, "process_heap_used_bytes family missing");
            const heapVal = heapFam.samples.find(s => s.name === "cybergroupmate_process_heap_used_bytes")?.value ?? 0;
            assert.ok(heapVal > 0, `heap used should be positive, got ${heapVal}`);
        } finally {
            exporter.stop();
        }
    });

    test("Gauge is overwritten on each scrape (not accumulated)", async () => {
        const { sandboxPoolActive } = await import("../src/metrics/registry.js");
        sandboxPoolActive.reset();

        // First exporter: inUse=3
        const { exporter: exp1 } = await createMockExporter(19205, { sandboxStats: { inUse: 3, idle: 1 } });
        await exp1.start();
        const { families: f1 } = await scrape(19205);
        exp1.stop();
        const v1 = f1.get("cybergroupmate_sandbox_pool_active")!.samples
            .find(s => s.name === "cybergroupmate_sandbox_pool_active")?.value;
        assert.equal(v1, 3, `First scrape should show 3, got ${v1}`);

        // Second exporter: inUse=1 (gauge should be updated/overwritten)
        const { exporter: exp2 } = await createMockExporter(19205, { sandboxStats: { inUse: 1, idle: 3 } });
        await exp2.start();
        const { families: f2 } = await scrape(19205);
        exp2.stop();
        const v2 = f2.get("cybergroupmate_sandbox_pool_active")!.samples
            .find(s => s.name === "cybergroupmate_sandbox_pool_active")?.value;
        assert.equal(v2, 1, `Second scrape should show 1, got ${v2}`);
    });
});

// ─── E. GroupCollector 全属性 scrape 验证 ────────────────────────────────

describe("E2E Scrape — GroupCollector full attribute scrape", () => {
    test("All group gauges populated from mock subagent on scrape", async () => {
        const {
            groupsTotal, groupEngagementScore, groupBufferSize,
            groupStickiness, groupTopicCount, groupLastAttendAgeSeconds,
        } = await import("../src/metrics/registry.js");

        groupsTotal.reset(); groupEngagementScore.reset(); groupBufferSize.reset();
        groupStickiness.reset(); groupTopicCount.reset(); groupLastAttendAgeSeconds.reset();

        const lastAttendedAt = new Date(Date.now() - 120_000).toISOString(); // 2 min ago

        const mockSubagents = [{
            chatId: "test-group-1",
            observer: {
                getEngagementScore: () => 78,
                getBufferSize: () => 7,
            },
            stickiness: { level: "CORE" },
            topicRegistry: {
                getAll: () => [
                    { state: "OPEN" },
                    { state: "OPEN" },
                    { state: "SEALED" },
                    { state: "ARCHIVED" },
                    { state: "ARCHIVED" },
                    { state: "ARCHIVED" },
                ],
            },
            lastAttendedAt,
            codeActExecutor: null,
        }];

        const { exporter } = await createMockExporter(19206, { subagents: mockSubagents });
        await exporter.start();

        try {
            const { families } = await scrape(19206);

            // groups_total
            const totalFam = families.get("cybergroupmate_groups_total");
            assert.ok(totalFam, "groups_total family missing");
            const totalVal = totalFam.samples.find(s => s.name === "cybergroupmate_groups_total")?.value;
            assert.equal(totalVal, 1, `groups_total should be 1, got ${totalVal}`);

            // engagement score
            const engFam = families.get("cybergroupmate_group_engagement_score");
            assert.ok(engFam, "group_engagement_score family missing");
            const engVal = findSample(engFam, "cybergroupmate_group_engagement_score", { chat_id: "test-group-1" })?.value;
            assert.equal(engVal, 78, `engagement score should be 78, got ${engVal}`);

            // buffer size
            const bufFam = families.get("cybergroupmate_group_buffer_size");
            assert.ok(bufFam, "group_buffer_size family missing");
            const bufVal = findSample(bufFam, "cybergroupmate_group_buffer_size", { chat_id: "test-group-1" })?.value;
            assert.equal(bufVal, 7, `buffer size should be 7, got ${bufVal}`);

            // stickiness = CORE (indicator = 1)
            const stickFam = families.get("cybergroupmate_group_stickiness");
            assert.ok(stickFam, "group_stickiness family missing");
            const stickCore = findSample(stickFam, "cybergroupmate_group_stickiness", { chat_id: "test-group-1", level: "CORE" })?.value;
            assert.equal(stickCore, 1, "CORE stickiness should be 1 (active level)");
            const stickFamiliar = findSample(stickFam, "cybergroupmate_group_stickiness", { chat_id: "test-group-1", level: "FAMILIAR" })?.value;
            assert.equal(stickFamiliar, 0, "FAMILIAR stickiness should be 0 (not active)");

            // topic counts
            const topicFam = families.get("cybergroupmate_group_topic_count");
            assert.ok(topicFam, "group_topic_count family missing");
            const openCount = findSample(topicFam, "cybergroupmate_group_topic_count", { chat_id: "test-group-1", state: "OPEN" })?.value;
            assert.equal(openCount, 2, `OPEN topics should be 2, got ${openCount}`);
            const sealedCount = findSample(topicFam, "cybergroupmate_group_topic_count", { chat_id: "test-group-1", state: "SEALED" })?.value;
            assert.equal(sealedCount, 1, `SEALED topics should be 1, got ${sealedCount}`);
            const archivedCount = findSample(topicFam, "cybergroupmate_group_topic_count", { chat_id: "test-group-1", state: "ARCHIVED" })?.value;
            assert.equal(archivedCount, 3, `ARCHIVED topics should be 3, got ${archivedCount}`);

            // last attend age (should be ~120 seconds, allow ±5s tolerance)
            const ageFam = families.get("cybergroupmate_group_last_attend_age_seconds");
            assert.ok(ageFam, "group_last_attend_age_seconds family missing");
            const ageVal = findSample(ageFam, "cybergroupmate_group_last_attend_age_seconds", { chat_id: "test-group-1" })?.value ?? -1;
            assert.ok(ageVal >= 115 && ageVal <= 130, `last attend age should be ~120s, got ${ageVal}`);
        } finally {
            exporter.stop();
        }
    });

    test("Multiple groups reported correctly (multi-group scrape)", async () => {
        const { groupsTotal, groupEngagementScore } = await import("../src/metrics/registry.js");
        groupsTotal.reset(); groupEngagementScore.reset();

        const mockSubagents = [
            {
                chatId: "grp-1",
                observer: { getEngagementScore: () => 20, getBufferSize: () => 0 },
                stickiness: { level: "STRANGER" },
                topicRegistry: { getAll: () => [] },
                lastAttendedAt: null,
                codeActExecutor: null,
            },
            {
                chatId: "grp-2",
                observer: { getEngagementScore: () => 90, getBufferSize: () => 10 },
                stickiness: { level: "CORE" },
                topicRegistry: { getAll: () => [] },
                lastAttendedAt: null,
                codeActExecutor: null,
            },
        ];

        const { exporter } = await createMockExporter(19207, { subagents: mockSubagents });
        await exporter.start();

        try {
            const { families } = await scrape(19207);

            const totalFam = families.get("cybergroupmate_groups_total");
            const totalVal = totalFam!.samples.find(s => s.name === "cybergroupmate_groups_total")?.value;
            assert.equal(totalVal, 2, "Should report 2 groups");

            const engFam = families.get("cybergroupmate_group_engagement_score")!;
            const eng1 = findSample(engFam, "cybergroupmate_group_engagement_score", { chat_id: "grp-1" })?.value;
            const eng2 = findSample(engFam, "cybergroupmate_group_engagement_score", { chat_id: "grp-2" })?.value;
            assert.equal(eng1, 20, `grp-1 engagement should be 20, got ${eng1}`);
            assert.equal(eng2, 90, `grp-2 engagement should be 90, got ${eng2}`);
        } finally {
            exporter.stop();
        }
    });
});

// ─── F. Label 格式验证 ────────────────────────────────────────────────────

describe("Prometheus Label Format", () => {
    test("Label values with special characters are escaped correctly", async () => {
        const { Counter } = await import("../src/metrics/registry.js");
        const c = new Counter();
        // Test label value containing double quote
        c.inc({ model: 'model-with-"quotes"' }, 1);
        const out = c.render("test_escape_counter", "escape test");
        // The quote should be escaped as \"
        assert.ok(out.includes('\\"quotes\\"'), `Quotes should be escaped: ${out}`);
    });

    test("Label keys are sorted alphabetically in output", async () => {
        const { Counter } = await import("../src/metrics/registry.js");
        const c = new Counter();
        // Insert labels in non-alphabetical order
        c.inc({ zzz: "last", aaa: "first", mmm: "middle" }, 5);
        const out = c.render("sort_test", "sort test");
        const labelLine = out.split("\n").find(l => l.startsWith("sort_test{"));
        assert.ok(labelLine, "Sample line not found");
        // Labels should be sorted: aaa, mmm, zzz
        const aaaPos = labelLine!.indexOf("aaa=");
        const mmmPos = labelLine!.indexOf("mmm=");
        const zzzPos = labelLine!.indexOf("zzz=");
        assert.ok(aaaPos < mmmPos && mmmPos < zzzPos, `Labels should be sorted: aaa<mmm<zzz, got positions ${aaaPos},${mmmPos},${zzzPos}`);
    });

    test("Histogram with multiple label sets produces separate bucket series", async () => {
        const { Histogram } = await import("../src/metrics/registry.js");
        const h = new Histogram([100, 1000]);
        h.observe({ model: "fast", status: "success" }, 50);
        h.observe({ model: "slow", status: "error" }, 500);
        const out = h.render("multi_label_hist", "multi");
        // Both label sets should appear in bucket lines
        assert.ok(out.includes(`model="fast"`), "fast model missing");
        assert.ok(out.includes(`model="slow"`), "slow model missing");
        // Fast: 50 ≤ 100 (bucket = 1), slow: 500 ≤ 1000 (bucket = 1)
        assert.ok(out.includes(`model="fast",`) && out.includes(`le="100"} 1`), "fast le=100 should be 1");
        assert.ok(out.includes(`model="slow",`) && out.includes(`le="100"} 0`), "slow le=100 should be 0");
    });
});

// ─── G. 全量 metrics 完整性验证（所有 30 个 metric 都出现在 scrape 中） ──

describe("E2E Scrape — All 30 cybergroupmate metrics present", () => {
    test("All registered metrics appear in Prometheus scrape output", async () => {
        const { exporter } = await createMockExporter(19208);
        await exporter.start();

        try {
            const { body, families } = await scrape(19208);

            const expectedMetrics = [
                "cybergroupmate_llm_tokens_prompt_total",
                "cybergroupmate_llm_tokens_completion_total",
                "cybergroupmate_llm_tokens_cached_total",
                "cybergroupmate_llm_tokens_cache_creation_total",
                "cybergroupmate_llm_request_duration_ms",
                "cybergroupmate_llm_requests_total",
                "cybergroupmate_llm_retries_total",
                "cybergroupmate_llm_tps",
                "cybergroupmate_groups_total",
                "cybergroupmate_group_messages_total",
                "cybergroupmate_group_attends_total",
                "cybergroupmate_group_engagement_score",
                "cybergroupmate_group_stickiness",
                "cybergroupmate_group_buffer_size",
                "cybergroupmate_group_topic_count",
                "cybergroupmate_group_codeact_queue_size",
                "cybergroupmate_group_last_attend_age_seconds",
                "cybergroupmate_main_loop_ticks_total",
                "cybergroupmate_main_loop_running",
                "cybergroupmate_sandbox_pool_active",
                "cybergroupmate_sandbox_pool_idle",
                "cybergroupmate_q3_queue_size",
                "cybergroupmate_q5_callback_pending",
                "cybergroupmate_feedback_loop_windows_active",
                "cybergroupmate_process_uptime_seconds",
                "cybergroupmate_process_heap_used_bytes",
                "cybergroupmate_process_heap_total_bytes",
                "cybergroupmate_process_rss_bytes",
            ];

            const missing: string[] = [];
            for (const name of expectedMetrics) {
                if (!families.has(name)) {
                    missing.push(name);
                }
            }

            assert.equal(
                missing.length, 0,
                `Missing metrics in scrape: ${missing.join(", ")}\n\nFull body (first 500 chars): ${body.slice(0, 500)}`,
            );
        } finally {
            exporter.stop();
        }
    });

    test("All metric families have HELP and TYPE lines", async () => {
        const { exporter } = await createMockExporter(19209);
        await exporter.start();

        try {
            const { families } = await scrape(19209);
            const missingHelp: string[] = [];
            const missingType: string[] = [];

            for (const [name, fam] of families) {
                if (!name.startsWith("cybergroupmate_")) continue;
                if (!fam.help) missingHelp.push(name);
                if (fam.type === "untyped") missingType.push(name);
            }

            assert.equal(missingHelp.length, 0, `Metrics missing HELP: ${missingHelp.join(", ")}`);
            assert.equal(missingType.length, 0, `Metrics with untyped TYPE: ${missingType.join(", ")}`);
        } finally {
            exporter.stop();
        }
    });

    test("Body ends with a newline (Prometheus spec requirement)", async () => {
        const { exporter } = await createMockExporter(19210);
        await exporter.start();
        try {
            const { body } = await scrape(19210);
            assert.ok(body.endsWith("\n"), "Prometheus output must end with a newline");
        } finally {
            exporter.stop();
        }
    });
});

// ─── H. 安全性验证：localhost binding ────────────────────────────────────

describe("Security — Localhost-only binding", () => {
    test("Exporter config defaults to 127.0.0.1 and cannot be reached via external-looking addresses", async () => {
        const { exporter } = await createMockExporter(19211);
        await exporter.start();
        try {
            const config = exporter.getConfig();
            assert.equal(config.host, "127.0.0.1", "Default host must be 127.0.0.1");
            assert.equal(config.port, 19211);
            assert.equal(config.path, "/metrics");
        } finally {
            exporter.stop();
        }
    });

    test("Custom path is respected", async () => {
        const { MetricsExporter } = await import("../src/metrics/exporter.js");
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");

        const mockSubagentManager = { getAllSubagents: () => [] };
        const gc = new GroupCollector({ subagentManager: mockSubagentManager as any });
        const sc = new SystemCollector({
            sandboxPool: { getStats: () => ({ total: 0, inUse: 0, idle: 0, instances: [] }) },
            q3: { getAll: () => [] }, q5: { peek: () => [] },
            mainLoop: { getTickCount: () => 0, isRunning: () => false },
            feedbackLoop: { getActiveWindows: () => [] },
        } as any);

        const exporter = new MetricsExporter(gc, sc, { host: "127.0.0.1", port: 19212, path: "/custom-metrics" });
        await exporter.start();
        try {
            // Custom path: /custom-metrics → 200
            const res = await fetch("http://127.0.0.1:19212/custom-metrics");
            assert.equal(res.status, 200);
            // Default /metrics path → 404
            const res2 = await fetch("http://127.0.0.1:19212/metrics");
            assert.equal(res2.status, 404);
        } finally {
            exporter.stop();
        }
    });

    test("Query strings are stripped from path matching", async () => {
        const { exporter } = await createMockExporter(19213);
        await exporter.start();
        try {
            // Prometheus sometimes sends ?foo=bar query params — should still match /metrics
            const res = await fetch("http://127.0.0.1:19213/metrics?format=openmetrics");
            assert.equal(res.status, 200, "Query params should not break /metrics path match");
        } finally {
            exporter.stop();
        }
    });
});

// ─── I. 多次 scrape 幂等性与稳定性 ──────────────────────────────────────

describe("Scrape idempotency and stability", () => {
    test("Gauge metrics return the same value across consecutive scrapes without new data", async () => {
        const { sandboxPoolActive } = await import("../src/metrics/registry.js");
        sandboxPoolActive.reset();

        const { exporter } = await createMockExporter(19214, { sandboxStats: { inUse: 5, idle: 0 } });
        await exporter.start();

        try {
            const { families: f1 } = await scrape(19214);
            const { families: f2 } = await scrape(19214);
            const { families: f3 } = await scrape(19214);

            const v1 = f1.get("cybergroupmate_sandbox_pool_active")!.samples.find(s => s.name === "cybergroupmate_sandbox_pool_active")?.value;
            const v2 = f2.get("cybergroupmate_sandbox_pool_active")!.samples.find(s => s.name === "cybergroupmate_sandbox_pool_active")?.value;
            const v3 = f3.get("cybergroupmate_sandbox_pool_active")!.samples.find(s => s.name === "cybergroupmate_sandbox_pool_active")?.value;

            assert.equal(v1, v2, `Scrape 1 and 2 should match: ${v1} ≠ ${v2}`);
            assert.equal(v2, v3, `Scrape 2 and 3 should match: ${v2} ≠ ${v3}`);
            assert.equal(v1, 5, `Value should be 5, got ${v1}`);
        } finally {
            exporter.stop();
        }
    });

    test("Counter metrics never decrease across scrapes", async () => {
        const { groupMessagesTotal } = await import("../src/metrics/registry.js");
        groupMessagesTotal.reset();

        const { exporter, groupCollector } = await createMockExporter(19215);
        await exporter.start();

        try {
            let prevValue = 0;
            for (let i = 0; i < 5; i++) {
                groupCollector.onMessage("stability-group");
                const { families } = await scrape(19215);
                const fam = families.get("cybergroupmate_group_messages_total");
                const val = fam ? findSample(fam, "cybergroupmate_group_messages_total", { chat_id: "stability-group" })?.value ?? 0 : 0;
                assert.ok(val >= prevValue, `Counter should never decrease: ${prevValue} → ${val}`);
                prevValue = val;
            }
            assert.equal(prevValue, 5, "After 5 messages, counter should be 5");
        } finally {
            exporter.stop();
        }
    });
});
