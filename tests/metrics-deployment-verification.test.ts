/**
 * metrics-deployment-verification.test.ts — Deployment Verification Tests
 *
 * Validates that:
 * 1. The /metrics endpoint produces valid, scrapable Prometheus exposition format
 * 2. No configuration issues prevent deployment
 * 3. The attend and FastPath hooks are properly wired
 * 4. GroupCollector is resilient to broken subagents
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// ─── Prometheus text format parser (mimics Prometheus scraper) ───

interface PrometheusMetric {
    name: string;
    type?: string;
    help?: string;
    samples: Array<{
        name: string;
        labels: Record<string, string>;
        value: number;
    }>;
}

function parsePrometheusText(text: string): Map<string, PrometheusMetric> {
    const metrics = new Map<string, PrometheusMetric>();
    let currentMetric: PrometheusMetric | null = null;

    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("# HELP ")) {
            const rest = trimmed.slice(7);
            const spaceIdx = rest.indexOf(" ");
            const name = rest.slice(0, spaceIdx);
            const help = rest.slice(spaceIdx + 1);
            if (!metrics.has(name)) {
                metrics.set(name, { name, help, samples: [] });
            } else {
                metrics.get(name)!.help = help;
            }
            currentMetric = metrics.get(name)!;
        } else if (trimmed.startsWith("# TYPE ")) {
            const rest = trimmed.slice(7);
            const spaceIdx = rest.indexOf(" ");
            const name = rest.slice(0, spaceIdx);
            const type = rest.slice(spaceIdx + 1);
            if (!metrics.has(name)) {
                metrics.set(name, { name, type, samples: [] });
            } else {
                metrics.get(name)!.type = type;
            }
            currentMetric = metrics.get(name)!;
        } else if (!trimmed.startsWith("#")) {
            // Sample line: metric_name{label="value"} 123.45
            const match = trimmed.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{?(.*?)\}?\s+([\d.eE+\-NaInf]+)$/);
            if (match) {
                const sampleName = match[1];
                const labelsStr = match[2];
                const value = match[3] === "+Inf" ? Infinity :
                              match[3] === "-Inf" ? -Infinity :
                              match[3] === "NaN" ? NaN :
                              parseFloat(match[3]);

                const labels: Record<string, string> = {};
                if (labelsStr) {
                    const labelRegex = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
                    let m;
                    while ((m = labelRegex.exec(labelsStr)) !== null) {
                        labels[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
                    }
                }

                // Find parent metric
                const baseName = sampleName
                    .replace(/_bucket$/, "")
                    .replace(/_sum$/, "")
                    .replace(/_count$/, "")
                    .replace(/_total$/, "");

                const parentName = metrics.has(sampleName) ? sampleName :
                                   metrics.has(baseName) ? baseName :
                                   currentMetric?.name ?? sampleName;

                if (!metrics.has(parentName)) {
                    metrics.set(parentName, { name: parentName, samples: [] });
                }
                metrics.get(parentName)!.samples.push({ name: sampleName, labels, value });
            }
        }
    }
    return metrics;
}

// ─── HTTP helper ───

function httpGet(url: string): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => {
                resolve({
                    status: res.statusCode!,
                    headers: res.headers as Record<string, string>,
                    body,
                });
            });
        }).on("error", reject);
    });
}

// ─── Tests ───

describe("Metrics Deployment Verification", () => {

    // ═══ 1. Mock Prometheus Scrape E2E ═══

    describe("Mock Prometheus Scrape", () => {
        let exporter: any;
        let registry: any;
        const TEST_PORT = 19199;

        after(async () => {
            if (exporter) await exporter.stop();
        });

        it("#1 /metrics endpoint returns valid Prometheus Content-Type", async () => {
            // Import and start a fresh exporter
            const { MetricsExporter } = await import("../src/metrics/exporter.js");
            const registryMod = await import("../src/metrics/registry.js");
            registry = registryMod.registry;

            const mockGroupCollector = { collect() {} } as any;
            const mockSystemCollector = { collect() {} } as any;

            exporter = new MetricsExporter(
                mockGroupCollector,
                mockSystemCollector,
                { host: "127.0.0.1", port: TEST_PORT, path: "/metrics" },
            );
            await exporter.start();

            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
            assert.equal(res.status, 200);
            assert.ok(
                res.headers["content-type"]?.includes("text/plain"),
                `Content-Type should be text/plain, got: ${res.headers["content-type"]}`,
            );
            assert.ok(
                res.headers["content-type"]?.includes("version=0.0.4"),
                "Content-Type should include version=0.0.4",
            );
        });

        it("#2 /metrics body is parseable by Prometheus text parser", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
            const metrics = parsePrometheusText(res.body);
            assert.ok(metrics.size > 0, "should have at least one metric family");
        });

        it("#3 every metric has # HELP and # TYPE declarations", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
            const lines = res.body.split("\n");

            const helpNames = new Set<string>();
            const typeNames = new Set<string>();

            for (const line of lines) {
                if (line.startsWith("# HELP ")) {
                    const name = line.slice(7).split(" ")[0];
                    helpNames.add(name);
                }
                if (line.startsWith("# TYPE ")) {
                    const name = line.slice(7).split(" ")[0];
                    typeNames.add(name);
                }
            }

            // Every TYPE should have a matching HELP
            for (const name of typeNames) {
                assert.ok(helpNames.has(name), `Metric ${name} has TYPE but missing HELP`);
            }
        });

        it("#4 metric types are valid Prometheus types", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
            const validTypes = new Set(["counter", "gauge", "histogram", "summary", "untyped"]);

            for (const line of res.body.split("\n")) {
                if (line.startsWith("# TYPE ")) {
                    const parts = line.slice(7).split(" ");
                    const type = parts[parts.length - 1];
                    assert.ok(validTypes.has(type), `Invalid metric type: ${type} in line: ${line}`);
                }
            }
        });

        it("#5 all cybergroupmate_ prefixed metrics are present", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
            const metrics = parsePrometheusText(res.body);

            const expectedPrefixes = [
                "cybergroupmate_llm_tokens_prompt_total",
                "cybergroupmate_llm_tokens_completion_total",
                "cybergroupmate_llm_request_duration_ms",
                "cybergroupmate_llm_requests_total",
                "cybergroupmate_process_uptime_seconds",
                "cybergroupmate_process_heap_used_bytes",
            ];

            for (const prefix of expectedPrefixes) {
                const found = [...metrics.keys()].some(k => k.startsWith(prefix) || k === prefix);
                assert.ok(found, `Expected metric ${prefix} not found in scrape output`);
            }
        });

        it("#6 /metrics handles query strings (Prometheus appends ?timestamp)", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics?timestamp=1234567890`);
            assert.equal(res.status, 200, "should still return 200 with query string");
        });

        it("#7 /healthz returns 200 OK", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/healthz`);
            assert.equal(res.status, 200);
            assert.ok(res.body.includes("OK"));
        });

        it("#8 unknown paths return 404", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/unknown`);
            assert.equal(res.status, 404);
        });

        it("#9 histogram metrics have _bucket, _sum, _count suffixes", async () => {
            // Inject a histogram observation to ensure it renders
            const registryMod = await import("../src/metrics/registry.js");
            const { llmRequestDurationMs } = registryMod;
            llmRequestDurationMs.observe({ model: "test", caller: "test", provider: "test" }, 500);

            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
            const body = res.body;

            assert.ok(body.includes("_bucket{"), "should have _bucket lines");
            assert.ok(body.includes("_sum"), "should have _sum lines");
            assert.ok(body.includes("_count"), "should have _count lines");
            assert.ok(body.includes('le="+Inf"'), "should have +Inf bucket");
        });

        it("#10 counter values are non-negative numbers", async () => {
            const res = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);

            for (const line of res.body.split("\n")) {
                if (line.startsWith("#") || !line.trim()) continue;
                const match = line.match(/\s+([\d.eE+\-NaInf]+)$/);
                if (match) {
                    const val = parseFloat(match[1]);
                    if (!isNaN(val)) {
                        assert.ok(val >= 0, `Metric value should be non-negative: ${line}`);
                    }
                }
            }
        });

        it("#11 consecutive scrapes produce stable output", async () => {
            const res1 = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);
            const res2 = await httpGet(`http://127.0.0.1:${TEST_PORT}/metrics`);

            const metrics1 = parsePrometheusText(res1.body);
            const metrics2 = parsePrometheusText(res2.body);

            // Same metric families
            assert.equal(metrics1.size, metrics2.size, "metric family count should be stable");
        });
    });

    // ═══ 2. Configuration Verification ═══

    describe("Configuration", () => {
        it("#12 config.yaml has metrics section", () => {
            const configContent = readFileSync(join(projectRoot, "config.yaml"), "utf-8");
            assert.ok(configContent.includes("metrics:"), "config.yaml should have metrics section");
            assert.ok(configContent.includes("enabled: true"), "metrics should be enabled");
        });

        it("#13 MetricsConfig type matches config.yaml fields", async () => {
            const configMod = await import("../src/core/config.js");
            const config = configMod.loadConfig();
            // metrics should be parsed (may be undefined if not in yaml, but enabled by default)
            const metricsEnabled = config.metrics?.enabled !== false;
            assert.ok(metricsEnabled, "metrics should default to enabled");
        });

        it("#14 metrics port (9091) does not conflict with dashboard port (6767)", async () => {
            const configMod = await import("../src/core/config.js");
            const config = configMod.loadConfig();
            const dashboardPort = config.dashboard?.port ?? 6767;
            const metricsPort = config.metrics?.port ?? 9091;
            assert.notEqual(dashboardPort, metricsPort,
                `dashboard port (${dashboardPort}) must not equal metrics port (${metricsPort})`);
        });
    });

    // ═══ 3. Hook Wiring Verification ═══

    describe("Hook Wiring", () => {
        it("#15 MainAgentLoop has setOnAttendComplete method", async () => {
            const { MainAgentLoop } = await import("../src/main-agent/main-agent-loop.js");
            assert.equal(typeof MainAgentLoop.prototype.setOnAttendComplete, "function",
                "MainAgentLoop should have setOnAttendComplete method");
        });

        it("#16 main.ts uses setOnAttendComplete instead of broken .on('attend')", () => {
            const mainSource = readFileSync(join(projectRoot, "src/main.ts"), "utf-8");

            // Should NOT have the broken pattern
            assert.ok(
                !mainSource.includes('(mainLoop as any).on?.("attend"'),
                "main.ts should not use broken (mainLoop as any).on pattern",
            );

            // Should have the correct pattern
            assert.ok(
                mainSource.includes("setOnAttendComplete"),
                "main.ts should use setOnAttendComplete callback",
            );
        });

        it("#17 main.ts FastPath hook uses scene field instead of viaFastPath", () => {
            const mainSource = readFileSync(join(projectRoot, "src/main.ts"), "utf-8");

            // Should NOT check viaFastPath
            assert.ok(
                !mainSource.includes("viaFastPath"),
                "main.ts should not check viaFastPath (never set)",
            );

            // Should check scene === "fastpath"
            assert.ok(
                mainSource.includes('scene === "fastpath"'),
                "main.ts should check scene === 'fastpath'",
            );
        });

        it("#18 dispatch-handler sets scene: 'fastpath' on NC events", () => {
            const dispatchSource = readFileSync(
                join(projectRoot, "src/main-agent/dispatch-handler.ts"), "utf-8"
            );
            assert.ok(
                dispatchSource.includes('scene: "fastpath"'),
                "dispatch-handler should set scene: 'fastpath' on FastPath NC events",
            );
        });
    });

    // ═══ 4. GroupCollector Resilience ═══

    describe("GroupCollector Resilience", () => {
        it("#19 collect() survives a broken subagent", async () => {
            const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");

            const brokenSubagent = {
                chatId: "tg:broken",
                observer: null, // will throw when accessing getEngagementScore()
                stickiness: { level: "STRANGER" },
                topicRegistry: { getAll: () => [] },
                codeActExecutor: null,
                lastAttendedAt: null,
            };

            const healthySubagent = {
                chatId: "tg:healthy",
                observer: { getEngagementScore: () => 42, getBufferSize: () => 5 },
                stickiness: { level: "FAMILIAR" },
                topicRegistry: { getAll: () => [] },
                codeActExecutor: null,
                lastAttendedAt: "2026-04-03T10:00:00Z",
            };

            const mockManager = {
                getAllSubagents: () => [brokenSubagent, healthySubagent],
            };

            const collector = new GroupCollector({ subagentManager: mockManager as any });

            // Should NOT throw even with a broken subagent
            assert.doesNotThrow(() => collector.collect());
        });

        it("#20 onMessage/onAttend/onFastPathReply don't throw on invalid chatId", async () => {
            const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
            const collector = new GroupCollector({
                subagentManager: { getAllSubagents: () => [] } as any,
            });

            assert.doesNotThrow(() => collector.onMessage(""));
            assert.doesNotThrow(() => collector.onAttend("", "OBSERVE"));
            assert.doesNotThrow(() => collector.onFastPathReply(""));
        });
    });

    // ═══ 5. Prometheus Format Compliance ═══

    describe("Prometheus Format Compliance", () => {
        it("#21 metric names follow naming convention (lowercase, underscores)", async () => {
            const { MetricsExporter } = await import("../src/metrics/exporter.js");
            const port = 19200;
            const exp = new MetricsExporter(
                { collect() {} } as any,
                { collect() {} } as any,
                { host: "127.0.0.1", port, path: "/metrics" },
            );
            await exp.start();

            try {
                const res = await httpGet(`http://127.0.0.1:${port}/metrics`);
                for (const line of res.body.split("\n")) {
                    if (line.startsWith("#") || !line.trim()) continue;
                    const metricName = line.split(/[\s{]/)[0];
                    assert.match(metricName, /^[a-zA-Z_:][a-zA-Z0-9_:]*$/,
                        `Invalid metric name: ${metricName}`);
                }
            } finally {
                await exp.stop();
            }
        });

        it("#22 label values are properly escaped", async () => {
            const registryMod = await import("../src/metrics/registry.js");
            const { registry: reg, Counter: CounterClass } = registryMod;

            // Create a counter with labels containing special chars
            const testCounter = new CounterClass();
            testCounter.inc({ model: 'test"model', caller: "line\nbreak" });

            const rendered = testCounter.render("test_escape", "test escaping");
            assert.ok(rendered.includes('model="test\\"model"'), "double quotes should be escaped");
            assert.ok(rendered.includes('caller="line\\nbreak"'), "newlines should be escaped");
        });
    });
});
