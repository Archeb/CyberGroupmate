import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildWakeConditionPayload, matchDelayWakeReminder } from "../src/main-agent/wake-conditions.js";

describe("meta wake conditions", () => {
    it("matches __meta__ delay reminders back to wake conditions", () => {
        const match = matchDelayWakeReminder({
            id: "rem-1",
            type: "reminder",
            chatId: "__meta__",
            description: "wake:wake-1",
        }, [
            {
                id: "wake-1",
                condition: { type: "delay", ms: 60_000 },
                registeredAt: new Date().toISOString(),
            },
        ]);

        assert.deepEqual(match, {
            conditionId: "wake-1",
            condition: { type: "delay", ms: 60_000 },
        });
        assert.deepEqual(buildWakeConditionPayload(match!, { reminderId: "rem-1" }), {
            id: "wake-1",
            type: "wake_condition",
            description: "delay elapsed (60000ms)",
            condition: { type: "delay", ms: 60_000 },
            reminderId: "rem-1",
        });
    });
});