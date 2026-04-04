/**
 * m2-tasks-notes.test.ts — M2 tasks + notes 命名空间 单元测试
 */

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { GlobalState } from "../../src/main-agent/global-state.js";
import {
    executeMiniCodeActs,
    clearHandlers,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";
import { formatMiniCodeActReport } from "../../src/main-agent/minicodeact-formatter.js";
import {
    renderPrompt,
    renderTemplate,
    setPromptDirectory,
    clearTemplateCache,
} from "../../src/main-agent/prompt-renderer.js";

// Import handlers (side-effect: registers them)
import "../../src/main-agent/minicodeact-handlers/tasks.js";
import "../../src/main-agent/minicodeact-handlers/notes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

const tempDirs: string[] = [];
function tempDir(): string {
    const d = join(tmpdir(), `m2-${randomUUID()}`);
    mkdirSync(d, { recursive: true });
    tempDirs.push(d);
    return d;
}
after(() => {
    for (const d of tempDirs) if (existsSync(d)) rmSync(d, { recursive: true, force: true });
});

function createGS(): GlobalState {
    const dir = tempDir();
    return new GlobalState({ filePath: join(dir, "s.json"), autoSaveInterval: 0 });
}

function mockDeps(gs: GlobalState): MiniCodeActDeps {
    return {
        globalState: gs,
        memory: {} as any,
        attentionQueue: {} as any,
        subagentManager: {} as any,
    };
}

describe("M2: tasks + notes 命名空间", () => {
    beforeEach(() => {
        clearTemplateCache();
        setPromptDirectory(join(projectRoot, "system-prompts"));
    });

    // ── tasks ──

    it("#1 tasks.add 正常调用", () => {
        const gs = createGS();
        const results = executeMiniCodeActs(
            [{ call: "tasks.add", args: { description: "买菜" } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].success, true);
        assert.ok((results[0].result as any).taskId);
        assert.equal(gs.getTaskList().length, 1);
        assert.equal(gs.getTaskList()[0].description, "买菜");
        gs.dispose();
    });

    it("#2 tasks.add 缺少 description", () => {
        const gs = createGS();
        const results = executeMiniCodeActs(
            [{ call: "tasks.add", args: {} }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, false);
        assert.ok(results[0].error!.includes("description"));
        gs.dispose();
    });

    it("#3 tasks.add 自定义 priority", () => {
        const gs = createGS();
        executeMiniCodeActs(
            [{ call: "tasks.add", args: { description: "紧急任务", priority: "HIGH" } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(gs.getTaskList()[0].priority, "HIGH");
        gs.dispose();
    });

    it("#4 tasks.update 正常调用", () => {
        const gs = createGS();
        const task = gs.addTask("test task");
        const results = executeMiniCodeActs(
            [{ call: "tasks.update", args: { taskId: task.id, status: "DONE" } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, true);
        assert.equal((results[0].result as any).success, true);
        assert.equal(gs.getTaskList()[0].status, "DONE");
        gs.dispose();
    });

    it("#5 tasks.update 无效 taskId", () => {
        const gs = createGS();
        const results = executeMiniCodeActs(
            [{ call: "tasks.update", args: { taskId: "nonexistent", status: "DONE" } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, true); // handler doesn't throw, returns { success: false }
        assert.equal((results[0].result as any).success, false);
        gs.dispose();
    });

    it("#6 tasks.addFollowup 正常调用", () => {
        const gs = createGS();
        const results = executeMiniCodeActs(
            [{
                call: "tasks.addFollowup",
                args: {
                    sourceChatId: "tg:groupA",
                    targetChatId: "tg:groupB",
                    description: "转告聚会时间",
                },
            }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, true);
        assert.ok((results[0].result as any).followupId);
        assert.equal(gs.getPendingFollowups().length, 1);
        gs.dispose();
    });

    it("#7 tasks.completeFollowup 正常调用", () => {
        const gs = createGS();
        const fuId = gs.addFollowup("a", "b", "test");
        const results = executeMiniCodeActs(
            [{ call: "tasks.completeFollowup", args: { followupId: fuId } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, true);
        assert.equal((results[0].result as any).success, true);
        const fu = gs.getPendingFollowups().find(f => f.id === fuId);
        assert.equal(fu!.status, "DONE");
        gs.dispose();
    });

    // ── notes ──

    it("#8 notes.add 正常调用", () => {
        const gs = createGS();
        const results = executeMiniCodeActs(
            [{ call: "notes.add", args: { content: "这是一条笔记" } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, true);
        assert.ok((results[0].result as any).noteId);
        assert.equal(gs.getNotes().length, 1);
        assert.equal(gs.getNotes()[0].content, "这是一条笔记");
        gs.dispose();
    });

    it("#9 notes.add 含 tags 和 expiresAt", () => {
        const gs = createGS();
        const expiresAt = new Date(Date.now() + 3600_000).toISOString();
        executeMiniCodeActs(
            [{
                call: "notes.add",
                args: {
                    content: "带标签的笔记",
                    tags: ["important", "followup"],
                    expiresAt,
                },
            }],
            "chat1",
            mockDeps(gs),
        );
        const note = gs.getNotes()[0];
        assert.deepEqual(note.tags, ["important", "followup"]);
        assert.equal(note.expiresAt, expiresAt);
        gs.dispose();
    });

    it("#10 notes.remove 正常调用", () => {
        const gs = createGS();
        const note = gs.addNote("to be removed");
        assert.equal(gs.getNotes().length, 1);

        const results = executeMiniCodeActs(
            [{ call: "notes.remove", args: { noteId: note.id } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, true);
        assert.equal((results[0].result as any).success, true);
        assert.equal(gs.getNotes().length, 0);
        gs.dispose();
    });

    it("#11 notes.remove 无效 noteId", () => {
        const gs = createGS();
        const results = executeMiniCodeActs(
            [{ call: "notes.remove", args: { noteId: "nonexistent" } }],
            "chat1",
            mockDeps(gs),
        );
        assert.equal(results[0].success, true); // handler doesn't throw
        assert.equal((results[0].result as any).success, false);
        gs.dispose();
    });

    it("#12 cleanExpiredNotes 清理过期笔记", () => {
        const gs = createGS();
        // Add an expired note
        gs.addNote("expired", [], undefined, "2020-01-01T00:00:00Z");
        // Add a valid note
        gs.addNote("valid", [], undefined, new Date(Date.now() + 3600_000).toISOString());
        // Add a note without expiry
        gs.addNote("no expiry");

        assert.equal(gs.getNotes().length, 3);
        const removed = gs.cleanExpiredNotes();
        assert.equal(removed, 1, "should remove 1 expired note");
        assert.equal(gs.getNotes().length, 2);
        assert.ok(gs.getNotes().every(n => n.content !== "expired"));
        gs.dispose();
    });

    it("#13 getNotes(chatId) 按 chatId 过滤", () => {
        const gs = createGS();
        gs.addNote("global note");  // no relatedChatId
        gs.addNote("chat1 note", [], "chat1");
        gs.addNote("chat2 note", [], "chat2");

        const chat1Notes = gs.getNotes("chat1");
        // Should include: global note (no chatId) + chat1 note
        assert.equal(chat1Notes.length, 2);
        assert.ok(chat1Notes.some(n => n.content === "global note"));
        assert.ok(chat1Notes.some(n => n.content === "chat1 note"));
        assert.ok(!chat1Notes.some(n => n.content === "chat2 note"));
        gs.dispose();
    });

    it("#14 GlobalState save/load 包含 notes", () => {
        const dir = tempDir();
        const filePath = join(dir, "s.json");

        // Write
        const gs1 = new GlobalState({ filePath, autoSaveInterval: 0 });
        gs1.addNote("persistent note", ["test"]);
        gs1.save();
        gs1.dispose();

        // Reload
        const gs2 = new GlobalState({ filePath, autoSaveInterval: 0 });
        assert.equal(gs2.getNotes().length, 1);
        assert.equal(gs2.getNotes()[0].content, "persistent note");
        assert.deepEqual(gs2.getNotes()[0].tags, ["test"]);
        gs2.dispose();
    });

    it("#15 ATTENTION prompt 含工作笔记区块", () => {
        const template = readFileSync(
            join(projectRoot, "system-prompts", "main-agent", "mainagent-attention.md"),
            "utf-8",
        );

        // With notes
        const rendered = renderTemplate(template, {
            chatTitle: "测试群",
            chatId: "tg:123",
            chatType: "群聊",
            attentionSummary: "",
            recentDecisions: "",
            activeTasks: "",
            stickinessLevel: "FAMILIAR",
            snapshotTimestamp: "2026-04-04",
            lastAttendedAt: "",
            timeSinceLastAttend: "5分钟",
            depth: "2",
            priorityMultiplier: "0.7",
            topicDigests: "",
            newMessageCount: "5",
            messages: "",
            hasNotes: true,
            notes: "- [n1] 测试笔记 (test)",
        });

        assert.ok(rendered.includes("工作笔记"), "should contain workbench header");
        assert.ok(rendered.includes("测试笔记"), "should contain note content");

        // Without notes
        const renderedNoNotes = renderTemplate(template, {
            chatTitle: "测试群",
            chatId: "tg:123",
            chatType: "群聊",
            hasNotes: false,
        });
        assert.ok(!renderedNoNotes.includes("工作笔记"), "should not contain workbench when no notes");
    });

    // ── E2E ──

    it("#16 E2E: tasks.add miniCodeAct → GlobalState 含新任务", () => {
        const gs = createGS();
        const deps = mockDeps(gs);

        // Simulate full flow
        const results = executeMiniCodeActs(
            [{ call: "tasks.add", args: { description: "E2E 测试任务", priority: "HIGH" } }],
            "tg:group_1",
            deps,
        );

        assert.equal(results.length, 1);
        assert.equal(results[0].success, true);
        assert.equal(gs.getTaskList().length, 1);
        assert.equal(gs.getTaskList()[0].description, "E2E 测试任务");
        assert.equal(gs.getTaskList()[0].priority, "HIGH");

        const report = formatMiniCodeActReport(results);
        assert.ok(report.includes("✅"));
        assert.ok(report.includes("tasks.add"));
        gs.dispose();
    });

    it("#17 E2E: notes.add → ATTENTION prompt 含该笔记", () => {
        const gs = createGS();
        const deps = mockDeps(gs);

        // Add note via MiniCodeAct
        executeMiniCodeActs(
            [{
                call: "notes.add",
                args: {
                    content: "群 A 正在讨论政治话题",
                    tags: ["敏感", "暂不介入"],
                    relatedChatId: "tg:groupA",
                },
            }],
            "tg:groupA",
            deps,
        );

        // Simulate building attention prompt
        gs.cleanExpiredNotes();
        const notes = gs.getNotes("tg:groupA");
        assert.equal(notes.length, 1);

        const notesText = notes.map(n =>
            `- [${n.id}] ${n.content} (${n.tags.join(", ")})`
        ).join("\n");

        const template = readFileSync(
            join(projectRoot, "system-prompts", "main-agent", "mainagent-attention.md"),
            "utf-8",
        );
        const rendered = renderTemplate(template, {
            chatTitle: "GroupA",
            chatId: "tg:groupA",
            chatType: "群聊",
            hasNotes: notes.length > 0,
            notes: notesText,
        });

        assert.ok(rendered.includes("工作笔记"));
        assert.ok(rendered.includes("群 A 正在讨论政治话题"));
        assert.ok(rendered.includes("敏感"));
        gs.dispose();
    });
});
