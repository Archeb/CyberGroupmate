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

    it("#4 addSessionDigest cap at 10", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        for (let i = 0; i < 12; i++) gs.addSessionDigest(`digest-${i}`);
        const digests = gs.getSessionDigests();
        assert.equal(digests.length, 10);
        assert.equal(digests[0].content, "digest-2");
        assert.equal(digests.at(-1)?.content, "digest-11");
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
        assert.ok(id);
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
        assert.equal(gs.cancelSchedulerEvent(reminder.id), true);
        assert.equal(gs.getSchedulerEvents("chat-1").length, 1);
        assert.equal(gs.getSchedulerEvents("chat-1")[0].id, cron.id);
        gs.dispose();
    });
});
