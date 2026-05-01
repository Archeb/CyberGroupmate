import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoApi } from "../src/meta-sandbox/meta-api/memo.js";
import { createScheduleApi } from "../src/meta-sandbox/meta-api/schedule.js";
import { buildMetaApiContext } from "../src/meta-sandbox/meta-api/index.js";

describe("createMemoApi", () => {
    it("delegates set/get/delete/list to global state", async () => {
        const calls: string[] = [];
        const api = createMemoApi({
            memoSet: (key: string, value: unknown, ttlMinutes?: number) => {
                calls.push(`set:${key}:${String(value)}:${ttlMinutes ?? ""}`);
            },
            memoGet: (key: string) => {
                calls.push(`get:${key}`);
                return { ok: true };
            },
            memoDelete: (key: string) => {
                calls.push(`delete:${key}`);
            },
            memoList: () => {
                calls.push("list");
                return [{ key: "x", value: 1 }];
            },
        } as any);

        await api.set("token", 7, 15);
        const found = await api.get("token");
        await api.delete("token");
        const rows = await api.list();

        assert.deepEqual(found, { ok: true });
        assert.deepEqual(rows, [{ key: "x", value: 1 }]);
        assert.deepEqual(calls, ["set:token:7:15", "get:token", "delete:token", "list"]);
    });
});

describe("createScheduleApi", () => {
    it("registers delay wake conditions and creates a paired reminder", async () => {
        const schedulerEvents = [] as any[];
        const api = createScheduleApi({
            addWakeCondition: () => "wake-1",
            removeWakeCondition: () => true,
            addReminder: (_chatId: string, description: string) => {
                const event = { id: "rem-1", type: "reminder", description };
                schedulerEvents.push(event);
                return event as any;
            },
            getSchedulerEvents: () => schedulerEvents as any,
            cancelSchedulerEvent: (id: string) => id === "rem-1",
        } as any);

        const result = await api.wakeOnCondition({ type: "delay", ms: 1000 });
        const cancelled = await api.cancel("wake-1");

        assert.equal(result.conditionId, "wake-1");
        assert.equal(result.reminderId, "rem-1");
        assert.deepEqual(cancelled, {
            removedWakeCondition: true,
            removedReminderIds: ["rem-1"],
        });
    });

    it("registers callback wake conditions without creating reminders", async () => {
        const api = createScheduleApi({
            addWakeCondition: () => "wake-2",
            removeWakeCondition: () => false,
            addReminder: () => {
                throw new Error("should not add reminder");
            },
            getSchedulerEvents: () => [],
            cancelSchedulerEvent: () => false,
        } as any);

        const result = await api.wakeOnCondition({ type: "callback_received", taskId: "task-1" });

        assert.deepEqual(result, { conditionId: "wake-2" });
    });
});

describe("buildMetaApiContext", () => {
    it("assembles all six meta api modules", () => {
        const context = buildMetaApiContext({
            memory: {} as any,
            subagentManager: {} as any,
            globalState: {} as any,
            accumulator: {} as any,
        });

        assert.equal(typeof context.conversations.query, "function");
        assert.equal(typeof context.memory.searchEntities, "function");
        assert.equal(typeof context.agents.listStatus, "function");
        assert.equal(typeof context.dispatch.taskToGroup, "function");
        assert.equal(typeof context.memo.set, "function");
        assert.equal(typeof context.schedule.wakeOnCondition, "function");
    });
});