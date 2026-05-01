import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    createDirectAddressItem,
    createSchedulerItem,
    estimateSignalPressureFromQueueEntry,
    queueEntryToTopicSignalItem,
} from "../src/accumulator/queue-entry-adapter.js";
import type { AttentionQueueEntry } from "../src/subagent/types.js";

function createEntry(overrides: Partial<AttentionQueueEntry> = {}): AttentionQueueEntry {
    return {
        chatId: "telegram:1",
        source: "DIGEST_UPDATE",
        priority: 40,
        basePriority: 40,
        enqueuedAt: 123,
        lastAttendedAt: null,
        attendCount: 0,
        blocked: false,
        newMessageCount: 3,
        topicDigests: [{
            topicId: "topic-1",
            label: "午饭",
            summary: "讨论午饭吃什么",
            state: "active",
            participants: ["u1", "u2"],
            keywords: ["午饭"],
            messageCount: 12,
            lastActivityAt: new Date(123).toISOString(),
            callbackPotential: 18,
        }],
        stickinessLevel: "FAMILIAR",
        callbackPotential: 18,
        snapshotTimestamp: new Date(123).toISOString(),
        ...overrides,
    };
}

describe("accumulator queue entry adapter", () => {
    it("creates a direct-address item", () => {
        const item = createDirectAddressItem("telegram:1", { reason: "DM" }, 456);
        assert.deepEqual(item, {
            chatId: "telegram:1",
            source: "DIRECT_ADDRESS",
            payload: { reason: "DM" },
            enqueuedAt: 456,
        });
    });

    it("creates a scheduler item", () => {
        const item = createSchedulerItem("telegram:1", { id: "cron-1" }, 789);
        assert.deepEqual(item, {
            chatId: "telegram:1",
            source: "SCHEDULER",
            payload: { id: "cron-1" },
            enqueuedAt: 789,
        });
    });

    it("estimates signal pressure from queue context", () => {
        const low = estimateSignalPressureFromQueueEntry(createEntry());
        const high = estimateSignalPressureFromQueueEntry(createEntry({
            priority: 70,
            callbackPotential: 50,
            urgentSignals: ["@mention"],
            stickinessLevel: "CORE",
            topicDigests: [{
                topicId: "topic-1",
                label: "项目",
                summary: "讨论项目安排",
                state: "active",
                participants: ["u1", "u2", "u3"],
                keywords: ["项目"],
                messageCount: 30,
                lastActivityAt: new Date(123).toISOString(),
                callbackPotential: 50,
            }],
        }));
        assert.ok(high > low);
    });

    it("maps a queue entry to a topic signal item", () => {
        const entry = createEntry({ source: "OBSERVER_ALERT" });
        const item = queueEntryToTopicSignalItem(entry);
        assert.equal(item.chatId, entry.chatId);
        assert.equal(item.source, "TOPIC_SIGNAL");
        assert.equal(item.enqueuedAt, entry.enqueuedAt);
        assert.equal(item.pressure, estimateSignalPressureFromQueueEntry(entry));
        assert.deepEqual(item.payload, {
            topicDigests: entry.topicDigests,
            snapshotTimestamp: entry.snapshotTimestamp,
            callbackPotential: entry.callbackPotential,
            queueSource: entry.source,
        });
    });
});