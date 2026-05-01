import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDispatchApi } from "../src/meta-sandbox/meta-api/dispatch.js";

describe("createDispatchApi", () => {
    it("builds and enqueues a CodeActReplyTask with serialized context and grounding", async () => {
        const enqueued: any[] = [];
        const marked: string[] = [];
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
            groundingConfig: {
                provider: "google",
                apiKey: "test",
                baseUrl: "https://example.invalid",
            },
            groundingRunner: async () => "grounded",
            taskIdFactory: () => "task-meta-1",
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
        assert.equal(enqueued[0].taskId, "task-meta-1");
        assert.equal(enqueued[0].decisions[0].action, "REPLY");
        assert.equal(enqueued[0].contextSnapshot.contentDirection, "reply with a concise answer");
        assert.equal(enqueued[0].contextSnapshot.toneGuidance, "calm");
        assert.equal(enqueued[0].contextSnapshot.groundingContext, "grounded");
        assert.equal(enqueued[0].contextSnapshot.personContext, JSON.stringify({ facts: ["x"] }));
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
});