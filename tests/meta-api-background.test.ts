import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createBackgroundApi } from "../src/meta-sandbox/meta-api/background.js";
import type { HarnessManager } from "../src/harness/manager.js";
import type { HarnessNotify } from "../src/harness/types.js";

function createApi() {
    const enqueued: HarnessNotify[] = [];
    const manager = {
        enqueue: (notify: HarnessNotify) => {
            enqueued.push(notify);
        },
        get queueLength() {
            return enqueued.length;
        },
        getStatus: async () => ({ enabled: true }),
    } as unknown as HarnessManager;
    const api = createBackgroundApi(() => manager);
    return { api, enqueued };
}

describe("metaApi.background.enqueue", () => {
    it("rejects object-style calls with rewrite guidance instead of stringifying to [object Object]", async () => {
        const { api, enqueued } = createApi();

        await assert.rejects(
            api.enqueue({ content: "任务正文", source: "meta" } as unknown as string),
            (err: unknown) => {
                assert.ok(err instanceof TypeError);
                assert.match((err as TypeError).message, /content 必须是 string/);
                assert.match((err as TypeError).message, /obj\.content, obj\.source, obj\.options/);
                return true;
            },
        );
        assert.equal(enqueued.length, 0);
    });

    it("rejects null/undefined content", async () => {
        const { api } = createApi();

        for (const bad of [null, undefined]) {
            await assert.rejects(
                api.enqueue(bad as unknown as string),
                (err: unknown) => {
                    assert.match((err as TypeError).message, /收到的是 (null|undefined)/);
                    return true;
                },
            );
        }
    });

    it("defaults source to meta and forwards options on correct positional calls", async () => {
        const { api, enqueued } = createApi();

        const minimal = await api.enqueue("整理搜索技巧成 skill");
        assert.deepEqual(minimal, { queued: true, queueLength: 1 });
        assert.deepEqual(enqueued[0], { content: "整理搜索技巧成 skill", source: "meta" });

        const full = await api.enqueue("深入查资料", "proactive-idle", { taskId: "task-1", metadata: { k: 1 } });
        assert.deepEqual(full, { queued: true, queueLength: 2 });
        assert.deepEqual(enqueued[1], {
            content: "深入查资料",
            source: "proactive-idle",
            taskId: "task-1",
            metadata: { k: 1 },
        });
    });

    it("returns queued:false with reason when harness manager is absent", async () => {
        const api = createBackgroundApi(() => null);
        const result = await api.enqueue("任务");
        assert.deepEqual(result, { queued: false, reason: "Background Agent not configured" });
    });
});
