import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AttentionAccumulator } from "../src/accumulator/attention-accumulator.js";
import { GlobalState } from "../src/main-agent/global-state.js";
import { MainAgentLoop } from "../src/main-agent/main-agent-loop.js";
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

describe("MainAgentLoop meta session path", () => {
    it("batches released attention entries into one meta session and stores digest", async () => {
        const dir = tempDir();
        const globalState = new GlobalState({
            filePath: join(dir, "global-state.json"),
            autoSaveInterval: 0,
        });
        const accumulator = new AttentionAccumulator(globalState, { windowMs: 1_000, topN: 2 });
        const callbackQueue = new CallbackQueue();
        const subagentManager = new SubagentManager({ sessionsDir: join(dir, "sessions") });
        const loop = new MainAgentLoop(accumulator, callbackQueue, subagentManager, { maxAttendsPerTick: 2 }, globalState);

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
});