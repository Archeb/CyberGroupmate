/**
 * s7-stickiness.test.ts — S7 GroupStickiness 单元测试
 *
 * 从 s6-s7-s8-integration.test.ts 拆分 + s-audit-edge-cases.test.ts 合并
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createStickiness, evaluateStickiness, updateStickiness } from "../src/subagent/stickiness.js";
import type { GroupModel } from "../src/memory-v2/types.js";

describe("S7: GroupStickiness", () => {
    it("#1 createStickiness CORE", () => {
        const s = createStickiness("CORE");
        assert.equal(s.level, "CORE");
        assert.equal(s.priorityMultiplier, 1.0);
        assert.equal(s.fastPathEligible, true);
    });

    it("#2 createStickiness STRANGER", () => {
        const s = createStickiness("STRANGER");
        assert.equal(s.level, "STRANGER");
        assert.equal(s.priorityMultiplier, 0.2);
        assert.equal(s.fastPathEligible, false);
    });

    it("#3 evaluateStickiness: null → STRANGER", () => {
        assert.equal(evaluateStickiness(null, 0, "ACQUAINTANCE"), "STRANGER");
    });

    it("#4 evaluateStickiness: 高 avgMsgs → 升级", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 25 } as GroupModel;
        const result = evaluateStickiness(gm, 0, "ACQUAINTANCE");
        assert.equal(result, "FAMILIAR", "25 msgs/day 应升至 FAMILIAR");
    });

    it("#5 evaluateStickiness: STRANGER → ACQUAINTANCE 升级", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 10 } as GroupModel;
        const result = evaluateStickiness(gm, 0, "STRANGER");
        assert.equal(result, "ACQUAINTANCE");
    });

    it("#6 evaluateStickiness: FAMILIAR → CORE 升级", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 60 } as GroupModel;
        const result = evaluateStickiness(gm, 0, "FAMILIAR");
        assert.equal(result, "CORE");
    });

    it("#7 evaluateStickiness: 久无交互 → 降级", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 1 } as GroupModel;
        const result = evaluateStickiness(gm, 15, "CORE");
        assert.equal(result, "FAMILIAR", "14天+ 无交互应从 CORE 降至 FAMILIAR");
    });

    it("#8 evaluateStickiness: FAMILIAR → ACQUAINTANCE 降级", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 1 } as GroupModel;
        const result = evaluateStickiness(gm, 31, "FAMILIAR");
        assert.equal(result, "ACQUAINTANCE");
    });

    it("#9 updateStickiness 不同级别", () => {
        const current = createStickiness("STRANGER");
        const updated = updateStickiness(current, "FAMILIAR");
        assert.equal(updated.level, "FAMILIAR");
        assert.notEqual(updated.priorityMultiplier, current.priorityMultiplier);
    });

    it("#10 updateStickiness 相同级别返回原对象", () => {
        const current = createStickiness("CORE");
        const same = updateStickiness(current, "CORE");
        assert.strictEqual(same, current, "相同级别应返回同一对象");
    });

    // ─── Edge cases (from audit) ───

    it("#11 Full upgrade path STRANGER→ACQUAINTANCE→FAMILIAR→CORE", () => {
        let level = evaluateStickiness({ chatId: "c1", avgMessagesPerDay: 10 } as GroupModel, 0, "STRANGER");
        assert.equal(level, "ACQUAINTANCE");
        level = evaluateStickiness({ chatId: "c1", avgMessagesPerDay: 25 } as GroupModel, 0, "ACQUAINTANCE");
        assert.equal(level, "FAMILIAR");
        level = evaluateStickiness({ chatId: "c1", avgMessagesPerDay: 55 } as GroupModel, 0, "FAMILIAR");
        assert.equal(level, "CORE");
    });

    it("#12 evaluateStickiness with 0 avgMsgsPerDay stays same", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 0 } as GroupModel;
        const result = evaluateStickiness(gm, 0, "ACQUAINTANCE");
        assert.equal(result, "ACQUAINTANCE", "0 messages should not trigger upgrade");
    });

    it("#13 CORE stays CORE with high activity", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 100 } as GroupModel;
        const result = evaluateStickiness(gm, 0, "CORE");
        assert.equal(result, "CORE");
    });

    it("#14 createStickiness all levels", () => {
        for (const level of ["CORE", "FAMILIAR", "ACQUAINTANCE", "STRANGER"] as const) {
            const s = createStickiness(level);
            assert.equal(s.level, level);
            assert.ok(s.priorityMultiplier >= 0 && s.priorityMultiplier <= 1);
        }
    });

    it("#15 ACQUAINTANCE → STRANGER downgrade after long inactivity", () => {
        const gm = { chatId: "c1", avgMessagesPerDay: 0 } as GroupModel;
        const result = evaluateStickiness(gm, 61, "ACQUAINTANCE");
        assert.equal(result, "STRANGER");
    });

    // ─── New fields (audit fix 3.5) ───

    it("#16 createStickiness includes replyFrequency and initiativeLevel", () => {
        const core = createStickiness("CORE");
        assert.equal(core.replyFrequency, 0.8);
        assert.equal(core.initiativeLevel, 0.7);
        assert.equal(core.maxInterventionsPerHour, 20);
        assert.equal(core.cooldownAfterIntervention, 30_000);
    });

    it("#17 createStickiness STRANGER has conservative behavioral defaults", () => {
        const stranger = createStickiness("STRANGER");
        assert.equal(stranger.replyFrequency, 0.1);
        assert.equal(stranger.initiativeLevel, 0.05);
        assert.equal(stranger.maxInterventionsPerHour, 2);
        assert.equal(stranger.cooldownAfterIntervention, 300_000);
    });

    it("#18 all levels have monotonically increasing replyFrequency", () => {
        const levels: Array<"STRANGER" | "ACQUAINTANCE" | "FAMILIAR" | "CORE"> = 
            ["STRANGER", "ACQUAINTANCE", "FAMILIAR", "CORE"];
        const freqs = levels.map(l => createStickiness(l).replyFrequency);
        for (let i = 1; i < freqs.length; i++) {
            assert.ok(freqs[i] > freqs[i - 1], `${levels[i]} should have higher replyFrequency than ${levels[i - 1]}`);
        }
    });
});
