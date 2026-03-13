/**
 * s4-fast-path.test.ts — S4 FastPath Handler 单元测试
 *
 * 覆盖 10 个测试用例（subtask.md S4 测试计划）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FastPathHandler } from "../src/subagent/fast-path-handler.js";
import type { FastPathConfig, SubagentCallback } from "../src/subagent/types.js";
import type { FastPathEvent } from "../src/subagent/fast-path-handler.js";

function makeConfig(overrides?: Partial<FastPathConfig>): FastPathConfig {
    return {
        preauthorizedActions: ["ack", "thanks", "reply"],
        blockedActions: ["ban", "delete"],
        tonePreset: "casual",
        maxRepliesBeforeReauth: 3,
        expiresAt: new Date(Date.now() + 300_000).toISOString(), // 5 min
        authorizedAt: new Date().toISOString(),
        ...overrides,
    };
}

function makeEvent(text: string = "hello ack"): FastPathEvent {
    return {
        chatId: "chat1",
        messageId: `msg-${Date.now()}`,
        userId: "user1",
        text,
        timestamp: new Date().toISOString(),
    };
}

describe("S4: FastPath Handler", () => {
    it("#1 authorize() 启用 FastPath", () => {
        const fp = new FastPathHandler("chat1");
        assert.equal(fp.isAuthorized(), false, "初始应未授权");

        fp.authorize(makeConfig());
        assert.equal(fp.isAuthorized(), true, "授权后应可用");
    });

    it("#2 revoke() 撤销授权", () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig());
        assert.equal(fp.isAuthorized(), true);

        fp.revoke();
        assert.equal(fp.isAuthorized(), false, "撤销后应不可用");
    });

    it("#3 handle() 匹配预授权动作返回回复", async () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig());

        const reply = await fp.handle(makeEvent("please ack this"));
        assert.ok(reply !== null, "应返回回复");
        assert.ok(reply!.includes("FastPath"), "应包含 FastPath 标识");
    });

    it("#4 handle() 未授权时返回 null", async () => {
        const fp = new FastPathHandler("chat1");
        const reply = await fp.handle(makeEvent("hello"));
        assert.equal(reply, null, "未授权应返回 null");
    });

    it("#5 __SKIP__ 标记跳过发送", async () => {
        const fp = new FastPathHandler("chat1");
        // 使用 blocked action 触发跳过
        fp.authorize(makeConfig({ preauthorizedActions: ["__SKIP__"] }));

        const reply = await fp.handle(makeEvent("__SKIP__ test"));
        assert.equal(reply, null, "__SKIP__ 应跳过");
    });

    it("#6 maxReplies 自动禁用", async () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig({ maxRepliesBeforeReauth: 2 }));

        await fp.handle(makeEvent("ack 1"));
        assert.equal(fp.isAuthorized(), true, "第 1 次后仍授权");

        await fp.handle(makeEvent("ack 2"));
        assert.equal(fp.isAuthorized(), false, "第 2 次后应自动禁用");
    });

    it("#7 过期自动禁用", () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig({
            expiresAt: new Date(Date.now() - 1000).toISOString(), // 已过期
        }));

        assert.equal(fp.isAuthorized(), false, "过期应返回 false");
    });

    it("#8 blocked actions 阻止回复", async () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig());

        const reply = await fp.handle(makeEvent("please ban this user"));
        assert.equal(reply, null, "blocked action 应阻止");
    });

    it("#9 callback handler 在回复后调用", async () => {
        const fp = new FastPathHandler("chat1");
        const callbacks: SubagentCallback[] = [];
        fp.setCallbackHandler(cb => callbacks.push(cb));
        fp.authorize(makeConfig());

        await fp.handle(makeEvent("ack this"));
        assert.equal(callbacks.length, 1, "应调用 callback");
        assert.equal(callbacks[0].executionType, "FAST_PATH");
        assert.equal(callbacks[0].status, "COMPLETED");
    });

    it("#10 getStatus() 返回正确状态", async () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig({ maxRepliesBeforeReauth: 5 }));

        await fp.handle(makeEvent("ack 1"));
        await fp.handle(makeEvent("reply 2"));

        const status = fp.getStatus();
        assert.equal(status.authorized, true);
        assert.equal(status.repliesSent, 2);
        assert.equal(status.maxReplies, 5);
        assert.ok(status.expiresAt !== null);

        assert.equal(fp.getSentMessages().length, 2);
    });

    // ─── Edge cases ───

    it("#11 handle after revoke returns null", async () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig());
        fp.revoke();
        assert.equal(await fp.handle(makeEvent("ack")), null);
    });

    it("#12 sendFn failure produces ERROR callback", async () => {
        const fp = new FastPathHandler("chat1");
        const cbs: SubagentCallback[] = [];
        fp.setCallbackHandler(cb => cbs.push(cb));
        fp.setSendFunction(async () => { throw new Error("network error"); });
        fp.authorize(makeConfig());
        const reply = await fp.handle(makeEvent("ack x"));
        assert.equal(reply, null, "sendFn 失败应返回 null");
        assert.equal(cbs.length, 1);
        assert.equal(cbs[0].status, "ERROR");
    });

    it("#13 re-authorize resets counter", async () => {
        const fp = new FastPathHandler("chat1");
        fp.authorize(makeConfig({ maxRepliesBeforeReauth: 2 }));
        await fp.handle(makeEvent("ack 1"));
        assert.equal(fp.getStatus().repliesSent, 1);
        fp.authorize(makeConfig({ maxRepliesBeforeReauth: 5 }));
        assert.equal(fp.getStatus().repliesSent, 0, "re-authorize 应重置计数器");
        assert.equal(fp.getStatus().maxReplies, 5);
    });
});
