/**
 * s6-global-state.test.ts — S6 GlobalState 单元测试
 *
 * 聚焦 Phase 1 的 Meta-CodeAct 持久化状态结构。
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

import { GlobalState } from "../src/main-agent/global-state.js";
import { resolveMetaHistoryBudget } from "../src/main-agent/meta-history-retention.js";

const tempDirs: string[] = [];
function tempDir(): string { const d = join(tmpdir(), `s6-${randomUUID()}`); mkdirSync(d, { recursive: true }); tempDirs.push(d); return d; }
after(() => { for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true }); });

describe("S6: Global State", () => {
    it("#1 GlobalState 初始化（空文件）", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const state = gs.getState();
        assert.deepEqual(state.schedulerEvents, []);
        assert.deepEqual(state.memos, []);
        assert.deepEqual(state.sessionDigests, []);
        assert.deepEqual(state.signalPool, []);
        assert.deepEqual(state.wakeConditions, []);
        assert.equal("taskList" in state, false);
        assert.equal("recentDecisions" in state, false);
        gs.dispose();
    });

    it("#2 memoSet + memoGet + memoList", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        gs.memoSet("followup:a", { chatId: "chat1", step: 1 }, 30);
        assert.deepEqual(gs.memoGet("followup:a"), { chatId: "chat1", step: 1 });
        assert.equal(gs.memoList().length, 1);
        gs.dispose();
    });

    it("#3 memoDelete + cleanExpiredMemos", () => {
        const dir = tempDir();
        const path = join(dir, "s.json");
        writeFileSync(path, JSON.stringify({
            schedulerEvents: [],
            memos: [
                {
                    key: "expired",
                    value: { ok: false },
                    createdAt: new Date(Date.now() - 60_000).toISOString(),
                    expiresAt: new Date(Date.now() - 1_000).toISOString(),
                },
            ],
            sessionDigests: [],
            signalPool: [],
            wakeConditions: [],
        }), "utf-8");
        const gs = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        assert.equal(gs.cleanExpiredMemos(), 1);
        gs.memoSet("live", { ok: true });
        gs.memoDelete("live");
        assert.equal(gs.memoGet("live"), null);
        gs.dispose();
    });

    it("#4 addSessionDigest cap at 30", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        for (let i = 0; i < 32; i++) gs.addSessionDigest(`digest-${i}`);
        const digests = gs.getSessionDigests();
        assert.equal(digests.length, 30);
        assert.equal(digests[0].content, "digest-2");
        assert.equal(digests.at(-1)?.content, "digest-31");
        gs.dispose();
    });

    it("#4b metaSessionHistory uses a hysteresis window instead of trimming every overflow", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });

        // Derive sizes from the resolved budget so the test is independent of the
        // ambient config.yaml (which may override the compiled defaults). Each message
        // is sized so a handful of them blows past the soft char limit; trimming is
        // applied incrementally on every append.
        const budget = resolveMetaHistoryBudget();
        const prefixLen = 6; // "mNNN-" worst case
        const chunkLen = Math.floor(budget.trimTargetChars / budget.minMessages) - prefixLen;
        assert.ok(chunkLen > 0, "budget too small for this test");
        const chunk = "x".repeat(chunkLen);

        // Push far more oversized messages than the budget allows.
        const total = Math.ceil(budget.softCharLimit / chunkLen) * 2 + 5;
        let maxLenObserved = 0;
        for (let i = 0; i < total; i++) {
            gs.appendMetaSessionHistory([{ role: "assistant", content: `m${i}-${chunk}` }]);
            const h = gs.getMetaSessionHistory();
            const chars = h.reduce((sum, m) => sum + m.content.trim().length, 0);
            maxLenObserved = Math.max(maxLenObserved, h.length);
            // Hysteresis core property: the window never grows unbounded — after any
            // append the char total stays within the soft limit (which is the trigger
            // to trim), and it never trims below the configured minimum.
            assert.ok(
                chars <= budget.softCharLimit + chunkLen,
                `chars ${chars} should stay bounded by soft limit`,
            );
            assert.ok(h.length >= budget.minMessages || i + 1 < budget.minMessages,
                `should never trim below minMessages (${budget.minMessages})`);
        }

        const history = gs.getMetaSessionHistory();
        // Newest messages are always retained.
        assert.equal(history.at(-1)?.content.startsWith(`m${total - 1}-`), true);
        // Hysteresis means it does NOT collapse to exactly minMessages on each overflow;
        // the steady-state window sits between minMessages and the soft-limit capacity.
        assert.ok(history.length >= budget.minMessages, "window respects minMessages floor");
        assert.ok(maxLenObserved > budget.minMessages, "window grows above minMessages between trims");

        // A small append after a non-overflowing append should not trigger another trim:
        // it simply grows the history by one entry.
        const before = gs.getMetaSessionHistory();
        // Only meaningful when we are not already at the overflow boundary; trim the
        // window first by leaving it as-is and appending a tiny message.
        gs.appendMetaSessionHistory([{ role: "user", content: "tail-tiny" }]);
        const nextHistory = gs.getMetaSessionHistory();
        assert.ok(
            nextHistory.length >= before.length - 1,
            "a tiny append must not aggressively shrink the window",
        );
        assert.equal(nextHistory.at(-1)?.content, "tail-tiny");
        gs.dispose();
    });

    it("#4c clears meta session context stores", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        gs.addSessionDigest("bad digest");
        gs.appendMetaSessionHistory([
            { role: "assistant", content: "[SESSION_DIGEST]bad[/SESSION_DIGEST]\n<end_turn>" },
            { role: "user", content: "old context" },
        ]);

        assert.equal(gs.clearSessionDigests(), 1);
        assert.equal(gs.clearMetaSessionHistory(), 2);
        assert.deepEqual(gs.getSessionDigests(), []);
        assert.deepEqual(gs.getMetaSessionHistory(), []);
        assert.equal(gs.clearSessionDigests(), 0);
        assert.equal(gs.clearMetaSessionHistory(), 0);
        gs.dispose();
    });

    it("#5 save + load 持久化", () => {
        const dir = tempDir();
        const path = join(dir, "s.json");
        const gs1 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        gs1.memoSet("persisted", { source: "meta" });
        gs1.addSessionDigest("waiting for callback");
        gs1.setSignalPool([
            {
                chatId: "telegram:1",
                source: "TOPIC_SIGNAL",
                payload: { label: "团建" },
                enqueuedAt: Date.now(),
                pressure: 42,
                ignoredCount: 0,
            },
        ]);
        const wakeConditionId = gs1.addWakeCondition({ type: "delay", ms: 60_000 });
        gs1.save();
        gs1.dispose();

        const gs2 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        assert.deepEqual(gs2.memoGet("persisted"), { source: "meta" });
        assert.equal(gs2.getSessionDigests()[0]?.content, "waiting for callback");
        assert.equal(gs2.getSignalPool()[0]?.chatId, "telegram:1");
        assert.equal(gs2.getWakeConditions()[0]?.id, wakeConditionId);
        gs2.dispose();
    });

    it("#6 损坏文件恢复", () => {
        const dir = tempDir();
        const path = join(dir, "s.json");
        writeFileSync(path, "INVALID JSON!!!", "utf-8");

        const gs = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        assert.deepEqual(gs.getState().memos, [], "损坏文件应恢复为默认");
        gs.dispose();
    });

    it("#7 wakeCondition add/remove", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const id = gs.addWakeCondition({ type: "callback_received", taskId: "task-1" });
        assert.match(id, /^[0-9a-f]{8}$/);
        assert.equal(gs.getWakeConditions().length, 1);
        assert.equal(gs.removeWakeCondition(id), true);
        assert.equal(gs.removeWakeCondition(id), false);
        gs.dispose();
    });

    it("#8 signalPool set/get", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        gs.setSignalPool([
            {
                chatId: "telegram:group1",
                source: "TOPIC_SIGNAL",
                payload: { label: "技术讨论" },
                enqueuedAt: 123,
                pressure: 10,
                ignoredCount: 2,
            },
        ]);
        const pool = gs.getSignalPool();
        assert.equal(pool.length, 1);
        assert.equal(pool[0].ignoredCount, 2);
        gs.dispose();
    });

    it("#9 schedulerEvents 保持原有行为", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const reminder = gs.addReminder("chat-1", "回访", new Date(Date.now() + 60_000).toISOString());
        const cron = gs.addCron("chat-1", "日报", "0 9 * * *", "send daily summary");
        const events = gs.getSchedulerEvents("chat-1");
        assert.equal(events.length, 2);
        assert.match(reminder.id, /^[0-9a-f]{8}$/);
        assert.match(cron.id, /^[0-9a-f]{8}$/);
        assert.equal(gs.cancelSchedulerEvent(reminder.id), true);
        assert.equal(gs.getSchedulerEvents("chat-1").length, 1);
        assert.equal(gs.getSchedulerEvents("chat-1")[0].id, cron.id);
        gs.dispose();
    });

    it("#10 终态更新立即落盘（即使 autosave 关闭）", () => {
        const dir = tempDir();
        const path = join(dir, "s.json");
        // autoSaveInterval: 0 → 仅终态的立即 save() 能把状态写到磁盘
        const gs1 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        gs1.recordDispatchedSubagentTask({
            taskId: "task-1",
            chatId: "telegram:1",
            contentDirection: "reply",
            createdAt: new Date().toISOString(),
        });
        const updated = gs1.updateDispatchedSubagentTask("task-1", { status: "COMPLETED" });
        assert.equal(updated?.status, "COMPLETED");
        assert.ok(updated?.completedAt, "终态应自动补全 completedAt");
        // 故意不调用 save()/dispose() —— 验证终态写入已经落盘
        const gs2 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        const reloaded = gs2.getDispatchedSubagentTask("task-1");
        assert.equal(reloaded?.status, "COMPLETED");
        assert.ok(reloaded?.completedAt);
        gs1.dispose();
        gs2.dispose();
    });

    it("#11 启动对账：残留 RUNNING/PENDING 任务被标记为 TIMEOUT", () => {
        const dir = tempDir();
        const path = join(dir, "s.json");
        const gs1 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        // RUNNING 任务（执行中崩溃）
        gs1.recordDispatchedSubagentTask({
            taskId: "running-1",
            chatId: "telegram:1",
            contentDirection: "reply",
            createdAt: new Date().toISOString(),
        });
        gs1.updateDispatchedSubagentTask("running-1", { status: "RUNNING" });
        // PENDING 任务（入队未执行就崩溃）
        gs1.recordDispatchedSubagentTask({
            taskId: "pending-1",
            chatId: "telegram:1",
            contentDirection: "reply",
            createdAt: new Date().toISOString(),
        });
        // 已完成任务不应被对账
        gs1.recordDispatchedSubagentTask({
            taskId: "done-1",
            chatId: "telegram:1",
            contentDirection: "reply",
            createdAt: new Date().toISOString(),
        });
        gs1.updateDispatchedSubagentTask("done-1", { status: "COMPLETED" });
        gs1.save();
        gs1.dispose();

        const gs2 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        const running = gs2.getDispatchedSubagentTask("running-1");
        const pending = gs2.getDispatchedSubagentTask("pending-1");
        const done = gs2.getDispatchedSubagentTask("done-1");
        assert.equal(running?.status, "TIMEOUT");
        assert.ok(running?.completedAt);
        assert.match(running?.error ?? "", /process exited mid-flight/);
        assert.equal(pending?.status, "TIMEOUT");
        assert.match(pending?.error ?? "", /process exited mid-flight/);
        assert.equal(done?.status, "COMPLETED", "已完成任务不应被对账改写");
        gs2.dispose();
    });
});
