import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSandboxHostCallHandler } from "../src/sandbox/host-call-handler.js";

describe("runtime.elevate host call", () => {
    it("enqueues an immediate synthetic Meta wake condition with source chat binding", async () => {
        const captured: Array<{ layer: number; item: any }> = [];
        const handler = createSandboxHostCallHandler("telegram:g1", {
            appConfig: {},
            globalState: {},
            accumulator: {
                ingest: (layer: number, item: any) => captured.push({ layer, item }),
            },
            memory: {},
            adapters: [],
            sandbox: {},
            sandboxPool: {},
            mcpBridge: {},
            buildEnvPlan: () => ({ sandboxVisible: {}, managedKeys: [] }),
            getCurrentEnvPlan: () => ({ sandboxVisible: {}, managedKeys: [] }),
            setCurrentEnvPlan: () => undefined,
            applyHostManagedEnv: () => undefined,
        } as any);

        const result = await handler("runtime.elevate", [
            "请 Meta 查询 D 群 API 网关讨论并派回当前群",
            { urgency: "high", data: { topic: "API 网关" } },
        ]) as { ok: true; id: string; enqueuedAt: string };

        assert.equal(result.ok, true);
        assert.match(result.id, /^elevate:/);
        assert.equal(captured.length, 1);
        assert.equal(captured[0].layer, 0);
        assert.equal(captured[0].item.chatId, "__meta__");
        assert.equal(captured[0].item.source, "WAKE_CONDITION");
        assert.equal(captured[0].item.pressure, 100);
        assert.equal(captured[0].item.payload.type, "wake_condition");
        assert.equal(captured[0].item.payload.bindingId, "telegram:g1");
        assert.equal(captured[0].item.payload.callback, "请 Meta 查询 D 群 API 网关讨论并派回当前群");
        assert.deepEqual(captured[0].item.payload.data, {
            type: "subagent_elevation",
            sourceChatId: "telegram:g1",
            urgency: "high",
            data: { topic: "API 网关" },
        });
    });
});
