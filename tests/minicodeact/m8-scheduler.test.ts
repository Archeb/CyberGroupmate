/**
 * m8-scheduler.test.ts — scheduler 命名空间单元测试
 *
 * 验证 scheduler.setReminder / setCron / cancel / list 的完整功能，
 * 包括 GlobalState 持久化、输入验证、到期检测、以及 system prompt 集成。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    executeMiniCodeActs,
    clearHandlers,
    getRegisteredNamespaces,
    type MiniCodeActDeps,
} from "../../src/main-agent/minicodeact-executor.js";

// Side-effect import: registers scheduler handlers
import "../../src/main-agent/minicodeact-handlers/scheduler.js";

import { GlobalState } from "../../src/main-agent/global-state.js";
import { readFileSync } from "node:fs";

// ─── Mock helpers ───

function makeTestGlobalState(id: number): GlobalState {
    const dir = "/tmp/cybergroupmate-test";
    return new GlobalState({
        filePath: join(dir, `scheduler-${id}.json`),
        autoSaveInterval: 0, // disable auto-save
    });
}

let testCounter = 0;

function makeDeps(): { deps: MiniCodeActDeps; globalState: GlobalState } {
    const globalState = makeTestGlobalState(++testCounter);
    const deps: MiniCodeActDeps = {
        globalState,
        memory: {} as any,
        attentionQueue: {} as any,
        subagentManager: {} as any,
    };
    return { deps, globalState };
}

// ─── Tests ───

describe("M8: scheduler 命名空间", () => {

    it("#1 scheduler.setReminder 正常设置一次性提醒", () => {
        const { deps, globalState } = makeDeps();
        const future = new Date(Date.now() + 60 * 60_000).toISOString(); // 1h later

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:group_1", description: "提醒拿外卖", triggerAt: future } }],
            "tg:group_1",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.ok(result.reminderId, "should return reminderId");

        // 验证 GlobalState 存储
        const events = globalState.getSchedulerEvents("tg:group_1");
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "reminder");
        assert.equal(events[0].description, "提醒拿外卖");
        assert.equal(events[0].triggered, false);
    });

    it("#2 scheduler.setReminder 使用当前 chatId 作默认", () => {
        const { deps, globalState } = makeDeps();
        const future = new Date(Date.now() + 10 * 60_000).toISOString();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { description: "默认群提醒", triggerAt: future } }],
            "tg:default_group",
            deps,
        );

        assert.equal(results[0].success, true);
        const events = globalState.getSchedulerEvents("tg:default_group");
        assert.equal(events.length, 1);
    });

    it("#3 scheduler.setReminder 缺少 description → 失败", () => {
        const { deps } = makeDeps();
        const future = new Date(Date.now() + 10 * 60_000).toISOString();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:1", triggerAt: future } }],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("description"));
    });

    it("#4 scheduler.setReminder 缺少 triggerAt → 失败", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:1", description: "test" } }],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("triggerAt"));
    });

    it("#5 scheduler.setReminder 无效时间格式 → 失败", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:1", description: "test", triggerAt: "not-a-date" } }],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("invalid triggerAt"));
    });

    it("#6 scheduler.setReminder 过去的时间 → 失败", () => {
        const { deps } = makeDeps();
        const past = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:1", description: "test", triggerAt: past } }],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("past"));
    });

    it("#7 scheduler.setReminder 含 requestedBy", () => {
        const { deps, globalState } = makeDeps();
        const future = new Date(Date.now() + 30 * 60_000).toISOString();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:1", description: "提醒小明", triggerAt: future, requestedBy: "user_456" } }],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, true);
        const events = globalState.getSchedulerEvents("tg:1");
        assert.equal(events[0].requestedBy, "user_456");
    });

    it("#8 scheduler.setCron 正常设置周期任务", () => {
        const { deps, globalState } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setCron", args: {
                chatId: "tg:group_456",
                description: "每日天气播报",
                cronExpr: "0 9 * * *",
                taskTemplate: "查询今日天气并在群里播报",
            }}],
            "tg:group_456",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.ok(result.cronId, "should return cronId");

        const events = globalState.getSchedulerEvents("tg:group_456");
        assert.equal(events.length, 1);
        assert.equal(events[0].type, "cron");
        assert.equal(events[0].cronExpr, "0 9 * * *");
        assert.equal(events[0].taskTemplate, "查询今日天气并在群里播报");
    });

    it("#9 scheduler.setCron 无效 cron 表达式 → 失败", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setCron", args: {
                chatId: "tg:1",
                description: "bad cron",
                cronExpr: "not-valid",
                taskTemplate: "test",
            }}],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("invalid cron"));
    });

    it("#10 scheduler.setCron 缺少 taskTemplate → 失败", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setCron", args: {
                chatId: "tg:1",
                description: "test",
                cronExpr: "0 9 * * *",
            }}],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("taskTemplate"));
    });

    it("#11 scheduler.cancel 取消已设置的提醒", () => {
        const { deps, globalState } = makeDeps();
        const future = new Date(Date.now() + 60 * 60_000).toISOString();

        // 先设置一个提醒
        const setResults = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:1", description: "will cancel", triggerAt: future } }],
            "tg:1",
            deps,
        );
        const reminderId = (setResults[0].result as any).reminderId;

        // 取消
        const cancelResults = executeMiniCodeActs(
            [{ call: "scheduler.cancel", args: { id: reminderId } }],
            "tg:1",
            deps,
        );

        assert.equal(cancelResults[0].success, true);
        const result = cancelResults[0].result as any;
        assert.equal(result.success, true);

        // 验证已删除
        assert.equal(globalState.getSchedulerEvents().length, 0);
    });

    it("#12 scheduler.cancel 不存在的 ID → success false", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.cancel", args: { id: "nonexistent-id" } }],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, true);
        const result = results[0].result as any;
        assert.equal(result.success, false);
    });

    it("#13 scheduler.list 查看所有调度", () => {
        const { deps, globalState } = makeDeps();
        const future = new Date(Date.now() + 60 * 60_000).toISOString();

        // 设置一个提醒和一个 cron
        executeMiniCodeActs([
            { call: "scheduler.setReminder", args: { chatId: "tg:1", description: "r1", triggerAt: future } },
            { call: "scheduler.setCron", args: { chatId: "tg:1", description: "c1", cronExpr: "0 9 * * *", taskTemplate: "test" } },
        ], "tg:1", deps);

        // 查看列表
        const listResults = executeMiniCodeActs(
            [{ call: "scheduler.list", args: { chatId: "tg:1" } }],
            "tg:1",
            deps,
        );

        assert.equal(listResults[0].success, true);
        const result = listResults[0].result as any;
        assert.equal(result.events.length, 2);
        assert.ok(result.events.some((e: any) => e.type === "reminder"));
        assert.ok(result.events.some((e: any) => e.type === "cron"));
    });

    it("#14 scheduler.list 按 chatId 过滤", () => {
        const { deps } = makeDeps();
        const future = new Date(Date.now() + 60 * 60_000).toISOString();

        executeMiniCodeActs([
            { call: "scheduler.setReminder", args: { chatId: "tg:group_A", description: "r-A", triggerAt: future } },
            { call: "scheduler.setReminder", args: { chatId: "tg:group_B", description: "r-B", triggerAt: future } },
        ], "tg:x", deps);

        const listA = executeMiniCodeActs(
            [{ call: "scheduler.list", args: { chatId: "tg:group_A" } }],
            "tg:x", deps,
        );
        assert.equal((listA[0].result as any).events.length, 1);
        assert.equal((listA[0].result as any).events[0].description, "r-A");
    });

    it("#15 GlobalState.getDueReminders 检测到期提醒", () => {
        const globalState = makeTestGlobalState(++testCounter);
        const pastTime = new Date(Date.now() - 1000).toISOString();
        const futureTime = new Date(Date.now() + 3600_000).toISOString();

        globalState.addReminder("tg:1", "past reminder", pastTime);
        globalState.addReminder("tg:1", "future reminder", futureTime);

        const due = globalState.getDueReminders();
        assert.equal(due.length, 1);
        assert.equal(due[0].description, "past reminder");
    });

    it("#16 GlobalState.markReminderTriggered 标记已触发", () => {
        const globalState = makeTestGlobalState(++testCounter);
        const pastTime = new Date(Date.now() - 1000).toISOString();

        const event = globalState.addReminder("tg:1", "test", pastTime);
        assert.equal(globalState.getDueReminders().length, 1);

        const success = globalState.markReminderTriggered(event.id);
        assert.equal(success, true);
        assert.equal(globalState.getDueReminders().length, 0); // 触发后不再出现
    });

    it("#17 GlobalState save/load 包含 schedulerEvents", () => {
        const id = Date.now() + Math.floor(Math.random() * 10000);
        const gs1 = makeTestGlobalState(id);
        const future = new Date(Date.now() + 60 * 60_000).toISOString();

        gs1.addReminder("tg:1", "persistent reminder", future);
        gs1.addCron("tg:2", "daily task", "0 9 * * *", "do stuff");
        gs1.save();

        // 新实例应恢复
        const gs2 = makeTestGlobalState(id);
        const events = gs2.getSchedulerEvents();
        assert.equal(events.length, 2);
        assert.ok(events.some(e => e.type === "reminder" && e.description === "persistent reminder"));
        assert.ok(events.some(e => e.type === "cron" && e.cronExpr === "0 9 * * *"));

        gs1.dispose();
        gs2.dispose();
    });

    it("#18 scheduler 已注册到 HANDLER_MAP", () => {
        const namespaces = getRegisteredNamespaces();
        assert.ok(namespaces.includes("scheduler"), "scheduler namespace should be registered");
    });

    it("#19 system prompt 包含 scheduler API", () => {
        const promptPath = join(
            process.cwd(),
            "system-prompts/main-agent/mainagent-main-system.md"
        );
        assert.ok(existsSync(promptPath), "system prompt file should exist");
        const content = readFileSync(promptPath, "utf-8");
        assert.ok(content.includes("scheduler.setReminder"), "should mention setReminder");
        assert.ok(content.includes("scheduler.setCron"), "should mention setCron");
        assert.ok(content.includes("scheduler.cancel"), "should mention cancel");
        assert.ok(content.includes("scheduler.list"), "should mention list");
    });

    it("#20 scheduler.cancel 缺少 id → 失败", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.cancel", args: {} }],
            "tg:1",
            deps,
        );

        assert.equal(results[0].success, false);
        assert.ok(results[0].error?.includes("id"));
    });

    it("#21 describe 函数返回可读描述", () => {
        const { deps } = makeDeps();
        const future = new Date(Date.now() + 60 * 60_000).toISOString();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setReminder", args: { chatId: "tg:1", description: "拿外卖", triggerAt: future } }],
            "tg:1",
            deps,
        );

        assert.ok(results[0].summary.includes("拿外卖"));
        assert.ok(results[0].summary.includes("已设置提醒"));
    });

    it("#22 scheduler.setCron 5 字段 cron 合法", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setCron", args: { chatId: "tg:1", description: "test", cronExpr: "*/5 * * * *", taskTemplate: "check" } }],
            "tg:1",
            deps,
        );
        assert.equal(results[0].success, true);
    });

    it("#23 scheduler.setCron 7 字段 cron 合法", () => {
        const { deps } = makeDeps();

        const results = executeMiniCodeActs(
            [{ call: "scheduler.setCron", args: { chatId: "tg:1", description: "test", cronExpr: "0 9 * * 1-5 2026 CST", taskTemplate: "check" } }],
            "tg:1",
            deps,
        );
        assert.equal(results[0].success, true);
    });

    it("#24 多个 reminder 可同时存在于同一群组", () => {
        const { deps, globalState } = makeDeps();
        const f1 = new Date(Date.now() + 30 * 60_000).toISOString();
        const f2 = new Date(Date.now() + 60 * 60_000).toISOString();

        executeMiniCodeActs([
            { call: "scheduler.setReminder", args: { chatId: "tg:1", description: "r1", triggerAt: f1 } },
            { call: "scheduler.setReminder", args: { chatId: "tg:1", description: "r2", triggerAt: f2 } },
        ], "tg:1", deps);

        assert.equal(globalState.getSchedulerEvents("tg:1").length, 2);
    });

    it("#25 GlobalState 向后兼容: 旧数据无 schedulerEvents 字段", () => {
        const id = Date.now() + Math.floor(Math.random() * 100000);
        const filePath = `/tmp/cybergroupmate-test/scheduler-compat-${id}.json`;

        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        // 写入不含 schedulerEvents 的旧版状态
        writeFileSync(filePath, JSON.stringify({
            lastActiveAt: new Date().toISOString(),
            taskList: [],
            recentDecisions: [],
            pendingFollowups: [],
            attentionSummary: "",
            notes: [],
            // 无 schedulerEvents
        }));

        const gs = new GlobalState({ filePath, autoSaveInterval: 0 });
        const events = gs.getSchedulerEvents();
        assert.ok(Array.isArray(events));
        assert.equal(events.length, 0);
        gs.dispose();
    });
});
