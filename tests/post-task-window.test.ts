import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CallbackQueue } from "../src/subagent/callback-queue.js";
import { formatFollowUpJudgeInput, PostTaskWindowManager } from "../src/subagent/post-task-window.js";
import type {
    PostTaskFollowUpJudge,
    PostTaskFollowUpJudgeInput,
    PostTaskRecentMessagesProvider,
} from "../src/subagent/post-task-window.js";
import type { CodeActReplyTask, PostTaskReactionMessage, SubagentCallback } from "../src/subagent/types.js";

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
    maxWindowMs?: number;
    q5?: CallbackQueue;
    enqueued?: CodeActReplyTask[];
    directTasks?: CodeActReplyTask[];
    unblocks?: string[];
    blocks?: string[];
    isProcessing?: () => boolean;
    getQueueSize?: () => number;
    followUpCheckIntervalMs?: number;
    followUpJudge?: PostTaskFollowUpJudge | null;
    recentMessagesProvider?: PostTaskRecentMessagesProvider;
}) {
    const q5 = options?.q5 ?? new CallbackQueue();
    const enqueued = options?.enqueued ?? [];
    const unblocks = options?.unblocks ?? [];
    const blocks = options?.blocks ?? [];
    const executor = {
        enqueue: (task: CodeActReplyTask) => enqueued.push(task),
        isProcessing: options?.isProcessing ?? (() => false),
        getQueueSize: options?.getQueueSize ?? (() => 0),
    };
    const subagent = {
        codeActExecutor: executor,
        observer: { getEngagementScore: () => 42 },
        buildQueueEntry: () => ({ topicDigests: [] }),
    };
    const manager = new PostTaskWindowManager({
        windowMs: options?.windowMs ?? 20,
        maxWindowMs: options?.maxWindowMs,
        callbackQueue: q5,
        accumulator: {
            block: (chatId: string) => blocks.push(chatId),
            unblock: (chatId: string) => unblocks.push(chatId),
        },
        subagentManager: {
            get: () => subagent,
        } as any,
        onDirectTaskEnqueued: options?.directTasks
            ? (task) => options.directTasks?.push(task)
            : undefined,
        followUpCheckIntervalMs: options?.followUpCheckIntervalMs,
        followUpJudge: options?.followUpJudge,
        recentMessagesProvider: options?.recentMessagesProvider,
    });
    return { manager, q5, enqueued, unblocks, blocks };
}

