/**
 * sandbox.test.ts — Sandbox + Worker 集成测试
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "../src/sandbox/sandbox.js";

/**
 * 从执行输出中取出 JSON 行。
 * 执行输出末尾会附加运行时诊断行（如 "异步方法调用数：N"），
 * 故不能直接 JSON.parse 整段输出，需从后往前找第一行可解析的 JSON。
 */
function parseJsonLine(output: string): any {
    const lines = output.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith("{") || t.startsWith("[")) {
            try { return JSON.parse(t); } catch { /* keep scanning */ }
        }
    }
    throw new Error(`no JSON line found in output: ${JSON.stringify(output)}`);
}

describe("Sandbox", () => {
    const sandboxes: Sandbox[] = [];

    async function makeSandbox(): Promise<Sandbox> {
        const sb = new Sandbox();
        sb.setHostCallHandler(async (method) => {
            if (method === "mcp.list") return [];
            throw new Error(`unexpected method: ${method}`);
        });
        sandboxes.push(sb);
        await sb.start();
        return sb;
    }

    after(async () => {
        for (const sb of sandboxes) {
            await sb.stop().catch(() => { });
        }
    });

    it("should start and report isAlive", async () => {
        const sb = await makeSandbox();
        assert.equal(sb.isAlive(), true);
    });

    it("should execute simple code and capture console.log", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute('console.log("hello world")');
        assert.equal(result.error, false);
        assert.equal(result.output, "hello world");
    });

    it("should capture multiple console.log calls", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute(
            'console.log("line1"); console.log("line2"); console.log("line3")'
        );
        assert.equal(result.error, false);
        assert.equal(result.output, "line1\nline2\nline3");
    });

    it("should capture console.warn and console.error", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute(
            'console.warn("warning"); console.error("error")'
        );
        assert.equal(result.error, false);
        assert.equal(result.output, "warning\nerror");
    });

    it("should handle objects in console.log", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute('console.log({ a: 1, b: "two" })');
        assert.equal(result.error, false);
        const parsed = JSON.parse(result.output);
        assert.deepEqual(parsed, { a: 1, b: "two" });
    });

    it("should return error for invalid code", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute("throw new Error('test error')");
        assert.equal(result.error, true);
        assert.ok(result.output.includes("test error"));
    });

    it("should return error with stack trace for runtime errors", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute("undeclaredVariable.foo()");
        assert.equal(result.error, true);
        assert.ok(
            result.output.includes("ReferenceError") ||
            result.output.includes("not defined")
        );
    });

    it("should maintain ctx across executions (persistent namespace)", async () => {
        const sb = await makeSandbox();

        // First execution: set ctx.myValue
        const r1 = await sb.execute('ctx.myValue = 42; console.log("set")');
        assert.equal(r1.error, false);
        assert.equal(r1.output, "set");

        // Second execution: read ctx.myValue
        const r2 = await sb.execute("console.log(ctx.myValue)");
        assert.equal(r2.error, false);
        assert.equal(r2.output, "42");
    });

    it("should maintain notebook variables within a task scope", async () => {
        const sb = await makeSandbox();
        const scopeId = "test-task-scope";

        const r1 = await sb.execute("const messages = ['a', 'b']; console.log(messages.length)", 30000, { scopeId });
        assert.equal(r1.error, false);
        assert.equal(r1.output, "2");

        const r2 = await sb.execute("console.log(messages.join(','))", 30000, { scopeId });
        assert.equal(r2.error, false);
        assert.equal(r2.output, "a,b");
    });

    it("should allow repeated top-level const names in notebook scope", async () => {
        const sb = await makeSandbox();
        const scopeId = "test-repeat-const";

        const r1 = await sb.execute("const result = 1; console.log(result)", 30000, { scopeId });
        assert.equal(r1.error, false);
        assert.equal(r1.output, "1");

        const r2 = await sb.execute("const result = result + 1; console.log(result)", 30000, { scopeId });
        assert.equal(r2.error, false);
        assert.equal(r2.output, "2");
    });

    it("should isolate notebook variables by task scope and reset them", async () => {
        const sb = await makeSandbox();

        await sb.execute("const token = 'alpha';", 30000, { scopeId: "scope-a" });

        const isolated = await sb.execute("console.log(typeof token)", 30000, { scopeId: "scope-b" });
        assert.equal(isolated.error, false);
        assert.equal(isolated.output, "undefined");

        const retained = await sb.execute("console.log(token)", 30000, { scopeId: "scope-a" });
        assert.equal(retained.error, false);
        assert.equal(retained.output, "alpha");

        await sb.resetNotebookScope("scope-a");
        const cleared = await sb.execute("console.log(typeof token)", 30000, { scopeId: "scope-a" });
        assert.equal(cleared.error, false);
        assert.equal(cleared.output, "undefined");
    });

    it("should rehydrate notebook functions with the current execution API bindings", async () => {
        const sb = await makeSandbox();
        const scopeId = "test-function-rehydrate";

        const defined = await sb.execute(`
          async function ping() {
            runtime.notify({ type: "notebook.ping", data: "ok" });
          }
          console.log("defined");
        `, 30000, { scopeId });
        assert.equal(defined.error, false);
        assert.equal(defined.output, "defined");

        const notifyPromise = new Promise<Record<string, unknown>>((resolve) => {
            sb.once("notify", resolve);
        });

        const called = await sb.execute("await ping(); console.log('called')", 30000, { scopeId });
        assert.equal(called.error, false);
        assert.equal(called.output, "called");

        const event = await notifyPromise;
        assert.equal(event.type, "notebook.ping");
        assert.equal(event.data, "ok");
    });

    it("should support top-level await", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute(`
      const result = await Promise.resolve("async hello");
      console.log(result);
    `);
        assert.equal(result.error, false);
        assert.equal(result.output, "async hello");
    });

    it("should support runtime.notify", async () => {
        const sb = await makeSandbox();

        const notifyPromise = new Promise<Record<string, unknown>>((resolve) => {
            sb.once("notify", resolve);
        });

        await sb.execute(
            'runtime.notify({ type: "test.event", data: "hello" })'
        );

        const event = await notifyPromise;
        assert.equal(event.type, "test.event");
        assert.equal(event.data, "hello");
    });

    it("should bridge memory module calls to host", async () => {
        const sb = await makeSandbox();

        sb.setHostCallHandler(async (method, args) => {
            if (method === "mcp.list") {
                return [];
            }
            if (method === "memory.searchTopics") {
                return [{ id: "topic_1", label: String(args[0]) }];
            }
            if (method === "memory.searchFacts") {
                return [{ id: "fact_1", subject: String(args[0]) }];
            }
            throw new Error(`unexpected method: ${method}`);
        });

        const result = await sb.execute(`
          const topics = await memory.searchTopics("京都");
          const facts = await memory.searchFacts("京都");
          console.log(JSON.stringify({ topics, facts }));
        `);

        assert.equal(result.error, false, result.output);
        const parsed = parseJsonLine(result.output);
        assert.equal(parsed.topics[0].label, "京都");
        assert.equal(parsed.facts[0].subject, "京都");
    });

    it("should include host call method and stack in proxied errors", async () => {
        const sb = await makeSandbox();

        sb.setHostCallHandler(async (method) => {
            if (method === "mcp.list") {
                return [];
            }
            if (method === "memory.searchFacts") {
                throw new Error("boom from host");
            }
            throw new Error(`unexpected method: ${method}`);
        });

        const result = await sb.execute(`await memory.searchFacts("京都");`);

        assert.equal(result.error, true);
        assert.match(result.output, /\[host_call:memory\.searchFacts\] boom from host/);
        assert.match(result.output, /--- Host stack ---/);
    });

    it("should expose host-backed telegram proxy as top-level variable", async () => {
        const sb = await makeSandbox();
        sb.setHostCallHandler(async (method, args) => {
            if (method === "mcp.list") {
                return [];
            }
            if (method === "telegram.getMe") {
                return { id: "42", firstName: "Cyber", isBot: true };
            }
            if (method === "telegram.sendText") {
                return {
                    id: "msg_1",
                    chat: { id: String(args[0]), type: "private" },
                    sender: { id: "42", firstName: "Cyber", isBot: true },
                    text: String(args[1]),
                    date: "2026-03-08T00:00:00.000Z",
                    isMention: false,
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });

        const result = await sb.execute(`
          const me = await telegram.getMe();
          const sent = await telegram.sendText("100", "ping");
          console.log(JSON.stringify({ me, sent }));
        `);

        assert.equal(result.error, false);
        const lines = result.output.split("\n");
        assert.ok(lines.some(line => line.includes("[Telegram] sendText ok chat=100 msg=msg_1 text=ping")));
        const parsed = parseJsonLine(result.output);
        assert.equal(parsed.me.id, "42");
        assert.equal(parsed.sent.id, "msg_1");
        assert.equal(parsed.sent.chat.id, "100");
    });

    it("should expose host-backed global mcp proxy", async () => {
        const sb = await makeSandbox();
        const calls: string[] = [];
        sb.setHostCallHandler(async (method, args) => {
            calls.push(method);
            if (method === "mcp.list") {
                return [
                    {
                        name: "global-github",
                        transport: "streamable-http",
                        url: "https://example.com/mcp",
                        tools: ["search_repositories"],
                        running: true,
                    },
                ];
            }
            if (method === "mcp.connect") {
                const [config] = args;
                return {
                    name: config.name,
                    tools: [{ name: "search_repositories", description: "Search repositories" }],
                };
            }
            if (method === "mcp.call") {
                return { ok: true, server: args[0], tool: args[1], payload: args[2] };
            }
            if (method === "mcp.disconnect") {
                return null;
            }
            throw new Error(`unexpected method: ${method}`);
        });

        const result = await sb.execute(`
          const before = mcp.list();
          const github = await mcp.connect({
            name: "global-github",
            transport: "streamable-http",
            url: "https://example.com/mcp"
          });
          const called = await github.call("search_repositories", { query: "mcp" });
          await mcp.disconnect("global-github");
          console.log(JSON.stringify({ before, called }));
        `);

        assert.equal(result.error, false);
        const parsed = JSON.parse(result.output);
        assert.equal(parsed.before[0].name, "global-github");
        assert.equal(parsed.called.server, "global-github");
        assert.equal(parsed.called.tool, "search_repositories");
        assert.ok(calls.includes("mcp.connect"));
        assert.ok(calls.includes("mcp.call"));
        assert.ok(calls.includes("mcp.disconnect"));
    });


    it("flushes and counts un-awaited API calls via runtime promise tracking", async () => {
        // 旧的"正则检测未 await IIFE"告警已被运行时 Promise 追踪取代
        // （commit 6d56082）。现在即使忘记 await，注入 API 的调用仍会被 flush 完成，
        // 并在输出末尾附加 "异步方法调用数：N" 诊断行。
        const sb = await makeSandbox();
        const calls: string[] = [];
        sb.setHostCallHandler(async (method, args) => {
            if (method === "mcp.list") return [];
            if (method === "memory.searchFacts") {
                calls.push(String(args[0]));
                return [];
            }
            throw new Error(`unexpected method: ${method}`);
        });

        const result = await sb.execute(`
          memory.searchFacts("kyoto");   // 故意不 await
          console.log("outside");
        `);

        assert.equal(result.error, false, result.output);
        assert.ok(result.output.includes("outside"));
        // 未 await 的调用仍抵达 host（被 flush）
        assert.deepEqual(calls, ["kyoto"]);
        // 诊断行出现，表明运行时追踪生效
        assert.ok(result.output.includes("异步方法调用数"), `output: ${JSON.stringify(result.output)}`);
    });

    it("should stop cleanly", async () => {
        const sb = new Sandbox();
        await sb.start();
        assert.equal(sb.isAlive(), true);

        await sb.stop();
        assert.equal(sb.isAlive(), false);
    });

    it("should handle execution timeout", async () => {
        const sb = await makeSandbox();
        await assert.rejects(
            () =>
                sb.execute(
                    "await new Promise(resolve => setTimeout(resolve, 10000))",
                    500
                ),
            { message: /timed out/ }
        );
    });

    // ─── Shell execution tests ───

    it("should execute shell command and capture stdout", async () => {
        const sb = await makeSandbox();
        const result = await sb.executeShell('echo "hello from bash"');
        assert.equal(result.error, false);
        // 应捕获到 stdout，附加 [cwd: ...]，且绝不泄漏 PTY 握手/完成 sentinel。
        // （命令回显是否被剥离取决于 PTY chunk 时序，属尽力而为，不强断言）
        assert.ok(result.output.includes("hello from bash"), `output: ${JSON.stringify(result.output)}`);
        assert.ok(!result.output.includes("__SANDBOX_DONE_"), `sentinel leaked: ${JSON.stringify(result.output)}`);
        assert.ok(result.output.includes("[cwd:"));
    });

    it("should capture shell stderr", async () => {
        const sb = await makeSandbox();
        const result = await sb.executeShell('echo "stderr message" >&2');
        assert.equal(result.error, false);
        assert.ok(result.output.includes("stderr message"));
    });

    it("should handle shell execution errors (non-zero exit)", async () => {
        const sb = await makeSandbox();
        // 用 `false`（返回码 1 但不会像 `exit` 那样杀掉持久 shell 进程）
        const result = await sb.executeShell('false');
        assert.equal(result.error, true);
    });

    it("should resolve with a timeout marker (not reject) when a command exceeds its timeout", async () => {
        const sb = await makeSandbox();
        // executeShell 超时不抛错：保留进程在后台，返回带超时标记的部分输出，供 agent 决策（detach/kill）
        const result = await sb.executeShell("sleep 30", 500);
        assert.equal(result.error, true);
        assert.ok(result.output.includes("timed out"), `output: ${JSON.stringify(result.output)}`);
    });

    it("should execute multi-command shell script", async () => {
        const sb = await makeSandbox();
        const result = await sb.executeShell('echo "line1" && echo "line2"');
        assert.equal(result.error, false);
        assert.ok(result.output.includes("line1"));
        assert.ok(result.output.includes("line2"));
    });

    it("shell.runBackground launches non-blocking and emits shell_wake 'exit' on completion", async () => {
        const sb = await makeSandbox();
        const wake = new Promise<any>((resolve) => sb.once("shell_wake", resolve));
        // 立即返回（非阻塞），命令仍在后台跑
        const { tabId } = await sb.runShellBackground("sleep 1; echo RUN_DONE", { idleTimeout: 0 });
        assert.ok(tabId && tabId !== "default");
        const ev = await wake;
        assert.equal(ev.reason, "exit");
        assert.equal(ev.tabId, tabId);
        assert.equal(ev.exitCode, 0);
        assert.ok(ev.recentOutput.includes("RUN_DONE"), `recentOutput: ${JSON.stringify(ev.recentOutput)}`);
        assert.ok(!ev.recentOutput.includes("__SANDBOX_DONE_"));
    });

    it("shell.runBackground emits shell_wake 'exit' with the real non-zero exit code", async () => {
        const sb = await makeSandbox();
        const wake = new Promise<any>((resolve) => sb.once("shell_wake", resolve));
        await sb.runShellBackground("false", { idleTimeout: 0 });
        const ev = await wake;
        assert.equal(ev.reason, "exit");
        assert.equal(ev.exitCode, 1);
    });

    it("shell.runBackground wakes with 'idle' when output goes quiet, without killing the process", async () => {
        const sb = await makeSandbox();
        const wake = new Promise<any>((resolve) => sb.once("shell_wake", resolve));
        // 打印一行后长时间静默；idleTimeout 很短 → 触发 idle 唤醒
        const { tabId } = await sb.runShellBackground("echo HELLO_IDLE; sleep 30", { idleTimeout: 5000, maxDuration: 0 });
        const ev = await wake;
        assert.equal(ev.reason, "idle");
        assert.equal(ev.tabId, tabId);
        // 进程未被 kill：tab 仍存活且 busy
        const tabs = sb.listShellTabs();
        const t = tabs.find((x) => x.id === tabId);
        assert.ok(t && t.state === "busy", "idle 唤醒不应 kill 进程");
    });

    it("shell.runBackground wakes with 'hard' when maxDuration elapses while still printing, without killing", async () => {
        const sb = await makeSandbox();
        const wake = new Promise<any>((resolve) => sb.once("shell_wake", resolve));
        // 持续刷输出，所以 idle 不会触发；maxDuration 很短 → 触发 hard
        const { tabId } = await sb.runShellBackground(
            "while true; do echo tick; sleep 0.2; done",
            { idleTimeout: 0, maxDuration: 10000 },
        );
        const ev = await wake;
        assert.equal(ev.reason, "hard");
        assert.equal(ev.tabId, tabId);
        const t = sb.listShellTabs().find((x) => x.id === tabId);
        assert.ok(t && t.state === "busy", "hard 唤醒不应 kill 进程");
        await sb.killShellTab(tabId);
    });

    it("shell.runBackground rejects 'default' as a background tab id", async () => {
        const sb = await makeSandbox();
        await assert.rejects(() => sb.runShellBackground("echo x", { tabId: "default" }), /default/);
    });

    it("shell.read does not leak internal sentinel lines", async () => {
        const sb = await makeSandbox();
        const wake = new Promise<any>((resolve) => sb.once("shell_wake", resolve));
        const { tabId } = await sb.runShellBackground("echo READ_VISIBLE", { idleTimeout: 0 });
        await wake; // 等命令跑完（含 sentinel 写入 scrollback）
        const out = await sb.readShellTab(tabId, 100);
        assert.ok(out.includes("READ_VISIBLE"), `read output: ${JSON.stringify(out)}`);
        assert.ok(!out.includes("__SANDBOX_DONE_"), `sentinel leaked into read(): ${JSON.stringify(out)}`);
    });

    it("late host_call result after worker stdin closes never crashes the host", async () => {
        const sb = await makeSandbox();
        const internals = sb as unknown as {
            child?: { stdin?: NodeJS.WritableStream & { write: (...a: unknown[]) => unknown; destroy?: () => void } };
            stopping: boolean;
            safeWrite: (message: string) => boolean;
            handleHostCall: (id: string, method: string, args: unknown[]) => Promise<void>;
        };
        const stdin = internals.child?.stdin;
        assert.ok(stdin, "worker stdin should exist");

        // 关键守卫：stdin 上必须挂着 error 监听，否则 EPIPE 会成为 unhandled 'error' 直接终止进程。
        assert.ok((stdin as unknown as NodeJS.EventEmitter).listenerCount("error") >= 1);

        // 流仍健康，但 write 同步抛 EPIPE 时，safeWrite 必须吞掉而不是让进程崩溃。
        const originalWrite = stdin.write.bind(stdin);
        stdin.write = () => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); };
        assert.equal(internals.safeWrite("x"), false);
        stdin.write = originalWrite as typeof stdin.write;

        // 模拟超时停止窗口：stopping=true 且 stdin 已 destroy，但 child 引用尚未在 exit 回调里置空。
        // 此时一个迟到的 host_call 结果到达：handleHostCall 必须正常 resolve，不得向死管道写。
        internals.stopping = true;
        stdin.destroy?.();
        await internals.handleHostCall("late-1", "mcp.list", []);
        assert.equal(internals.safeWrite("anything"), false);
    });

    it("hasActiveBackgroundTasks tracks the background monitor lifecycle", async () => {
        const sb = await makeSandbox();
        assert.equal(sb.hasActiveBackgroundTasks(), false);
        const wake = new Promise<any>((resolve) => sb.once("shell_wake", resolve));
        await sb.runShellBackground("sleep 1; echo done", { idleTimeout: 0 });
        assert.equal(sb.hasActiveBackgroundTasks(), true);
        await wake;
        assert.equal(sb.hasActiveBackgroundTasks(), false);
    });
});
