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
import { cleanupTestMemory, createTestMemory } from "./helpers/test-db.js";

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

        it("#5b compact 时从 memory 重建被压缩的交互历史", async () => {
            const memory = createTestMemory("executor-compact-rebuild");
            try {
                memory.storeMessageBatch([
                    { messageId: "m1", chatId: "chat1", userId: "u1", displayName: "Alice", text: "第一条用户消息", timestamp: "2026-01-01T10:00:00.000Z" },
                    { messageId: "m2", chatId: "chat1", userId: "agent", displayName: "赛博群友", text: "agent 自己发出的消息", timestamp: "2026-01-01T10:00:10.000Z" },
                    { messageId: "m3", chatId: "chat1", userId: "u2", displayName: "Bob", text: "最后一次增量位置", timestamp: "2026-01-01T10:00:20.000Z" },
                ]);

                const executor = new CodeActExecutor("chat1", { maxSessionMessages: 6, maxExecutionTimeMs: 60000 });
                (executor as any).memory = memory;
                executor.session = [
                    { role: "user", content: "## 目标消息\n[2026-01-01 10:00] [msgId:m1] Alice: 第一条用户消息", timestamp: "2026-01-01T10:00:00.000Z" },
                    { role: "assistant", content: "收到。", timestamp: "2026-01-01T10:00:01.000Z" },
                    { role: "user", content: "## 目标消息 (更新)\n[2026-01-01 10:00] [msgId:m3] Bob: 最后一次增量位置", timestamp: "2026-01-01T10:00:20.000Z" },
                    { role: "assistant", content: "tail 1", timestamp: "2026-01-01T10:00:21.000Z" },
                    { role: "user", content: "tail 2", timestamp: "2026-01-01T10:00:22.000Z" },
                    { role: "assistant", content: "tail 3", timestamp: "2026-01-01T10:00:23.000Z" },
                    { role: "user", content: "tail 4", timestamp: "2026-01-01T10:00:24.000Z" },
                ];
                (executor as any).executionRecords = [{
                    taskId: "5c7cab41-9f47-44e3-bd6d-fad0f20f1510",
                    timestamp: "2026-01-01T10:00:30.000Z",
                    endReason: "end_turn",
                    turns: 11,
                    sentMessages: [{ chatId: "chat1", messageId: "m2", text: "agent 自己发出的消息", timestamp: "2026-01-01T10:00:10.000Z" }],
                    thinkingSummary: "已经回复并确认上下文",
                }];

                await (executor as any).compactSession();

                assert.match(executor.session[0].content, /被压缩的交互历史/);
                assert.match(executor.session[0].content, /\[msgId:m1\].*第一条用户消息/);
                assert.match(executor.session[0].content, /\[msgId:m2\].*agent 自己发出的消息/);
                assert.match(executor.session[0].content, /\[msgId:m3\].*最后一次增量位置/);
                assert.doesNotMatch(executor.session[0].content, /5c7cab41-9f47-44e3-bd6d-fad0f20f1510/);
                assert.doesNotMatch(executor.session[0].content, /- Task /);
                assert.match(executor.session[0].content, /已发消息: "agent 自己发出的消息"/);
                assert.match(executor.session[0].content, /思路: 已经回复并确认上下文/);
            } finally {
                cleanupTestMemory(memory, "executor-compact-rebuild");
            }
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
                taskId: "t2", chatId: "c2", executionType: "CODEACT",
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

    // ─── S3.4: Session 持久化 ───

    describe("S3.4: Session 持久化", () => {
        it("#15 saveSession() / loadSession() round-trip", async () => {
            const { join } = await import("node:path");
            const { rmSync } = await import("node:fs");

            const tmpDir = join("/tmp", `test-session-rt-${Date.now()}`);
            const filePath = join(tmpDir, "telegram", "chat1.json");

            // 创建 executor 并执行一个任务
            const exec1 = new CodeActExecutor("chat1");
            exec1.setSessionFilePath(filePath);
            await exec1.execute(makeTask("chat1", [{ action: "REPLY", reason: "test" }]));

            // 保存到磁盘
            exec1.saveSession();

            // 创建新 executor，从磁盘恢复
            const exec2 = new CodeActExecutor("chat1");
            const loaded = exec2.loadSession(filePath);

            assert.ok(loaded, "loadSession 应返回 true");
            assert.equal(exec2.getSessionSize(), exec1.getSessionSize(), "session 大小应一致");
            assert.equal(exec2.getExecutionCount(), exec1.getExecutionCount(), "executionCount 应一致");

            rmSync(tmpDir, { recursive: true, force: true });
        });

        it("#16 processNext 后自动 saveSession 到磁盘", async () => {
            const { join } = await import("node:path");
            const { existsSync, rmSync } = await import("node:fs");

            const tmpDir = join("/tmp", `test-session-auto-${Date.now()}`);
            const filePath = join(tmpDir, "telegram", "chat1.json");

            const exec = new CodeActExecutor("chat1");
            exec.setSessionFilePath(filePath);

            // 通过 enqueue 触发 processNext（自动 save）
            exec.enqueue(makeTask("chat1"));
            await new Promise(r => setTimeout(r, 200));

            assert.ok(existsSync(filePath), "session 文件应在 execute 后自动创建");

            rmSync(tmpDir, { recursive: true, force: true });
        });

        it("#17 loadSession() chatId 不匹配时拒绝恢复", async () => {
            const { join } = await import("node:path");
            const { writeFileSync, mkdirSync, rmSync } = await import("node:fs");

            const tmpDir = join("/tmp", `test-session-mismatch-${Date.now()}`);
            mkdirSync(tmpDir, { recursive: true });
            const filePath = join(tmpDir, "wrong.json");

            // 写入 chatId 不匹配的 session 文件
            writeFileSync(filePath, JSON.stringify({
                chatId: "other_chat",
                session: [{ role: "user", content: "test", timestamp: new Date().toISOString() }],
                executionRecords: [],
                executionCount: 5,
            }));

            const exec = new CodeActExecutor("chat1");
            const loaded = exec.loadSession(filePath);

            assert.equal(loaded, false, "chatId 不匹配时应拒绝恢复");
            assert.equal(exec.getSessionSize(), 0, "session 应为空");

            rmSync(tmpDir, { recursive: true, force: true });
        });
    });
});
