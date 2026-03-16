/**
 * feedback-loop.test.ts — FeedbackLoop 集成测试
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { TopicRegistry } from "../src/pipeline/topic-registry.js";
import { FeedbackLoop } from "../src/pipeline/feedback-loop.js";
import { MemoryStoreV2 } from "../src/memory-v2/index.js";
import { NotificationCenter } from "../src/event/notification-center.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = join(tmpdir(), `feedback-loop-${randomUUID()}`);
    tempDirs.push(dir);
    return dir;
}

after(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("FeedbackLoop", () => {
    it("should evaluate follow-up activity and write feedback", async () => {
        const dir = makeTempDir();
        const memory = new MemoryStoreV2(join(dir, "memory.db"));
        const nc = new NotificationCenter(join(dir, "events.jsonl"), false);
        const registry = new TopicRegistry();
        const loop = new FeedbackLoop(memory, nc, () => registry, 20);

        const topic = registry.create("-1001", "测试话题", ["测试"], [{
            id: "1",
            chatId: "-1001",
            senderId: "10",
            senderName: "Alice",
            text: "你怎么看？",
            timestamp: Date.now(),
        }]);

        loop.recordAgentMessage({
            scene: "telegram",
            chatId: "-1001",
            messageId: "500",
            text: "我觉得可以试试",
            timestamp: new Date().toISOString(),
        });

        await new Promise(r => setTimeout(r, 5));
        registry.addMessages(topic.id, [{
            id: "2",
            chatId: "-1001",
            senderId: "11",
            senderName: "Bob",
            text: "那我们周末去？",
            timestamp: Date.now(),
        }]);

        await new Promise(r => setTimeout(r, 40));

        const model = memory.getGroupModel("-1001");
        assert.ok(model);
        assert.equal(model!.engagementLevel, "high");
        assert.ok(model!.recentFeedback.includes("后续互动"));

        const events = await nc.drain(0, 10);
        const feedbackEvent = events.find(e => e.type === "system.feedback_evaluated");
        assert.ok(feedbackEvent);

        loop.dispose();
        memory.close();
        nc.dispose();
    });
});
