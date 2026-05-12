import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttentionAccumulator } from "../src/accumulator/attention-accumulator.js";
import { createDirectAddressItem } from "../src/accumulator/queue-entry-adapter.js";
import type { LLMConfig } from "../src/core/config.js";
import { GlobalState } from "../src/main-agent/global-state.js";
import { createMetaSessionHandler } from "../src/main-agent/meta-session-handler.js";
import { MainAgentLoop } from "../src/main-agent/main-agent-loop.js";
import { buildMetaApiContext } from "../src/meta-sandbox/meta-api/index.js";
import { MetaSandbox } from "../src/meta-sandbox/meta-sandbox.js";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { SubagentManager } from "../src/subagent/subagent-manager.js";
import type { AttentionQueueEntry } from "../src/subagent/types.js";
import type { LLMResponse } from "../src/core/llm.js";

function createMetaMemoryStub() {
    return {
        getGroupModel: () => null,
        getProfilesForChat: () => [],
        getPersonIdentity: () => null,
        getTopicById: () => null,
        listGroupModels: () => [],
        todoList: () => [],
    };
}

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
            payload: {
                topicDigest: {
                    topicId: "topic-signal-1",
                    label: "群内求助",
                    summary: "有人提出了一个仍未解决的问题。",
                    state: "ACTIVE",
                    participants: ["telegram:u1"],
                    keywords: ["求助"],
                    messageCount: 2,
                    lastActivityAt: new Date(1).toISOString(),
                    triageReason: "悬空求助，值得让 Meta 判断。",
                    callbackPotential: 20,
                },
            },
            enqueuedAt: 1,
            pressure: 80,
        });
        accumulator.ingest(2, {
            chatId: "telegram:g2",
            source: "TOPIC_SIGNAL",
            payload: {
                topicDigest: {
                    topicId: "topic-signal-2",
                    label: "后续讨论",
                    summary: "另一个群也出现了值得观察的话题。",
                    state: "ACTIVE",
                    participants: ["telegram:u2"],
                    keywords: ["讨论"],
                    messageCount: 1,
                    lastActivityAt: new Date(2).toISOString(),
                    triageReason: "可以让 Meta 判断是否需要跟进。",
                    callbackPotential: 10,
                },
            },
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
        assert.equal(receivedEntries.find((entry) => entry.chatId === "telegram:g1")?.source, "TOPIC_SIGNAL");
        assert.deepEqual(
            receivedEntries.find((entry) => entry.chatId === "telegram:g1")?.topicDigests.map((topic) => topic.topicId),
            ["topic-signal-1"],
        );
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

        const responses: LLMResponse[] = [
            {
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
            },
            {
                content: [
                    "根据注入的 dispatch 文档重新下发。",
                    "```ts",
                    "await dispatch.taskToGroup(\"telegram:g1\", {",
                    "  contentDirection: \"reply from meta session\",",
                    "  toneGuidance: \"calm\",",
                    "  context: { source: \"meta-session\" },",
                    "  useSkills: [\"memory\"],",
                    "});",
                    "```",
                ].join("\n"),
            },
            {
                content: "Done.\n[SESSION_DIGEST]dispatched task to telegram:g1[/SESSION_DIGEST]\n<end_turn>",
            },
        ];
        loop.setMetaSessionHandler(createMetaSessionHandler({
            getPersona: () => ({ name: "测试编排者", description: "验证真实 meta session dispatch" }),
            globalState,
            memory: createMetaMemoryStub() as any,
            sandbox,
            getLlmConfigs: () => [TEST_LLM_CONFIG],
            llmCaller: async () => {
                const next = responses.shift();
                assert.ok(next);
                return next;
            },
        }));

        accumulator.ingest(2, {
            chatId: "telegram:g1",
            source: "TOPIC_SIGNAL",
            payload: {
                topicDigest: {
                    topicId: "topic-meta-dispatch",
                    label: "Meta 派发测试",
                    summary: "这个话题需要 Meta 下发一个回复任务。",
                    state: "ACTIVE",
                    participants: ["telegram:u1"],
                    keywords: ["dispatch"],
                    messageCount: 1,
                    lastActivityAt: new Date(1).toISOString(),
                    triageReason: "测试 dispatch path。",
                    callbackPotential: 80,
                },
            },
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
        assert.equal(enqueuedTasks[0]?.contextSnapshot.personContext, undefined);
        assert.equal(enqueuedTasks[0]?.contextSnapshot.dispatchContext, JSON.stringify({ source: "meta-session" }));
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

    it("routes ordinary callbacks through layer 1 attention", async () => {
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

        callbackQueue.enqueue({
            taskId: "task-cb-ordinary",
            chatId: "telegram:g1",
            executionType: "CODEACT",
            status: "COMPLETED",
            summary: "ordinary callback done",
            durationMs: 100,
            createdAt: new Date().toISOString(),
        });

        let receivedEntries: AttentionQueueEntry[] = [];
        let receivedCallbacks = 0;
        loop.setMetaSessionHandler(async (entries, callbacks) => {
            receivedEntries = entries;
            receivedCallbacks = callbacks.length;
            return { endReason: "end_turn", sessionDigest: "ordinary callback handled" };
        });

        const result = await loop.tick();

        assert.equal(result.phase1Callbacks, 1);
        assert.deepEqual(result.phase3Attended, ["telegram:g1"]);
        assert.equal(receivedEntries[0]?.source, "DEFERRED_RE_ENTRY");
        assert.equal(receivedCallbacks, 1);
        globalState.dispose();
    });

    it("drops stale topic signals that do not carry a topic digest", async () => {
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

        accumulator.ingest(2, {
            chatId: "telegram:g1",
            source: "TOPIC_SIGNAL",
            payload: null,
            enqueuedAt: 1,
            pressure: 80,
        });

        let callCount = 0;
        loop.setMetaSessionHandler(async () => {
            callCount += 1;
            return { endReason: "end_turn" };
        });

        const result = await loop.tick();

        assert.equal(callCount, 0);
        assert.deepEqual(result.phase3Attended, []);
        assert.equal(accumulator.getSignalPoolSize(), 0);
        globalState.dispose();
    });

    it("merges same-chat topic signals into a direct-address turn", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 3 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);
        subagentManager.getOrCreate("telegram:g1");

        accumulator.ingest(0, {
            ...createDirectAddressItem("telegram:g1", { reason: "DM" }, 1),
            pressure: 20,
        });
        accumulator.ingest(2, {
            chatId: "telegram:g1",
            source: "TOPIC_SIGNAL",
            payload: {
                topicDigest: {
                    topicId: "topic-love-stickers",
                    label: "爱心贴纸互动",
                    summary: "用户请求继续发送爱心或喜欢主题贴纸。",
                    state: "ACTIVE",
                    participants: ["telegram:u1"],
                    keywords: ["爱心", "贴纸"],
                    messageCount: 1,
                    lastActivityAt: new Date(2).toISOString(),
                    triageReason: "用户明确提出亲昵互动请求。",
                    callbackPotential: 100,
                },
            },
            enqueuedAt: 2,
            pressure: 90,
        });

        let receivedEntries: AttentionQueueEntry[] = [];
        loop.setMetaSessionHandler(async (entries) => {
            receivedEntries = entries;
            return { endReason: "end_turn", sessionDigest: "merged" };
        });

        const result = await loop.tick();

        assert.deepEqual(result.phase3Attended, ["telegram:g1"]);
        assert.equal(receivedEntries.length, 1);
        assert.equal(receivedEntries[0]?.source, "DIRECT_ADDRESS");
        assert.deepEqual(receivedEntries[0]?.topicDigests.map((topic) => topic.topicId), ["topic-love-stickers"]);
        assert.equal(receivedEntries[0]?.callbackPotential, 100);
        assert.ok(receivedEntries[0]?.urgentSignals?.includes("TOPIC_SIGNAL:爱心贴纸互动"));
        assert.equal(accumulator.getSignalPoolSize(), 0);
        globalState.dispose();
    });

    it("wakes synthetic __meta__ turns for scheduler and proactive idle sources", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 2 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);

        accumulator.ingest(1, {
            chatId: "__meta__",
            source: "SCHEDULER",
            payload: {
                id: "rem-1",
                type: "reminder",
                description: "检查 Soha 回复",
                bindingId: "telegram:g1",
                callback: "看一下后续回复并决定是否转发",
                data: { originalTask: "reply-soha" },
            },
            enqueuedAt: 1,
            pressure: 50,
        });

        let receivedEntries: AttentionQueueEntry[] = [];
        loop.setMetaSessionHandler(async (entries) => {
            receivedEntries = entries;
            return { endReason: "end_turn", sessionDigest: "scheduler handled" };
        });

        const schedulerResult = await loop.tick();
        assert.deepEqual(schedulerResult.phase3Attended, ["__meta__"]);
        assert.equal(receivedEntries[0]?.source, "SCHEDULER_TRIGGER");
        assert.deepEqual(receivedEntries[0]?.schedulerTriggers, [{
            id: "rem-1",
            type: "reminder",
            description: "检查 Soha 回复",
            bindingId: "telegram:g1",
            callback: "看一下后续回复并决定是否转发",
            data: { originalTask: "reply-soha" },
        }]);

        receivedEntries = [];
        (loop as any).lastNonIdleActivityAt = 0;
        (loop as any).lastProactiveIdleAt = 0;

        const idleResult = await loop.tick();
        assert.deepEqual(idleResult.phase3Attended, ["__meta__"]);
        assert.equal(receivedEntries[0]?.source, "PROACTIVE_IDLE");
        assert.deepEqual(receivedEntries[0]?.schedulerTriggers, []);

        globalState.dispose();
    });

    it("runs proactive idle 15 minutes after meta activity, then repeats every 30 minutes", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 2 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);
        const originalNow = Date.now;
        const fifteenMinutes = 15 * 60 * 1000;
        const thirtyMinutes = 30 * 60 * 1000;
        let now = 1_800_000_000_000;
        let receivedEntries: AttentionQueueEntry[] = [];

        loop.setMetaSessionHandler(async (entries) => {
            receivedEntries = entries;
            return { endReason: "end_turn", sessionDigest: "idle handled" };
        });

        Date.now = () => now;
        try {
            (loop as any).lastNonIdleActivityAt = now;
            (loop as any).lastProactiveIdleAt = 0;

            now += fifteenMinutes - 1;
            let result = await loop.tick();
            assert.deepEqual(result.phase3Attended, []);
            assert.equal(receivedEntries.length, 0);

            now += 1;
            result = await loop.tick();
            assert.deepEqual(result.phase3Attended, ["__meta__"]);
            assert.equal(receivedEntries[0]?.source, "PROACTIVE_IDLE");

            const firstIdleAt = now;
            receivedEntries = [];
            now = firstIdleAt + thirtyMinutes - 1;
            result = await loop.tick();
            assert.deepEqual(result.phase3Attended, []);
            assert.equal(receivedEntries.length, 0);

            now += 1;
            result = await loop.tick();
            assert.deepEqual(result.phase3Attended, ["__meta__"]);
            assert.equal(receivedEntries[0]?.source, "PROACTIVE_IDLE");

            const secondIdleAt = now;
            receivedEntries = [];
            now = secondIdleAt + 5 * 60 * 1000;
            accumulator.ingest(1, {
                chatId: "__meta__",
                source: "SCHEDULER",
                payload: {
                    id: "rem-reset",
                    type: "reminder",
                    description: "reset proactive idle baseline",
                },
                enqueuedAt: now,
            });
            result = await loop.tick();
            assert.deepEqual(result.phase3Attended, ["__meta__"]);
            assert.equal(receivedEntries[0]?.source, "SCHEDULER_TRIGGER");

            receivedEntries = [];
            now += fifteenMinutes - 1;
            result = await loop.tick();
            assert.deepEqual(result.phase3Attended, []);
            assert.equal(receivedEntries.length, 0);

            now += 1;
            result = await loop.tick();
            assert.deepEqual(result.phase3Attended, ["__meta__"]);
            assert.equal(receivedEntries[0]?.source, "PROACTIVE_IDLE");
        } finally {
            Date.now = originalNow;
            globalState.dispose();
        }
    });

    it("includes recent direct-address messages in the meta prompt", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 0, topN: 2 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, {}, globalState);
        const subagent = subagentManager.getOrCreate("telegram:g1");

        subagent.onMessage({
            _id: "evt-1",
            _ts: "2026-05-01T14:28:01.000Z",
            type: "telegram.message",
            chatId: "telegram:g1",
            userId: "telegram:u1",
            displayName: "阿喵",
            text: "在吗在吗",
            messageId: "7305",
        });

        accumulator.ingest(0, {
            ...createDirectAddressItem("telegram:g1", { reason: "DM" }, 1),
            pressure: 90,
        });

        const metaApiContext = buildMetaApiContext({
            memory: {} as any,
            subagentManager,
            globalState,
            accumulator,
            executorFactory: () => ({
                enqueue: () => undefined,
                setSessionFilePath: () => undefined,
                getSessionFilePath: () => null,
                loadSession: () => undefined,
            } as any),
            initializeExecutor: async () => undefined,
        });
        const sandbox = new MetaSandbox(metaApiContext);

        let lastUserPrompt = "";
        loop.setMetaSessionHandler(createMetaSessionHandler({
            getPersona: () => ({ name: "测试编排者", description: "验证 recentMessages 会进入 Meta prompt" }),
            globalState,
            memory: createMetaMemoryStub() as any,
            sandbox,
            getLlmConfigs: () => [TEST_LLM_CONFIG],
            llmCaller: async (messages) => {
                if (String(messages.at(-1)?.content ?? "").includes("你本次未写代码分配任务")) {
                    return { content: "<end_turn>" };
                }
                lastUserPrompt = messages
                    .filter((message) => message.role === "user")
                    .map((message) => message.content)
                    .join("\n\n");
                return {
                    content: [
                        "[SESSION_DIGEST]saw direct-address message[/SESSION_DIGEST]",
                        "<end_turn>",
                    ].join("\n"),
                };
            },
        }));

        const result = await loop.tick();

        assert.equal(result.phase4MetaEndReason, "end_turn");
        assert.match(lastUserPrompt, /在吗在吗/);
        assert.match(lastUserPrompt, /阿喵/);
        assert.match(lastUserPrompt, /directAddressReason: DM/);
        assert.match(lastUserPrompt, /## 新消息/);

        globalState.dispose();
    });
});
