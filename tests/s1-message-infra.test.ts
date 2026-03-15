/**
 * s1-message-infra.test.ts — S1 消息基础设施改造 单元测试
 *
 * 覆盖：
 * - MessageLogWriter 实时落盘（幂等、类型过滤）
 * - NC onPush hook 触发
 * - GroupDispatcher per-chatId 分发
 * - MessageSnapshot 时间一致性查询
 * - RecordingPipeline INSERT OR IGNORE 兼容
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync } from "node:fs";

import { NotificationCenter } from "../src/event/notification-center.js";
import { MessageLogWriter } from "../src/event/message-log-writer.js";
import { buildMessageSnapshot } from "../src/memory-v2/message-snapshot.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";

function createTempDir(): string {
    const dir = join(tmpdir(), `s1-test-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

describe("S1: 消息基础设施改造", () => {
    const tempDirs: string[] = [];

    function makeTestEnv() {
        const dir = createTempDir();
        tempDirs.push(dir);
        const ncPath = join(dir, "events.jsonl");
        const dbPath = join(dir, "memory.db");
        const nc = new NotificationCenter(ncPath, false);
        const memory = new MemoryStoreV2(dbPath);
        return { dir, nc, memory, dbPath };
    }

    after(() => {
        for (const dir of tempDirs) {
            if (existsSync(dir)) {
                rmSync(dir, { recursive: true, force: true });
            }
        }
    });

    // ─── S1.1: MessageLogWriter ───

    describe("S1.1: MessageLogWriter", () => {
        it("#1 写入 telegram.message 事件到 message_log", () => {
            const { nc, memory } = makeTestEnv();
            const writer = new MessageLogWriter(memory);

            const event = nc.push({
                type: "telegram.message",
                chatId: "chat1",
                userId: "user1",
                messageId: "msg1",
                displayName: "Alice",
                text: "Hello world",
                timestamp: "2026-03-13T10:00:00Z",
            });

            const result = writer.write(event);
            assert.equal(result, true, "应该成功写入");

            // 验证 message_log 表中有数据
            const rows = memory.getRecentMessages("chat1", 10);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].messageId, "msg1");
            assert.equal(rows[0].text, "Hello world");
            assert.equal(rows[0].displayName, "Alice");
            assert.equal(rows[0].userId, "user1");

            memory.close();
        });

        it("#2 幂等写入（重复 messageId 不报错不重复）", () => {
            const { nc, memory } = makeTestEnv();
            const writer = new MessageLogWriter(memory);

            const event = nc.push({
                type: "telegram.message",
                chatId: "chat1",
                userId: "user1",
                messageId: "msg_dup",
                text: "First",
                timestamp: "2026-03-13T10:00:00Z",
            });

            // 写两次
            writer.write(event);
            writer.write(event);

            const rows = memory.getRecentMessages("chat1", 10);
            assert.equal(rows.length, 1, "不应该有重复");

            memory.close();
        });

        it("#3 忽略非 telegram.message 事件", () => {
            const { nc, memory } = makeTestEnv();
            const writer = new MessageLogWriter(memory);

            const event = nc.push({
                type: "system.background_error",
                chatId: "chat1",
                messageId: "sys1",
                text: "error info",
            });

            const result = writer.write(event);
            assert.equal(result, false, "应该跳过非 telegram.message 事件");
            assert.equal(writer.getWrittenCount(), 0);

            memory.close();
        });
    });

    // ─── NC onPush + 实时落盘 ───

    describe("S1.1 + NC: 实时落盘", () => {
        it("#4 NC push() 触发实时落盘", () => {
            const { nc, memory } = makeTestEnv();
            const writer = new MessageLogWriter(memory);

            // 注册 onPush hook
            nc.onPush(event => writer.write(event));

            // push 一条消息
            nc.push({
                type: "telegram.message",
                chatId: "chat_rt",
                userId: "user_rt",
                messageId: "msg_rt_1",
                text: "Real-time test",
                timestamp: "2026-03-13T10:00:00Z",
            });

            // 立即应该能从 message_log 查到
            const rows = memory.getRecentMessages("chat_rt", 10);
            assert.equal(rows.length, 1, "push 后立即可查到");
            assert.equal(rows[0].messageId, "msg_rt_1");
            assert.equal(rows[0].text, "Real-time test");

            memory.close();
        });
    });

    // ─── S1.3: MessageSnapshot ───

    describe("S1.3: MessageSnapshot", () => {
        it("#8 时间一致性（snapshot(250) 只返回 t≤250 的消息）", () => {
            const { memory } = makeTestEnv();

            // 写入 3 条不同时间的消息
            memory.storeMessageBatch([
                { messageId: "m1", chatId: "c1", userId: "u1", displayName: "A", text: "t100", timestamp: "2026-03-13T10:00:00Z" },
                { messageId: "m2", chatId: "c1", userId: "u1", displayName: "A", text: "t200", timestamp: "2026-03-13T10:02:00Z" },
                { messageId: "m3", chatId: "c1", userId: "u1", displayName: "A", text: "t300", timestamp: "2026-03-13T10:04:00Z" },
            ]);

            // snapshot 截至 10:02:30（应包含 t100 和 t200，不含 t300）
            const snapshot = buildMessageSnapshot(
                (memory as any).db,
                "c1",
                "2026-03-13T10:02:30Z",
                "2026-03-13T09:00:00Z"
            );

            assert.equal(snapshot.messages.length, 2, "应只返回 t≤250 的消息");
            assert.equal(snapshot.messages[0].text, "t100");
            assert.equal(snapshot.messages[1].text, "t200");
            assert.equal(snapshot.newMessageCount, 2);

            memory.close();
        });

        it("#9 按 chatId 过滤", () => {
            const { memory } = makeTestEnv();

            memory.storeMessageBatch([
                { messageId: "m1", chatId: "c1", userId: "u1", displayName: "A", text: "from c1", timestamp: "2026-03-13T10:00:00Z" },
                { messageId: "m2", chatId: "c2", userId: "u2", displayName: "B", text: "from c2", timestamp: "2026-03-13T10:01:00Z" },
                { messageId: "m3", chatId: "c1", userId: "u1", displayName: "A", text: "from c1 again", timestamp: "2026-03-13T10:02:00Z" },
            ]);

            const snapshot = buildMessageSnapshot(
                (memory as any).db,
                "c1",
                "2026-03-13T10:05:00Z",
                "2026-03-13T09:00:00Z"
            );

            assert.equal(snapshot.messages.length, 2, "应只返回 c1 的消息");
            assert.ok(snapshot.messages.every(m => m.chatId === "c1"));

            memory.close();
        });
    });

    // ─── S1 兼容: Recording Pipeline INSERT OR IGNORE ───

    describe("S1 兼容: Recording Pipeline 与实时写入共存", () => {
        it("#10 实时写入后 storeMessageBatch 不 crash", () => {
            const { nc, memory } = makeTestEnv();
            const writer = new MessageLogWriter(memory);
            nc.onPush(event => writer.write(event));

            // 通过 NC push（触发实时写入）
            nc.push({
                type: "telegram.message",
                chatId: "compat1",
                userId: "u1",
                messageId: "compat_msg_1",
                text: "Real-time",
                timestamp: "2026-03-13T10:00:00Z",
            });

            // 模拟 Recording Pipeline 的批量写入（相同 messageId）
            assert.doesNotThrow(() => {
                memory.storeMessageBatch([
                    {
                        messageId: "compat_msg_1",
                        chatId: "compat1",
                        userId: "u1",
                        displayName: "",
                        text: "Real-time",
                        timestamp: "2026-03-13T10:00:00Z",
                    },
                ]);
            }, "INSERT OR IGNORE 应兼容重复写入");

            // 确认只有 1 条记录
            const rows = memory.getRecentMessages("compat1", 10);
            assert.equal(rows.length, 1);

            memory.close();
        });
    });
});
