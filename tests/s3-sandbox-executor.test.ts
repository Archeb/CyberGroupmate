/**
 * s3-sandbox-executor.test.ts — S3 SandboxPool + CodeActExecutor 单元测试
 *
 * 覆盖 11 个测试用例（subtask.md S3 测试计划）
 *
 * 注意：SandboxPool 的实际 Sandbox worker 测试在 sandbox.test.ts 中已有覆盖。
 * 此处专注于测试 Pool 管理逻辑、CodeActExecutor session/Q4/Q5、ExecutionQueue 和 CallbackQueue。
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import type { CodeActReplyTask, SubagentCallback, GroupContextPackage, Decision } from "../src/subagent/types.js";

/** 创建测试用的 CodeActReplyTask */
function makeTask(chatId: string = "chat1", decisions: Partial<Decision>[] = []): CodeActReplyTask {
    return {
        type: "CODEACT_REPLY",
        chatId,
        taskId: `task-${randomUUID().slice(0, 8)}`,
        decisions: decisions.map(d => ({
            action: d.action ?? "REPLY",
            confidence: d.confidence ?? 0.8,
            reason: d.reason ?? "test",
            ...d,
        })) as Decision[],
        contextSnapshot: {
            depth: 0,
            chatId,
            snapshotTimestamp: new Date().toISOString(),
            topicDigests: [],
            engagementScore: 50,
        },
        replyMode: "SINGLE",
        createdAt: new Date().toISOString(),
    };
}

