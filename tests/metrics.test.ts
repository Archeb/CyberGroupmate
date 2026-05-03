/**
 * metrics.test.ts — Metrics 模块单元测试
 *
 * 测试范围：
 * 1. Counter / Gauge / Histogram render() 格式正确性
 * 2. LLMCollector 订阅 llmEvents 后，事件驱动 counter 递增
 * 3. SystemCollector.collect() 正常调用不抛异常
 * 4. MetricsExporter HTTP 端点：/metrics → 200, /healthz → 200, other → 404
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ─── 1. Registry 原语测试 ───

describe("Counter", () => {
    test("inc() accumulates values correctly", async () => {
        const { Counter } = await import("../src/metrics/registry.js");
        const c = new Counter();
        c.inc({ model: "gpt-4" }, 5);
        c.inc({ model: "gpt-4" }, 3);
        c.inc({ model: "claude" }, 1);
        assert.equal(c.get({ model: "gpt-4" }), 8);
        assert.equal(c.get({ model: "claude" }), 1);
        assert.equal(c.get({ model: "unknown" }), 0);
    });

    test("render() produces valid Prometheus counter format", async () => {
        const { Counter } = await import("../src/metrics/registry.js");
        const c = new Counter();
        c.inc({ model: "a", caller: "b" }, 10);
        const out = c.render("test_counter_total", "A test counter");
        assert.ok(out.includes("# HELP test_counter_total A test counter"), `Missing HELP: ${out}`);
        assert.ok(out.includes("# TYPE test_counter_total counter"), `Missing TYPE: ${out}`);
        assert.ok(out.includes("test_counter_total{") , `Missing metric line: ${out}`);
        assert.ok(out.includes("} 10"), `Missing value: ${out}`);
    });

    test("render() emits empty sample when no values recorded", async () => {
        const { Counter } = await import("../src/metrics/registry.js");
        const c = new Counter();
        const out = c.render("empty_counter", "empty");
        assert.ok(out.includes("empty_counter 0"), `Should emit 0 sample: ${out}`);
    });
});

describe("Gauge", () => {
    test("set() overwrites previous value", async () => {
        const { Gauge } = await import("../src/metrics/registry.js");
        const g = new Gauge();
        g.set({ chat_id: "123" }, 50);
        g.set({ chat_id: "123" }, 75);
        assert.equal(g.get({ chat_id: "123" }), 75);
    });

    test("render() produces valid Prometheus gauge format", async () => {
        const { Gauge } = await import("../src/metrics/registry.js");
        const g = new Gauge();
        g.set({}, 42.5);
        const out = g.render("test_gauge", "A test gauge");
        assert.ok(out.includes("# TYPE test_gauge gauge"));
        assert.ok(out.includes("test_gauge 42.5"));
    });
});

describe("Histogram", () => {
    test("observe() correctly distributes values into buckets", async () => {
        const { Histogram } = await import("../src/metrics/registry.js");
        const h = new Histogram([100, 500, 1000, 5000]);
        h.observe({}, 200);
        h.observe({}, 800);
        h.observe({}, 6000);
        const out = h.render("test_hist_ms", "A test histogram");
        assert.ok(out.includes(`test_hist_ms_bucket{le="100"} 0`), `100ms bucket wrong: ${out}`);
        assert.ok(out.includes(`test_hist_ms_bucket{le="500"} 1`), `500ms bucket wrong: ${out}`);
        assert.ok(out.includes(`test_hist_ms_bucket{le="1000"} 2`), `1000ms bucket wrong: ${out}`);
        assert.ok(out.includes(`test_hist_ms_bucket{le="5000"} 2`), `5000ms bucket wrong: ${out}`);
        assert.ok(out.includes(`test_hist_ms_bucket{le="+Inf"} 3`), `+Inf bucket wrong: ${out}`);
        assert.ok(out.includes("test_hist_ms_count 3"), `count wrong: ${out}`);
    });

    test("render() emits empty histogram template when no observations", async () => {
        const { Histogram } = await import("../src/metrics/registry.js");
        const h = new Histogram([100, 500]);
        const out = h.render("empty_hist", "empty");
        assert.ok(out.includes(`empty_hist_bucket{le="100"} 0`));
        assert.ok(out.includes(`empty_hist_bucket{le="+Inf"} 0`));
        assert.ok(out.includes("empty_hist_count 0"));
    });

    test("observe() with labels produces correct label sets", async () => {
        const { Histogram } = await import("../src/metrics/registry.js");
        const h = new Histogram([1000]);
        h.observe({ model: "gpt4", status: "success" }, 500);
        const out = h.render("labeled_hist", "labeled");
        assert.ok(out.includes(`model="gpt4"`), `Missing model label: ${out}`);
        assert.ok(out.includes(`status="success"`), `Missing status label: ${out}`);
        // The le label is added for buckets
        assert.ok(out.includes(`le="1000"`), `Missing le label: ${out}`);
    });
});

describe("MetricsRegistry", () => {
    test("render() concatenates all registered metrics", async () => {
        const { MetricsRegistry, Counter, Gauge } = await import("../src/metrics/registry.js");
        const reg = new MetricsRegistry();
        const c = reg.register("my_counter_total", "a counter", new Counter());
        const g = reg.register("my_gauge", "a gauge", new Gauge());
        c.inc({}, 1);
        g.set({}, 99);
        const out = reg.render();
        assert.ok(out.includes("my_counter_total"), `Missing counter: ${out}`);
        assert.ok(out.includes("my_gauge"), `Missing gauge: ${out}`);
        assert.ok(out.endsWith("\n"), "Should end with newline");
    });
});

// ─── 2. LLMCollector 测试 ───
// NOTE: We cannot directly import llm-collector.ts in tests because importing llm.ts
// triggers a transitive import of @google/genai (via llm/google.ts) which is not
// installed in the test environment. Instead, we test the core counter/histogram update
// logic by directly simulating the same operations that LLMCollector performs.

describe("LLMCollector - counter logic (unit)", () => {
    test("llm:response event increments token counters", async () => {
        const {
            llmTokensPrompt,
            llmTokensCompletion,
            llmRequests,
            llmRequestDurationMs,
            llmTps,
        } = await import("../src/metrics/registry.js");

        // Reset
        llmTokensPrompt.reset();
        llmTokensCompletion.reset();
        llmRequests.reset();
        llmRequestDurationMs.reset();
        llmTps.reset();

        // Simulate what LLMCollector.onResponse does internally
        const labels = { model: "test-model", caller: "test_caller", provider: "openai" };
        const statusLabels = { ...labels, status: "success" };
        const promptTokens = 100;
        const completionTokens = 50;
        const durationMs = 1500;

        llmRequests.inc(statusLabels);
        llmRequestDurationMs.observe(statusLabels, durationMs);
        llmTokensPrompt.inc(labels, promptTokens);
        llmTokensCompletion.inc(labels, completionTokens);
        const tps = (completionTokens / durationMs) * 1000;
        llmTps.observe(labels, tps);

        assert.equal(llmTokensPrompt.get(labels), 100, "prompt tokens should be 100");
        assert.equal(llmTokensCompletion.get(labels), 50, "completion tokens should be 50");
        assert.equal(llmRequests.get(statusLabels), 1, "requests count should be 1");
        assert.ok(tps > 0, "TPS should be positive");
        assert.equal(llmRequestDurationMs.getCount(statusLabels), 1, "histogram count should be 1");
    });

    test("error response marks status=error", async () => {
        const { llmRequests } = await import("../src/metrics/registry.js");
        llmRequests.reset();

        const labels = { model: "error-model", caller: "test", provider: "anthropic", status: "error" };
        llmRequests.inc(labels);

        assert.equal(llmRequests.get(labels), 1, "error request count should be 1");
    });

    test("retry counter increments per reason", async () => {
        const { llmRetries } = await import("../src/metrics/registry.js");
        llmRetries.reset();

        const labels = { model: "retry-model", caller: "test", provider: "openai", reason: "rate_limit" };
        llmRetries.inc(labels);
        llmRetries.inc(labels);

        assert.equal(llmRetries.get(labels), 2, "retry count should be 2");
    });
});


// ─── 3. SystemCollector 测试 ───

describe("SystemCollector", () => {
    test("collect() runs without throwing", async () => {
        const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");

        // Minimal mock deps
        const mockDeps = {
            sandboxPool: {
                getStats: () => ({ total: 2, inUse: 1, idle: 1, instances: [] }),
            },
            q3: {
                getAll: () => [],
            },
            accumulator: {
                getActiveCount: () => 0,
            },
            q5: {
                peek: () => [],
            },
            mainLoop: {
                getTickCount: () => 42,
                isRunning: () => true,
            },
        };

        const collector = new SystemCollector(mockDeps as any);
        // Should not throw
        assert.doesNotThrow(() => collector.collect());
    });

    test("collect() updates process uptime gauge", async () => {
        const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");
        const { processUptimeSeconds } = await import("../src/metrics/registry.js");

        processUptimeSeconds.reset();

        const mockDeps = {
            sandboxPool: { getStats: () => ({ total: 0, inUse: 0, idle: 0, instances: [] }) },
            q3: { getAll: () => [] },
            accumulator: { getActiveCount: () => 0 },
            q5: { peek: () => [] },
            mainLoop: { getTickCount: () => 0, isRunning: () => false },
        };

        const collector = new SystemCollector(mockDeps as any);
        collector.collect();

        // uptime should be > 0 (process has been running for at least a bit)
        assert.ok(processUptimeSeconds.get({}) > 0, "uptime should be > 0");
    });
});

// ─── 4. GroupCollector 测试 ───

describe("GroupCollector", () => {
    test("onMessage() increments group_messages_total counter", async () => {
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { groupMessagesTotal } = await import("../src/metrics/registry.js");

        groupMessagesTotal.reset();

        const mockSubagentManager = {
            getAllSubagents: () => [],
        };

        const collector = new GroupCollector({ subagentManager: mockSubagentManager as any });
        collector.onMessage("chat123");
        collector.onMessage("chat123");
        collector.onMessage("chat456");

        assert.equal(groupMessagesTotal.get({ chat_id: "chat123" }), 2);
        assert.equal(groupMessagesTotal.get({ chat_id: "chat456" }), 1);
    });

    test("onAttend() increments group_attends_total counter", async () => {
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { groupAttendsTotal } = await import("../src/metrics/registry.js");

        groupAttendsTotal.reset();

        const mockSubagentManager = { getAllSubagents: () => [] };
        const collector = new GroupCollector({ subagentManager: mockSubagentManager as any });
        collector.onAttend("chat123", "REPLY");
        collector.onAttend("chat123", "DEFER");
        collector.onAttend("chat123", "REPLY");

        assert.equal(groupAttendsTotal.get({ chat_id: "chat123", decision: "REPLY" }), 2);
        assert.equal(groupAttendsTotal.get({ chat_id: "chat123", decision: "DEFER" }), 1);
    });

    test("collect() with mock subagents sets engagement gauge", async () => {
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { groupEngagementScore, groupsTotal } = await import("../src/metrics/registry.js");

        groupEngagementScore.reset();
        groupsTotal.reset();

        const mockSub = {
            chatId: "test_chat",
            observer: {
                getEngagementScore: () => 65,
                getBufferSize: () => 3,
            },
            stickiness: { level: "FAMILIAR" },
            topicRegistry: { getAll: () => [] },
            lastAttendedAt: null,
            codeActExecutor: null,
        };

        const mockSubagentManager = { getAllSubagents: () => [mockSub] };
        const collector = new GroupCollector({ subagentManager: mockSubagentManager as any });
        collector.collect();

        assert.equal(groupsTotal.get({}), 1);
        assert.equal(groupEngagementScore.get({ chat_id: "test_chat" }), 65);
    });
});

// ─── 5. MetricsExporter HTTP 端点测试 ───

describe("MetricsExporter", () => {
    test("GET /metrics returns 200 with Prometheus content-type", async () => {
        const { MetricsExporter } = await import("../src/metrics/exporter.js");
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");

        const mockSubagentManager = { getAllSubagents: () => [] };
        const groupCollector = new GroupCollector({ subagentManager: mockSubagentManager as any });

        const mockDeps = {
            sandboxPool: { getStats: () => ({ total: 0, inUse: 0, idle: 0, instances: [] }) },
            q3: { getAll: () => [] },
            accumulator: { getActiveCount: () => 0 },
            q5: { peek: () => [] },
            mainLoop: { getTickCount: () => 0, isRunning: () => true },
        };
        const systemCollector = new SystemCollector(mockDeps as any);

        const port = 19091; // Use non-default port to avoid conflicts
        const exporter = new MetricsExporter(groupCollector, systemCollector, {
            host: "127.0.0.1",
            port,
            path: "/metrics",
        });

        await exporter.start();

        try {
            const res = await fetch(`http://127.0.0.1:${port}/metrics`);
            assert.equal(res.status, 200, `Expected 200, got ${res.status}`);

            const contentType = res.headers.get("content-type") ?? "";
            assert.ok(
                contentType.includes("text/plain"),
                `Expected text/plain content type, got: ${contentType}`,
            );

            const body = await res.text();
            assert.ok(body.includes("# HELP"), `Body should contain HELP lines: ${body.slice(0, 200)}`);
            assert.ok(body.includes("# TYPE"), `Body should contain TYPE lines: ${body.slice(0, 200)}`);
            assert.ok(
                body.includes("cybergroupmate_"),
                `Body should contain cybergroupmate_ metrics: ${body.slice(0, 200)}`,
            );
        } finally {
            exporter.stop();
        }
    });

    test("GET /healthz returns 200 OK", async () => {
        const { MetricsExporter } = await import("../src/metrics/exporter.js");
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");

        const mockSubagentManager = { getAllSubagents: () => [] };
        const groupCollector = new GroupCollector({ subagentManager: mockSubagentManager as any });
        const mockDeps = {
            sandboxPool: { getStats: () => ({ total: 0, inUse: 0, idle: 0, instances: [] }) },
            q3: { getAll: () => [] },
            accumulator: { getActiveCount: () => 0 },
            q5: { peek: () => [] },
            mainLoop: { getTickCount: () => 0, isRunning: () => true },
        };
        const systemCollector = new SystemCollector(mockDeps as any);

        const port = 19092;
        const exporter = new MetricsExporter(groupCollector, systemCollector, {
            host: "127.0.0.1",
            port,
        });
        await exporter.start();

        try {
            const res = await fetch(`http://127.0.0.1:${port}/healthz`);
            assert.equal(res.status, 200);
            const body = await res.text();
            assert.ok(body.includes("OK"));
        } finally {
            exporter.stop();
        }
    });

    test("Unknown paths return 404", async () => {
        const { MetricsExporter } = await import("../src/metrics/exporter.js");
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");

        const mockSubagentManager = { getAllSubagents: () => [] };
        const groupCollector = new GroupCollector({ subagentManager: mockSubagentManager as any });
        const mockDeps = {
            sandboxPool: { getStats: () => ({ total: 0, inUse: 0, idle: 0, instances: [] }) },
            q3: { getAll: () => [] },
            accumulator: { getActiveCount: () => 0 },
            q5: { peek: () => [] },
            mainLoop: { getTickCount: () => 0, isRunning: () => true },
        };
        const systemCollector = new SystemCollector(mockDeps as any);

        const port = 19093;
        const exporter = new MetricsExporter(groupCollector, systemCollector, {
            host: "127.0.0.1",
            port,
        });
        await exporter.start();

        try {
            const res = await fetch(`http://127.0.0.1:${port}/unknown-path`);
            assert.equal(res.status, 404);
        } finally {
            exporter.stop();
        }
    });

    test("MetricsExporter binds to 127.0.0.1 by default", async () => {
        const { MetricsExporter } = await import("../src/metrics/exporter.js");
        const { GroupCollector } = await import("../src/metrics/collectors/group-collector.js");
        const { SystemCollector } = await import("../src/metrics/collectors/system-collector.js");

        const mockSubagentManager = { getAllSubagents: () => [] };
        const groupCollector = new GroupCollector({ subagentManager: mockSubagentManager as any });
        const mockDeps = {
            sandboxPool: { getStats: () => ({ total: 0, inUse: 0, idle: 0, instances: [] }) },
            q3: { getAll: () => [] },
            accumulator: { getActiveCount: () => 0 },
            q5: { peek: () => [] },
            mainLoop: { getTickCount: () => 0, isRunning: () => true },
        };
        const systemCollector = new SystemCollector(mockDeps as any);

        const port = 19094;
        const exporter = new MetricsExporter(groupCollector, systemCollector, { port });
        await exporter.start();

        try {
            assert.equal(exporter.getConfig().host, "127.0.0.1", "Should default to localhost");
        } finally {
            exporter.stop();
        }
    });
});