describe("PostTaskWindowManager", () => {
    it("delays callbacks with sent messages and attaches reaction messages", async () => {
        const { manager, q5, unblocks, blocks } = makeManager({ windowMs: 20 });

        manager.handleCallback(makeCallback());
        assert.equal(q5.size, 0);
        assert.deepEqual(blocks, ["telegram:1"]);

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

    it("does not block callbacks without sent messages", () => {
        const { manager, q5, blocks, unblocks } = makeManager({ windowMs: 20 });

        manager.handleCallback(makeCallback({ sentMessages: undefined }));

        assert.equal(q5.size, 1);
        assert.deepEqual(blocks, []);
        assert.deepEqual(unblocks, ["telegram:1"]);
        manager.dispose();
    });

    it("force flushes an active window immediately and unblocks the chat", () => {
        const { manager, q5, unblocks } = makeManager({ windowMs: 60_000 });

        manager.handleCallback(makeCallback());
        assert.equal(q5.size, 0);
        assert.equal(manager.hasActiveWindow("telegram:1"), true);

        // 无窗口的 chat 返回 false，不产生副作用
        assert.equal(manager.forceFlush("telegram:other", "test"), false);
        assert.equal(q5.size, 0);

        manager.recordMessage("telegram:1", {
            _id: "evt-1",
            _ts: "2026-05-03T12:00:00.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-1",
            displayName: "Alice",
            text: "等窗口结束再看",
        });

        assert.equal(manager.forceFlush("telegram:1", "test"), true);
        assert.equal(manager.hasActiveWindow("telegram:1"), false);
        assert.equal(q5.size, 1);
        const [callback] = q5.drain();
        assert.equal(callback.taskId, "task-1");
        assert.equal(callback.postTaskMessages?.length, 1);
        assert.equal(callback.postTaskMessages?.[0]?.text, "等窗口结束再看");
        assert.deepEqual(unblocks, ["telegram:1"]);
        manager.dispose();
    });

    it("opens from agent sent events before callback arrives", async () => {
        const { manager, q5, enqueued, blocks, unblocks } = makeManager({ windowMs: 20 });
        const chatId = "discord:guild-1:channel-1";

        manager.handleSentMessage(chatId, {
            _id: "sent-event-1",
            _ts: "2026-05-03T12:00:00.000Z",
            type: "system.agent_message_sent",
            scene: "discord",
            chatId: "guild-1:channel-1",
            messageId: "sent-discord-1",
            text: "hello discord",
        });

        assert.equal(manager.hasActiveWindow(chatId), true);
        assert.deepEqual(blocks, [chatId]);
        assert.equal(q5.size, 0);

        const event = {
            _id: "evt-discord-1",
            _ts: "2026-05-03T12:00:01.000Z",
            type: "nc.message",
            chatId,
            messageId: "msg-discord-2",
            displayName: "Dana",
            text: "刚才那句我回一下",
            replyToMessageId: "sent-discord-1",
        };
        assert.equal(manager.isReplyToWindowSentMessage(chatId, event), true);
        manager.recordMessage(chatId, event, { isDirectAttention: true, directReason: "reply-to-agent" });
        assert.equal(manager.tryForwardDirectMessage(chatId, event, "reply-to-agent"), true);
        assert.equal(enqueued.length, 1);

        manager.handleCallback(makeCallback({
            chatId,
            sentMessages: [{ messageId: "sent-discord-1", text: "hello discord", timestamp: new Date().toISOString() }],
        }));

        await sleep(60);

        assert.equal(q5.size, 1);
        const [callback] = q5.drain();
        assert.equal(callback.chatId, chatId);
        assert.equal(callback.postTaskWindow?.directMessageCount, 1);
        assert.deepEqual(unblocks, [chatId]);
        manager.dispose();
    });

    it("expires sent-message windows that never receive a callback", async () => {
        const { manager, q5, blocks, unblocks } = makeManager({ windowMs: 20, maxWindowMs: 40 });
        const chatId = "telegram:stale";

        manager.handleSentMessage(chatId, {
            _id: "sent-event-stale",
            _ts: "2026-05-03T12:00:00.000Z",
            type: "system.agent_message_sent",
            scene: "telegram",
            chatId,
            messageId: "sent-stale-1",
            text: "hello",
        });

        assert.equal(manager.hasActiveWindow(chatId), true);
        assert.deepEqual(blocks, [chatId]);

        await sleep(80);

        assert.equal(manager.hasActiveWindow(chatId), false);
        assert.equal(q5.size, 0);
        assert.deepEqual(unblocks, [chatId]);
        manager.dispose();
    });

    it("force flushes callback windows after the max lifetime even if executor stays busy", async () => {
        const { manager, q5, unblocks } = makeManager({
            windowMs: 20,
            maxWindowMs: 40,
            isProcessing: () => true,
        });

        manager.handleCallback(makeCallback());
        await sleep(80);

        assert.equal(q5.size, 1);
        const [callback] = q5.drain();
        assert.equal(callback.taskId, "task-1");
        assert.deepEqual(unblocks, ["telegram:1"]);
        manager.dispose();
    });

    it("forwards direct post-task messages to the subagent", () => {
        const directTasks: CodeActReplyTask[] = [];
        const { manager, q5, enqueued } = makeManager({ windowMs: 200, directTasks });

        manager.handleCallback(makeCallback());
        manager.recordMessage("telegram:1", {
            _id: "evt-1",
            _ts: "2026-05-03T12:00:05.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-1",
            displayName: "Alice",
            text: "前面这句也还没送过",
        });
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
        assert.match(enqueued[0].taskId, /^post-task-[0-9a-f]{8}$/);
        assert.deepEqual(directTasks.map((task) => task.taskId), [enqueued[0].taskId]);
        assert.equal(enqueued[0].chatId, "telegram:1");
        assert.deepEqual(enqueued[0].targetMessageIds, ["msg-1", "msg-2"]);
        assert.equal(enqueued[0].replyStrategy, "DIRECT_REPLY");
        assert.equal(enqueued[0].skipRefreshTaskMessages, true);
        assert.deepEqual(enqueued[0].continuationMessages?.map((message) => message.messageId), ["msg-1", "msg-2"]);
        assert.equal(enqueued[0].continuationReason, "reply-to-agent");
        assert.match(enqueued[0].continuationPrompt ?? "", /\[📩 新消息到达\]/);
        assert.match(enqueued[0].continuationPrompt ?? "", /前面这句也还没送过/);
        assert.match(enqueued[0].continuationPrompt ?? "", /你刚才说的是这个意思吗？/);
        assert.equal(enqueued[0].contextSnapshot.recentMessages, undefined);
        assert.equal(enqueued[0].contextSnapshot.personContext, undefined);
        manager.dispose();
    });

    it("does not resend post-task messages already forwarded to the subagent", () => {
        const { manager, enqueued } = makeManager({ windowMs: 200 });

        manager.handleCallback(makeCallback());
        manager.recordMessage("telegram:1", {
            _id: "evt-1",
            _ts: "2026-05-03T12:00:05.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-1",
            displayName: "Alice",
            text: "第一条",
        });
        manager.tryForwardDirectMessage("telegram:1", {
            _id: "evt-2",
            _ts: "2026-05-03T12:00:10.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-2",
            displayName: "Bob",
            text: "第二条",
            replyToMessageId: "sent-1",
        }, "reply-to-agent");

        manager.recordMessage("telegram:1", {
            _id: "evt-3",
            _ts: "2026-05-03T12:00:15.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-3",
            displayName: "Carol",
            text: "第三条",
            replyToMessageId: "sent-1",
        }, { isDirectAttention: true, directReason: "reply-to-agent" });
        manager.tryForwardDirectMessage("telegram:1", {
            _id: "evt-3",
            _ts: "2026-05-03T12:00:15.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-3",
            displayName: "Carol",
            text: "第三条",
            replyToMessageId: "sent-1",
        }, "reply-to-agent");

        assert.equal(enqueued.length, 2);
        assert.deepEqual(enqueued[0].targetMessageIds, ["msg-1", "msg-2"]);
        assert.deepEqual(enqueued[1].targetMessageIds, ["msg-3"]);
        assert.doesNotMatch(enqueued[1].continuationPrompt ?? "", /第一条/);
        assert.match(enqueued[1].continuationPrompt ?? "", /第三条/);
        manager.dispose();
    });

    it("classifies batched post-task messages as follow-up and forwards them", async () => {
        const judgeInputs: PostTaskFollowUpJudgeInput[] = [];
        const followUpJudge: PostTaskFollowUpJudge = async (input) => {
            judgeInputs.push(input);
            return {
                hasFollowUp: true,
                triggerMessageId: "msg-follow",
                reason: "对刚才的回复追问细节",
            };
        };
        const { manager, enqueued } = makeManager({
            windowMs: 200,
            followUpCheckIntervalMs: 10,
            followUpJudge,
        });

        manager.handleCallback(makeCallback());
        manager.recordMessage("telegram:1", {
            _id: "evt-follow",
            _ts: "2026-05-03T12:00:20.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-follow",
            displayName: "Alice",
            text: "那你刚才说的第二点具体怎么做？",
        });

        await sleep(50);

        assert.equal(judgeInputs.length, 1);
        assert.equal(judgeInputs[0]?.messages[0]?.messageId, "msg-follow");
        assert.equal(enqueued.length, 1);
        assert.deepEqual(enqueued[0].targetMessageIds, ["msg-follow"]);
        assert.match(enqueued[0].continuationPrompt ?? "", /对刚才的回复追问细节/);
        assert.equal(enqueued[0].decisions[0]?.confidence, 1);
        assert.deepEqual(enqueued[0].continuationMessages?.map((message) => message.messageId), ["msg-follow"]);
        assert.equal(enqueued[0].continuationReason, "llm-followup");
        assert.equal(enqueued[0].continuationClassifierReason, "对刚才的回复追问细节");
        manager.dispose();
    });

    it("passes recent chat context to the post-task follow-up judge", async () => {
        const judgeInputs: PostTaskFollowUpJudgeInput[] = [];
        const recent: PostTaskReactionMessage[] = Array.from({ length: 24 }, (_, index) => ({
            messageId: `ctx-${index}`,
            sender: `User${index}`,
            text: `上下文 ${index}`,
            timestamp: `2026-05-03T12:${String(index).padStart(2, "0")}:00.000Z`,
        }));
        const followUpJudge: PostTaskFollowUpJudge = async (input) => {
            judgeInputs.push(input);
            return { hasFollowUp: false, reason: "上下文显示是在和别人说话" };
        };
        const { manager } = makeManager({
            windowMs: 200,
            followUpCheckIntervalMs: 10,
            followUpJudge,
            recentMessagesProvider: () => [
                ...recent,
                {
                    messageId: "msg-batch",
                    sender: "Bob",
                    text: "你流量怎么这么少",
                    timestamp: "2026-05-03T12:30:00.000Z",
                },
            ],
        });

        manager.handleCallback(makeCallback());
        manager.recordMessage("telegram:1", {
            _id: "evt-batch",
            _ts: "2026-05-03T12:30:00.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-batch",
            displayName: "Bob",
            text: "你流量怎么这么少",
        });

        await sleep(50);

        assert.equal(judgeInputs.length, 1);
        assert.equal(judgeInputs[0]?.recentMessages?.length, 20);
        assert.equal(judgeInputs[0]?.recentMessages?.[0]?.messageId, "ctx-4");
        assert.equal(judgeInputs[0]?.recentMessages?.at(-1)?.messageId, "ctx-23");
        assert.equal(judgeInputs[0]?.messages[0]?.messageId, "msg-batch");
        manager.dispose();
    });

    it("does not re-inject messages already delivered through mid-turn pending", async () => {
        let calls = 0;
        const { manager, enqueued } = makeManager({
            windowMs: 200,
            followUpCheckIntervalMs: 10,
            followUpJudge: async () => {
                calls += 1;
                return { hasFollowUp: true, triggerMessageId: "msg-seen", reason: "不应被调用" };
            },
        });

        manager.handleCallback(makeCallback());
        manager.recordMessage("telegram:1", {
            _id: "evt-seen",
            _ts: "2026-05-03T12:31:00.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-seen",
            displayName: "Liang",
            text: "还会主动pm吗（（",
        });
        manager.markMessagesInjected("telegram:1", ["msg-seen"], "mid-turn-turn");

        await sleep(50);

        assert.equal(calls, 0);
        assert.equal(enqueued.length, 0);
        manager.dispose();
    });

    it("renders only the latest SESSION_DIGEST in follow-up judge input", async () => {
        const prompt = await formatFollowUpJudgeInput({
            chatId: "telegram:1",
            chatTitle: "测试群",
            isDirectMessage: false,
            recentMessages: [{
                messageId: "ctx-1",
                sender: "Alice",
                text: "前文",
                timestamp: "2026-05-03T12:00:00.000Z",
            }],
            sentMessages: [{ messageId: "sent-1", text: "一个贴纸", timestamp: "2026-05-03T12:00:01.000Z" }],
            callbacks: [makeCallback({
                summary: [
                    "本次思考过程：",
                    "[Turn 1] 让Miu想想",
                    "[SESSION_DIGEST]旧摘要[/SESSION_DIGEST]",
                    "[Turn 2] 继续想",
                    "[SESSION_DIGEST]最新摘要：不需要继续参与[/SESSION_DIGEST]",
                ].join("\n"),
            })],
            messages: [{
                messageId: "msg-1",
                sender: "Bob",
                text: "后续消息",
                timestamp: "2026-05-03T12:00:02.000Z",
            }],
        });

        assert.match(prompt, /## 最近 20 条上下文消息/);
        assert.doesNotMatch(prompt, /## Agent 刚发出的消息/);
        assert.doesNotMatch(prompt, /一个贴纸/);
        assert.match(prompt, /sessionDigest=最新摘要：不需要继续参与/);
        assert.doesNotMatch(prompt, /本次思考过程/);
        assert.doesNotMatch(prompt, /旧摘要/);
        assert.doesNotMatch(prompt, /confidence/);
    });

    it("formats follow-up judge messages through message-enricher cache-only mode", async () => {
        const prompt = await formatFollowUpJudgeInput({
            chatId: "telegram:1",
            isDirectMessage: false,
            recentMessages: [{
                messageId: "ctx-sticker",
                sender: "Alice",
                text: "[🎭 贴纸: 🫶]",
                timestamp: "2026-05-03T12:00:00.000Z",
                mediaType: "sticker",
                mediaInfo: JSON.stringify({
                    type: "sticker",
                    fileId: "file-sticker-context",
                    uniqueFileId: "sticker-known",
                    emoji: "🫶",
                }),
            }],
            sentMessages: [{ messageId: "sent-1", text: "hello", timestamp: "2026-05-03T12:00:01.000Z" }],
            callbacks: [makeCallback()],
            messages: [{
                messageId: "msg-sticker",
                sender: "Bob",
                text: "[🎭 贴纸: 🫶]",
                timestamp: "2026-05-03T12:00:02.000Z",
                mediaType: "sticker",
                mediaInfo: JSON.stringify({
                    type: "sticker",
                    fileId: "file-sticker-batch",
                    uniqueFileId: "sticker-known",
                    emoji: "🫶",
                }),
            }],
            stickerDescriptionLookup: {
                getStickerDescription: (uniqueFileId: string) => uniqueFileId === "sticker-known"
                    ? { description: "比心示好的温柔贴纸", emojis: ["🫶"] }
                    : null,
            },
        });

        assert.match(prompt, /ctx-sticker/);
        assert.match(prompt, /msg-sticker/);
        assert.match(prompt, /贴纸 🫶: 比心示好的温柔贴纸/);
        assert.doesNotMatch(prompt, /file-sticker-context/);
        assert.doesNotMatch(prompt, /file-sticker-batch/);
    });

    it("does not reclassify post-task batches already judged as non-follow-up", async () => {
        let calls = 0;
        const { manager, enqueued } = makeManager({
            windowMs: 200,
            followUpCheckIntervalMs: 10,
            followUpJudge: async () => {
                calls += 1;
                return { hasFollowUp: false, reason: "只是附和" };
            },
        });

        manager.handleCallback(makeCallback());
        manager.recordMessage("telegram:1", {
            _id: "evt-no-follow",
            _ts: "2026-05-03T12:00:21.000Z",
            type: "nc.message",
            chatId: "telegram:1",
            messageId: "msg-no-follow",
            displayName: "Bob",
            text: "哈哈哈哈",
        });

        await sleep(60);

        assert.equal(calls, 1);
        assert.equal(enqueued.length, 0);
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
