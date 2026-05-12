/**
 * chat-title-sync.test.ts — 群名变更实时同步测试
 *
 * 测试场景:
 * 1. OneBot group_name_change → NC 广播
 * 2. CodeActExecutor.updateChatTitle 刷新 pending tasks 的 contextSnapshot
 * 3. Telegram chat_title_refresh 事件流
 * 4. NC 事件字段映射
 * 5. 端到端: NC事件 → CodeActExecutor 刷新
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationCenter } from "../src/event/notification-center.js";
import { CodeActExecutor } from "../src/subagent/code-act-executor.js";
import type { CodeActReplyTask, GroupContextPackage } from "../src/subagent/types.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `chat-title-sync-test-${randomUUID()}.jsonl`), false);
}

function makeContextSnapshot(overrides: Partial<GroupContextPackage> = {}): GroupContextPackage {
    return {
        depth: 1,
        chatId: "onebot:group:123456",
        snapshotTimestamp: new Date().toISOString(),
        topicDigests: [],
        engagementScore: 0,
        chatTitle: "旧群名",
        ...overrides,
    };
}

function makeTask(chatTitle: string, chatId = "onebot:group:123456"): CodeActReplyTask {
    return {
        taskId: `task-${randomUUID()}`,
        chatId,
        contextSnapshot: makeContextSnapshot({ chatId, chatTitle, groupModel: { chatId, chatTitle, isDirectMessage: false } }),
        decisions: [],
        enqueuedAt: Date.now(),
    };
}

describe("群名变更同步", () => {
    describe("OneBot group_name_change → NC 广播", () => {
        it("should broadcast onebot.group_name_change event via NC when group name changes", () => {
            const nc = makeNC();
            const receivedEvents: Array<Record<string, unknown>> = [];

            nc.onPush(event => {
                if (event.type === "onebot.group_name_change") {
                    receivedEvents.push(event as Record<string, unknown>);
                }
            });

            nc.push({
                type: "onebot.group_name_change",
                chatId: "onebot:group:123456789",
                groupId: "123456789",
                oldName: "旧群名",
                newName: "新群名",
            });

            assert.equal(receivedEvents.length, 1);
            assert.equal(receivedEvents[0].chatId, "onebot:group:123456789");
            assert.equal(receivedEvents[0].newName, "新群名");
            assert.equal(receivedEvents[0].oldName, "旧群名");

            nc.dispose();
        });

        it("should not broadcast for unrelated events", () => {
            const nc = makeNC();
            const receivedEvents: Array<Record<string, unknown>> = [];

            nc.onPush(event => {
                if (event.type === "onebot.group_name_change") {
                    receivedEvents.push(event as Record<string, unknown>);
                }
            });

            nc.push({ type: "nc.message", chatId: "onebot:group:123456789" });
            nc.push({ type: "system.adapter_status" });

            assert.equal(receivedEvents.length, 0);

            nc.dispose();
        });
    });

    describe("CodeActExecutor.updateChatTitle", () => {
        it("should update chatTitle on tasks directly in the taskQueue", () => {
            const executor = new CodeActExecutor("onebot:group:123456");

            const task1 = makeTask("旧群名A");
            const task2 = makeTask("旧群名B", "onebot:group:123456");

            // 直接操作 taskQueue 避免 processNext 消费 tasks
            // @ts-expect-error - accessing private field for testing
            executor.taskQueue.push(task1);
            // @ts-expect-error - accessing private field for testing
            executor.taskQueue.push(task2);

            executor.updateChatTitle("新群名");

            assert.equal(task1.contextSnapshot.chatTitle, "新群名");
            assert.equal(task2.contextSnapshot.chatTitle, "新群名");
            assert.equal(task1.contextSnapshot.groupModel?.chatTitle, "新群名");
            assert.equal(task2.contextSnapshot.groupModel?.chatTitle, "新群名");
        });

        it("should handle empty task queue gracefully", () => {
            const executor = new CodeActExecutor("onebot:group:999");

            // 不应抛出异常
            executor.updateChatTitle("新群名");
        });

        it("should handle tasks without groupModel", () => {
            const executor = new CodeActExecutor("onebot:group:123456");

            const task: CodeActReplyTask = {
                taskId: `task-${randomUUID()}`,
                chatId: "onebot:group:123456",
                contextSnapshot: makeContextSnapshot({ chatTitle: "旧群名", groupModel: undefined }),
                decisions: [],
                enqueuedAt: Date.now(),
            };

            // @ts-expect-error - accessing private field for testing
            executor.taskQueue.push(task);
            executor.updateChatTitle("新群名");

            assert.equal(task.contextSnapshot.chatTitle, "新群名");
            assert.equal(task.contextSnapshot.groupModel, undefined);
        });

        it("should update only chatTitle and groupModel.chatTitle, not other fields", () => {
            const executor = new CodeActExecutor("onebot:group:123456");

            const task = makeTask("旧群名");
            const originalChatId = task.contextSnapshot.chatId;
            const originalDepth = task.contextSnapshot.depth;

            // @ts-expect-error - accessing private field for testing
            executor.taskQueue.push(task);
            executor.updateChatTitle("更新后的群名");

            assert.equal(task.contextSnapshot.chatTitle, "更新后的群名");
            assert.equal(task.contextSnapshot.chatId, originalChatId);
            assert.equal(task.contextSnapshot.depth, originalDepth);
        });
    });

    describe("NC listener: chatTitle 同步字段映射", () => {
        it("should extract newTitle from newName field (onebot)", () => {
            const event = {
                type: "onebot.group_name_change",
                chatId: "onebot:group:123",
                newName: "来自OneBot的新群名",
            };

            const newTitle = String(event.newName ?? (event as any).chatTitle ?? "");
            assert.equal(newTitle, "来自OneBot的新群名");
        });

        it("should extract newTitle from chatTitle field (telegram)", () => {
            const event = {
                type: "telegram.chat_title_refresh",
                chatId: "telegram:-1001234567890",
                chatTitle: "来自Telegram的新群名",
            };

            const newTitle = String((event as any).newName ?? event.chatTitle ?? "");
            assert.equal(newTitle, "来自Telegram的新群名");
        });

        it("should prefer newName over chatTitle when both present", () => {
            const event = {
                type: "onebot.group_name_change",
                chatId: "onebot:group:123",
                newName: "OneBot名称",
                chatTitle: "不应使用",
            };

            const newTitle = String(event.newName ?? (event as any).chatTitle ?? "");
            assert.equal(newTitle, "OneBot名称");
        });

        it("should handle missing both newName and chatTitle", () => {
            const event = {
                type: "onebot.group_name_change",
                chatId: "onebot:group:123",
            };

            const newTitle = String((event as any).newName ?? (event as any).chatTitle ?? "");
            assert.equal(newTitle, "");
        });
    });

    describe("Telegram chat_title_refresh 事件", () => {
        it("should broadcast telegram.chat_title_refresh event via NC", () => {
            const nc = makeNC();
            const receivedEvents: Array<Record<string, unknown>> = [];

            nc.onPush(event => {
                if (event.type === "telegram.chat_title_refresh") {
                    receivedEvents.push(event as Record<string, unknown>);
                }
            });

            nc.push({
                type: "telegram.chat_title_refresh",
                chatId: "telegram:-1001234567890",
                chatTitle: "Telegram新群名",
                platform: "telegram",
            });

            assert.equal(receivedEvents.length, 1);
            assert.equal(receivedEvents[0].chatId, "telegram:-1001234567890");
            assert.equal(receivedEvents[0].chatTitle, "Telegram新群名");

            nc.dispose();
        });
    });

    describe("端到端: NC事件 → CodeActExecutor 刷新", () => {
        it("should update CodeActExecutor when NC event triggers updateChatTitle", () => {
            const nc = makeNC();
            const executor = new CodeActExecutor("onebot:group:123456");

            const task = makeTask("旧群名");
            // 直接操作 taskQueue 避免 processNext 消费
            // @ts-expect-error - accessing private field for testing
            executor.taskQueue.push(task);

            // 模拟 main.ts 中的 onPush 监听逻辑
            nc.onPush(event => {
                const eventType = String(event.type ?? "");
                if (eventType !== "onebot.group_name_change" && eventType !== "telegram.chat_title_refresh") return;
                const newTitle = String(event.newName ?? event.chatTitle ?? "");
                if (newTitle) {
                    executor.updateChatTitle(newTitle);
                }
            });

            // 触发群名变更
            nc.push({
                type: "onebot.group_name_change",
                chatId: "onebot:group:123456",
                newName: "端到端新群名",
            });

            assert.equal(task.contextSnapshot.chatTitle, "端到端新群名");
            assert.equal(task.contextSnapshot.groupModel?.chatTitle, "端到端新群名");

            nc.dispose();
        });

        it("should work with telegram.chat_title_refresh events too", () => {
            const nc = makeNC();
            const executor = new CodeActExecutor("telegram:-1001234567890");

            const task = makeTask("旧TG群名", "telegram:-1001234567890");
            // @ts-expect-error - accessing private field for testing
            executor.taskQueue.push(task);

            nc.onPush(event => {
                const eventType = String(event.type ?? "");
                if (eventType !== "onebot.group_name_change" && eventType !== "telegram.chat_title_refresh") return;
                const newTitle = String(event.newName ?? event.chatTitle ?? "");
                if (newTitle) {
                    executor.updateChatTitle(newTitle);
                }
            });

            nc.push({
                type: "telegram.chat_title_refresh",
                chatId: "telegram:-1001234567890",
                chatTitle: "新TG群名",
            });

            assert.equal(task.contextSnapshot.chatTitle, "新TG群名");
            assert.equal(task.contextSnapshot.groupModel?.chatTitle, "新TG群名");

            nc.dispose();
        });
    });
});
