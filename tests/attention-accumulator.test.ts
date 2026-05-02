import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttentionAccumulator } from "../src/accumulator/attention-accumulator.js";
import { calculatePressure } from "../src/accumulator/pressure.js";
import { GlobalState } from "../src/main-agent/global-state.js";

const tempDirs: string[] = [];

function tempDir(): string {
    const dir = join(tmpdir(), `accumulator-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    tempDirs.push(dir);
    return dir;
}

after(() => {
    for (const dir of tempDirs) {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
});

function createAccumulator(config?: ConstructorParameters<typeof AttentionAccumulator>[1]) {
    const dir = tempDir();
    const globalState = new GlobalState({ filePath: join(dir, "state.json"), autoSaveInterval: 0 });
    const accumulator = new AttentionAccumulator(globalState, { windowMs: 1_000, topN: 2, ...config });
    return { accumulator, globalState };
}

describe("AttentionAccumulator", () => {
    it("calculates pressure with tier, stickiness and age factors", () => {
        const pressure = calculatePressure({
            participants: [{ messageCount: 2, totalChars: 300, dunbarTier: 1 }],
            stickinessLevel: "CORE",
            ageMinutes: 5,
            ignoredCount: 0,
        });
        assert.equal(pressure, 1320);
    });

    it("applies ignored penalty to pressure", () => {
        const pressure = calculatePressure({
            participants: [{ messageCount: 2, totalChars: 300, dunbarTier: 1 }],
            stickinessLevel: "CORE",
            ageMinutes: 5,
            ignoredCount: 1,
        });
        assert.equal(pressure, 396);
    });

    it("waits for window before flushing layer 1 items", () => {
        const { accumulator, globalState } = createAccumulator();
        accumulator.ingest(1, {
            chatId: "telegram:1",
            source: "CALLBACK",
            payload: { taskId: "a" },
            enqueuedAt: 0,
        });

        assert.equal(accumulator.flush(500), null);
        const set = accumulator.flush(1_000);
        assert.ok(set);
        assert.equal(set?.triggerReason, "window");
        assert.equal(set?.items.length, 1);
        globalState.dispose();
    });

    it("waits for the window even when a layer 0 item arrives", () => {
        const { accumulator, globalState } = createAccumulator();
        accumulator.ingest(1, {
            chatId: "telegram:1",
            source: "CALLBACK",
            payload: { taskId: "a" },
            enqueuedAt: 0,
        });
        accumulator.ingest(0, {
            chatId: "telegram:2",
            source: "DIRECT_ADDRESS",
            payload: { preview: "在吗" },
            enqueuedAt: 100,
        });

        assert.equal(accumulator.flush(100), null);
        const set = accumulator.flush(1_000);
        assert.ok(set);
        assert.equal(set?.triggerReason, "window");
        assert.equal(set?.items[0]?.layer, 0);
        globalState.dispose();
    });

    it("caps each window and only fills remaining slots with layer 2 signals", () => {
        const { accumulator, globalState } = createAccumulator({ topN: 3 });
        accumulator.ingest(1, {
            chatId: "telegram:1",
            source: "CALLBACK",
            payload: { taskId: "a" },
            enqueuedAt: 0,
        });
        accumulator.ingest(0, {
            chatId: "telegram:2",
            source: "DIRECT_ADDRESS",
            payload: { reason: "DM" },
            enqueuedAt: 1,
        });
        accumulator.ingest(2, {
            chatId: "telegram:3",
            source: "TOPIC_SIGNAL",
            payload: { label: "A" },
            enqueuedAt: 2,
            pressure: 10,
        });
        accumulator.ingest(2, {
            chatId: "telegram:4",
            source: "TOPIC_SIGNAL",
            payload: { label: "B" },
            enqueuedAt: 3,
            pressure: 30,
        });

        const set = accumulator.flush(1_000);
        assert.ok(set);
        assert.deepEqual(
            set?.items.map((item) => item.chatId),
            ["telegram:2", "telegram:1", "telegram:4"],
        );
        globalState.dispose();
    });

    it("releases only top N signals and persists ignored counts", () => {
        const { accumulator, globalState } = createAccumulator();
        accumulator.ingest(2, {
            chatId: "telegram:1",
            source: "TOPIC_SIGNAL",
            payload: { label: "A" },
            enqueuedAt: 0,
            pressure: 10,
        });
        accumulator.ingest(2, {
            chatId: "telegram:2",
            source: "TOPIC_SIGNAL",
            payload: { label: "B" },
            enqueuedAt: 1,
            pressure: 30,
        });
        accumulator.ingest(2, {
            chatId: "telegram:3",
            source: "TOPIC_SIGNAL",
            payload: { label: "C" },
            enqueuedAt: 2,
            pressure: 20,
        });

        const set = accumulator.flush(2_000);
        assert.ok(set);
        assert.equal(set?.items.length, 2);
        assert.deepEqual(
            set?.items.map((item) => item.chatId),
            ["telegram:2", "telegram:3"],
        );
        assert.deepEqual(
            globalState.getSignalPool().map((item) => ({ chatId: item.chatId, ignoredCount: item.ignoredCount })),
            [
                { chatId: "telegram:1", ignoredCount: 0 },
                { chatId: "telegram:2", ignoredCount: 1 },
                { chatId: "telegram:3", ignoredCount: 1 },
            ],
        );
        globalState.dispose();
    });

    it("recalculates topic signal pressure after a signal is ignored", () => {
        const { accumulator, globalState } = createAccumulator({ topN: 1 });
        accumulator.ingest(2, {
            chatId: "telegram:1",
            source: "TOPIC_SIGNAL",
            payload: {
                pressureInput: {
                    participants: [{ messageCount: 2, totalChars: 300, dunbarTier: 1 }],
                    stickinessLevel: "CORE",
                },
            },
            enqueuedAt: 0,
        });
        accumulator.ingest(2, {
            chatId: "telegram:2",
            source: "TOPIC_SIGNAL",
            payload: {
                pressureInput: {
                    participants: [{ messageCount: 1, totalChars: 200, dunbarTier: 1 }],
                    stickinessLevel: "CORE",
                },
            },
            enqueuedAt: 0,
        });

        const firstSet = accumulator.flush(0);
        assert.ok(firstSet);
        assert.deepEqual(firstSet?.items.map((item) => item.chatId), ["telegram:1"]);

        const secondSet = accumulator.flush(60_000);
        assert.ok(secondSet);
        assert.deepEqual(secondSet?.items.map((item) => item.chatId), ["telegram:2"]);
        globalState.dispose();
    });

    it("restores persisted signal pool and resets ignored count on markActioned", () => {
        const dir = tempDir();
        const path = join(dir, "state.json");
        const gs1 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        const acc1 = new AttentionAccumulator(gs1, { windowMs: 1_000, topN: 2 });
        acc1.ingest(2, {
            chatId: "telegram:1",
            source: "TOPIC_SIGNAL",
            payload: { label: "persisted" },
            enqueuedAt: 0,
            pressure: 12,
        });
        acc1.flush(2_000);
        gs1.save();
        gs1.dispose();

        const gs2 = new GlobalState({ filePath: path, autoSaveInterval: 0 });
        const acc2 = new AttentionAccumulator(gs2, { windowMs: 1_000, topN: 2 });
        acc2.restoreSignalPool();
        assert.equal(acc2.getSignalPoolSize(), 1);
        assert.equal(gs2.getSignalPool()[0]?.ignoredCount, 1);
        acc2.markActioned("telegram:1");
        assert.equal(gs2.getSignalPool()[0]?.ignoredCount, 0);
        gs2.dispose();
    });

    it("blocks chats, drops queued items, and ignores ingress until unblocked", () => {
        const { accumulator, globalState } = createAccumulator();
        accumulator.ingest(2, {
            chatId: "telegram:1",
            source: "TOPIC_SIGNAL",
            payload: { label: "blocked" },
            enqueuedAt: 0,
            pressure: 10,
        });
        accumulator.block("telegram:1");

        assert.equal(accumulator.getSignalPoolSize(), 0);
        accumulator.ingest(0, {
            chatId: "telegram:1",
            source: "DIRECT_ADDRESS",
            payload: { reason: "DM" },
            enqueuedAt: 10,
        });
        assert.equal(accumulator.flush(10), null);

        accumulator.unblock("telegram:1");
        accumulator.ingest(0, {
            chatId: "telegram:1",
            source: "DIRECT_ADDRESS",
            payload: { reason: "DM" },
            enqueuedAt: 20,
        });
        const set = accumulator.flush(1_020);
        assert.ok(set);
        assert.equal(set?.items[0]?.chatId, "telegram:1");
        globalState.dispose();
    });

    it("requeues unprocessed pending items for the next flush", () => {
        const { accumulator, globalState } = createAccumulator();
        accumulator.ingest(1, {
            chatId: "telegram:1",
            source: "CALLBACK",
            payload: { taskId: "a" },
            enqueuedAt: 0,
        });

        const firstSet = accumulator.flush(1_000);
        assert.ok(firstSet);
        accumulator.requeue(firstSet!.items[0]!);

        const secondSet = accumulator.flush(1_000);
        assert.ok(secondSet);
        assert.equal(secondSet?.items[0]?.chatId, "telegram:1");
        globalState.dispose();
    });

    it("exposes active, dequeued, and blocked state snapshots", () => {
        const { accumulator, globalState } = createAccumulator();
        accumulator.ingest(1, {
            chatId: "telegram:1",
            source: "CALLBACK",
            payload: { taskId: "a" },
            enqueuedAt: 0,
        });
        accumulator.ingest(2, {
            chatId: "telegram:2",
            source: "TOPIC_SIGNAL",
            payload: { label: "signal" },
            enqueuedAt: 0,
            pressure: 10,
        });
        accumulator.block("telegram:3");
        accumulator.flush(1_000);

        const snapshot = accumulator.getSnapshot();
        assert.deepEqual(snapshot.blockedChatIds, ["telegram:3"]);
        assert.equal(snapshot.active.length, 1);
        assert.equal(snapshot.active[0]?.kind, "signal");
        assert.equal(snapshot.dequeued.length, 2);
        globalState.dispose();
    });
});
