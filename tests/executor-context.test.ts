import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ContextEngine } from "../src/context-engine/context-engine.js";
import { getExecutorTaskProviders } from "../src/context-engine/providers/executor-providers.js";
import { loadApiTypeDefs } from "../src/subagent/code-act-executor.js";

describe("executor context providers", () => {
    it("renders the same recent Meta session digest window for subagents", () => {
        const engine = new ContextEngine("executor-digest-test");
        engine.registerAll(getExecutorTaskProviders());

        const digests = Array.from({ length: 12 }, (_, index) => ({
            createdAt: `2026-05-01T${String(index).padStart(2, "0")}:00:00.000Z`,
            content: `digest ${index + 1}`,
        }));

        const result = engine.render({
            chatId: "telegram:g1",
            taskId: "task-1",
            decisions: [{ action: "REPLY", contentDirection: "回复当前问题", confidence: 1 }],
            sessionDigests: digests,
        });

        assert.match(result.historicalContent, /# 历史 Session Digests/);
        assert.match(result.historicalContent, /digest 3/);
        assert.match(result.historicalContent, /digest 12/);
        assert.doesNotMatch(result.historicalContent, /digest 2/);
    });

    it("exposes runtime.elevate in the subagent API overview", () => {
        const api = loadApiTypeDefs("telegram");
        assert.match(api, /## runtime/);
        assert.match(api, /elevate/);
        assert.match(api, /升级给 Meta Agent/);
    });
});
