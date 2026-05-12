import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDispatchApi } from "../src/meta-sandbox/meta-api/dispatch.js";

describe("createDispatchApi", () => {
    it("builds and enqueues a CodeActReplyTask with serialized context and grounding", async () => {
        const enqueued: any[] = [];
        const marked: string[] = [];
        const dispatched: string[] = [];
        const subagent = {
            chatId: "telegram:1",
            codeActExecutor: {
                enqueue: (task: unknown) => {
                    enqueued.push(task);
                },
                getSessionFilePath: () => "workspace/sessions/telegram/1.json",
            },
        };

        const api = createDispatchApi({
            memory: {} as any,
            subagentManager: {
                getOrCreate: () => subagent as any,
                getSessionFilePath: () => "workspace/sessions/telegram/1.json",
            },
            accumulator: {
                markActioned: (chatId: string) => {
                    marked.push(chatId);
                },
            } as any,
            onTaskDispatched: (task) => {
                dispatched.push(`${task.chatId}:${task.decisions[0]?.action}`);
            },
            groundingConfig: {
                provider: "google",
                apiKey: "test",
                baseUrl: "https://example.invalid",
            },
            groundingRunner: async () => "grounded",
            taskIdFactory: () => "task-meta-1",
            getActiveUserProfilesForChat: (chatId) => chatId === "telegram:1"
                ? [{
                    userId: "telegram:u1",
                    displayName: "阿喵",
                    aliases: [],
                    currentChatLabel: "快乐摸鱼群(telegram:1)",
                    messageCount: 1,
                }]
                : undefined,
        });

        const result = await api.taskToGroup("telegram:1", {
            contentDirection: "reply with a concise answer",
            toneGuidance: "calm",
            context: { facts: ["x"] },
            useSkills: ["memory", "telegram"],
        });

        assert.equal(result.taskId, "task-meta-1");
        assert.equal(enqueued.length, 1);
        assert.deepEqual(marked, ["telegram:1"]);
        assert.deepEqual(dispatched, ["telegram:1:REPLY"]);
        assert.equal(enqueued[0].taskId, "task-meta-1");
        assert.equal(enqueued[0].decisions[0].action, "REPLY");
        assert.equal(enqueued[0].contextSnapshot.contentDirection, "reply with a concise answer");
        assert.equal(enqueued[0].contextSnapshot.toneGuidance, "calm");
        assert.equal(enqueued[0].contextSnapshot.groundingContext, "grounded");
        assert.equal(enqueued[0].contextSnapshot.personContext, undefined);
        assert.equal(enqueued[0].contextSnapshot.dispatchContext, JSON.stringify({ facts: ["x"] }));
        assert.equal(enqueued[0].contextSnapshot.activeUserProfiles[0].userId, "telegram:u1");
        assert.deepEqual(enqueued[0].useSkills, ["memory", "telegram"]);
    });

    it("creates and initializes an executor when the subagent has none", async () => {
        const events: string[] = [];
        const createdExecutors: any[] = [];
        const subagent = {
            chatId: "telegram:2",
            codeActExecutor: null as any,
        };

        const api = createDispatchApi({
            memory: {} as any,
            subagentManager: {
                getOrCreate: () => subagent as any,
                getSessionFilePath: () => "workspace/sessions/telegram/2.json",
            },
            accumulator: {
                markActioned: () => {
                    events.push("markActioned");
                },
            } as any,
            executorFactory: () => {
                const executor = {
                    sessionFilePath: null as string | null,
                    setSessionFilePath(filePath: string) {
                        this.sessionFilePath = filePath;
                        events.push(`setSessionFilePath:${filePath}`);
                    },
                    getSessionFilePath() {
                        return this.sessionFilePath;
                    },
                    loadSession() {
                        events.push("loadSession");
                    },
                    enqueue(task: unknown) {
                        createdExecutors.push(task);
                        events.push("enqueue");
                    },
                };
                return executor as any;
            },
            initializeExecutor: async () => {
                events.push("initializeExecutor");
            },
            taskIdFactory: () => "task-meta-2",
        });

        await api.taskToGroup("telegram:2", {
            contentDirection: "say hi",
        });

        assert.ok(subagent.codeActExecutor);
        assert.deepEqual(events, [
            "setSessionFilePath:workspace/sessions/telegram/2.json",
            "loadSession",
            "initializeExecutor",
            "enqueue",
            "markActioned",
        ]);
        assert.equal(createdExecutors.length, 1);
    });

    it("records dispatch tracking into todo and optional reminder", async () => {
        const enqueued: any[] = [];
        const todos: any[] = [];
        const reminders: any[] = [];
        const subagent = {
            chatId: "telegram:3",
            codeActExecutor: {
                enqueue: (task: unknown) => enqueued.push(task),
                getSessionFilePath: () => "workspace/sessions/telegram/3.json",
            },
        };

        const api = createDispatchApi({
            memory: {
                todoUpsert: (bindingId: string, key: string, content: string, dueAt: string | null) => {
                    todos.push({ bindingId, key, content: JSON.parse(content), dueAt });
                    return { key, content, dueAt, createdAt: "now", updatedAt: "now", expired: false };
                },
            } as any,
            globalState: {
                addReminder: (chatId: string, description: string, triggerAt: string, requestedBy: string, options: any) => {
                    const reminder = { id: "reminder-1", chatId, description, triggerAt, requestedBy, ...options };
                    reminders.push(reminder);
                    return reminder;
                },
            } as any,
            subagentManager: {
                getOrCreate: () => subagent as any,
                getSessionFilePath: () => "workspace/sessions/telegram/3.json",
            },
            accumulator: {
                markActioned: () => undefined,
            } as any,
            taskIdFactory: () => "task-meta-3",
        });

        const result = await api.taskToGroup("telegram:3", {
            contentDirection: "ask for clarification",
            tracking: {
                content: "等对方回复后确认细节",
                remindAfterMinutes: 15,
                callback: "检查 telegram:3 是否有回复，并决定是否继续跟进",
                data: { topicId: "topic-3" },
            },
        });

        assert.deepEqual(result, {
            taskId: "task-meta-3",
            trackingKey: "dispatch:task-meta-3",
            reminderId: "reminder-1",
        });
        assert.equal(enqueued.length, 1);
        assert.equal(todos[0].bindingId, "telegram:3");
        assert.equal(todos[0].key, "dispatch:task-meta-3");
        assert.equal(todos[0].content.taskId, "task-meta-3");
        assert.equal(todos[0].content.bindingId, "telegram:3");
        assert.deepEqual(todos[0].content.data, { topicId: "topic-3" });
        assert.equal(reminders[0].bindingId, "telegram:3");
        assert.equal(reminders[0].callback, "检查 telegram:3 是否有回复，并决定是否继续跟进");
        assert.equal(reminders[0].data.trackingKey, "dispatch:task-meta-3");
    });
});
