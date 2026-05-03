import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { PostTaskWindowManager } from "../src/subagent/post-task-window.js";
import type { CodeActReplyTask, SubagentCallback } from "../src/subagent/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeCallback(overrides?: Partial<SubagentCallback>): SubagentCallback {
    return {
        taskId: "task-1",
        chatId: "telegram:1",
        executionType: "CODEACT",
        status: "COMPLETED",
        summary: "done",
        durationMs: 100,
        createdAt: new Date().toISOString(),
        sentMessages: [{ messageId: "sent-1", text: "hello", timestamp: new Date().toISOString() }],
        ...overrides,
    };
}

function makeManager(options?: {
    windowMs?: number;
    q5?: CallbackQueue;
    enqueued?: CodeActReplyTask[];
    unblocks?: string[];
}) {
    const q5 = options?.q5 ?? new CallbackQueue();
    const enqueued = options?.enqueued ?? [];
    const unblocks = options?.unblocks ?? [];
    const executor = {
        enqueue: (task: CodeActReplyTask) => enqueued.push(task),
        isProcessing: () => false,
        getQueueSize: () => 0,
    };
    const subagent = {
        codeActExecutor: executor,
        observer: { getEngagementScore: () => 42 },
        buildQueueEntry: () => ({ topicDigests: [] }),
    };
    const manager = new PostTaskWindowManager({
        windowMs: options?.windowMs ?? 20,
        callbackQueue: q5,
        accumulator: {
            unblock: (chatId: string) => unblocks.push(chatId),
        },
        subagentManager: {
            get: () => subagent,
        } as any,
    });
    return { manager, q5, enqueued, unblocks };
}

describe("PostTaskWindowManager", () => {
    it("delays callbacks with sent messages and attaches reaction messages", async () => {
        const { manager, q5, unblocks } = makeManager({ windowMs: 20 });

        manager.handleCallback(makeCallback());
        assert.equal(q5.size, 0);

        manager.recordMessage("telegram:1", {
            _id: "evt-1",
            _ts: "2026-05-03T12:00:00.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-1",
            displayName: "Alice",
            text: "看到了",
        });

        await sleep(60);

        assert.equal(q5.size, 1);
        const [callback] = q5.drain();
        assert.equal(callback.taskId, "task-1");
        assert.equal(callback.postTaskMessages?.length, 1);
        assert.equal(callback.postTaskMessages?.[0]?.text, "看到了");
        assert.equal(callback.postTaskWindow?.messageCount, 1);
        assert.deepEqual(unblocks, ["telegram:1"]);
        manager.dispose();
    });

    it("forwards direct post-task messages to the subagent", () => {
        const { manager, q5, enqueued } = makeManager({ windowMs: 200 });

        manager.handleCallback(makeCallback());
        const event = {
            _id: "evt-2",
            _ts: "2026-05-03T12:00:10.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-2",
            displayName: "Bob",
            text: "你刚才说的是这个意思吗？",
            replyToMessageId: "sent-1",
        };

        assert.equal(manager.isReplyToWindowSentMessage("telegram:1", event), true);
        const handled = manager.tryForwardDirectMessage("telegram:1", event, "reply-to-agent");

        assert.equal(handled, true);
        assert.equal(q5.size, 0);
        assert.equal(enqueued.length, 1);
        assert.equal(enqueued[0].chatId, "telegram:1");
        assert.deepEqual(enqueued[0].targetMessageIds, ["msg-2"]);
        assert.equal(enqueued[0].replyStrategy, "DIRECT_REPLY");
        assert.equal(enqueued[0].skipRefreshTaskMessages, true);
        assert.match(enqueued[0].continuationPrompt ?? "", /\[📩 新消息到达\]/);
        assert.match(enqueued[0].continuationPrompt ?? "", /你刚才说的是这个意思吗？/);
        assert.equal(enqueued[0].contextSnapshot.recentMessages, undefined);
        assert.equal(enqueued[0].contextSnapshot.personContext, undefined);
        manager.dispose();
    });

    it("merges follow-up callbacks into the original window callback", async () => {
        const { manager, q5 } = makeManager({ windowMs: 20 });

        manager.handleCallback(makeCallback());
        manager.handleCallback(makeCallback({
            taskId: "task-follow",
            summary: "followed",
            sentMessages: [{ messageId: "sent-2", text: "补一句", timestamp: new Date().toISOString() }],
        }));

        await sleep(60);

        const [callback] = q5.drain();
        assert.equal(callback.taskId, "task-1");
        assert.equal(callback.postTaskFollowUpCallbacks?.length, 1);
        assert.equal(callback.postTaskFollowUpCallbacks?.[0]?.taskId, "task-follow");
        assert.equal(callback.postTaskWindow?.followUpCallbackCount, 1);
        manager.dispose();
    });
});
