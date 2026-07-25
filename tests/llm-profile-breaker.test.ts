/**
 * llm-profile-breaker.test.ts — Profile 级熔断器 单元测试
 *
 * 覆盖：三态转换 / 半开并发只放一个探针 / resetAll / enabled 开关 /
 *      per-(component,profile) 隔离 / 冷却退避递增 / 冷却封顶
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { profileBreaker } from "../src/core/llm-profile-breaker.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function entry(component: string, profileName: string) {
    const e = profileBreaker.getStatus().entries.find(
        (x) => x.component === component && x.profileName === profileName,
    );
    assert.ok(e, `entry ${component}/${profileName} 应存在`);
    return e;
}

describe("LLMProfileBreaker", () => {
    beforeEach(() => {
        profileBreaker.resetAll();
        profileBreaker.setConfig({
            enabled: true,
            failureThreshold: 3,
            cooldownBaseMs: 20,
            cooldownFactor: 2,
            cooldownMaxMs: 1000,
        });
    });

    describe("closed 状态", () => {
        it("新 entry 放行且非探针", () => {
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: false,
            });
        });

        it("recordSuccess 后保持 closed", () => {
            profileBreaker.recordSuccess("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: false,
            });
        });

        it("未达阈值时累计失败仍 closed、放行", () => {
            profileBreaker.recordFailure("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: false,
            });
        });
    });

    describe("open 状态", () => {
        it("达阈值后熔断，tryAcquire 拒绝", () => {
            for (let i = 0; i < 3; i++) profileBreaker.recordFailure("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: false,
                probe: false,
            });
            assert.equal(entry("meta", "p1").state, "open");
        });

        it("成功调用重置计数（不会因历史失败累积而误熔断）", () => {
            profileBreaker.recordFailure("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            profileBreaker.recordSuccess("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: false,
            });
        });
    });

    describe("half_open 状态", () => {
        async function tripAndExpire(component: string, profileName: string) {
            for (let i = 0; i < 3; i++) profileBreaker.recordFailure(component, profileName);
            assert.deepStrictEqual(
                profileBreaker.tryAcquire(component, profileName),
                { try: false, probe: false },
            );
            await sleep(25);
        }

        it("冷却到期后转 half_open 并放行首个探针", async () => {
            await tripAndExpire("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: true,
            });
            assert.equal(entry("meta", "p1").state, "half_open");
        });

        it("半开期间只放一个探针，其余拒绝", async () => {
            await tripAndExpire("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: true,
            });
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: false,
                probe: false,
            });
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: false,
                probe: false,
            });
        });

        it("探针成功 → 恢复 closed", async () => {
            await tripAndExpire("meta", "p1");
            profileBreaker.tryAcquire("meta", "p1");
            profileBreaker.recordSuccess("meta", "p1");
            assert.equal(entry("meta", "p1").state, "closed");
            assert.equal(entry("meta", "p1").consecutiveErrors, 0);
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: false,
            });
        });

        it("探针失败 → 重新 open 且 errors 累加", async () => {
            await tripAndExpire("meta", "p1");
            profileBreaker.tryAcquire("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            assert.equal(entry("meta", "p1").state, "open");
            assert.equal(entry("meta", "p1").consecutiveErrors, 4);
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: false,
                probe: false,
            });
        });
    });

    describe("resetAll", () => {
        it("清空所有 entry，之后放行", () => {
            for (let i = 0; i < 3; i++) profileBreaker.recordFailure("meta", "p1");
            assert.equal(profileBreaker.getStatus().entries.length, 1);
            profileBreaker.resetAll();
            assert.equal(profileBreaker.getStatus().entries.length, 0);
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: false,
            });
        });
    });

    describe("enabled 开关", () => {
        it("enabled=false 时即使已熔断也放行", () => {
            for (let i = 0; i < 3; i++) profileBreaker.recordFailure("meta", "p1");
            profileBreaker.setConfig({ enabled: false });
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: true,
                probe: false,
            });
        });

        it("重新 enable 后恢复熔断语义", () => {
            for (let i = 0; i < 3; i++) profileBreaker.recordFailure("meta", "p1");
            profileBreaker.setConfig({ enabled: false });
            profileBreaker.tryAcquire("meta", "p1");
            profileBreaker.setConfig({ enabled: true });
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: false,
                probe: false,
            });
        });
    });

    describe("隔离性", () => {
        it("不同 component 的同名 profile 状态独立", () => {
            for (let i = 0; i < 3; i++) profileBreaker.recordFailure("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: false,
                probe: false,
            });
            assert.deepStrictEqual(profileBreaker.tryAcquire("session", "p1"), {
                try: true,
                probe: false,
            });
        });

        it("同 component 的不同 profile 状态独立", () => {
            for (let i = 0; i < 3; i++) profileBreaker.recordFailure("meta", "p1");
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p1"), {
                try: false,
                probe: false,
            });
            assert.deepStrictEqual(profileBreaker.tryAcquire("meta", "p2"), {
                try: true,
                probe: false,
            });
        });

        it("getStatus 反映不同 component/profile 的独立条目", () => {
            profileBreaker.recordFailure("meta", "p1");
            profileBreaker.recordFailure("session", "p1");
            profileBreaker.recordFailure("meta", "p2");
            const entries = profileBreaker.getStatus().entries;
            assert.equal(entries.length, 3);
            const keys = entries.map((e) => `${e.component}/${e.profileName}`).sort();
            assert.deepStrictEqual(keys, ["meta/p1", "meta/p2", "session/p1"]);
        });
    });

    describe("冷却退避", () => {
        it("连续 half_open 失败使冷却时长递增", async () => {
            profileBreaker.setConfig({
                enabled: true,
                failureThreshold: 2,
                cooldownBaseMs: 20,
                cooldownFactor: 2,
                cooldownMaxMs: 10_000,
            });
            profileBreaker.recordFailure("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            const c1 = entry("meta", "p1").cooldownRemainingMs;
            assert.ok(c1 > 0, "首次冷却应 > 0");

            await sleep(25);
            profileBreaker.tryAcquire("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            const c2 = entry("meta", "p1").cooldownRemainingMs;
            assert.ok(c2 > c1, `二次冷却应更长 ${c1} → ${c2}`);

            await sleep(45);
            profileBreaker.tryAcquire("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            const c3 = entry("meta", "p1").cooldownRemainingMs;
            assert.ok(c3 > c2, `三次冷却应更长 ${c2} → ${c3}`);
        });

        it("冷却封顶不超过 cooldownMaxMs", async () => {
            profileBreaker.setConfig({
                enabled: true,
                failureThreshold: 1,
                cooldownBaseMs: 20,
                cooldownFactor: 10,
                cooldownMaxMs: 50,
            });
            profileBreaker.recordFailure("meta", "p1");
            await sleep(25);
            profileBreaker.tryAcquire("meta", "p1");
            profileBreaker.recordFailure("meta", "p1");
            const c = entry("meta", "p1").cooldownRemainingMs;
            assert.ok(c <= 50, `应封顶到 ≤50，实际 ${c}`);
        });
    });
});
