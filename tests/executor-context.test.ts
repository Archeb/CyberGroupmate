import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ContextEngine } from "../src/context-engine/context-engine.js";
import { getExecutorTaskProviders } from "../src/context-engine/providers/executor-providers.js";
import { loadApiTypeDefs } from "../src/subagent/code-act-executor.js";

describe("executor context providers", () => {
    it("renders the recent 30 session digests scoped to this chat", () => {
        const engine = new ContextEngine("executor-digest-test");
        engine.registerAll(getExecutorTaskProviders());

        const digests = Array.from({ length: 35 }, (_, index) => ({
            sourceChatId: "telegram:g1", createdAt: `2026-05-01T${String(index).padStart(2, "0")}:00:00.000Z`,
            content: `digest ${index + 1}`,
        }));

        const result = engine.render({
            chatId: "telegram:g1",
            taskId: "task-1",
            decisions: [{ action: "REPLY", contentDirection: "回复当前问题", confidence: 1 }],
            sessionDigests: digests,
        });

        assert.match(result.historicalContent, /# 历史 Session Digests/);
        assert.match(result.historicalContent, /digest 6/);
        assert.match(result.historicalContent, /digest 35/);
        assert.doesNotMatch(result.historicalContent, /digest 5/);
    });

    it("only persists new Meta session digests after commit", () => {
        const engine = new ContextEngine("executor-digest-delta-test");
        engine.registerAll(getExecutorTaskProviders());

        const base = [
            { sourceChatId: "telegram:g1", createdAt: "2026-05-01T10:00:00.000Z", content: "digest A" },
            { sourceChatId: "telegram:g1", createdAt: "2026-05-01T10:01:00.000Z", content: "digest B" },
        ];
        const common = {
            chatId: "telegram:g1",
            taskId: "task-1",
            decisions: [{ action: "REPLY", contentDirection: "回复当前问题", confidence: 1 }],
        };

        const first = engine.render({ ...common, sessionDigests: base });
        assert.match(first.historicalContent, /digest A/);
        assert.match(first.historicalContent, /digest B/);
        engine.commit(first.tree);

        const unchanged = engine.render({ ...common, taskId: "task-2", sessionDigests: base });
        assert.doesNotMatch(unchanged.historicalContent, /# 历史 Session Digests/);

        const changed = engine.render({
            ...common,
            taskId: "task-3",
            sessionDigests: [
                ...base,
                { sourceChatId: "telegram:g1", createdAt: "2026-05-01T10:02:00.000Z", content: "digest C" },
            ],
        });
        assert.match(changed.historicalContent, /digest C/);
        assert.doesNotMatch(changed.historicalContent, /digest A/);
        assert.doesNotMatch(changed.historicalContent, /digest B/);
    });

    it("exposes runtime.elevate in the subagent API overview", () => {
        const api = loadApiTypeDefs("telegram");
        assert.match(api, /## runtime/);
        assert.match(api, /elevate/);
        assert.match(api, /升级给 Meta Agent/);
    });
});
