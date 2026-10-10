import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OneBotAdapter } from "../src/adapter/onebot-adapter.js";
import { NotificationCenter, type NotificationEvent } from "../src/event/notification-center.js";
import { enrichMessages, normalizeMessageMediaFields } from "../src/core/message-enricher.js";
import { MediaDownloader } from "../src/core/media-downloader.js";

const images = ["A", "B", "C"].map(letter => ({
    type: "image",
    data: {
        file: `${letter.repeat(32)}.jpg`,
        url: `https://media.example.invalid/${letter}.jpg`,
        sub_type: 0,
        mime_type: "image/jpeg",
    },
}));

function makeAdapter() {
    const nc = new NotificationCenter(join(tmpdir(), `onebot-multi-${randomUUID()}.jsonl`), false);
    const adapter = new OneBotAdapter({ wsUrl: "ws://127.0.0.1:6700/onebot", selfId: "123456789" }, nc);
    // @ts-expect-error - simulate a connected adapter without opening a socket
    adapter.ws = { readyState: 1 };
    // @ts-expect-error - keep ingress metadata lookup offline
    adapter.callAction = async (action: string, params: Record<string, unknown>) => {
        if (action === "get_group_info") return { group_name: "Test group" };
        if (action === "get_group_member_info") return { nickname: `Member${params.user_id}` };
        throw new Error(`unexpected action: ${action}`);
    };
    return { adapter, nc };
}

function incoming(message: unknown) {
    return {
        post_type: "message", self_id: "123456789", message_type: "group",
        group_id: 42, user_id: 777, message_id: 9001, time: 1770000000,
        sender: { nickname: "Alice" }, message,
    };
}

async function receive(message: unknown): Promise<NotificationEvent> {
    const { adapter, nc } = makeAdapter();
    try {
        const received = new Promise<NotificationEvent>(resolve => nc.onPush(resolve));
        // @ts-expect-error - exercise the real websocket ingress
        adapter.handleWsMessage(JSON.stringify(incoming(message)));
        return await received;
    } finally {
        nc.dispose();
    }
}

function getMedia(event: Record<string, unknown>) {
    return event.mediaInfo as {
        type: string; fileId: string; uniqueFileId: string;
        attachments?: Array<{ type: string; fileId: string; uniqueFileId: string }>;
    };
}

