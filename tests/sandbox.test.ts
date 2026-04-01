/**
 * sandbox.test.ts — Sandbox + Worker 集成测试
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { Sandbox } from "../src/sandbox/sandbox.js";

describe("Sandbox", () => {
    const sandboxes: Sandbox[] = [];

    async function makeSandbox(): Promise<Sandbox> {
        const sb = new Sandbox();
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

    it("should bridge memory and actions calls to host", async () => {
        const sb = await makeSandbox();

        sb.setHostCallHandler(async (method, args) => {
            if (method === "memory.recall") {
                return { topics: [{ id: "topic_1", label: args[0] }], facts: [], persons: [] };
            }
            if (method === "actions.getTopicContext") {
                return { id: args[0], label: "测试话题" };
            }
            throw new Error(`unexpected method: ${method}`);
        });

        const result = await sb.execute(`
          const recall = await memory.recall("京都");
          const topic = await actions.getTopicContext("topic_1");
          console.log(JSON.stringify({ recall, topic }));
        `);

        assert.equal(result.error, false);
        const parsed = JSON.parse(result.output);
        assert.equal(parsed.recall.topics[0].label, "京都");
        assert.equal(parsed.topic.label, "测试话题");
    });

    it("should expose code-based social skill helpers", async () => {
        const sb = await makeSandbox();
        sb.setHostCallHandler(async (method, args) => {
            if (method === "telegram.sendText") {
                return {
                    id: "sent_1",
                    chat: { id: String(args[0]), type: "group" },
                    sender: null,
                    text: String(args[1]),
                    date: new Date().toISOString(),
                    isMention: false,
                };
            }
            throw new Error(`unexpected method: ${method}`);
        });

        const result = await sb.execute(`
          const sent = await skills.social.replyInTelegram(123, "hello", { replyTo: 9 });
          console.log(JSON.stringify(sent));
        `);

        assert.equal(result.error, false);
        const lines = result.output.split("\n");
        assert.ok(lines.some(line => line.includes("[Telegram] sendText ok chat=123 msg=sent_1 text=hello")));
        const parsed = JSON.parse(lines[lines.length - 1]);
        assert.equal(parsed.chat.id, "123");
        assert.equal(parsed.text, "hello");
        assert.equal(parsed.id, "sent_1");
    });

    it("should expose host-backed telegram proxy as top-level variable", async () => {
        const sb = await makeSandbox();
        sb.setHostCallHandler(async (method, args) => {
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
        const parsed = JSON.parse(lines[lines.length - 1]);
        assert.equal(parsed.me.id, "42");
        assert.equal(parsed.sent.id, "msg_1");
        assert.equal(parsed.sent.chat.id, "100");
    });


    it("should warn about bare async IIFE that is not awaited", async () => {
        const sb = await makeSandbox();
        const result = await sb.execute(`
          (async () => {
            console.log("inside");
          })();
          console.log("outside");
        `);

        assert.equal(result.error, false);
        assert.ok(result.output.includes("[Warning] 检测到未 await 的 async IIFE"));
        assert.ok(result.output.includes("outside"));
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
        assert.equal(result.output, "hello from bash");
    });

    it("should capture shell stderr", async () => {
        const sb = await makeSandbox();
        const result = await sb.executeShell('echo "stderr message" >&2');
        assert.equal(result.error, false);
        assert.ok(result.output.includes("stderr message"));
    });

    it("should handle shell execution errors (non-zero exit)", async () => {
        const sb = await makeSandbox();
        const result = await sb.executeShell('exit 1');
        assert.equal(result.error, true);
    });

    it("should handle shell execution timeout", async () => {
        const sb = await makeSandbox();
        await assert.rejects(
            () => sb.executeShell("sleep 30", 500),
            { message: /timed out/ }
        );
    });

    it("should execute multi-command shell script", async () => {
        const sb = await makeSandbox();
        const result = await sb.executeShell('echo "line1" && echo "line2"');
        assert.equal(result.error, false);
        assert.ok(result.output.includes("line1"));
        assert.ok(result.output.includes("line2"));
    });
});
