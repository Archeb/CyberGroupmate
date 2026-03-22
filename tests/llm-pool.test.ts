/**
 * llm-pool.test.ts — LLMPool 负载均衡调度器 单元测试
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { LLMPool, clearAllPools, getOrCreatePool } from "../src/core/llm-pool.js";
import type { PoolConfig } from "../src/core/config.js";

function makePoolConfig(
    memberCount: number,
    strategy: PoolConfig["strategy"] = "round_robin",
): PoolConfig {
    return {
        strategy,
        members: Array.from({ length: memberCount }, (_, i) => ({
            apiKey: `key-${i}`,
            weight: 1,
        })),
    };
}

describe("LLMPool", () => {
    beforeEach(() => {
        clearAllPools();
    });

    describe("round_robin 策略", () => {
        it("应按轮转顺序分发 key", () => {
            const pool = new LLMPool("test-rr", makePoolConfig(3, "round_robin"));

            const keys: string[] = [];
            for (let i = 0; i < 6; i++) {
                const handle = pool.acquire();
                assert.ok(handle, "acquire should return a handle");
                keys.push(handle.apiKey);
                pool.release(handle, true);
            }

            assert.deepStrictEqual(keys, ["key-0", "key-1", "key-2", "key-0", "key-1", "key-2"]);
        });

        it("应跳过冷却中的 key", () => {
            const pool = new LLMPool("test-rr-skip", makePoolConfig(3, "round_robin"));

            // 让 key-0 进入冷却
            const h0 = pool.acquire()!;
            assert.equal(h0.apiKey, "key-0");
            pool.release(h0, false, true); // quota error → 冷却

            // 下次应该跳过 key-0，直接到 key-1
            const h1 = pool.acquire()!;
            assert.equal(h1.apiKey, "key-1");
            pool.release(h1, true);

            const h2 = pool.acquire()!;
            assert.equal(h2.apiKey, "key-2");
            pool.release(h2, true);

            // key-0 仍在冷却，再次跳过
            const h3 = pool.acquire()!;
            assert.equal(h3.apiKey, "key-1");
            pool.release(h3, true);
        });
    });

    describe("least_pending 策略", () => {
        it("应选择 pending 最少的 key", () => {
            const pool = new LLMPool("test-lp", makePoolConfig(3, "least_pending"));

            // 持有 key-0（pending=1）
            const h0 = pool.acquire()!;
            assert.ok(h0);

            // 持有 key-0 不释放，下次应选 pending=0 的 key
            const h1 = pool.acquire()!;
            assert.ok(h1);
            assert.notEqual(h1.apiKey, h0.apiKey);

            // 释放
            pool.release(h0, true);
            pool.release(h1, true);
        });
    });

    describe("random 策略", () => {
        it("应成功分发 key（无崩溃）", () => {
            const pool = new LLMPool("test-rand", makePoolConfig(3, "random"));
            const keys = new Set<string>();
            for (let i = 0; i < 30; i++) {
                const h = pool.acquire()!;
                assert.ok(h);
                keys.add(h.apiKey);
                pool.release(h, true);
            }
            // 30 次应该至少选到 2 个不同的 key
            assert.ok(keys.size >= 2, `Expected at least 2 different keys, got ${keys.size}`);
        });
    });

    describe("冷却与恢复", () => {
        it("所有 key 冷却时应返回 null", () => {
            const pool = new LLMPool("test-cooldown", makePoolConfig(2, "round_robin"));

            // 让所有 key 进入冷却
            const h0 = pool.acquire()!;
            pool.release(h0, false, true);
            const h1 = pool.acquire()!;
            pool.release(h1, false, true);

            // 现在所有 key 都在冷却
            const h2 = pool.acquire();
            assert.equal(h2, null);
        });

        it("成功调用应重置冷却状态", () => {
            const pool = new LLMPool("test-reset", makePoolConfig(1, "round_robin"));

            // 触发冷却
            const h0 = pool.acquire()!;
            pool.release(h0, false, true);
            assert.equal(pool.acquire(), null);

            // 手动将 cooldownUntil 设置为过去（模拟冷却到期）
            // @ts-expect-error - 访问 private 成员用于测试
            pool["members"][0].cooldownUntil = Date.now() - 1;

            // 现在应该可以获取了
            const h1 = pool.acquire()!;
            assert.equal(h1.apiKey, "key-0");

            // 成功后 consecutiveErrors 应重置
            pool.release(h1, true);
            // @ts-expect-error
            assert.equal(pool["members"][0].consecutiveErrors, 0);
        });
    });

    describe("pendingRequests 计数", () => {
        it("acquire 增加、release 减少", () => {
            const pool = new LLMPool("test-pending", makePoolConfig(1, "round_robin"));

            const h = pool.acquire()!;
            const status = pool.getStatus();
            assert.equal(status[0].pendingRequests, 1);

            pool.release(h, true);
            const status2 = pool.getStatus();
            assert.equal(status2[0].pendingRequests, 0);
        });
    });

    describe("baseUrl 覆盖", () => {
        it("应使用 member 的 baseUrl", () => {
            const config: PoolConfig = {
                strategy: "round_robin",
                members: [
                    { apiKey: "key-a", baseUrl: "https://vertex.example.com/v1" },
                    { apiKey: "key-b" }, // 无 baseUrl
                ],
            };
            const pool = new LLMPool("test-baseurl", config);

            const h0 = pool.acquire()!;
            assert.equal(h0.baseUrl, "https://vertex.example.com/v1");
            pool.release(h0, true);

            const h1 = pool.acquire()!;
            assert.equal(h1.baseUrl, undefined);
            pool.release(h1, true);
        });
    });

    describe("getOrCreatePool 注册表", () => {
        it("应复用相同 ID 的 pool 实例", () => {
            const config = makePoolConfig(2);
            const pool1 = getOrCreatePool("shared-pool", config);
            const pool2 = getOrCreatePool("shared-pool", config);
            assert.strictEqual(pool1, pool2);
        });

        it("不同 ID 应创建不同实例", () => {
            const config = makePoolConfig(2);
            const pool1 = getOrCreatePool("pool-a", config);
            const pool2 = getOrCreatePool("pool-b", config);
            assert.notStrictEqual(pool1, pool2);
        });
    });

    describe("getStatus", () => {
        it("应返回正确的状态快照", () => {
            const pool = new LLMPool("test-status", makePoolConfig(2));
            const status = pool.getStatus();
            assert.equal(status.length, 2);
            assert.equal(status[0].apiKeyPreview, "key-0...");
            assert.equal(status[0].pendingRequests, 0);
            assert.equal(status[0].consecutiveErrors, 0);
            assert.equal(status[0].cooldownRemaining, 0);
            assert.equal(status[0].disabled, false);
        });
    });

    describe("永久禁用（quota 连续失败）", () => {
        it("连续 5 次 quota 失败后应永久禁用", () => {
            const pool = new LLMPool("test-disable-quota", makePoolConfig(1, "round_robin"));

            // 连续 5 次 quota 失败
            for (let i = 0; i < 5; i++) {
                const h = pool.acquire();
                if (!h) {
                    // 冷却中，手动过期
                    // @ts-expect-error
                    pool["members"][0].cooldownUntil = Date.now() - 1;
                    continue;
                }
                pool.release(h, false, true); // quota error
                // 手动过期冷却，以便下一次 acquire 可用
                // @ts-expect-error
                pool["members"][0].cooldownUntil = Date.now() - 1;
            }

            // 第 5 次后应该被 disabled
            // @ts-expect-error
            assert.equal(pool["members"][0].disabled, true);

            // acquire 应该返回 null（即使冷却已过期）
            // @ts-expect-error
            pool["members"][0].cooldownUntil = 0;
            const h = pool.acquire();
            assert.equal(h, null);
        });

        it("4 次 quota 失败不应禁用", () => {
            const pool = new LLMPool("test-no-disable", makePoolConfig(1, "round_robin"));

            for (let i = 0; i < 4; i++) {
                const h = pool.acquire()!;
                pool.release(h, false, true);
                // @ts-expect-error
                pool["members"][0].cooldownUntil = Date.now() - 1;
            }

            // @ts-expect-error
            assert.equal(pool["members"][0].disabled, false);
            assert.equal(pool["members"][0].consecutiveErrors, 4);
        });
    });

    describe("永久禁用（认证错误）", () => {
        it("auth 错误应立即禁用", () => {
            const pool = new LLMPool("test-disable-auth", makePoolConfig(2, "round_robin"));

            const h0 = pool.acquire()!;
            assert.equal(h0.apiKey, "key-0");
            pool.release(h0, false, false, true); // auth error

            // key-0 应已被禁用
            // @ts-expect-error
            assert.equal(pool["members"][0].disabled, true);

            // 下次 acquire 应跳过 key-0，选 key-1
            const h1 = pool.acquire()!;
            assert.equal(h1.apiKey, "key-1");
            pool.release(h1, true);
        });

        it("所有 key auth 失败后应返回 null", () => {
            const pool = new LLMPool("test-all-auth-fail", makePoolConfig(2, "round_robin"));

            const h0 = pool.acquire()!;
            pool.release(h0, false, false, true);
            const h1 = pool.acquire()!;
            pool.release(h1, false, false, true);

            assert.equal(pool.acquire(), null);

            // getStatus 应显示所有 key 都被禁用
            const status = pool.getStatus();
            assert.equal(status[0].disabled, true);
            assert.equal(status[1].disabled, true);
        });
    });
});
