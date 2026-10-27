import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";

describe("MetaSandbox session scope", () => {
    it("keeps top-level const values for one session and allows redeclare", async () => {
        const sandbox = new MetaSandbox({});
        sandbox.beginSession("s1");

        const first = await sandbox.execute("const result = 41; console.log(result)");
        assert.equal(first.error, false);
        assert.equal(first.output, "[log] 41");

        const second = await sandbox.execute("const result = result + 1; console.log(result)");
        assert.equal(second.error, false);
        assert.equal(second.output, "[log] 42");

        const third = await sandbox.execute("console.log(result)");
        assert.equal(third.error, false);
        assert.equal(third.output, "[log] 42");

        sandbox.endSession("s1");
        const after = await sandbox.execute("console.log(typeof result)");
        assert.equal(after.error, false);
        assert.equal(after.output, "[log] undefined");
    });

    it("does not let session locals shadow api globals", async () => {
        const sandbox = new MetaSandbox({
            agents: {
                listStatus: async () => [{ chatId: "telegram:-1001", chatTitle: "早苗基金会" }],
            },
        });
        sandbox.beginSession("s1");

        const first = await sandbox.execute(`
const agents = await agents.listStatus();
console.log(JSON.stringify(agents));
`);
        assert.equal(first.error, false);
        assert.match(first.output, /早苗基金会/);

        const second = await sandbox.execute(`
const again = await agents.listStatus();
console.log(JSON.stringify(again));
`);
        assert.equal(second.error, false);
        assert.match(second.output, /早苗基金会/);

        const third = await sandbox.execute(`
agents = [];
console.log(typeof agents.listStatus);
`);
        assert.equal(third.error, false);
        assert.equal(third.output, "[log] function");
    });

    it("emits meta-api call observations even without console.log", async () => {
        const sandbox = new MetaSandbox({
            dispatch: {
                taskToGroup: async () => ({ taskId: "task-42", status: "PENDING" }),
            },
        });
        sandbox.beginSession("s1");

        const result = await sandbox.execute("await dispatch.taskToGroup('telegram:g1', { contentDirection: 'reply' });");
        assert.equal(result.error, false);
        assert.match(result.output, /\[log\] \[meta-api\] dispatch.taskToGroup ->/);
        assert.match(result.output, /task-42/);
    });
});

describe("MetaSandbox unawaited API rejections", () => {
    // 2026-10-14 事故形态：agent 未 await 的 API 拒绝曾以 unhandledRejection 打穿主进程。
    // 若安全 catch 缺失，下面的悬空拒绝会触发 Node 默认致命退出，测试进程直接失败。
    it("fire-and-forget rejection followed by sync error surfaces only the sync error", async () => {
        const sandbox = new MetaSandbox({
            conversations: {
                messages: async () => {
                    throw new RangeError("Too few parameter values were provided");
                },
            },
        });
        sandbox.beginSession("s1");

        const result = await sandbox.execute(`
const m = conversations.messages(undefined);
const out = shell("ls");
`);
        assert.equal(result.error, true);
        assert.match(result.output, /shell is not defined/);
    });

    it("lone fire-and-forget rejection does not fail the execution and lands in pendingAsyncErrors", async () => {
        const sandbox = new MetaSandbox({
            dispatch: {
                taskToGroup: async () => {
                    throw new Error("boom");
                },
            },
        });
        sandbox.beginSession("s1");

        const result = await sandbox.execute("dispatch.taskToGroup('g'); 'ok'");
        assert.equal(result.error, false);

        const pending = sandbox.drainPendingAsyncErrors();
        assert.equal(pending.length, 1);
        assert.match(pending[0], /taskToGroup/);
        assert.match(pending[0], /boom/);
        // drain 幂等：取过即清空
        assert.deepEqual(sandbox.drainPendingAsyncErrors(), []);
    });

    it("late rejection after execute returned still becomes visible on the next drain", async () => {
        const sandbox = new MetaSandbox({
            dispatch: {
                // 宿主侧真 setTimeout：拒绝发生在 execute 返回之后
                taskToGroup: () => new Promise((_resolve, reject) => {
                    setTimeout(() => reject(new Error("late boom")), 20);
                }),
            },
        });
        sandbox.beginSession("s1");

        const result = await sandbox.execute("dispatch.taskToGroup('g'); 'ok'");
        assert.equal(result.error, false);
        assert.deepEqual(sandbox.drainPendingAsyncErrors(), []);

        await new Promise((resolve) => setTimeout(resolve, 40));
        const pending = sandbox.drainPendingAsyncErrors();
        assert.equal(pending.length, 1);
        assert.match(pending[0], /late boom/);
    });

    it("late rejection does not leak into the next session", async () => {
        const sandbox = new MetaSandbox({
            dispatch: {
                taskToGroup: () => new Promise((_resolve, reject) => {
                    setTimeout(() => reject(new Error("late boom")), 20);
                }),
            },
        });
        sandbox.beginSession("s1");
        await sandbox.execute("dispatch.taskToGroup('g'); 'ok'");
        sandbox.endSession("s1");

        await new Promise((resolve) => setTimeout(resolve, 40));
        sandbox.beginSession("s2");
        assert.deepEqual(sandbox.drainPendingAsyncErrors(), []);
        sandbox.endSession("s2");
    });

    it("awaited API rejection still rejects execution for two-pass correction", async () => {
        const sandbox = new MetaSandbox({
            conversations: {
                messages: async () => {
                    throw new Error("chatId is required");
                },
            },
        });
        sandbox.beginSession("s1");

        const result = await sandbox.execute("await conversations.messages('telegram:1')");
        assert.equal(result.error, true);
        assert.match(result.output, /chatId is required/);
    });
});