describe("OneBot multi-media", () => {
    for (const count of [2, 3]) {
        it(`retains all ${count} images from a live message in segment order`, async () => {
            const event = await receive([
                { type: "text", data: { text: "compare these images" } },
                ...images.slice(0, count),
            ]);
            const media = getMedia(event);
            assert.equal(event.text, "compare these images");
            assert.equal(media.fileId, images[0].data.url);
            assert.equal(media.uniqueFileId, "A".repeat(32));
            assert.deepEqual(media.attachments?.map(item => item.fileId), images.slice(0, count).map(item => item.data.url));
            assert.deepEqual(media.attachments?.map(item => item.uniqueFileId), ["A", "B", "C"].slice(0, count).map(letter => letter.repeat(32)));
        });
    }

    it("retains both images when OneBot sends a CQ string", async () => {
        const event = await receive("[CQ:image,file=first.jpg,url=https://media.example.invalid/1.jpg][CQ:image,file=second.jpg,url=https://media.example.invalid/2.jpg]");
        assert.deepEqual(getMedia(event).attachments?.map(item => item.fileId), [
            "https://media.example.invalid/1.jpg", "https://media.example.invalid/2.jpg",
        ]);
    });

    it("does not let a face, sticker or other media hide later images", async () => {
        const event = await receive([
            { type: "face", data: { id: 14 } },
            images[0],
            { type: "mface", data: { emoji_package_id: 1, emoji_id: 2 } },
            { ...images[1], data: { ...images[1].data, sub_type: "1" } },
            { type: "video", data: { file: "video.mp4" } },
            { type: "record", data: { file: "voice.amr" } },
            { type: "file", data: { file_id: "document", name: "notes.txt" } },
            images[2],
        ]);
        assert.deepEqual(getMedia(event).attachments?.map(item => [item.type, item.fileId]), [
            ["sticker", "face:14"], ["photo", images[0].data.url],
            ["sticker", "mface:1_2"], ["sticker", images[1].data.url],
            ["video", "video.mp4"], ["audio", "voice.amr"],
            ["document", "document"], ["photo", images[2].data.url],
        ]);
    });

    it("retains GIF image/sticker segments and the following static image", async () => {
        const event = await receive([
            { type: "image", data: { file: "D".repeat(32) + ".gif", url: "https://media.example.invalid/normal.gif" } },
            { type: "image", data: { file: "E".repeat(32) + ".gif", url: "https://media.example.invalid/sticker.gif", sub_type: 1 } },
            images[0],
        ]);
        assert.deepEqual(getMedia(event).attachments?.map(item => [item.type, item.fileId, item.uniqueFileId]), [
            ["photo", "https://media.example.invalid/normal.gif", "D".repeat(32)],
            ["sticker", "https://media.example.invalid/sticker.gif", "E".repeat(32)],
            ["photo", images[0].data.url, "A".repeat(32)],
        ]);
    });

    for (const format of ["array", "CQ"]) {
        it(`keeps multiple mentions separate from media in ${format} messages`, async () => {
            const message = format === "array" ? [
                { type: "at", data: { qq: "778" } }, images[0],
                { type: "at", data: { qq: "779" } },
                { type: "at", data: { qq: "123456789" } }, images[1],
                { type: "at", data: { qq: "all" } },
                { type: "at", data: { qq: "778" } },
            ] : `[CQ:at,qq=778][CQ:image,file=first.jpg,url=${images[0].data.url}][CQ:at,qq=779][CQ:at,qq=123456789][CQ:image,file=second.jpg,url=${images[1].data.url}][CQ:at,qq=all][CQ:at,qq=778]`;
            const event = await receive(message);
            const mentions = event.mentions as Array<{ rawUserId: string; isSelf: boolean; isAll: boolean }>;
            assert.deepEqual(mentions.map(item => item.rawUserId), ["778", "779", "123456789", "all"]);
            assert.equal(mentions[2].isSelf, true);
            assert.equal(mentions[3].isAll, true);
            assert.equal(event.mentionsAgent, true);
            assert.equal(event.text, "@Member778@Member779@Member123456789@全体成员@Member778");
            assert.deepEqual(getMedia(event).attachments?.map(item => item.fileId), images.slice(0, 2).map(item => item.data.url));
        });
    }

    it("retains all images fetched by message ID", async () => {
        const { adapter, nc } = makeAdapter();
        try {
            // @ts-expect-error - mock the OneBot get_msg response
            adapter.callAction = async (action: string) => {
                assert.equal(action, "get_msg");
                return incoming(images.slice(0, 2));
            };
            const result = await adapter.handleCall("onebot.getMessage", ["9001"]) as NotificationEvent;
            assert.deepEqual(getMedia(result).attachments?.map(item => item.fileId), images.slice(0, 2).map(item => item.data.url));
        } finally {
            nc.dispose();
        }
    });

    it("retains all images in offline-history backfill", async () => {
        const { adapter, nc } = makeAdapter();
        const events: Record<string, unknown>[] = [];
        try {
            // @ts-expect-error - mock the history response and group lookup
            adapter.callAction = async (action: string) => {
                if (action === "get_group_msg_history") return { messages: [incoming(images.slice(0, 2))] };
                if (action === "get_group_info") return { group_name: "Test group" };
                throw new Error(`unexpected action: ${action}`);
            };
            const result = await adapter.fetchMissedMessages({
                knownChatIds: ["onebot:group:42"], maxChats: 1, maxMessagesPerChat: 10,
                since: new Date("2026-02-01T00:00:00Z"), getWatermark: () => null,
                deliver: event => events.push(event),
            });
            assert.equal(result.messages, 1);
            assert.deepEqual(getMedia(events[0]).attachments?.map(item => item.fileId), images.slice(0, 2).map(item => item.data.url));
        } finally {
            nc.dispose();
        }
    });

    it("skips an empty media segment and keeps the later valid image", async () => {
        const event = await receive([{ type: "image", data: {} }, images[1]]);
        assert.equal(getMedia(event).fileId, images[1].data.url);
        assert.equal(getMedia(event).attachments, undefined);
    });

    it("preserves the legacy shape for a single image and no media for text", async () => {
        const single = getMedia(await receive([images[0]]));
        assert.equal(single.type, "photo");
        assert.equal(single.fileId, images[0].data.url);
        assert.equal(single.attachments, undefined);
        assert.equal((await receive([{ type: "text", data: { text: "hello" } }])).mediaInfo, undefined);
    });

    it("delivers three distinct image files to enrichment despite reverse download completion", async () => {
        const event = await receive(images);
        assert.equal(getMedia(event).attachments?.length, 3);
        const mediaFields = normalizeMessageMediaFields(event.mediaInfo);
        const directory = mkdtempSync(join(tmpdir(), "onebot-multi-enrich-"));
        const downloader = new MediaDownloader({ downloadDir: directory, retentionDays: 1, maxFileSize: 1024 });
        const releases: Array<() => void> = [];
        const completed: string[] = [];
        try {
            const result = await enrichMessages([{
                id: "9001", sender: "Alice", text: event.text as string,
                chatId: "onebot:group:42", ...mediaFields,
            }], {
                llmConfig: {
                    provider: "openai", model: "test", vision: true,
                    baseUrl: "https://llm.example.invalid/v1", apiKey: "test",
                    temperature: 0, maxTokens: 100,
                },
                enableOgPreview: false, mediaDownloader: downloader,
                downloadFn: (fileId, chatId, messageId, uniqueFileId) => {
                    const index = images.findIndex(item => item.data.url === fileId);
                    assert.notEqual(index, -1);
                    assert.equal(chatId, "onebot:group:42");
                    assert.equal(messageId, "9001");
                    assert.equal(uniqueFileId, ["A", "B", "C"][index].repeat(32));
                    return new Promise<Buffer>(resolve => {
                        releases.push(() => { completed.push(fileId); resolve(Buffer.from(fileId)); });
                        if (releases.length === 3) releases.slice().reverse().forEach(release => release());
                    });
                },
            });
            assert.deepEqual(completed, images.slice().reverse().map(item => item.data.url));
            assert.equal(result.imageParts.length, 3);
            const paths = ["A", "B", "C"].map(letter => downloader.getExistingPath(letter.repeat(32)));
            assert.equal(new Set(paths).size, 3);
            images.forEach((image, index) => {
                assert.ok(paths[index]);
                assert.equal(readFileSync(paths[index]!).toString(), image.data.url);
                assert.equal(Buffer.from(result.imageParts[index].url.split(",")[1], "base64").toString(), image.data.url);
            });
            assert.match(result.formattedText, /图片1/);
            assert.match(result.formattedText, /图片2/);
            assert.match(result.formattedText, /图片3/);
        } finally {
            downloader.dispose();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
