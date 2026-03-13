/**
 * s6-global-state.test.ts — S6 GlobalState + TaskList 单元测试
 *
 * 从 s6-s7-s8-integration.test.ts 拆分 + s-audit-edge-cases.test.ts 合并
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";

import { GlobalState } from "../src/main-agent/global-state.js";
import { createTaskListSkill } from "../src/sandbox/skills/task-list.js";

const tempDirs: string[] = [];
function tempDir(): string { const d = join(tmpdir(), `s6-${randomUUID()}`); mkdirSync(d, { recursive: true }); tempDirs.push(d); return d; }
after(() => { for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true }); });

describe("S6: Global State + TaskList", () => {
    it("#1 GlobalState 初始化（空文件）", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const state = gs.getState();
        assert.ok(state.lastActiveAt);
        assert.deepEqual(state.taskList, []);
        assert.deepEqual(state.recentDecisions, []);
        gs.dispose();
    });

    it("#2 addTask + getTaskList", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const task = gs.addTask("Fix bug", "chat1", "HIGH");
        assert.equal(task.description, "Fix bug");
        assert.equal(task.status, "PENDING");
        assert.equal(gs.getTaskList().length, 1);
        gs.dispose();
    });

    it("#3 updateTaskStatus", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const task = gs.addTask("Test");
        gs.updateTaskStatus(task.id, "DONE");
        const updated = gs.getTaskList()[0];
        assert.equal(updated.status, "DONE");
        assert.ok(updated.completedAt);
        gs.dispose();
    });

    it("#4 recordDecision cap at maxRecentDecisions", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0, maxRecentDecisions: 3 });
        for (let i = 0; i < 5; i++) gs.recordDecision("c1", `d${i}`);
        assert.equal(gs.getRecentDecisions().length, 3, "should cap at 3");
        gs.dispose();
    });

    it("#5 save + load 持久化", () => {
        const dir = tempDir();
        const path = join(dir, "s.json");
        const gs1 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        gs1.addTask("Persist me");
        gs1.save();
        gs1.dispose();

        const gs2 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        assert.equal(gs2.getTaskList().length, 1);
        assert.equal(gs2.getTaskList()[0].description, "Persist me");
        gs2.dispose();
    });

    it("#6 损坏文件恢复", () => {
        const dir = tempDir();
        const path = join(dir, "s.json");
        writeFileSync(path, "INVALID JSON!!!", "utf-8");

        const gs = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        assert.deepEqual(gs.getTaskList(), [], "损坏文件应恢复为默认");
        gs.dispose();
    });

    it("#7 addFollowup + completeFollowup", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const id = gs.addFollowup("c1", "c2", "relay message");
        assert.ok(id);
        assert.equal(gs.completeFollowup(id), true);
        gs.dispose();
    });

    it("#8 TaskListSkill.list() 过滤", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        gs.addTask("A", "chat1");
        gs.addTask("B", "chat2");
        gs.addTask("C", "chat1");

        const skill = createTaskListSkill(gs);
        assert.equal(skill.list({ chatId: "chat1" }).length, 2);
        assert.equal(skill.list({ chatId: "chat2" }).length, 1);
        gs.dispose();
    });

    it("#9 TaskListSkill.add()", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const skill = createTaskListSkill(gs);
        const task = skill.add("New task", "c1", "HIGH");
        assert.equal(task.priority, "HIGH");
        assert.equal(gs.getTaskList().length, 1);
        gs.dispose();
    });

    it("#10 TaskListSkill.update()", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const skill = createTaskListSkill(gs);
        const task = skill.add("To update");
        assert.equal(skill.update(task.id, "IN_PROGRESS"), true);
        assert.equal(skill.update("nonexistent", "DONE"), false);
        gs.dispose();
    });

    // ─── Edge cases (from audit) ───

    it("#11 updateAttentionSummary persists across reload", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        gs.updateAttentionSummary("Monitoring 3 groups.");
        assert.equal(gs.getAttentionSummary(), "Monitoring 3 groups.");
        gs.save();
        const gs2 = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        assert.equal(gs2.getAttentionSummary(), "Monitoring 3 groups.");
        gs.dispose(); gs2.dispose();
    });

    it("#12 concurrent task operations", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const t1 = gs.addTask("Task A", "g1", "HIGH");
        const t2 = gs.addTask("Task B", "g2", "LOW");
        gs.addTask("Task C", undefined, "MEDIUM");
        gs.updateTaskStatus(t1.id, "IN_PROGRESS");
        gs.updateTaskStatus(t2.id, "DONE");
        const tasks = gs.getTaskList();
        assert.equal(tasks.length, 3);
        assert.equal(tasks.find(t => t.id === t1.id)!.status, "IN_PROGRESS");
        assert.equal(tasks.find(t => t.id === t2.id)!.status, "DONE");
        assert.ok(tasks.find(t => t.id === t2.id)!.completedAt);
        gs.dispose();
    });

    it("#13 TaskListSkill.update nonexistent returns false", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        const skill = createTaskListSkill(gs);
        assert.equal(skill.update("nonexistent-id", "DONE"), false);
        gs.dispose();
    });

    it("#14 recordDecision tracks chatId + timestamp", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        gs.recordDecision("g1", "REPLY:BATCH");
        gs.recordDecision("g2", "OBSERVE");
        assert.equal(gs.getRecentDecisions().length, 2);
        assert.equal(gs.getRecentDecisions()[0].chatId, "g1");
        assert.ok(gs.getRecentDecisions()[0].timestamp);
        gs.dispose();
    });

    it("#15 completeFollowup for nonexistent id returns false", () => {
        const dir = tempDir();
        const gs = new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
        assert.equal(gs.completeFollowup("nope"), false);
        gs.dispose();
    });
});
