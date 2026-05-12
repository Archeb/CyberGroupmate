import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { NotificationCenter } from "../src/event/notification-center.js";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import type { OneBotConfig } from "../src/core/config.js";

function makeNC(): NotificationCenter {
    return new NotificationCenter(join(tmpdir(), `onebot-adapter-${randomUUID()}.jsonl`), false);
}

function makeConfig(overrides: Partial<OneBotConfig> = {}): OneBotConfig {
    return {
        wsUrl: "ws://127.0.0.1:6700/onebot",
        selfId: "123456789",
        ...overrides,
    };
}

describe("OneBotAdapter", () => {
    it("should drop replyTo for group voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 1 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:group:979200391",
            { type: "audio", file: "media/mimo_tts_1777522996493.ogg" },
            { replyTo: 1805758077 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_group_msg");
        assert.equal(calls[0].params.group_id, 979200391);
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/mimo_tts_1777522996493.ogg")}` } },
        ]);

        nc.dispose();
    });

    it("should drop replyTo for private voice payloads", async () => {
        const nc = makeNC();
        const adapter = new OneBotAdapter(makeConfig(), nc);
        const calls: Array<{ action: string; params: Record<string, unknown> }> = [];

        // @ts-expect-error - override private method for payload inspection
        adapter.callAction = async (action: string, params: Record<string, unknown>) => {
            calls.push({ action, params });
            return { message_id: 2 };
        };

        // @ts-expect-error - invoke private method for focused transport test
        await adapter.sendMedia(
            "onebot:private:12345678",
            { type: "audio", file: "media/private_voice.ogg" },
            { replyTo: 99887766 },
        );

        assert.equal(calls.length, 1);
        assert.equal(calls[0].action, "send_private_msg");
        assert.deepEqual(calls[0].params.message, [
            { type: "record", data: { file: `file://${pathResolve(process.cwd(), "workspace", "media/private_voice.ogg")}` } },
        ]);

        nc.dispose();
    });

    // ─── markAsRead ───
    describe("markAsRead", () => {
        function setup(overrides: Partial<OneBotConfig> = {}) {
            const nc = makeNC();
            const adapter = new OneBotAdapter(makeConfig(overrides), nc);
            const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
            // 满足 callAction 内的 WS 状态校验
            (adapter as any).ws = { readyState: 1 };
            (adapter as any).callAction = async (action: string, params: Record<string, unknown>) => {
                calls.push({ action, params });
                return null;
            };
            return { nc, adapter, calls };
        }

        it("disabled by default → no API call", async () => {
            const { nc, adapter, calls } = setup();
            await adapter.markAsRead("onebot:group:679691983");
            assert.equal(calls.length, 0);
            nc.dispose();
        });

        it("enabled for group → calls mark_group_msg_as_read", async () => {
            const { nc, adapter, calls } = setup({ enableReadReceipts: true });
            await adapter.markAsRead("onebot:group:679691983");
            assert.equal(calls.length, 1);
            assert.equal(calls[0].action, "mark_group_msg_as_read");
            assert.equal(calls[0].params.group_id, 679691983);
            nc.dispose();
        });

        it("enabled for private → calls mark_private_msg_as_read", async () => {
            const { nc, adapter, calls } = setup({ enableReadReceipts: true });
            await adapter.markAsRead("onebot:private:12345678");
            assert.equal(calls.length, 1);
            assert.equal(calls[0].action, "mark_private_msg_as_read");
            assert.equal(calls[0].params.user_id, 12345678);
            nc.dispose();
        });

        it("swallows action error (warn-once degradation)", async () => {
            const nc = makeNC();
            const adapter = new OneBotAdapter(makeConfig({ enableReadReceipts: true }), nc);
            (adapter as any).ws = { readyState: 1 };
            (adapter as any).callAction = async () => { throw new Error("retcode 1404"); };
            // 不应抛出
            await assert.doesNotReject(() => adapter.markAsRead("onebot:group:679691983"));
            nc.dispose();
        });
    });

    // ─── sendTyping ───
    describe("sendTyping (handleCall)", () => {
        function setup(overrides: Partial<OneBotConfig> = {}) {
            const nc = makeNC();
            const adapter = new OneBotAdapter(makeConfig(overrides), nc);
            const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
            (adapter as any).ws = { readyState: 1 };
            (adapter as any).callAction = async (action: string, params: Record<string, unknown>) => {
                calls.push({ action, params });
                return null;
            };
            return { nc, adapter, calls };
        }

        it("disabled by default → no API call", async () => {
            const { nc, adapter, calls } = setup();
            const ret = await adapter.handleCall("onebot.sendTyping", ["onebot:private:12345678"]);
            assert.equal(ret, null);
            assert.equal(calls.length, 0);
            nc.dispose();
        });

        it("enabled in private → calls set_input_status with event_type=1", async () => {
            const { nc, adapter, calls } = setup({ enableTyping: true });
            await adapter.handleCall("onebot.sendTyping", ["onebot:private:12345678"]);
            assert.equal(calls.length, 1);
            assert.equal(calls[0].action, "set_input_status");
            assert.equal(calls[0].params.user_id, "12345678");
            assert.equal(calls[0].params.event_type, 1);
            nc.dispose();
        });

        it("enabled in group → still no-op (NapCat 仅私聊有此扩展)", async () => {
            const { nc, adapter, calls } = setup({ enableTyping: true });
            const ret = await adapter.handleCall("onebot.sendTyping", ["onebot:group:679691983"]);
            assert.equal(ret, null);
            assert.equal(calls.length, 0);
            nc.dispose();
        });
    });

    // ─── downloadIncomingMedia ───
    describe("downloadIncomingMedia", () => {
        type MediaInfo = {
            type: string;
            fileId: string;
            uniqueFileId: string;
            fileSize?: number;
            filePath?: string;
            downloadStatus?: string;
            downloadError?: string;
        };

        function setupAdapter(opts: {
            existingPath?: string | null;
            withinSizeLimit?: boolean;
            savedPath?: string | null;
            downloadShouldFail?: boolean;
            autoDownload?: boolean;
        }) {
            const nc = makeNC();
            const mediaDownloader = {
                getExistingPath: (_uniqueId: string) => opts.existingPath ?? null,
                isWithinSizeLimit: (_size?: number) => opts.withinSizeLimit ?? true,
                saveMedia: (buffer: Buffer, _saveOpts: unknown) => {
                    if (opts.savedPath === null) return null;
                    return { path: opts.savedPath ?? "/tmp/saved.bin", category: "photos", size: buffer.length };
                },
            };
            const adapter = new OneBotAdapter(
                makeConfig({ autoDownloadIncoming: opts.autoDownload }),
                nc,
                mediaDownloader as any,
            );
            (adapter as any).downloadMedia = async () => {
                if (opts.downloadShouldFail) throw new Error("HTTP 404");
                return Buffer.from("hello-bytes");
            };
            return { nc, adapter };
        }

        it("skips QQ face / mface", async () => {
            const { nc, adapter } = setupAdapter({});
            const info: MediaInfo = { type: "sticker", fileId: "face:123", uniqueFileId: "face:123" };
            // @ts-expect-error - private
            await adapter.downloadIncomingMedia(info, "onebot:group:1", "msg-1");
            assert.equal(info.downloadStatus, "skipped");
            assert.equal(info.filePath, undefined);
            nc.dispose();
        });

        it("cached → sets filePath from existing", async () => {
            const { nc, adapter } = setupAdapter({ existingPath: "/tmp/cached.png" });
            const info: MediaInfo = { type: "photo", fileId: "https://x/y.png", uniqueFileId: "abc" };
            // @ts-expect-error - private
            await adapter.downloadIncomingMedia(info, "onebot:group:1", "msg-1");
            assert.equal(info.downloadStatus, "cached");
            assert.equal(info.filePath, "/tmp/cached.png");
            nc.dispose();
        });

        it("downloads and saves", async () => {
            const { nc, adapter } = setupAdapter({ savedPath: "/tmp/saved.png" });
            const info: MediaInfo = { type: "photo", fileId: "https://x/y.png", uniqueFileId: "abc" };
            // @ts-expect-error - private
            await adapter.downloadIncomingMedia(info, "onebot:group:1", "msg-1");
            assert.equal(info.downloadStatus, "downloaded");
            assert.equal(info.filePath, "/tmp/saved.png");
            nc.dispose();
        });

        it("too_large", async () => {
            const { nc, adapter } = setupAdapter({ withinSizeLimit: false });
            const info: MediaInfo = { type: "video", fileId: "https://x/y.mp4", uniqueFileId: "abc", fileSize: 999_999_999 };
            // @ts-expect-error - private
            await adapter.downloadIncomingMedia(info, "onebot:group:1", "msg-1");
            assert.equal(info.downloadStatus, "too_large");
            assert.equal(info.filePath, undefined);
            nc.dispose();
        });

        it("download failure → status failed, error recorded", async () => {
            const { nc, adapter } = setupAdapter({ downloadShouldFail: true });
            const info: MediaInfo = { type: "photo", fileId: "https://x/y.png", uniqueFileId: "abc" };
            // @ts-expect-error - private
            await adapter.downloadIncomingMedia(info, "onebot:group:1", "msg-1");
            assert.equal(info.downloadStatus, "failed");
            assert.match(info.downloadError ?? "", /404/);
            nc.dispose();
        });

        it("disabled via autoDownloadIncoming=false → no-op", async () => {
            const { nc, adapter } = setupAdapter({ autoDownload: false });
            const info: MediaInfo = { type: "photo", fileId: "https://x/y.png", uniqueFileId: "abc" };
            // @ts-expect-error - private
            await adapter.downloadIncomingMedia(info, "onebot:group:1", "msg-1");
            assert.equal(info.downloadStatus, undefined);
            nc.dispose();
        });
    });

    // ─── 动图贴纸发送 ───
    describe("animated sticker send", () => {
        /** 创建 adapter 并 stub callAction / 文件系统方法 */
        function setup() {
            const nc = makeNC();
            const adapter = new OneBotAdapter(makeConfig(), nc);
            const calls: Array<{ action: string; params: Record<string, unknown> }> = [];
            (adapter as any).callAction = async (action: string, params: Record<string, unknown>) => {
                calls.push({ action, params });
                return { message_id: 1 };
            };
            return { nc, adapter, calls };
        }

        it("isAnimatedImagePath detects .gif/.webm/.tgs", () => {
            const { nc, adapter } = setup();
            assert.equal((adapter as any).isAnimatedImagePath("/tmp/sticker.gif"), true);
            assert.equal((adapter as any).isAnimatedImagePath("/tmp/sticker.GIF"), true);
            assert.equal((adapter as any).isAnimatedImagePath("/tmp/sticker.webm"), true);
            assert.equal((adapter as any).isAnimatedImagePath("/tmp/sticker.tgs"), true);
            assert.equal((adapter as any).isAnimatedImagePath("/tmp/sticker.png"), false);
            assert.equal((adapter as any).isAnimatedImagePath("/tmp/sticker.jpg"), false);
            assert.equal((adapter as any).isAnimatedImagePath("/tmp/sticker.webp"), false);
            nc.dispose();
        });

        it("GIF sticker with preserveAnimation bypasses ensureSupportedFormat", async () => {
            const { nc, adapter } = setup();
            // Stub: resolveFileReferenceToPath → 返回给定路径（假设文件存在）
            (adapter as any).resolveFileReferenceToPath = (f: string) => f;
            // Stub: convertToAnimatedGif → GIF 不需要转换，返回原路径
            (adapter as any).convertToAnimatedGif = (p: string) => p;
            // Stub: resizeStickerImageForQq → 返回原路径
            (adapter as any).resizeStickerImageForQq = (p: string) => p;
            // Spy: 确保 ensureSupportedFormat 不被调用
            let ensureCalled = false;
            const origInfer = (adapter as any).inferImageMimeType.bind(adapter);
            (adapter as any).inferImageMimeType = (f: string) => {
                if (f.endsWith(".gif")) {
                    ensureCalled = false; // 不应该到这里来
                }
                return origInfer(f);
            };

            const result = await (adapter as any).normalizeOutgoingImageFile("/tmp/sticker.gif", {
                preserveAnimation: true,
                resizeForQqSticker: true,
            });
            // GIF 应保持为 GIF 路径（未被转为 PNG）
            assert.equal(result, "/tmp/sticker.gif");
            assert.equal(ensureCalled, false);
            nc.dispose();
        });

        it("webm sticker with preserveAnimation calls convertToAnimatedGif", async () => {
            const { nc, adapter } = setup();
            (adapter as any).resolveFileReferenceToPath = (f: string) => f;
            let convertCalled = false;
            let convertArg = "";
            (adapter as any).convertToAnimatedGif = (p: string) => {
                convertCalled = true;
                convertArg = p;
                return p.replace(".webm", ".gif");
            };
            (adapter as any).resizeStickerImageForQq = (p: string) => p;

            const result = await (adapter as any).normalizeOutgoingImageFile("/tmp/sticker.webm", {
                preserveAnimation: true,
                resizeForQqSticker: true,
            });
            assert.equal(convertCalled, true);
            assert.equal(convertArg, "/tmp/sticker.webm");
            assert.equal(result, "/tmp/sticker.gif");
            nc.dispose();
        });

        it("tgs sticker with preserveAnimation calls convertToAnimatedGif", async () => {
            const { nc, adapter } = setup();
            (adapter as any).resolveFileReferenceToPath = (f: string) => f;
            let convertCalled = false;
            let convertArg = "";
            (adapter as any).convertToAnimatedGif = (p: string) => {
                convertCalled = true;
                convertArg = p;
                return p.replace(".tgs", ".gif");
            };
            (adapter as any).resizeStickerImageForQq = (p: string) => p;

            const result = await (adapter as any).normalizeOutgoingImageFile("/tmp/sticker.tgs", {
                preserveAnimation: true,
                resizeForQqSticker: true,
            });
            assert.equal(convertCalled, true);
            assert.equal(convertArg, "/tmp/sticker.tgs");
            assert.equal(result, "/tmp/sticker.gif");
            nc.dispose();
        });

        it("static PNG sticker is still resized normally", async () => {
            const { nc, adapter } = setup();
            (adapter as any).resolveFileReferenceToPath = (f: string) => f;
            // PNG 不走 ensureSupportedFormat（已经是 jpeg/png），直接 resize
            let resizeCalled = false;
            let resizeArg = "";
            (adapter as any).resizeStickerImageForQq = (p: string) => {
                resizeCalled = true;
                resizeArg = p;
                return p;
            };

            const result = await (adapter as any).normalizeOutgoingImageFile("/tmp/sticker.png", {
                preserveAnimation: true,
                resizeForQqSticker: true,
            });
            assert.equal(resizeCalled, true);
            assert.equal(resizeArg, "/tmp/sticker.png");
            assert.equal(result, "/tmp/sticker.png");
            nc.dispose();
        });

        it("sticker segment includes sub_type: 1", async () => {
            const { nc, adapter, calls } = setup();
            // Stub 文件处理方法
            (adapter as any).resolveFileReferenceToPath = (f: string) => f;
            (adapter as any).normalizeOutgoingImageFile = async (f: unknown) => f;
            (adapter as any).resolveWorkspacePath = (f: string) => f;

            await (adapter as any).sendSticker("onebot:group:123", "/tmp/sticker.png", {});
            assert.equal(calls.length, 1);
            const segments = calls[0].params.message as Array<Record<string, unknown>>;
            assert.equal(segments.length, 1);
            assert.equal(segments[0].type, "image");
            assert.equal(segments[0].data.sub_type, 1);
            nc.dispose();
        });

        it("regular photo send does not include sub_type", async () => {
            const { nc, adapter, calls } = setup();
            (adapter as any).resolveFileReferenceToPath = (f: string) => f;
            (adapter as any).normalizeOutgoingImageFile = async (f: unknown) => f;
            (adapter as any).resolveWorkspacePath = (f: string) => f;

            await (adapter as any).sendMedia("onebot:group:123", {
                type: "photo",
                file: "/tmp/photo.png",
            }, {});
            assert.equal(calls.length, 1);
            const segments = calls[0].params.message as Array<Record<string, unknown>>;
            assert.equal(segments.length, 1);
            assert.equal(segments[0].type, "image");
            assert.equal(segments[0].data.sub_type, undefined);
            nc.dispose();
        });
    });
});