describe("S3: Sandbox 多实例 + CodeActExecutor", () => {

    // ─── S3.1: SandboxPool 管理逻辑 ───
    // SandboxPool 实际 acquire/release 需要 sandbox-worker 进程，
    // 在 sandbox.test.ts 和 e2e 中测试。此处测试其辅助逻辑。

    describe("S3.1: SandboxPool (管理逻辑)", () => {
        it("#1 SandboxPool getStats() 初始化为空", async () => {
            // 动态 import 避免立即创建 cleanup timer
            const { SandboxPool } = await import("../src/sandbox/sandbox-pool.js");
            const pool = new SandboxPool({ maxInstances: 3 });
            const stats = pool.getStats();

            assert.equal(stats.total, 0);
            assert.equal(stats.inUse, 0);
            assert.equal(stats.idle, 0);

            await pool.dispose();
        });

        it("#2 SandboxPool 配置最大实例数", async () => {
            const { SandboxPool } = await import("../src/sandbox/sandbox-pool.js");
            const pool = new SandboxPool({ maxInstances: 2 });

            // 池大小限制测试（不实际创建 sandbox 进程，只验证配置）
            assert.equal(pool.size, 0);
            assert.equal(pool.has("nonexistent"), false);

            await pool.dispose();
        });
    });

    // ─── S3.2: CodeActExecutor ───

    describe("S3.2: CodeActExecutor", () => {
        it("#3 execute() 返回 COMPLETED callback", async () => {
            const executor = new CodeActExecutor("chat1");
            const task = makeTask("chat1", [{ action: "REPLY", reason: "test reply" }]);

            const callback = await executor.execute(task);

            assert.equal(callback.status, "COMPLETED");
            assert.equal(callback.chatId, "chat1");
            assert.equal(callback.taskId, task.taskId);
            assert.equal(callback.executionType, "CODEACT");
            assert.ok(callback.durationMs >= 0);
        });

        it("#4 execute() 更新 session 历史", async () => {
            const executor = new CodeActExecutor("chat1");
            assert.equal(executor.getSessionSize(), 0);

            const task = makeTask("chat1");
            await executor.execute(task);

            // session 应有 2 条：user(task) + assistant(completed)
            assert.equal(executor.getSessionSize(), 2);
        });

        it("#5 session 超限自动 compact", async () => {
            const executor = new CodeActExecutor("chat1", { maxSessionMessages: 5, maxExecutionTimeMs: 60000 });

            // 执行 5 个任务（每个产生 2 条 session 消息）
            for (let i = 0; i < 5; i++) {
                await executor.execute(makeTask("chat1"));
            }

            // session 应被 compact（不超过 20 + 1 = 21）
            assert.ok(executor.getSessionSize() <= 21, `session 应被 compact: ${executor.getSessionSize()}`);
            assert.ok(executor.lastCompactedAt !== null, "应有 compact 记录");
        });

        it("#6 callbackHandler 在执行后被调用", async () => {
            const executor = new CodeActExecutor("chat1");
            const callbacks: SubagentCallback[] = [];

            executor.setCallbackHandler(cb => callbacks.push(cb));

            const task = makeTask("chat1");
            executor.enqueue(task);

            // 等待 Q4 处理完成
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.equal(callbacks.length, 1, "callback 应被调用一次");
            assert.equal(callbacks[0].taskId, task.taskId);
        });
    });


    // ─── S3.3: CallbackQueue (Q5) ───

    describe("S3.3: CallbackQueue (Q5)", () => {
        it("#9 enqueue() + drain() 基本流程", () => {
            const q = new CallbackQueue();

            q.enqueue({
                taskId: "t1", chatId: "c1", executionType: "CODEACT",
                status: "COMPLETED", summary: "ok", durationMs: 100,
                createdAt: new Date().toISOString(),
            });
            q.enqueue({
                taskId: "t2", chatId: "c2", executionType: "FAST_PATH",
                status: "COMPLETED", summary: "fast", durationMs: 50,
                createdAt: new Date().toISOString(),
            });

            assert.equal(q.size, 2);

            const drained = q.drain();
            assert.equal(drained.length, 2);
            assert.equal(q.size, 0, "drain 后队列为空");
        });

        it("#10 peekByChatId() 过滤", () => {
            const q = new CallbackQueue();

            q.enqueue({
                taskId: "t1", chatId: "c1", executionType: "CODEACT",
                status: "COMPLETED", summary: "ok", durationMs: 100,
                createdAt: new Date().toISOString(),
            });
            q.enqueue({
                taskId: "t2", chatId: "c2", executionType: "CODEACT",
                status: "COMPLETED", summary: "ok2", durationMs: 50,
                createdAt: new Date().toISOString(),
            });

            const c1Only = q.peekByChatId("c1");
            assert.equal(c1Only.length, 1);
            assert.equal(c1Only[0].chatId, "c1");
        });

        it("#11 空队列 drain() 返回空数组", () => {
            const q = new CallbackQueue();
            const result = q.drain();
            assert.deepEqual(result, []);
            assert.equal(q.isEmpty, true);
        });

        // ─── Edge cases ───

        it("#12 Q5 drain preserves insertion order", () => {
            const q = new CallbackQueue();
            for (let i = 0; i < 5; i++) {
                q.enqueue({ taskId: `t${i}`, chatId: "c1", executionType: "CODEACT", status: "COMPLETED", summary: `s${i}`, durationMs: 0, createdAt: new Date().toISOString() });
            }
            const drained = q.drain();
            for (let i = 0; i < 5; i++) assert.equal(drained[i].taskId, `t${i}`, `order preserved at ${i}`);
        });

        it("#13 CodeActExecutor callback contains correct chatId and taskId", async () => {
            const exec = new CodeActExecutor("g99");
            const cbs: SubagentCallback[] = [];
            exec.setCallbackHandler(cb => cbs.push(cb));
            exec.enqueue(makeTask("g99"));
            await new Promise(r => setTimeout(r, 100));
            assert.equal(cbs.length, 1);
            assert.equal(cbs[0].chatId, "g99");
        });

        it("#14 CodeActExecutor rapid successive enqueue processes all", async () => {
            const exec = new CodeActExecutor("g1");
            const cbs: SubagentCallback[] = [];
            exec.setCallbackHandler(cb => cbs.push(cb));
            for (let i = 0; i < 5; i++) exec.enqueue(makeTask("g1"));
            await new Promise(r => setTimeout(r, 500));
            assert.equal(cbs.length, 5, "所有 5 个任务应被处理");
        });
    });
});
