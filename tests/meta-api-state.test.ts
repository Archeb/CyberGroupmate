import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTodoApi } from "../src/meta-sandbox/meta-api/todo.js";
import { createCronApi, createReminderApi } from "../src/meta-sandbox/meta-api/scheduler.js";
import { buildMetaApiContext } from "../src/meta-sandbox/meta-api/index.js";

describe("createTodoApi", () => {
    it("stores todo items by explicit binding id", async () => {
        const store = new Map<string, any>();
        const api = createTodoApi({
            listGroupModels: () => [{ chatId: "chat-1" }],
            todoList: (bindingId: string) => [...store.values()].filter((row) => row.bindingId === bindingId),
            todoGet: (bindingId: string, key: string) => store.get(`${bindingId}:${key}`) ?? null,
            todoUpsert: (bindingId: string, key: string, content: string, dueAt?: string | null) => {
                const row = { bindingId, key, content, dueAt: dueAt ?? null, createdAt: "now", updatedAt: "now", expired: false };
                store.set(`${bindingId}:${key}`, row);
                return row;
            },
            todoRemove: (bindingId: string, key: string) => {
                store.delete(`${bindingId}:${key}`);
            },
        } as any);

        const item = await api.set({ bindingId: "chat-1", key: "follow", content: "检查回复" });
        assert.equal(item.bindingId, "chat-1");
        assert.equal((await api.get("follow", "chat-1"))?.content, "检查回复");
        assert.equal((await api.list({ bindingId: "chat-1" })).length, 1);
        await api.delete("follow", "chat-1");
        assert.equal(await api.get("follow", "chat-1"), null);
    });
});

describe("scheduler APIs", () => {
    it("creates reminder with required callback and binding data", async () => {
        const events: any[] = [];
        const api = createReminderApi({
            addReminder: (chatId: string, description: string, triggerAt: string, requestedBy: string, options: any) => {
                const event = { id: "rem-1", type: "reminder", chatId, description, triggerAt, requestedBy, createdAt: "now", ...options };
                events.push(event);
                return event;
            },
            addCron: () => { throw new Error("unused"); },
            getSchedulerEvents: () => events,
            cancelSchedulerEvent: (id: string) => id === "rem-1",
        } as any);

        const event = await api.set({
            name: "回看",
            bindingId: "telegram:1",
            delayMinutes: 5,
            callback: "检查后续回复",
            data: { taskId: "t1" },
        });

        assert.equal(event.id, "rem-1");
        assert.equal(event.bindingId, "telegram:1");
        assert.equal(event.callback, "检查后续回复");
        assert.deepEqual(event.data, { taskId: "t1" });
        await assert.rejects(() => api.set({ name: "bad", delayMinutes: 1, callback: "" }), /callback/);
    });

    it("creates cron with required callback", async () => {
        const events: any[] = [];
        const api = createCronApi({
            addReminder: () => { throw new Error("unused"); },
            addCron: (chatId: string, description: string, cronExpr: string, taskTemplate: string, options: any) => {
                const event = { id: "cron-1", type: "cron", chatId, description, cronExpr, taskTemplate, createdAt: "now", ...options };
                events.push(event);
                return event;
            },
            getSchedulerEvents: () => events,
            cancelSchedulerEvent: (id: string) => id === "cron-1",
        } as any);

        const event = await api.set({
            name: "日报",
            bindingId: "meta",
            cronExpr: "0 9 * * *",
            callback: "整理昨日 digest",
        });

        assert.equal(event.id, "cron-1");
        assert.equal(event.bindingId, "meta");
        assert.equal(event.callback, "整理昨日 digest");
    });
});

describe("buildMetaApiContext", () => {
    it("assembles meta api modules", () => {
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
        assert.equal(typeof context.todo.set, "function");
        assert.equal(typeof context.remind.set, "function");
        assert.equal(typeof context.cron.set, "function");
    });
});
