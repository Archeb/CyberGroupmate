/**
 * tests/adapter-connection-status.test.ts — 平台连接状态 + 手动重连
 *
 * 覆盖：
 * - ConnectionTracker 状态迁移与重连计划记录
 * - 三个 adapter 都实现了 getConnectionStatus / reconnect
 * - OneBot ws 断开后自动排程重连，并在状态里体现
 * - dashboard collectAdapterStatuses 汇总（含 supportsReconnect）
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { NotificationCenter } from "../src/event/notification-center.js";
import { ConnectionTracker } from "../src/adapter/connection-tracker.js";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import { DiscordAdapter } from "../src/adapter/discord-adapter.js";
import { TelegramAdapter } from "../src/adapter/telegram-adapter.js";
import { collectAdapterStatuses } from "../src/dashboard/api-routes.js";
import type { PlatformAdapter } from "../src/adapter/platform-adapter.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `adapter-conn-${randomUUID()}.jsonl`), false);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("waitFor timed out");
}

describe("ConnectionTracker", () => {
    it("记录连接成功并清空重连计数与错误", () => {
        const tracker = new ConnectionTracker("telegram");
        tracker.markRetryScheduled(3, 5000);
        tracker.markDisconnected("boom");
        assert.equal(tracker.currentState, "disconnected");
        assert.equal(tracker.snapshot().reconnectAttempts, 3);
        assert.equal(tracker.snapshot().lastError, "boom");

        tracker.markConnected("me (42)");
        const snap = tracker.snapshot();
        assert.equal(snap.state, "connected");
        assert.equal(snap.reconnectAttempts, 0);
        assert.equal(snap.nextRetryAt, null);
        assert.equal(snap.lastError, undefined);
        assert.equal(snap.detail, "me (42)");
        assert.ok(snap.lastConnectedAt, "应记录连接时间");
    });

    it("排程重连时给出 nextRetryAt", () => {
        const tracker = new ConnectionTracker("onebot");
        tracker.markRetryScheduled(2, 4000);
        const snap = tracker.snapshot();
        assert.equal(snap.state, "disconnected");
        assert.equal(snap.reconnectAttempts, 2);
        assert.ok(snap.nextRetryAt, "应给出下次重连时间");
        const eta = new Date(snap.nextRetryAt!).getTime() - Date.now();
        assert.ok(eta > 1000 && eta <= 4000, `nextRetryAt 应在 4s 内, got ${eta}`);
    });

    it("noteError 不改变连接状态", () => {
        const tracker = new ConnectionTracker("discord");
        tracker.markConnected();
        tracker.noteError("transient");
        assert.equal(tracker.currentState, "connected");
        assert.equal(tracker.snapshot().lastError, "transient");
    });

    it("stop 后进入 stopped 且无重连计划", () => {
        const tracker = new ConnectionTracker("onebot");
        tracker.markRetryScheduled(1, 1000);
        tracker.markStopped();
        assert.equal(tracker.currentState, "stopped");
        assert.equal(tracker.snapshot().nextRetryAt, null);
    });
});

describe("adapter 连接状态接口", () => {
    it("三个 adapter 都实现 getConnectionStatus 和 reconnect", () => {
        const nc = makeNC();
        const adapters: PlatformAdapter[] = [
            new OneBotAdapter({ wsUrl: "ws://127.0.0.1:1/onebot", selfId: "1" }, nc),
            new DiscordAdapter({ botToken: "t" } as never, nc),
            new TelegramAdapter({ mode: "bot", botToken: "t" } as never, nc, async () => ""),
        ];

        for (const adapter of adapters) {
            assert.equal(typeof adapter.getConnectionStatus, "function", `${adapter.platform} 缺 getConnectionStatus`);
            assert.equal(typeof adapter.reconnect, "function", `${adapter.platform} 缺 reconnect`);
            const status = adapter.getConnectionStatus!();
            assert.equal(status.platform, adapter.platform);
            assert.equal(status.state, "stopped", "未 start 时应为 stopped");
        }
    });

    it("collectAdapterStatuses 汇总各平台并标记 supportsReconnect", () => {
        const nc = makeNC();
        const withReconnect = new OneBotAdapter({ wsUrl: "ws://127.0.0.1:1/onebot", selfId: "1" }, nc);
        const legacy: PlatformAdapter = {
            platform: "legacy",
            start: async () => {},
            stop: async () => {},
            canHandle: () => false,
            handleCall: async () => null,
            getWriteMethods: () => [],
            formatMention: () => undefined,
        };

        const statuses = collectAdapterStatuses({ adapters: [withReconnect, legacy] });
        assert.equal(statuses.length, 2);
        assert.equal(statuses[0].platform, "onebot");
        assert.equal(statuses[0].supportsReconnect, true);
        assert.equal(statuses[1].platform, "legacy");
        assert.equal(statuses[1].supportsReconnect, false);
    });
});

describe("OneBotAdapter 自动重连", () => {
    it("连接成功后状态为 connected，断开后排程重连", async () => {
        const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await new Promise<void>((resolve) => server.once("listening", resolve));
        const port = (server.address() as { port: number }).port;

        const nc = makeNC();
        const adapter = new OneBotAdapter(
            { wsUrl: `ws://127.0.0.1:${port}/onebot`, selfId: "123" },
            nc,
        );
        // 避免 start() 里的预加载去调不存在的 action
        (adapter as unknown as { prefetchWhitelistedGroups: () => void }).prefetchWhitelistedGroups = () => {};

        try {
            await adapter.start();
            assert.equal(adapter.getConnectionStatus().state, "connected");
            assert.ok(adapter.getConnectionStatus().lastConnectedAt, "应记录连接时间");

            // 服务端主动断开 → adapter 应转为 disconnected 并排好重连
            for (const client of server.clients) client.terminate();
            await waitFor(() => adapter.getConnectionStatus().state === "disconnected");

            const status = adapter.getConnectionStatus();
            assert.ok(status.reconnectAttempts >= 1, "应记录重连尝试次数");
            assert.ok(status.nextRetryAt, "应排程下一次重连");
        } finally {
            await adapter.stop();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        assert.equal(adapter.getConnectionStatus().state, "stopped");
    });

    it("首次连接失败也会进入自动重连", async () => {
        const nc = makeNC();
        // 端口 1 上不会有服务
        const adapter = new OneBotAdapter({ wsUrl: "ws://127.0.0.1:1/onebot", selfId: "123" }, nc);

        await assert.rejects(() => adapter.start());
        const status = adapter.getConnectionStatus();
        assert.equal(status.state, "disconnected", "失败后应等待自动重连而不是死掉");
        assert.ok(status.nextRetryAt, "应排程重连");

        await adapter.stop();
    });

    it("手动重连可以安全终止仍在握手的旧连接", async () => {
        const httpServer = createServer();
        const websocketServer = new WebSocketServer({ noServer: true });
        let upgradeCount = 0;
        let stalledUpgradeSocket: Duplex | undefined;
        httpServer.on("upgrade", (request, socket, head) => {
            upgradeCount++;
            if (upgradeCount === 1) {
                stalledUpgradeSocket = socket;
                return;
            }
            websocketServer.handleUpgrade(request, socket, head, client => {
                websocketServer.emit("connection", client, request);
            });
        });
        await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
        const port = (httpServer.address() as { port: number }).port;
        const nc = makeNC();
        const adapter = new OneBotAdapter(
            { wsUrl: `ws://127.0.0.1:${port}/onebot`, selfId: "123" },
            nc,
        );
        (adapter as unknown as { prefetchWhitelistedGroups: () => void }).prefetchWhitelistedGroups = () => {};

        const initialStart = adapter.start();
        void initialStart.catch(() => {});
        await waitFor(() => upgradeCount === 1);
        try {
            await adapter.reconnect();
            assert.equal(upgradeCount, 2);
            assert.equal(adapter.getConnectionStatus().state, "connected");
        } finally {
            await adapter.stop();
            stalledUpgradeSocket?.destroy();
            for (const client of websocketServer.clients) client.terminate();
            await new Promise<void>(resolve => websocketServer.close(() => resolve()));
            await new Promise<void>(resolve => httpServer.close(() => resolve()));
        }
    });
});
