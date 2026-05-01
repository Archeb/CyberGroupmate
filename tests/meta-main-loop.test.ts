import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttentionAccumulator } from "../src/accumulator/attention-accumulator.js";
import type { LLMConfig } from "../src/core/config.js";
import { GlobalState } from "../src/main-agent/global-state.js";
import { createMetaSessionHandler } from "../src/main-agent/meta-session-handler.js";
import { MainAgentLoop } from "../src/main-agent/main-agent-loop.js";
import { buildMetaApiContext } from "../src/meta-sandbox/meta-api/index.js";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { SubagentManager } from "../src/subagent/subagent-manager.js";
import type { AttentionQueueEntry } from "../src/subagent/types.js";

const tempDirs: string[] = [];

function tempDir(): string {
    const dir = join(tmpdir(), `meta-main-loop-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

after(() => {
    for (const dir of tempDirs) {
        if (existsSync(dir)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

const TEST_LLM_CONFIG: LLMConfig = {
    provider: "openai",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    model: "test-model",
    temperature: 0,
    maxTokens: 1024,
};

describe("MainAgentLoop meta session path", () => {
    it("batches released attention entries into one meta session and stores digest", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 2 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);

        subagentManager.getOrCreate("telegram:g1");
        subagentManager.getOrCreate("telegram:g2");

        accumulator.ingest(2, {
            chatId: "telegram:g1",
            source: "TOPIC_SIGNAL",
            payload: null,
            enqueuedAt: 1,
            pressure: 80,
        });
        accumulator.ingest(2, {
            chatId: "telegram:g2",
            source: "TOPIC_SIGNAL",
            payload: null,
            enqueuedAt: 2,
            pressure: 70,
        });

        let callCount = 0;
        let receivedEntries: AttentionQueueEntry[] = [];
        loop.setMetaSessionHandler(async (entries) => {
            callCount += 1;
            receivedEntries = entries;
            return {
                endReason: "end_turn",
                sessionDigest: "handled telegram:g1 and telegram:g2",
            };
        });

        const result = await loop.tick();

        assert.equal(callCount, 1);
        assert.deepEqual(receivedEntries.map((entry) => entry.chatId).sort(), ["telegram:g1", "telegram:g2"]);
        assert.deepEqual(result.phase3Attended.sort(), ["telegram:g1", "telegram:g2"]);
        assert.equal(result.phase4MetaEndReason, "end_turn");

        const digests = globalState.getSessionDigests();
        assert.equal(digests.length, 1);
        assert.equal(digests[0]?.content, "handled telegram:g1 and telegram:g2");

        globalState.dispose();
    });

    it("runs a real meta session and dispatches a CodeAct task through the meta api", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 2 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);

        subagentManager.getOrCreate("telegram:g1");

        const enqueuedTasks: any[] = [];
        const dispatchedTasks: string[] = [];
        const metaApiContext = buildMetaApiContext({
            memory: {} as any,
            subagentManager,
            globalState,
            accumulator,
            executorFactory: () => {
                let sessionFilePath: string | null = null;
                return {
                    enqueue: (task: unknown) => {
                        enqueuedTasks.push(task);
                    },
                    setSessionFilePath: (filePath: string) => {
                        sessionFilePath = filePath;
                    },
                    getSessionFilePath: () => sessionFilePath,
                    loadSession: () => undefined,
                } as any;
            },
            initializeExecutor: async () => undefined,
            onTaskDispatched: (task) => {
                dispatchedTasks.push(`${task.chatId}:${task.taskId}`);
            },
            taskIdFactory: () => "task-meta-dispatch",
        });
        const sandbox = new MetaSandbox(metaApiContext);

        loop.setMetaSessionHandler(createMetaSessionHandler({
            getPersona: () => ({ name: "测试编排者", description: "验证真实 meta session dispatch" }),
            globalState,
            sandbox,
            getLlmConfigs: () => [TEST_LLM_CONFIG],
            llmCaller: async () => ({
                content: [
                    "准备下发任务。",
                    "```ts",
                    "await dispatch.taskToGroup(\"telegram:g1\", {",
                    "  contentDirection: \"reply from meta session\",",
                    "  toneGuidance: \"calm\",",
                    "  context: { source: \"meta-session\" },",
                    "  useSkills: [\"memory\"],",
                    "});",
                    "```",
                    "[SESSION_DIGEST]dispatched task to telegram:g1[/SESSION_DIGEST]",
                    "<end_turn>",
                ].join("\n"),
            }),
        }));

        accumulator.ingest(2, {
            chatId: "telegram:g1",
            source: "TOPIC_SIGNAL",
            payload: null,
            enqueuedAt: 1,
            pressure: 80,
        });

        const result = await loop.tick();

        assert.deepEqual(result.phase3Attended, ["telegram:g1"]);
        assert.equal(result.phase4MetaEndReason, "end_turn");
        assert.equal(enqueuedTasks.length, 1);
        assert.deepEqual(dispatchedTasks, ["telegram:g1:task-meta-dispatch"]);
        assert.equal(enqueuedTasks[0]?.taskId, "task-meta-dispatch");
        assert.equal(enqueuedTasks[0]?.decisions[0]?.action, "REPLY");
        assert.equal(enqueuedTasks[0]?.contextSnapshot.contentDirection, "reply from meta session");
        assert.equal(enqueuedTasks[0]?.contextSnapshot.toneGuidance, "calm");
        assert.equal(enqueuedTasks[0]?.contextSnapshot.personContext, JSON.stringify({ source: "meta-session" }));
        assert.deepEqual(Array.from(enqueuedTasks[0]?.useSkills ?? []), ["memory"]);
        assert.equal(globalState.getSessionDigests()[0]?.content, "dispatched task to telegram:g1");

        globalState.dispose();
    });

    it("consumes callback_received wake conditions and wakes a synthetic __meta__ turn", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 2 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);

        const wakeConditionId = globalState.addWakeCondition({ type: "callback_received", taskId: "task-cb-1" });
        callbackQueue.enqueue({
            taskId: "task-cb-1",
            chatId: "telegram:g1",
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: "done",
            durationMs: 100,
            createdAt: new Date().toISOString(),
        });

        let receivedEntries: AttentionQueueEntry[] = [];
        loop.setMetaSessionHandler(async (entries) => {
            receivedEntries = entries;
            return {
                endReason: "end_turn",
                sessionDigest: "woke from callback",
            };
        });

        const result = await loop.tick();

        assert.equal(result.phase1Callbacks, 1);
        assert.deepEqual(result.phase3Attended, ["__meta__"]);
        assert.deepEqual(receivedEntries.map((entry) => entry.chatId), ["__meta__"]);
        assert.deepEqual(receivedEntries[0]?.schedulerTriggers, [{
            id: wakeConditionId,
            type: "wake_condition",
            description: "callback received for task-cb-1",
        }]);
        assert.equal(globalState.getWakeConditions().length, 0);
        assert.equal(globalState.getSessionDigests()[0]?.content, "woke from callback");

        globalState.dispose();
    });
});